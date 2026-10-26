import assert from 'node:assert/strict';
import { SceneContract } from './scene.ts';
import { sceneFixture } from './scene-fixtures.ts';

const fixture=sceneFixture(),contract=new SceneContract(JSON.stringify(fixture.catalog));
const result=contract.read(JSON.stringify(fixture.packet));
const encoded=contract.export(JSON.stringify(fixture.packet));
assert.deepEqual(contract.import(encoded),result);
assert.equal(result.assurance,'NOT_AUTHENTICATED');
assert.equal(Object.isFrozen(result.packet.claims[0]!.value),true);
console.log(JSON.stringify({status:'SCENE_CONTRACT_PASS',objects:result.packet.objects.length,
  claims:result.packet.claims.length,relations:result.packet.relations.length,anchors:result.packet.anchors.length,
  envelopeBytes:Buffer.byteLength(encoded,'utf8'),sourceAuthority:result.assurance,
  perception:'PERCEPTION_NOT_RUN',quality:'SEMANTIC_QUALITY_NOT_EVALUATED',production:'PRODUCTION_NOT_CONNECTED',
  compression:'COMPRESSION_NOT_RUN',decoder:'DECODER_NOT_RUN'}));
