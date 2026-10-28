import {record} from './durable-codec.ts';
import {fail} from './validation.ts';

export const STORE_COLD_PROFILE='blocks-br4-safety-store-cold-v1' as const;
export const MAX_STORE_COLD=1024*1024;
export const STORE_COLD_POLICY='one-purged-generation-v1' as const;
export type StoreColdDescriptor={version:1;format:'aemc-store-sqlite-v1';schema:1|2;file:string;cipherDigest:string;cipherBytes:number;
  plainDigest:string;plainBytes:number;counts:{nodes:number;ingress:number;dependencies:number}};
export function validateStoreColdDescriptor(value:unknown):asserts value is StoreColdDescriptor{
  if(!record(value)||Object.keys(value).sort().join(',')!=='cipherBytes,cipherDigest,counts,file,format,plainBytes,plainDigest,schema,version'
    ||value.version!==1||value.format!=='aemc-store-sqlite-v1'||![1,2].includes(value.schema)
    ||!['cipherDigest','plainDigest'].every(k=>typeof value[k]==='string'&&/^[a-f0-9]{64}$/.test(value[k]))
    ||value.file!==`store-${value.cipherDigest}.bin`||!Number.isSafeInteger(value.plainBytes)||value.plainBytes<4096||value.plainBytes>MAX_STORE_COLD
    ||value.plainBytes%4096!==0||value.cipherBytes!==value.plainBytes+28||!record(value.counts)
    ||Object.keys(value.counts).sort().join(',')!=='dependencies,ingress,nodes'
    ||!Object.values(value.counts).every(n=>Number.isSafeInteger(n)&&(n as number)>=0)||value.counts.nodes<1)fail('STORE_COLD_DESCRIPTOR');
}
