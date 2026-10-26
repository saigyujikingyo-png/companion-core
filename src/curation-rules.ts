import { createHash } from 'node:crypto';
import { canonical, CURATION_LIMITS, frozenCopy } from './curation-types.ts';
import type { CurationSnapshot, Frozen } from './curation-types.ts';
import { fields, integer, parseJson } from './wire.ts';
import * as v from './validation.ts';

export type CurationPolicy = { version:1; curationVersion:string; annotationVersion:string; selectionVersion:string; cutoff:number };
type Language = 'zh'|'en'|'ja'|'mixed'|'unknown';
type Split = 'train'|'eval'|'quarantine';
type Annotation = { origin:'human'|'synthetic'; claimKey:string|null; polarity:'affirmed'|'negated'|'unspecified';
  condition:string|null; quotation:'direct'|'quotation'|'unknown'; quotationSubject:string|null; uncertain:boolean };
export type CurationRequest = { version:1; rows:Array<{ memoryIndex:number; rootIndex:number; variant:'original'|'translation'|'summary';
  language:Language; split:Split; annotation:Annotation; derivedText?:string }> };
export type CurationReport = Frozen<{ status:'CURATION_LINT_PASS'; quality:'NOT_EVALUATED'; trainingQuality:'NOT_EVALUATED';
  evaluationQuality:'NOT_EVALUATED'; codes:string[]; counts:{ selected:number; roots:number; groups:number; inputRows:number;
  admitted:number; train:number; eval:number; quarantined:number; duplicates:number }; languages:Language[] }>;
const choice = <T extends string>(value:unknown, allowed:readonly T[]):T => {
  if (typeof value !== 'string' || !allowed.includes(value as T)) v.fail('INVALID_WIRE_SHAPE');
  return value as T;
};
function nullableText(value:unknown, empty = false): string|null {
  if (value === null || (empty && value === '')) return value;
  v.text(value, 128); return value;
}
export function curationPolicy(value:CurationPolicy): Frozen<CurationPolicy> {
  const p = fields(value, ['version','curationVersion','annotationVersion','selectionVersion','cutoff']);
  if (p.version !== 1) v.fail('UNSUPPORTED_PROTOCOL');
  for (const key of ['curationVersion','annotationVersion','selectionVersion']) v.text(p[key], 128);
  integer(p.cutoff);
  return frozenCopy({ version:1, curationVersion:p.curationVersion as string, annotationVersion:p.annotationVersion as string,
    selectionVersion:p.selectionVersion as string, cutoff:p.cutoff });
}
export function curationRequest(raw:string): CurationRequest {
  const input = fields(parseJson(raw), ['version','rows']);
  if (input.version !== 1) v.fail('UNSUPPORTED_PROTOCOL');
  if (!Array.isArray(input.rows) || input.rows.length > CURATION_LIMITS.rows) v.fail('CURATION_LIMIT');
  const rows = input.rows.map(value => {
    const r = fields(value, ['memoryIndex','rootIndex','variant','language','split','annotation'], ['derivedText']);
    integer(r.memoryIndex); integer(r.rootIndex);
    const variant = choice(r.variant, ['original','translation','summary']);
    if (variant === 'original' && Object.hasOwn(r, 'derivedText')) v.fail('INVALID_WIRE_SHAPE');
    if (variant !== 'original') v.text(r.derivedText, 4096);
    const a = fields(r.annotation, ['origin','claimKey','polarity','condition','quotation','quotationSubject','uncertain']);
    if (typeof a.uncertain !== 'boolean') v.fail('INVALID_WIRE_SHAPE');
    const annotation:Annotation = { origin:choice(a.origin, ['human','synthetic']), claimKey:nullableText(a.claimKey),
      polarity:choice(a.polarity, ['affirmed','negated','unspecified']), condition:nullableText(a.condition, true),
      quotation:choice(a.quotation, ['direct','quotation','unknown']), quotationSubject:nullableText(a.quotationSubject), uncertain:a.uncertain };
    if (annotation.quotation === 'direct' && annotation.quotationSubject !== null) v.fail('INVALID_WIRE_SHAPE');
    return { memoryIndex:r.memoryIndex, rootIndex:r.rootIndex, variant, language:choice(r.language, ['zh','en','ja','mixed','unknown']),
      split:choice(r.split, ['train','eval','quarantine']), annotation, ...(variant === 'original' ? {} : { derivedText:r.derivedText as string }) };
  });
  return { version:1, rows };
}

