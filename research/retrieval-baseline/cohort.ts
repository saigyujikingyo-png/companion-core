import type { SyntheticDocument } from './fixture.ts';

export type GoldQuery = Readonly<{id:string;text:string;status:'supported'|'unknown'|'conflict';
  relevantOrdinals:readonly number[];exactLiteral?:string;conflictSides?:readonly [number,number]}>;
export type SyntheticFamily = Readonly<{id:string;documents:readonly SyntheticDocument[];queries:readonly GoldQuery[]}>;

// Fixed before first formal run: eight families x two queries. No random sampling,
// score-dependent labels, learned annotations or replacement after seeing results.
// Gold and exact literals are consumed only by evaluation, never by rankBm25.
export const COHORT:readonly SyntheticFamily[]=[
  {id:'frequency-length-tie',documents:[
    {root:0,statement:'cobalt cobalt cobalt lamp'},
    {root:1,statement:'cobalt lamp beside the tall window with a long plain curtain'},
    {root:2,statement:'silver bell'},{root:3,statement:'silver bell'}],queries:[
    {id:'tf-length',text:'cobalt lamp',status:'supported',relevantOrdinals:[0,1]},
    {id:'stable-tie',text:'silver bell',status:'supported',relevantOrdinals:[2,3]}]},
  {id:'rare-identifiers',documents:[
    {root:0,statement:'device ZXQ917 uses amber seal'},
    {root:1,statement:'device ZXQ918 uses violet seal'},
    {root:2,statement:'device ZXQ-917 uses copper seal'}],queries:[
    {id:'rare-exact',text:'ZXQ917',status:'supported',relevantOrdinals:[0],exactLiteral:'ZXQ917'},
    {id:'hyphen',text:'ZXQ-917',status:'supported',relevantOrdinals:[2],exactLiteral:'ZXQ-917'}]},
  {id:'fully-unknown',documents:[
    {root:0,statement:'garden gate opens east'},{root:1,statement:'kitchen shelf holds cups'}],queries:[
    {id:'unknown-word',text:'quasar',status:'unknown',relevantOrdinals:[]},
    {id:'unknown-number',text:'NVC739',status:'unknown',relevantOrdinals:[],exactLiteral:'NVC739'}]},
  {id:'partially-unknown',documents:[
    {root:0,statement:'device KLM110 has green label'},
    {root:1,statement:'device KLM220 has orange label'},
    {root:2,statement:'parcel PRT100 arrived Tuesday'}],queries:[
    {id:'missing-device',text:'device KLM999',status:'unknown',relevantOrdinals:[],exactLiteral:'KLM999'},
    {id:'missing-parcel',text:'parcel PRT999',status:'unknown',relevantOrdinals:[],exactLiteral:'PRT999'}]},
  {id:'contradiction',documents:[
    {root:0,statement:'object ORB61 is waterproof'},
    {root:1,statement:'object ORB61 is not waterproof'},
    {root:2,statement:'object ORB62 is waterproof'}],queries:[
    {id:'object-conflict',text:'ORB61 waterproof',status:'conflict',relevantOrdinals:[0,1],conflictSides:[0,1],exactLiteral:'ORB61'},
    {id:'negative-conflict',text:'ORB61 not waterproof',status:'conflict',relevantOrdinals:[0,1],conflictSides:[0,1]}]},
  {id:'shared-root',documents:[
    {root:0,statement:'expedition ARK77 departs Friday'},
    {root:0,statement:'crew packs a canvas shelter'},
    {root:0,statement:'expedition ARK77 departs Friday'},
    {root:1,statement:'harbor office closes Monday'}],queries:[
    {id:'supplement',text:'ARK77',status:'supported',relevantOrdinals:[0,1,2],exactLiteral:'ARK77'},
    {id:'same-root',text:'canvas shelter',status:'supported',relevantOrdinals:[0,1,2]}]},
  {id:'normalization-chinese',documents:[
    {root:0,statement:'ＱｘＲ４２ ＢＬＵＥ'},{root:1,statement:'qxr43 red'},
    {root:2,statement:'星河站明天开放'},{root:3,statement:'山林站今天关闭'}],queries:[
    {id:'fullwidth-case',text:'qxr42 blue',status:'supported',relevantOrdinals:[0]},
    {id:'chinese-substring',text:'星河站',status:'supported',relevantOrdinals:[2],exactLiteral:'星河站'}]},
  {id:'punctuation-emoji',documents:[
    {root:0,statement:'***'},{root:1,statement:'🙂'},{root:2,statement:'plain note'}],queries:[
    {id:'punctuation-literal',text:'***',status:'supported',relevantOrdinals:[0],exactLiteral:'***'},
    {id:'emoji-literal',text:'🙂',status:'supported',relevantOrdinals:[1],exactLiteral:'🙂'}]},
];
