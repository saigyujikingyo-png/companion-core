import { teachingHostFixture } from '../teaching-cycle-host-fixture.ts';
import { runTeachingCycleCommand } from '../../src/teaching-cycle-cli.ts';
const f=teachingHostFixture(process.argv[2]);
try{process.stdout.write(JSON.stringify(await runTeachingCycleCommand({version:'TeachingCycleCommand/0.2',command:'verify-report',spec:f.options.cycle.spec},f.host.ports)));}finally{f.host.close();}