/** Pure declaration rules, not an authority entrypoint or a semantic classifier.
 * CurationService always supplies a fresh authenticated Store snapshot first. */
export function curateDeclarations(snapshot:CurationSnapshot, request:CurationRequest, policy:Frozen<CurationPolicy>) {
  const parent = snapshot.selected.map((_, index) => index);
  const find = (index:number):number => parent[index] === index ? index : find(parent[index]!);
  const rootsOwner = new Map<string,number>();
  for (const [index, selected] of snapshot.selected.entries()) for (const ref of selected.rootEventRefs) {
    const owner = rootsOwner.get(ref.id);
    if (owner === undefined) rootsOwner.set(ref.id, index);
    else parent[find(index)] = find(owner);
  }
  type Group = { id:string; memoryIndices:number[]; rootEventRefs:Array<{ id:string; revision:number }>;
    occurredMin:number|null; occurredMax:number|null; split:Split; codes:Set<string>; requested:Set<Split> };
  const groups = new Map<number,Group>(), events = new Map(snapshot.events.map(event => [event.ref.id, event]));
  for (const [index, selected] of snapshot.selected.entries()) {
    const leader = find(index);
    if (!groups.has(leader)) groups.set(leader, { id:'group-' + groups.size, memoryIndices:[], rootEventRefs:[],
      occurredMin:null, occurredMax:null, split:'quarantine', codes:new Set(), requested:new Set() });
    const group = groups.get(leader)!; group.memoryIndices.push(index);
    for (const ref of selected.rootEventRefs) if (!group.rootEventRefs.some(root => root.id === ref.id)) group.rootEventRefs.push({ ...ref });
  }
  for (const group of groups.values()) {
    group.rootEventRefs.sort((a,b) => a.id.localeCompare(b.id));
    const times = group.rootEventRefs.map(ref => events.get(ref.id)!.evidence.occurredAt);
    if (times.some(time => time === null)) group.codes.add('UNKNOWN_EVENT_TIME');
    else {
      group.occurredMin = Math.min(...times as number[]); group.occurredMax = Math.max(...times as number[]);
      if (group.occurredMax < policy.cutoff) group.split = 'train';
      else if (group.occurredMin >= policy.cutoff) group.split = 'eval';
      else group.codes.add('CROSS_CUTOFF_GROUP');
    }
  }
  const rows = request.rows.map((row,index) => {
    const selected = snapshot.selected[row.memoryIndex], ref = selected?.rootEventRefs[row.rootIndex];
    if (!selected || !ref) v.fail('CURATION_SELECTION_INVALID');
    const event = events.get(ref.id)!;
    if (!event || event.ref.revision !== ref.revision) v.fail('CURATION_SOURCE_INVALID');
    const group = groups.get(find(row.memoryIndex))!; group.requested.add(row.split);
    if (row.annotation.condition === null) group.codes.add('UNKNOWN_CONDITION');
    if (row.annotation.quotation === 'unknown' || (row.annotation.quotation === 'quotation' && row.annotation.quotationSubject === null)) group.codes.add('UNRESOLVED_QUOTATION');
    if (event.evidence.mode === 'quotation' && row.annotation.quotation !== 'quotation') group.codes.add('QUOTATION_MODE_MISMATCH');
    // The source actor is never an annotation field. A quoted subject is only a label.
    return { index, groupId:group.id, requestedSplit:row.split, variant:row.variant, language:row.language,
      textKind:row.variant === 'original' ? 'selected_original' as const : 'derived_' + row.variant,
      text:row.variant === 'original' ? event.evidence.selectedText : row.derivedText!, annotation:{ ...row.annotation },
      provenance:{ sourceRef:{ ...ref }, sourceActor:{ id:event.evidence.speakerId, role:event.evidence.speakerRole },
        mode:event.evidence.mode, occurredAt:event.evidence.occurredAt,
        memoryRef:{ id:selected.memory.id, revision:selected.memory.revision }, memoryBasis:selected.memory.basis,
        validFrom:selected.memory.validFrom, validTo:selected.memory.validTo }, group };
  });
  for (const group of groups.values()) {
    if (group.requested.has('train') && group.requested.has('eval')) group.codes.add('GROUP_SPLIT_CONFLICT');
    if (group.requested.has('quarantine')) group.codes.add('REQUESTED_QUARANTINE');
    if ([...group.requested].some(split => split !== 'quarantine' && split !== group.split)) group.codes.add('CHRONOLOGY_MISMATCH');
  }
  // Compare declarations only. Different attribution/quotation/condition/basis
  // remains different; overlap never asserts which declaration is true.
  const claimKey = (row:typeof rows[number]) => canonical([row.provenance.sourceActor, row.provenance.mode,
    row.provenance.memoryBasis, row.annotation.claimKey, row.annotation.condition, row.annotation.quotation, row.annotation.quotationSubject]);
  for (let i = 0; i < rows.length; i++) for (let j = i + 1; j < rows.length; j++) {
    const a = rows[i]!, b = rows[j]!;
    if (a.annotation.claimKey === null || b.annotation.claimKey === null || a.annotation.condition === null || b.annotation.condition === null ||
      a.annotation.uncertain || b.annotation.uncertain || a.annotation.quotation === 'unknown' || b.annotation.quotation === 'unknown' ||
      (a.annotation.quotation === 'quotation' && a.annotation.quotationSubject === null) ||
      (b.annotation.quotation === 'quotation' && b.annotation.quotationSubject === null) || a.annotation.polarity === 'unspecified' ||
      b.annotation.polarity === 'unspecified' || a.annotation.polarity === b.annotation.polarity || claimKey(a) !== claimKey(b)) continue;
    const start = Math.max(a.provenance.validFrom ?? -Infinity, b.provenance.validFrom ?? -Infinity);
    const end = Math.min(a.provenance.validTo ?? Infinity, b.provenance.validTo ?? Infinity);
    if (start < end) { a.group.codes.add('DECLARED_CONTRADICTION'); b.group.codes.add('DECLARED_CONTRADICTION'); }
  }
  const seen = new Set<string>();
  const admittedRows = rows.map(({ group, ...row }) => {
    // Include provenance semantics, but not a redundant derived memory ID or its
    // selector. Evaluate split conflicts first so dedup cannot hide leakage.
    const { memoryRef:_, ...provenance } = row.provenance;
    const key = canonical([row.variant, row.language, row.text, row.annotation, provenance]);
    const duplicate = seen.has(key); seen.add(key);
    const codes = [...group.codes].sort(); if (duplicate) codes.push('DUPLICATE_DECLARATION');
    const split = codes.length ? 'quarantine' as const : group.split;
    return { ...row, split, admission:duplicate ? 'duplicate' as const : codes.length ? 'quarantined' as const : 'admitted' as const, codes };
  });
  const normalizedGroups = [...groups.values()].map(({ codes, requested:_, ...group }) => ({ ...group,
    split:codes.size ? 'quarantine' as const : group.split, codes:[...codes].sort() }));
  const counts = { selected:snapshot.selected.length, roots:snapshot.events.length, groups:groups.size, inputRows:rows.length,
    admitted:admittedRows.filter(row => row.admission === 'admitted').length,
    train:admittedRows.filter(row => row.admission === 'admitted' && row.split === 'train').length,
    eval:admittedRows.filter(row => row.admission === 'admitted' && row.split === 'eval').length,
    quarantined:admittedRows.filter(row => row.admission === 'quarantined').length,
    duplicates:admittedRows.filter(row => row.admission === 'duplicate').length };
  const codes = [...new Set([...normalizedGroups.flatMap(group => group.codes), ...admittedRows.flatMap(row => row.codes)])].sort();
  const report:CurationReport = frozenCopy({ status:'CURATION_LINT_PASS', quality:'NOT_EVALUATED', trainingQuality:'NOT_EVALUATED',
    evaluationQuality:'NOT_EVALUATED', counts, codes, languages:[...new Set(admittedRows.map(row => row.language))].sort() });
  const body = { version:1, kind:'curation_candidate' as const, authority:snapshot.authority, asOf:snapshot.asOf, policy,
    sources:snapshot, rows:admittedRows, groups:normalizedGroups, counts, quality:'NOT_EVALUATED' as const };
  const manifest = frozenCopy({ ...body, manifestDigest:createHash('sha256').update(canonical(body)).digest('hex') });
  return frozenCopy({ manifest, report });
}
export type CurationManifest = ReturnType<typeof curateDeclarations>['manifest'];
