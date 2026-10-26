import type { Epoch, Evidence, SourceRef } from './contracts.ts';
import type { Frozen } from './curation-types.ts';
import type { SceneRead } from './scene.ts';

export const SCENE_SOURCE_LIMITS=Object.freeze({selected:32,nodes:128,edges:512,bytes:262_144});
export const SCENE_CONSUMER_LIMIT=8;
export type SceneSourceAuthority=Epoch & {runtimeEpoch:number};
export type SceneSourceSnapshot=Frozen<{
  version:1; authority:SceneSourceAuthority; asOf:number; metadataIdentity:string;
  selected:Array<{ref:SourceRef;rootEventRefs:SourceRef[]}>;
  roots:Array<{ref:SourceRef;mode:Evidence['mode'];speakerRole:Evidence['speakerRole'];occurredAt:number|null;recordedAt:number}>;
  counts:{selected:number;nodes:number;edges:number;bytes:number};
}>;
export type SceneBinding=Readonly<{version:1}>;
export type SceneConsumer=Readonly<{version:1}>;
export type SceneFrame=Readonly<{version:1}>;
export type SceneFrameInfo=Readonly<{operation:'reset'|'replace';barrier:number;revision:number}>;
export type SceneAuthorizedRead=Frozen<{
  view:SceneRead;sourceAssurance:'CURRENT_STORE_SOURCE_BOUND';claimAssurance:'NOT_VERIFIED';
  authority:SceneSourceAuthority;asOf:number;sources:SceneSourceSnapshot['roots'];
}>;
