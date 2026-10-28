# Fixed AU1 worker. Bounded stdin only; never evaluate text or place it in a path/command.
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
$utf8 = New-Object System.Text.UTF8Encoding($false, $true)
$inputStream = [Console]::OpenStandardInput()
$bytes = New-Object byte[] 1024
$pending = New-Object 'System.Collections.Generic.List[byte]'
$read = $inputStream.ReadAsync($bytes, 0, $bytes.Length)
$watch = [Diagnostics.Stopwatch]::StartNew()
$voice = $null
$initialized = $false
$speaking = $false
$spoken = $false
$stopping = $false
$sequence = 0
$streamId = 0
$token = $null
$parentProcess = $null
$speakStarted = 0L
$maxUtteranceMs = 5000
$exitCode = 1

function Send-Record($record) { [Console]::Out.WriteLine(($record | ConvertTo-Json -Compress -Depth 12)); [Console]::Out.Flush() }
function Check-Keys($record, [string[]]$keys) {
  $names = @($record.PSObject.Properties.Name)
  if ($names.Count -ne $keys.Count) { throw 'INVALID_SHAPE' }
  foreach ($name in $names) { if ($keys -notcontains $name) { throw 'INVALID_SHAPE' } }
}
function Send-Event([string]$kind, [string]$code) {
  $script:sequence++
  Send-Record @{version=1;kind=$kind;token=$script:token;sequence=$script:sequence;streamId=$script:streamId;code=$code}
}
function Request-Purge {
  $script:stopping = $true
  if ($null -ne $script:voice) { [void]$script:voice.Speak('', 3) }
}
try {
  while ($watch.ElapsedMilliseconds -lt 8000) {
    if ($null -ne $parentProcess -and $parentProcess.HasExited) { Request-Purge; break }
    if ($read.IsCompleted) {
      $count = $read.GetAwaiter().GetResult()
      if ($count -eq 0) { Request-Purge; break }
      for ($i=0; $i -lt $count; $i++) {
        if ($bytes[$i] -eq 10) {
          $line = $utf8.GetString($pending.ToArray()); $pending.Clear()
          $request = ConvertFrom-Json -InputObject $line
          if (-not $initialized) {
            if ($request.action -eq 'inventory') {
              Check-Keys $request @('action')
              $voice = New-Object -ComObject SAPI.SpVoice
              $voices = @(); $outputs = @()
              foreach ($v in $voice.GetVoices()) { $voices += @{id=$v.Id;language=$v.GetAttribute('Language')} }
              foreach ($o in $voice.GetAudioOutputs()) { $outputs += @{id=$o.Id} }
              Send-Record @{version=1;kind='inventory';voices=$voices;outputs=$outputs}
              $exitCode=0; return
            }
            Check-Keys $request @('action','version','parentPid','token','profile','expression','maxUtteranceMs')
            if ($request.action -ne 'initialize' -or $request.version -ne 1 -or $request.parentPid -le 0 -or
                $request.maxUtteranceMs -lt 1 -or $request.maxUtteranceMs -gt 5000) { throw 'INVALID_INITIALIZE' }
            $parentProcess = [Diagnostics.Process]::GetProcessById([int]$request.parentPid)
            # Retain a process handle: PID reuse cannot become a new accepted parent.
            [void]$parentProcess.Handle
            $token = $request.token; $profile = $request.profile; $expression = $request.expression
            Check-Keys $profile @('cognitiveBundleId','voiceBackendId','backendVersion','voiceProfileId','voiceTokenId','voiceRevision','locale','rate','volume','style','deviceTokenId','transportProfileId')
            if ($profile.voiceBackendId -ne 'windows-sapi' -or $profile.backendVersion -ne 'au1-v1' -or
                $profile.style -ne 'neutral' -or $profile.rate -lt -10 -or $profile.rate -gt 10 -or
                $profile.volume -lt 0 -or $profile.volume -gt 100) { throw 'INVALID_PROFILE' }
            $voice = New-Object -ComObject SAPI.SpVoice
            $selectedVoice = $null; $selectedOutput = $null
            foreach ($v in $voice.GetVoices()) { if ($v.Id -ceq $profile.voiceTokenId) { $selectedVoice=$v } }
            foreach ($o in $voice.GetAudioOutputs()) { if ($o.Id -ceq $profile.deviceTokenId) { $selectedOutput=$o } }
            if ($null -eq $selectedVoice -or $null -eq $selectedOutput) { throw 'PROFILE_NOT_FOUND' }
            $languageMatched = $false
            foreach ($language in $selectedVoice.GetAttribute('Language').Split(';')) {
              $culture = [Globalization.CultureInfo]::GetCultureInfo([Convert]::ToInt32($language,16))
              if ($culture.Name -ceq $profile.locale) { $languageMatched=$true }
            }
            if (-not $languageMatched) { throw 'VOICE_LOCALE_MISMATCH' }
            $voice.Voice=$selectedVoice; $voice.AudioOutput=$selectedOutput
            $voice.Rate=[int]$profile.rate; $voice.Volume=[int]$profile.volume
            if ($voice.Voice.Id -cne $profile.voiceTokenId -or $voice.AudioOutput.Id -cne $profile.deviceTokenId -or
                $voice.Rate -ne $profile.rate -or $voice.Volume -ne $profile.volume) { throw 'PROFILE_READBACK_MISMATCH' }
            $maxUtteranceMs=[int]$request.maxUtteranceMs; $initialized=$true
            Send-Record @{version=1;kind='ready';token=$token;profile=$profile}
          } elseif ($request.action -eq 'stop') {
            Check-Keys $request @('action'); Request-Purge
          } elseif ($request.action -eq 'speak') {
            Check-Keys $request @('action','text')
            if ($spoken -or $stopping -or $request.text -isnot [string] -or $request.text.Length -eq 0 -or $request.text.Contains([char]0)) { throw 'SPEAK_REFUSED' }
            $textBytes=$utf8.GetBytes($request.text)
            if ($textBytes.Length -gt 240 -or $textBytes.Length -ne $expression.utf8Bytes) { throw 'TEXT_LIMIT' }
            $sha=[Security.Cryptography.SHA256]::Create()
            try { $hash=([BitConverter]::ToString($sha.ComputeHash($textBytes))).Replace('-','').ToLowerInvariant() } finally { $sha.Dispose() }
            if ($hash -cne $expression.sha256) { throw 'TEXT_HASH_MISMATCH' }
            $spoken=$true; $speakStarted=$watch.ElapsedMilliseconds
            # SVSFlagsAsync (1) | SVSFIsNotXML (16). No filename, XML or SSML flags.
            $streamId=[int]$voice.Speak($request.text,17); $speaking=$true
            $request=$null; $line=$null; $textBytes=$null
            Send-Event 'queued' 'ENGINE_QUEUED'
          } else { throw 'UNKNOWN_ACTION' }
        } else {
          if ($pending.Count -ge 16384) { throw 'STDIN_LIMIT' }
          $pending.Add($bytes[$i])
        }
      }
      $read=$inputStream.ReadAsync($bytes,0,$bytes.Length)
    }
    if ($spoken -and ($watch.ElapsedMilliseconds-$speakStarted) -ge $maxUtteranceMs -and -not $stopping) { Request-Purge }
    if ($initialized -and $stopping -and $voice.WaitUntilDone(0)) { Send-Event 'stopped' 'ENGINE_STOPPED_REPORTED'; $exitCode=0; break }
    if ($speaking -and -not $stopping -and $voice.WaitUntilDone(0)) { Send-Event 'completed' 'ENGINE_COMPLETED_REPORTED'; $exitCode=0; break }
    Start-Sleep -Milliseconds 10
  }
} catch {
  # Deliberately omit exception messages: COM errors can contain user-controlled text or local paths.
  if ($initialized) { try { Send-Event 'fault' 'NATIVE_NOT_ACCEPTED' } catch {} }
} finally {
  if ($null -ne $voice) {
    if ($spoken) { try { [void]$voice.Speak('',3) } catch {} }
    try { [void][Runtime.InteropServices.Marshal]::FinalReleaseComObject($voice) } catch {}
  }
  if ($null -ne $parentProcess) { $parentProcess.Dispose() }
  $inputStream.Dispose()
}
exit $exitCode
