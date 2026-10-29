param(
 [Parameter(Mandatory=$true)][ValidateSet('Preflight','Initialize','Run','Resume','ColdVerify','Revoke')][string]$Action,
 [Parameter(Mandatory=$true)][string]$ConfigPath,
 [Parameter(Mandatory=$true)][ValidatePattern('^[a-f0-9]{64}$')][string]$ConfigSha256
)
$ErrorActionPreference='Stop'
Set-StrictMode -Version Latest
$config=$null;$key=$null;$credentialBytes=$null;$credentials=$null;$workers=0;$keyReads=0;$credentialReads=0;$cleanup=$false;$phase='CONFIG';$run=$null
$executionExit=$null;$terminal=$false;$revokeAttempted=$false;$revocation='NOT_REQUESTED'

function ReadOwnBytes([string]$file,[long]$cap){
 $item=Get-Item -LiteralPath $file -Force
 if($item.PSIsContainer-or($item.Attributes-band[IO.FileAttributes]::ReparsePoint)-ne0-or$item.Length-lt1-or$item.Length-gt$cap){throw 'TCH_FILE'}
 $parent=$item.Directory
 while($null-ne$parent){if(($parent.Attributes-band[IO.FileAttributes]::ReparsePoint)-ne0){throw 'TCH_PATH'};$parent=$parent.Parent}
 return ,([IO.File]::ReadAllBytes($file))
}
function WriteNewBytes([string]$file,[byte[]]$bytes){
 $stream=New-Object IO.FileStream($file,[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,[IO.FileShare]::None,4096,[IO.FileOptions]::WriteThrough)
 try{$stream.Write($bytes,0,$bytes.Length);$stream.Flush($true)}finally{$stream.Dispose()}
}
function NewPrivateDirectory([string]$directory){
 if(Test-Path -LiteralPath $directory){throw 'TCH_DIRECTORY_EXISTS'}
 [IO.Directory]::CreateDirectory($directory)|Out-Null
 $sid=[Security.Principal.WindowsIdentity]::GetCurrent().User;$acl=[IO.Directory]::GetAccessControl($directory);$acl.SetAccessRuleProtection($true,$false)
 foreach($rule in @($acl.GetAccessRules($true,$true,[Security.Principal.SecurityIdentifier]))){$acl.RemoveAccessRuleSpecific($rule)}
 $acl.AddAccessRule((New-Object Security.AccessControl.FileSystemAccessRule($sid,'FullControl','ContainerInherit,ObjectInherit','None','Allow')));[IO.Directory]::SetAccessControl($directory,$acl)
 $read=[IO.Directory]::GetAccessControl($directory);$rules=@($read.GetAccessRules($true,$true,[Security.Principal.SecurityIdentifier]))
 if(-not$read.AreAccessRulesProtected-or$rules.Count-ne1-or$rules[0].IdentityReference.Value-cne$sid.Value-or$rules[0].IsInherited-or$rules[0].AccessControlType-ne[Security.AccessControl.AccessControlType]::Allow-or$rules[0].FileSystemRights-ne[Security.AccessControl.FileSystemRights]::FullControl){throw 'TCH_PRIVATE_ACL'}
}
function AssertDigestFile([string]$file,[string]$expected,[long]$cap=4194304){
 $bytes=ReadOwnBytes $file $cap;$h=[Security.Cryptography.SHA256]::Create()
 try{$actual=([BitConverter]::ToString($h.ComputeHash($bytes))).Replace('-','').ToLowerInvariant();if($actual-cne$expected){throw 'TCH_PIN'}}finally{$h.Dispose()}
 return ,$bytes
}
function ReadRevokeClosure([string]$source){
 $match=[regex]::Match($source,'REVOKER_FILES=(\[[^\r\n]+\])');if(-not$match.Success){throw 'TCH_REVOKER_CLOSURE'}
 # PS5.1 ConvertFrom-Json writes an array as ONE pipeline object. Wrapping that
 # pipeline in @() nests it, so membership checks see Object[] instead of paths.
 $parsed=$match.Groups[1].Value|ConvertFrom-Json;if($parsed-isnot[Array]-or$parsed.Count-lt3-or$parsed.Count-gt192){throw 'TCH_REVOKER_CLOSURE'}
 $names=New-Object 'Collections.Generic.List[string]';$unique=New-Object 'Collections.Generic.HashSet[string]'
 foreach($name in $parsed){if($name-isnot[string]-or-not$name-or$name-match'(^|/)(\.|\.\.)(/|$)|[\\:]'-or-not$unique.Add($name)){throw 'TCH_REVOKER_CLOSURE'};$names.Add($name)}
 return ,($names.ToArray())
}
function AssertSourcePins([bool]$revokeOnly=$false) {
 $seen=New-Object 'Collections.Generic.HashSet[string]'
 foreach($entry in $config.sourcePins){if($entry.path-match'(^|/)(\.|\.\.)(/|$)|[\\:]'-or-not$seen.Add($entry.path)){throw 'TCH_SOURCE_PATH'}}
 if($revokeOnly){
  $entry=@($config.sourcePins|Where-Object{$_.path-ceq'runtime/teaching-cycle/teaching-revoker.mjs'});if($entry.Count-ne1){throw 'TCH_REVOKER_CLOSURE'}
  $source=[Text.Encoding]::UTF8.GetString((AssertDigestFile (Join-Path $config.sourceRoot $entry[0].path) $entry[0].sha256));$required=ReadRevokeClosure $source
  foreach($own in @('runtime/teaching-cycle/Invoke-TeachingCycle.ps1','runtime/teaching-cycle/teaching-native-worker.mjs','runtime/teaching-cycle/teaching-revoker.mjs')){if($own-cnotin$required){throw 'TCH_REVOKER_CLOSURE'}}
 }else{$required=@($config.sourcePins|ForEach-Object{$_.path});foreach($own in @('runtime/teaching-cycle/Invoke-TeachingCycle.ps1','runtime/teaching-cycle/teaching-native-worker.mjs','runtime/teaching-cycle/teaching-host-bindings.mjs','runtime/teaching-cycle/teaching-revoker.mjs','src/teaching-cycle-build.ts')){if(-not$seen.Contains($own)){throw 'TCH_SOURCE_PIN'}}}
 foreach($name in $required){if(-not$seen.Contains($name)){throw 'TCH_SOURCE_PIN'};$entry=@($config.sourcePins|Where-Object{$_.path-ceq$name});$null=AssertDigestFile (Join-Path $config.sourceRoot $name) $entry[0].sha256}
 if([IO.Path]::GetFullPath($PSCommandPath)-cne[IO.Path]::GetFullPath((Join-Path $config.sourceRoot 'runtime/teaching-cycle/Invoke-TeachingCycle.ps1'))){throw 'TCH_ENTRY_PIN'}
 if([IO.Path]::GetFullPath([Diagnostics.Process]::GetCurrentProcess().MainModule.FileName).ToLowerInvariant()-cne[IO.Path]::GetFullPath($config.launcher.shellPath).ToLowerInvariant()){throw 'TCH_SHELL'}
 $null=AssertDigestFile $config.launcher.nodePath $config.launcher.nodeSha256 134217728;$null=AssertDigestFile $config.launcher.shellPath $config.launcher.shellSha256 134217728
}
function AssertCustodyPaths {
 $training=[IO.Path]::GetFullPath($config.approvedTrainingRoot).TrimEnd('\');$control=[IO.Path]::GetFullPath($config.controlRoot).TrimEnd('\')
 if($control.Equals($training,[StringComparison]::OrdinalIgnoreCase)-or$control.StartsWith($training+'\',[StringComparison]::OrdinalIgnoreCase)-or$training.StartsWith($control+'\',[StringComparison]::OrdinalIgnoreCase)){throw 'TCH_CUSTODY'}
 $runtime=@($config.cycle.runtimeRoot)+@($config.children|ForEach-Object{$_.production.runtimeRoot;$_.audit.runtimeRoot})
 $files=@($config.cycle.authorityPath)+@($config.children|ForEach-Object{$_.production.authorityPath;$_.audit.authorityPath;$_.audit.grantPath;$_.archive.grantPath})
 foreach($p in $runtime){if(-not[IO.Path]::GetFullPath($p).StartsWith($training+'\',[StringComparison]::OrdinalIgnoreCase)){throw 'TCH_CUSTODY'}}
 foreach($p in $files){if(-not[IO.Path]::GetFullPath($p).StartsWith($control+'\',[StringComparison]::OrdinalIgnoreCase)){throw 'TCH_CUSTODY'}}
 if([IO.Path]::GetFullPath($config.launcher.credentialsDpapiPath).StartsWith($training+'\',[StringComparison]::OrdinalIgnoreCase)-or[IO.Path]::GetExtension($config.launcher.credentialsDpapiPath)-cne'.dpapi'){throw 'TCH_CREDENTIAL_PATH'}
 foreach($p in @($training,$control,$config.launcher.credentialsDpapiPath)+$runtime+$files){
  if(-not[IO.Path]::IsPathRooted($p)-or$p-match'(^|[\\/])OneDrive(?:\s|[\\/]|$)'){throw 'TCH_CUSTODY'}
  # Hidden ancestors still require the same reparse check; -Force exposes their metadata.
  $part=[IO.Path]::GetFullPath($p);while($part){if(Test-Path -LiteralPath $part){$item=Get-Item -LiteralPath $part -Force;if(($item.Attributes-band[IO.FileAttributes]::ReparsePoint)-ne0){throw 'TCH_CUSTODY'}};$part=[IO.Path]::GetDirectoryName($part)}
 }
}
function ReadDpapi([string]$file,[int]$limit){
 if([IO.Path]::GetExtension($file)-cne'.dpapi'){throw 'TCH_DPAPI_PATH'};$wrapped=ReadOwnBytes $file 65536
 try{$plain=[Security.Cryptography.ProtectedData]::Unprotect($wrapped,$null,[Security.Cryptography.DataProtectionScope]::CurrentUser);if($plain.Length-gt$limit){[Array]::Clear($plain,0,$plain.Length);throw 'TCH_DPAPI_SIZE'};return ,$plain}finally{[Array]::Clear($wrapped,0,$wrapped.Length)}
}
function AssertRootAction {
 $r=[Text.Encoding]::UTF8.GetString((AssertDigestFile $config.admission.rootRecord.path $config.admission.rootRecord.sha256))|ConvertFrom-Json
 $now=[DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
 if($r.version-cne'TeachingCycleRootAdmission/0.1'-or$r.cycleId-cne$config.cycle.spec.cycleId-or$r.planDigest-cne$config.cycle.spec.planDigest-or$now-lt$r.validFrom-or$now-ge$r.expiresAt){throw 'TCH_ROOT_ADMISSION'}
 $required=@('METADATA_READ','RETAIN');if($Action-cin@('Run','Resume','Initialize')){$required+=@('GENERATE','QA')};if($Action-ceq'Resume'){$required+='RESUME'}
 foreach($permission in $required){if($permission-cnotin@($r.approvedActions)){throw 'TCH_ROOT_ACTION'}}
}
function AssertFields($value,[string[]]$fields){if($null-eq$value-or(@($value.PSObject.Properties.Name|Sort-Object)-join'|')-cne(@($fields|Sort-Object)-join'|')){throw 'TCH_REPORT_SCHEMA'}}
function AssertReportNumber($value,[string]$field='',[int]$depth=0){
 if($depth-gt16){throw 'TCH_REPORT_LIMIT'}
 if($null-eq$value-or$value-is[bool]){return}
 if($value-is[string]){if($value.Length-gt256){throw 'TCH_REPORT_LIMIT'};return}
 if($value-is[System.ValueType]){$n=[double]$value;if([double]::IsNaN($n)-or[double]::IsInfinity($n)-or$n-lt0-or$n-gt9007199254740991-or($field-cne'qualifiedTrainLossTokensPerMinute'-and$n-ne[Math]::Floor($n))){throw 'TCH_REPORT_NUMBER'};return}
 if($value-is[Array]){if($value.Count-gt1024){throw 'TCH_REPORT_LIMIT'};foreach($v in $value){AssertReportNumber $v $field ($depth+1)};return}
 if(@($value.PSObject.Properties).Count-gt64){throw 'TCH_REPORT_LIMIT'};foreach($p in $value.PSObject.Properties){AssertReportNumber $p.Value $p.Name ($depth+1)}
}
function AssertReport($result){
 AssertFields $result @('version','cycleId','action','report')
 if($result.version-cne'TeachingNativeResult/0.1'-or$result.cycleId-cne$config.cycle.spec.cycleId){throw 'TCH_RESULT'}
 $r=$result.report;AssertFields $r @('version','cycleId','status','verification','publication','bindings','qualified','usage','generation','timing','observedNativePeakConcurrency','observedHostPeakRss','evidenceClass','factualTruth','comparison','trainingReady','trainingJobPolicy','reportDigest')
 AssertFields $r.bindings @('buildDigest','specDigest','planDigest','stateDigest','head','sequence','indexDigests','measurementDigest','accountingDigest','assemblyDigest')
 if($r.version-cne'TeachingCycleReport/0.2'-or$r.cycleId-cne$config.cycle.spec.cycleId-or$r.verification-cne'CURRENT_PROCESS_VERIFIED'-or$r.publication-cne'INDEPENDENT_COLD_REQUIRED'-or$r.trainingReady-ne$false-or$r.trainingJobPolicy-cne'NOT_AUTHORIZED'-or$r.reportDigest-cnotmatch'^[a-f0-9]{64}$'){throw 'TCH_REPORT'}
 foreach($name in @('buildDigest','specDigest','planDigest','stateDigest','head','measurementDigest','accountingDigest')){if($r.bindings.$name-cnotmatch'^[a-f0-9]{64}$'){throw 'TCH_REPORT'}}
 if($r.status-cnotin@('INCOMPLETE','COMPLETE_INDEX_CANDIDATE')-or$r.bindings.buildDigest-cne$config.cycle.spec.buildDigest-or$r.bindings.planDigest-cne$config.cycle.spec.planDigest){throw 'TCH_REPORT'}
 if($null-ne$r.bindings.assemblyDigest-and$r.bindings.assemblyDigest-cnotmatch'^[a-f0-9]{64}$'){throw 'TCH_REPORT'}
 foreach($value in $r.bindings.indexDigests){if($value-cnotmatch'^[a-f0-9]{64}$'){throw 'TCH_REPORT'}}
 if($null-ne$r.qualified){
  AssertFields $r.qualified @('tokenizerProfileDigest','train','dev','allSelected','joinedMeasurementDigest','excluded')
  foreach($name in @('tokenizerProfileDigest','joinedMeasurementDigest')){if($r.qualified.$name-cnotmatch'^[a-f0-9]{64}$'){throw 'TCH_REPORT'}}
  foreach($name in @('train','dev','allSelected')){AssertFields $r.qualified.$name @('rows','studentInputTokens','studentLossTokens','fullTokens');foreach($p in $r.qualified.$name.PSObject.Properties){if($p.Value-is[string]-or$p.Value-is[bool]-or$null-eq$p.Value){throw 'TCH_REPORT_NUMBER'}}}
  AssertFields $r.qualified.excluded @('rows','qaRejected','qaHeldOrUncertain','duplicateRows','crossSplitFamilyHoldRows','reasonCountsMayOverlap')
 }
 AssertFields $r.usage @('scope','complete','production','qa','total')
 foreach($name in @('production','qa','total')){
  AssertFields $r.usage.$name @('total','reported','unreported','invalid','unavailable','remoteUnknown','pending','known429','knownInputTokens','knownCompletionTokens','inputTokens','completionTokens')
  foreach($p in $r.usage.$name.PSObject.Properties){if($p.Value-is[string]-or$p.Value-is[bool]-or($null-eq$p.Value-and$p.Name-cnotin@('inputTokens','completionTokens'))){throw 'TCH_REPORT_NUMBER'}}
 }
 AssertFields $r.generation @('childrenAccounted','quarantined')
 AssertFields $r.timing @('boundary','evidence','startedAt','completedAt','elapsedMs','qualifiedTrainLossTokensPerMinute','independentColdVerificationMs')
 if($r.timing.boundary-cne'CYCLE_START_TO_FINAL_INDEX_BARRIER'-or$r.timing.evidence-cne'TRUSTED_HOST_CLOCK_OBSERVATIONS'){throw 'TCH_REPORT'}
 foreach($name in @('startedAt','completedAt','elapsedMs','qualifiedTrainLossTokensPerMinute','independentColdVerificationMs')){if($r.timing.$name-is[string]-or$r.timing.$name-is[bool]){throw 'TCH_REPORT_NUMBER'}}
 AssertReportNumber $r
}

try{
 $bytes=AssertDigestFile $ConfigPath $ConfigSha256;$config=[Text.Encoding]::UTF8.GetString($bytes).TrimStart([char]0xfeff)|ConvertFrom-Json
 if($config.version-cne'TeachingCycleHostConfig/0.1'-or$config.environment-cnotin@('PRODUCTION_NATIVE','SYNTHETIC_FIXTURE')){throw 'TCH_CONFIG'}
 $oncePath=Join-Path $config.controlRoot 'run-once.intent.json'
 # The repeated Run path cannot launch even a preflight worker or read any secret.
 if($Action-ceq'Run'-and(Test-Path -LiteralPath $oncePath)){[ordered]@{version='TeachingDuplicateSafe/0.1';status='REFUSED_ALREADY_CONSUMED';cycleId=$config.cycle.spec.cycleId;newWorkers=0;keyReads=0;credentialReads=0;providerCalls=0;automaticRetry=$false}|ConvertTo-Json -Compress;exit 0}
 if($PSVersionTable.PSEdition-cne'Desktop'-or$PSVersionTable.PSVersion.Major-ne5){throw 'TCH_WINDOWS_ENGINE'}
 # This deployment's actual custody gate; portable core still takes an explicit root.
 $approvedActual='D:\'+[char]0x5174+[char]0x8da3+[char]0x5f00+[char]0x53d1+'\AI\Training_0'
 if($config.environment-ceq'PRODUCTION_NATIVE'-and[IO.Path]::GetFullPath($config.approvedTrainingRoot)-cne$approvedActual){throw 'TCH_APPROVED_ROOT'}
 $phase='CUSTODY_PATHS';AssertCustodyPaths
 $phase='SOURCE_PINS';AssertSourcePins ($Action-ceq'Revoke')
 if($Action-cne'Revoke'){$phase='ROOT_ADMISSION';AssertRootAction}
 Add-Type -AssemblyName System.Security
 Add-Type -TypeDefinition @'
using System;
using System.IO;
using System.Text;
using System.Threading.Tasks;
using System.Runtime.InteropServices;
public sealed class TeachingOwnedJob : IDisposable {
 [StructLayout(LayoutKind.Sequential)] struct BasicLimits { public long PerProcess,PerJob; public uint Flags; public UIntPtr Min,Max; public uint Active; public UIntPtr Affinity; public uint Priority,Scheduling; }
 [StructLayout(LayoutKind.Sequential)] struct IO { public ulong Read,Write,Other,ReadBytes,WriteBytes,OtherBytes; }
 [StructLayout(LayoutKind.Sequential)] struct Extended { public BasicLimits Basic; public IO Io; public UIntPtr ProcessMemory,JobMemory,PeakProcessMemory,PeakJobMemory; }
 [StructLayout(LayoutKind.Sequential)] struct Accounting { public long User,Kernel,PeriodUser,PeriodKernel; public uint Faults,Total,Active,Terminated; }
 [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern IntPtr CreateJobObject(IntPtr attr,string name);
 [DllImport("kernel32.dll",SetLastError=true)] static extern bool SetInformationJobObject(IntPtr job,int info,IntPtr data,uint size);
 [DllImport("kernel32.dll",SetLastError=true)] static extern bool QueryInformationJobObject(IntPtr job,int info,IntPtr data,uint size,IntPtr length);
 [DllImport("kernel32.dll",SetLastError=true)] static extern bool AssignProcessToJobObject(IntPtr job,IntPtr process);
 [DllImport("kernel32.dll",SetLastError=true)] static extern bool TerminateJobObject(IntPtr job,uint exitCode);
 [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
 IntPtr handle;
 public TeachingOwnedJob(){handle=CreateJobObject(IntPtr.Zero,null);if(handle==IntPtr.Zero)throw new Exception("TCH_JOB_CREATE");var v=new Extended();v.Basic.Flags=0x2000;int n=Marshal.SizeOf(v);IntPtr p=Marshal.AllocHGlobal(n);try{Marshal.StructureToPtr(v,p,false);if(!SetInformationJobObject(handle,9,p,(uint)n))throw new Exception("TCH_JOB_LIMIT");}catch{CloseHandle(handle);handle=IntPtr.Zero;throw;}finally{Marshal.FreeHGlobal(p);}}
 public void Assign(IntPtr process){if(!AssignProcessToJobObject(handle,process))throw new Exception("TCH_JOB_ASSIGN");}
 public uint Active(){int n=Marshal.SizeOf(typeof(Accounting));IntPtr p=Marshal.AllocHGlobal(n);try{if(!QueryInformationJobObject(handle,1,p,(uint)n,IntPtr.Zero))throw new Exception("TCH_JOB_QUERY");return ((Accounting)Marshal.PtrToStructure(p,typeof(Accounting))).Active;}finally{Marshal.FreeHGlobal(p);}}
 public void Stop(){if(!TerminateJobObject(handle,1))throw new Exception("TCH_JOB_STOP");}
 public void Dispose(){if(handle!=IntPtr.Zero){CloseHandle(handle);handle=IntPtr.Zero;}}
 public static async Task<string> Read(StreamReader reader,int cap){var text=new StringBuilder();var chars=new char[256];int n;try{while((n=await reader.ReadAsync(chars,0,chars.Length))>0){if(text.Length+n>cap)throw new Exception("TCH_PIPE_LIMIT");text.Append(chars,0,n);}return text.ToString();}finally{Array.Clear(chars,0,chars.Length);}}
}
'@
 function InvokeTeachingWorker([string]$workerAction,$secret,$auth){
  if($workerAction-ceq'revoke'){AssertSourcePins $true}
  $start=New-Object Diagnostics.ProcessStartInfo;$start.FileName=$config.launcher.nodePath;$start.Arguments='"'+(Join-Path $config.sourceRoot 'runtime/teaching-cycle/teaching-native-worker.mjs')+'" --private-worker';$start.WorkingDirectory=$config.sourceRoot
  $start.UseShellExecute=$false;$start.CreateNoWindow=$true;$start.RedirectStandardInput=$true;$start.RedirectStandardOutput=$true;$start.RedirectStandardError=$true
  $start.StandardOutputEncoding=New-Object Text.UTF8Encoding($false,$true);$start.StandardErrorEncoding=New-Object Text.UTF8Encoding($false,$true)
  $start.EnvironmentVariables.Clear();foreach($name in @('SystemRoot','WINDIR','TEMP','TMP','LOCALAPPDATA')){$v=[Environment]::GetEnvironmentVariable($name);if($v){$start.EnvironmentVariables[$name]=$v}}
  $start.EnvironmentVariables['PATH']=Split-Path -Parent $config.launcher.nodePath;$start.EnvironmentVariables['PYTHONDONTWRITEBYTECODE']='1';$start.EnvironmentVariables['HF_HUB_OFFLINE']='1';$start.EnvironmentVariables['TRANSFORMERS_OFFLINE']='1'
  $process=New-Object Diagnostics.Process;$process.StartInfo=$start;$job=New-Object TeachingOwnedJob;$born=$null;$owned=$false;$disposed=$false;$json=$null;$bootstrapBytes=$null
  try{
   $script:workers++;if(-not$process.Start()){throw 'TCH_SPAWN'};$born=$process.StartTime.ToUniversalTime().Ticks;$job.Assign($process.Handle);$owned=$true
   $owner=@{epoch=('windows-'+$process.Id+'-'+$born);process=@{pid=$process.Id;birthId=('windows-ticks-'+$born)};workers=@()}
   $json=[ordered]@{version='TeachingPrivateBootstrap/0.1';action=$workerAction;configPath=$ConfigPath;configSha256=$ConfigSha256;keyBase64=$secret;credentials=$auth;owner=$owner}|ConvertTo-Json -Depth 10 -Compress
   $bootstrapBytes=(New-Object Text.UTF8Encoding($false,$true)).GetBytes($json);$json=$null;if($bootstrapBytes.Length-gt65536){throw 'TCH_PIPE_LIMIT'}
   $output=[TeachingOwnedJob]::Read($process.StandardOutput,1048576);$errors=[TeachingOwnedJob]::Read($process.StandardError,8192);$watch=[Diagnostics.Stopwatch]::StartNew()
   $pipe=$process.StandardInput.BaseStream;$writing=$pipe.WriteAsync($bootstrapBytes,0,$bootstrapBytes.Length);if(-not$writing.Wait(10000)-or$writing.IsFaulted){throw 'TCH_CHILD_UNKNOWN'};$pipe.Flush();$pipe.Close();[Array]::Clear($bootstrapBytes,0,$bootstrapBytes.Length);$bootstrapBytes=$null
   while(-not$process.WaitForExit(100)){if($watch.ElapsedMilliseconds-ge$config.launcher.timeoutMs-or$output.IsFaulted-or$errors.IsFaulted){throw 'TCH_CHILD_UNKNOWN'}}
   if(-not$output.Wait(5000)-or-not$errors.Wait(5000)-or$output.IsFaulted-or$errors.IsFaulted){throw 'TCH_CHILD_UNKNOWN'}
   if($process.StartTime.ToUniversalTime().Ticks-ne$born){throw 'TCH_OWNED_EXIT_UNKNOWN'};$childPid=$process.Id;$childExit=$process.ExitCode
   # Preserve the observed identity/exit, then release the process handle before
   # checking job accounting (terminated references can keep its count nonzero).
   $process.Dispose();$disposed=$true;$exitWatch=[Diagnostics.Stopwatch]::StartNew();while($job.Active()-ne0-and$exitWatch.ElapsedMilliseconds-lt5000){Start-Sleep -Milliseconds 20}
   if($job.Active()-ne0){throw 'TCH_OWNED_EXIT_UNKNOWN'}
   $receipt=@{pid=$childPid;birthId=('windows-ticks-'+$born);exitCode=$childExit;allOwnedProcessesExited=$true};if($workerAction-cin@('run','resume')){$script:executionExit=$receipt}
   if($errors.Result-and$errors.Result-notmatch'(?s)^\(node:\d+\) ExperimentalWarning: SQLite is an experimental feature and might change at any time\r?\n\(Use `node --trace-warnings \.\.\.` to show where the warning was created\)\r?\n$'){throw 'TCH_STDERR'}
   if($childExit-ne0){throw 'TCH_WORKER_REFUSED'}
   $value=$output.Result|ConvertFrom-Json
   if($workerAction-ceq'revoke'){AssertFields $value @('version','cycleId','head','providerCalls');if($value.version-cne'TeachingCycleRevoked/0.1'-or$value.cycleId-cne$config.cycle.spec.cycleId-or$value.providerCalls-ne0-or($null-ne$value.head-and$value.head-cnotmatch'^[a-f0-9]{64}$')){throw 'TCH_REVOKE_UNKNOWN'}}
   return @{value=$value;process=$receipt}
  }finally{
   $json=$null;if($null-ne$bootstrapBytes){[Array]::Clear($bootstrapBytes,0,$bootstrapBytes.Length)}
   if($null-ne$born){if($owned){if($job.Active()-ne0){try{$job.Stop();if(-not$disposed){$null=$process.WaitForExit(5000)}}catch{}}}elseif(-not$disposed-and-not$process.HasExited){try{$process.Kill();$null=$process.WaitForExit(5000)}catch{}}}
   $job.Dispose();if(-not$disposed){$process.Dispose()}
  }
 }
 if($Action-ceq'Initialize'){
  $phase='NEW_CUSTODY';NewPrivateDirectory $config.controlRoot
  foreach($root in @($config.cycle.runtimeRoot)+@($config.children|ForEach-Object{$_.production.runtimeRoot;$_.audit.runtimeRoot})){NewPrivateDirectory $root}
  $key=New-Object byte[] 32;$rng=[Security.Cryptography.RandomNumberGenerator]::Create();try{$rng.GetBytes($key)}finally{$rng.Dispose()}
  $wrapped=[Security.Cryptography.ProtectedData]::Protect($key,$null,[Security.Cryptography.DataProtectionScope]::CurrentUser)
  try{WriteNewBytes (Join-Path $config.controlRoot 'custody.dpapi') $wrapped}finally{[Array]::Clear($wrapped,0,$wrapped.Length)}
  $result=(InvokeTeachingWorker 'initialize' $null $null).value
 }elseif($Action-ceq'Preflight'){$result=(InvokeTeachingWorker 'preflight' $null $null).value}
 elseif($Action-ceq'Revoke'){$revokeAttempted=$true;$result=(InvokeTeachingWorker 'revoke' $null $null).value;$revocation='CONFIRMED'}
 else{
  if($Action-ceq'Run'){$phase='ONCE_CONSUME';$intent=[ordered]@{version='TeachingHostOnce/0.1';cycleId=$config.cycle.spec.cycleId;configSha256=$ConfigSha256;automaticRetry=$false};WriteNewBytes $oncePath ([Text.Encoding]::UTF8.GetBytes(($intent|ConvertTo-Json -Compress)+[char]10));$cleanup=$true}
  if($Action-ceq'Resume'){$intent=[Text.Encoding]::UTF8.GetString((ReadOwnBytes $oncePath 16384))|ConvertFrom-Json;if($intent.version-cne'TeachingHostOnce/0.1'-or$intent.cycleId-cne$config.cycle.spec.cycleId-or$intent.configSha256-cne$ConfigSha256){throw 'TCH_ONCE'};$cleanup=$true}
  $phase='KEY_UNWRAP';$keyReads++;$key=ReadDpapi (Join-Path $config.controlRoot 'custody.dpapi') 32;if($key.Length-ne32){throw 'TCH_KEY'}
  if($Action-cin@('Run','Resume')){
   $phase='SCOPED_CREDENTIALS';$credentialReads++;$credentialBytes=ReadDpapi $config.launcher.credentialsDpapiPath 32768;$credentials=[Text.Encoding]::UTF8.GetString($credentialBytes)|ConvertFrom-Json;AssertFields $credentials @('deepseek','together')
   $phase='RUN';$workerAction=if($Action-ceq'Resume'){'resume'}else{'run'};$run=InvokeTeachingWorker $workerAction ([Convert]::ToBase64String($key)) $credentials;AssertReport $run.value
   $credentials=$null;[Array]::Clear($credentialBytes,0,$credentialBytes.Length);$credentialBytes=$null
   if($run.value.report.status-cne'COMPLETE_INDEX_CANDIDATE'){throw 'TCH_INCOMPLETE_OR_UNKNOWN'};$terminal=$true
   $phase='REVOKE_CYCLE_ONLY';$revokeAttempted=$true;$null=InvokeTeachingWorker 'revoke' $null $null;$revocation='CONFIRMED';$cleanup=$false
   $phase='INDEPENDENT_COLD';$cold=InvokeTeachingWorker 'verify-report' ([Convert]::ToBase64String($key)) $null;AssertReport $cold.value
   if($run.process.pid-eq$cold.process.pid-and$run.process.birthId-ceq$cold.process.birthId){throw 'TCH_COLD_IDENTITY'}
   if($run.value.report.reportDigest-cne$cold.value.report.reportDigest-or($run.value.report|ConvertTo-Json -Depth 30 -Compress)-cne($cold.value.report|ConvertTo-Json -Depth 30 -Compress)){throw 'TCH_COLD_MISMATCH'}
   $r=$cold.value.report;if($r.status-cne'COMPLETE_INDEX_CANDIDATE'-or$null-eq$r.qualified-or$r.usage.total.remoteUnknown-ne0-or$r.usage.total.pending-ne0){throw 'TCH_INCOMPLETE_OR_UNKNOWN'}
   $result=[ordered]@{version='TeachingFinalColdResult/0.1';status='FINAL_COLD_VERIFIED';cycleId=$r.cycleId;configSha256=$ConfigSha256;runProcess=$run.process;coldProcess=$cold.process;report=$r;trainingReady=$false;automaticRetry=$false}
  }else{$phase='COLD_ONLY';$cold=InvokeTeachingWorker 'verify-report' ([Convert]::ToBase64String($key)) $null;AssertReport $cold.value;$result=[ordered]@{version='TeachingColdInspection/0.1';status='INDEPENDENT_INSPECTION_ONLY';process=$cold.process;report=$cold.value.report;publication='RUN_COMPARISON_REQUIRED'}}
 }
 $phase='SAFE_RESULT';$result|ConvertTo-Json -Depth 35 -Compress
}catch{
 $failurePhase=$phase
 if($cleanup){
  if($null-ne$executionExit-and-not$terminal-and$failurePhase-ceq'RUN'){$revocation='NOT_REQUESTED_CONFIRMED_EXIT'}
  elseif(-not$revokeAttempted){$revokeAttempted=$true;try{$null=InvokeTeachingWorker 'revoke' $null $null;$revocation='CONFIRMED'}catch{$revocation='NOT_CONFIRMED'}}
  $cleanup=$false
 }
 if($revokeAttempted-and$revocation-cne'CONFIRMED'){$revocation='NOT_CONFIRMED'}
 if($Action-ceq'Revoke'-and$revocation-cne'CONFIRMED'){$revocation='NOT_CONFIRMED'}
 $exitEvidence=if($null-ne$executionExit){'CONFIRMED'}else{'NOT_CLAIMED_ON_FAILURE'}
 [ordered]@{version='TeachingLauncherFailure/0.1';status='REFUSED_OR_UNKNOWN';phase=$failurePhase;newWorkers=$workers;keyReads=$keyReads;credentialReads=$credentialReads;providerCalls=$null;automaticRetry=$false;rawErrorPrinted=$false;ownedExit=$exitEvidence;executionProcess=$executionExit;revocation=$revocation}|ConvertTo-Json -Depth 5 -Compress
 exit 1
}finally{
 if($null-ne$key){[Array]::Clear($key,0,$key.Length)};if($null-ne$credentialBytes){[Array]::Clear($credentialBytes,0,$credentialBytes.Length)};$credentials=$null
}
