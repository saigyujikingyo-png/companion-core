import {openSync,closeSync,lstatSync,fstatSync,readSync} from 'node:fs';
import {fail} from './validation.ts';

/** The caller owns a ticket for maximum bytes before entering. Read a fixed
 * allocation through one descriptor; a file that grows cannot grow the buffer. */
export function readSafetyV2File(path:string,maximum:number):Buffer{
 const before=lstatSync(path);if(!before.isFile()||before.isSymbolicLink()||!Number.isSafeInteger(maximum)||maximum<0||before.size>maximum)fail('ANCHOR_FILE');
 const fd=openSync(path,'r');let data:Buffer|undefined;
 try{const opened=fstatSync(fd);if(!opened.isFile()||opened.dev!==before.dev||opened.ino!==before.ino||opened.size!==before.size)fail('ANCHOR_FILE');
  data=Buffer.allocUnsafe(opened.size);let offset=0;while(offset<data.length){const n=readSync(fd,data,offset,data.length-offset,offset);if(n===0)fail('ANCHOR_FILE');offset+=n;}
  const end=fstatSync(fd),after=lstatSync(path),extra=Buffer.alloc(1);if(readSync(fd,extra,0,1,offset)!==0||end.size!==opened.size||after.size!==opened.size||after.dev!==opened.dev||after.ino!==opened.ino||after.isSymbolicLink())fail('ANCHOR_FILE');
  const result=data;data=undefined;return result;
 }finally{data?.fill(0);closeSync(fd);}
}
