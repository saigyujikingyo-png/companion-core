import { statSync } from 'node:fs';
import { join } from 'node:path';
import { TrainingJournal, TJ_DISK } from '../../src/training-journal.ts';
import { tjHash, TrainingJournalError } from '../../src/training-journal-format.ts';
import { authority, event, trace } from './training-journal-fixture.ts';

const [mode,directory]=process.argv.slice(2);
if(!directory||!['hold','reopen','locked','denied'].includes(mode??''))process.exit(2);
const options={directory,journalId:'synthetic-journal',authority:()=>({...authority('child-'+mode),read:mode!=='denied'})};
let j:TrainingJournal|undefined;
try {
  j=mode==='hold'?TrainingJournal.create(options):TrainingJournal.open(options);
  if(mode==='hold') {
    for(const raw of trace().slice(0,3))j.append(raw,{codec:'zstd'});
    process.stdout.write(JSON.stringify({ready:true,events:j.status().events,digest:tjHash(j.exportCanonical()),
      lockBytes:statSync(join(directory,TJ_DISK.lockName)).size,journalBytes:statSync(join(directory,TJ_DISK.lockName+'-journal')).size})+'\n');
    // Retain the owning service, including its native SQLite handle, until killed.
    setInterval(()=>{if(j===undefined)process.exitCode=1;},1_000);
  } else if(mode==='reopen') {
    const before=j.status(),duplicate=j.append(event('INTENT',1));
    let conflict=false;try{const bad=JSON.parse(event('INTENT',1));bad.data.purpose='OTHER';j.append(JSON.stringify(bad));}
    catch(error){conflict=error instanceof TrainingJournalError&&error.code==='TJ_CONFLICT';}
    j.append(event('TERMINAL',4,{outcome:'FAILED'}));
    let terminal=false;try{j.append(event('STARTED',5));}catch(error){terminal=error instanceof TrainingJournalError&&error.code==='TJ_TERMINAL';}
    const result={before:before.events,duplicate,conflict,terminal,events:j.status().events,mode:j.status().executionMode,
      steps:j.readAttempt('run-1','attempt-1').projection.optimizerStepsLowerBound,digest:tjHash(j.exportCanonical()),realTraining:false};
    j.close();process.stdout.write(JSON.stringify(result)+'\n');
  } else {j.close();process.stdout.write(JSON.stringify({code:'UNEXPECTED_OPEN'})+'\n');process.exitCode=1;}
}catch(error){j?.close();process.stdout.write(JSON.stringify({code:error instanceof TrainingJournalError?error.code:'CHILD_UNKNOWN'})+'\n');
  if(mode!=='locked'&&mode!=='denied')process.exitCode=1;}
