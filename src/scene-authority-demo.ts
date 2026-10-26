import assert from 'node:assert/strict';
import { MemoryStore } from './store.ts';
import { SceneAuthorityService } from './scene-authority.ts';
import type { SceneCatalog, ScenePacket } from './scene.ts';

const store=new MemoryStore(':memory:',{clock:{wall:()=>100_000,monotonic:()=>0}});
try {
  const scope=store.ensureScope({tenantId:'synthetic',subjectId:'subject',personaId:'demo',relationshipId:'demo'});
  const accepted=store.acceptEvent(scope,{source:'synthetic',eventKey:'scene-demo',evidence:{speakerId:'subject',speakerRole:'subject',
    mode:'self_report',selectedText:'Synthetic selected evidence; not a real observation.',occurredAt:null}});
  const source={id:accepted.id,revision:accepted.revision},job=store.beginJob(scope,[source]),lease=store.claimLease(scope,job.id);
  store.propose(scope,job.id,lease.token,{kind:'claim',basis:'self_report',statement:'Synthetic published memory.',validFrom:null,validTo:null});
  const memory={id:store.publish(scope,job.id,lease.token).id,revision:1},epoch={generation:scope.generation,consentRevision:scope.consentRevision};
  const catalog:SceneCatalog={version:2,concepts:[],mappingProfiles:[],prototypes:[],declaredSources:[{ref:source,scopeRef:scope.id,epoch,kind:'report'}]};
  const packet:ScenePacket={version:2,ref:{id:'scene',revision:1},scopeRef:scope.id,epoch,occurredAt:null,recordedAt:100_000,
    applicability:{from:null,to:null},sourceRefs:[source],tracks:[],objects:[{id:'item',typeClaim:{id:'type',revision:1},
      identityClaim:null,trackRef:null,attributeClaims:[]}],claims:[{id:'type',revision:1,kind:'classification',subject:'item',predicate:null,
      value:{kind:'unknown',reason:'not_observed'},origin:'report',verification:'not_verified',sourceRefs:[source],occurredAt:null}],
    relations:[],anchors:[],geometry:{kind:'unknown'},residuals:[]};
  const service=new SceneAuthorityService(store),binding=service.bind({epoch:{id:scope.id,...epoch},publishedRefs:[memory],catalogJson:JSON.stringify(catalog)});
  const consumers=[service.register(binding),service.register(binding)];
  const resets=consumers.map(consumer=>service.pull(binding,consumer)!);
  service.stage(binding,JSON.stringify(packet));
  for(const [i,consumer] of consumers.entries()) {
    assert.equal(service.pull(binding,consumer)!.frame,resets[i]!.frame);service.acknowledge(binding,consumer,resets[i]!.frame);
  }
  const fast=consumers[0]!,slow=consumers[1]!,first=service.pull(binding,fast)!;
  assert.ok('data' in service.resolve(binding,fast,first.frame));service.acknowledge(binding,fast,first.frame);
  packet.ref.revision=2;service.stage(binding,JSON.stringify(packet));
  const latest=service.pull(binding,slow)!;assert.equal(latest.info.revision,2);
  assert.ok('data' in service.resolve(binding,slow,latest.frame));service.acknowledge(binding,slow,latest.frame);
  store.revoke(scope,source);let rejected=false;
  try {service.read(binding);}catch {rejected=true;}assert.equal(rejected,true);
  for(const consumer of consumers){const frame=service.pull(binding,consumer)!;assert.equal(frame.info.operation,'reset');
    assert.deepEqual(Object.keys(service.resolve(binding,consumer,frame.frame)),['info']);service.acknowledge(binding,consumer,frame.frame);}
  console.log(JSON.stringify({status:'SCENE_AUTHORITY_PASS',consumers:2,latestRevision:2,revokedReadRejected:true,cleanupResets:2,
    sourceAssurance:'CURRENT_STORE_SOURCE_BOUND',claimAssurance:'NOT_VERIFIED',quality:'NOT_EVALUATED',
    consumerState:'RAM_ONLY',durableFanout:'NOT_IMPLEMENTED',scenePersistence:'NOT_IMPLEMENTED',realModelCalls:0,productionData:false}));
} finally {store.close();}
