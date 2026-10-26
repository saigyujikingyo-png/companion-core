import { MemoryStore } from './store.ts';
import type { Epoch, SourceRef } from './contracts.ts';
import { canonical, frozenCopy } from './curation-types.ts';
import type { CurationSnapshot, Frozen } from './curation-types.ts';
import { curateDeclarations, curationPolicy, curationRequest } from './curation-rules.ts';
import type { CurationPolicy } from './curation-rules.ts';
import { fail } from './validation.ts';

export type CurationBinding = Readonly<{ version:1 }>;
export type CurationCandidate = Readonly<{ version:1 }>;
type Bound = { epoch:Frozen<Epoch>; refs:Frozen<SourceRef[]>; authority:string; policy:string };
type Candidate = { bound:Bound; snapshot:CurationSnapshot; payload:string; result:ReturnType<typeof curateDeclarations> };
const sourceIdentity = ({ asOf:_, counts:__, ...snapshot }:CurationSnapshot) => canonical(snapshot);

/** Trusted local control plane only. No host/stdio/network route is installed.
 * These capabilities authorize RAM inspection, never training or activation. */
export class CurationService {
  #store:MemoryStore;
  #policy:Frozen<CurationPolicy>;
  #bindings = new WeakMap<CurationBinding,Bound>();
  #candidates = new WeakMap<CurationCandidate,Candidate>();
  constructor(store:MemoryStore, trustedPolicy:CurationPolicy) { this.#store = store; this.#policy = curationPolicy(trustedPolicy); }
  bind(input:{ epoch:Epoch; publishedRefs:SourceRef[] }):CurationBinding {
    const snapshot = this.#store.curationSnapshot(input.epoch, input.publishedRefs);
    const handle:CurationBinding = Object.freeze({ version:1 });
    this.#bindings.set(handle, { epoch:frozenCopy(input.epoch), refs:frozenCopy(input.publishedRefs),
      authority:canonical(snapshot.authority), policy:canonical(this.#policy) });
    return handle;
  }
  #bound(binding:CurationBinding):Bound {
    const bound = this.#bindings.get(binding); if (!bound) fail('UNAUTHENTICATED'); return bound;
  }
  #snapshot(bound:Bound):CurationSnapshot {
    const snapshot = this.#store.curationSnapshot({ ...bound.epoch }, bound.refs.map(ref => ({ ...ref })));
    if (canonical(snapshot.authority) !== bound.authority) fail('CURATION_AUTHORITY_CHANGED');
    if (canonical(this.#policy) !== bound.policy) fail('CURATION_POLICY_CHANGED');
    return snapshot;
  }
  unbind(binding:CurationBinding):void { this.#bound(binding); this.#bindings.delete(binding); }
  lint(binding:CurationBinding, raw:string) {
    const bound = this.#bound(binding), snapshot = this.#snapshot(bound);
    const request = curationRequest(raw), payload = canonical(request);
    const result = curateDeclarations(snapshot, request, this.#policy);
    const candidate:CurationCandidate = Object.freeze({ version:1 });
    this.#candidates.set(candidate, { bound, snapshot, payload, result });
    return Object.freeze({ candidate, ...result });
  }
  revalidate(binding:CurationBinding, candidate:CurationCandidate) {
    // Authority/source/TTL is checked first, even when the previous report admitted zero rows.
    const bound = this.#bound(binding), current = this.#snapshot(bound);
    const saved = this.#candidates.get(candidate);
    if (!saved || saved.bound !== bound) fail('UNAUTHENTICATED');
    if (sourceIdentity(current) !== sourceIdentity(saved.snapshot)) fail('CURATION_SOURCE_CHANGED');
    const result = curateDeclarations(saved.snapshot, curationRequest(saved.payload), this.#policy);
    if (canonical(result) !== canonical(saved.result)) fail('CURATION_CANDIDATE_CHANGED');
    return result;
  }
}
