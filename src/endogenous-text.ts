import { isPromise } from 'node:util/types';
import { profileDigest, validateHybridProfile } from './hybrid-profile.ts';
import type { HybridProfile } from './hybrid-profile.ts';
import type { EndogenousTextPort, EndogenousTextRequest } from './endogenous-lifecycle.ts';
import type { RawTextMessage, RawTextPort } from './raw-text-http.ts';

const instruction =
  'Choose one bounded internal lifecycle decision. No human input is supplied. ' +
  'Return only a JSON object: {"version":1,"choice":"REST"} or {"version":1,"choice":"NOOP"}, ' +
  'optionally with nextWakeInMs (integer 10..300000), or {"version":1,"choice":"TEXT","text":"..."}. ' +
  'TEXT has no nextWakeInMs and must be at most 160 UTF-8 bytes. The entire JSON must be at most 256 UTF-8 bytes. ' +
  'REST and NOOP need no reason. Text is an assistant expression, never human testimony, a memory proposal, ' +
  'an observation of user presence, an emotion measurement or permission to deliver. Do not invent user facts. ' +
  'Profile identifiers are unverified declarations, not authentication. No tools, appraisal, hidden reasoning or extra fields.';

/** Purpose-specific codec over the shared raw transport, with no second timer or ledger. */
export function createEndogenousTextPort(raw: RawTextPort, declaredProfile: HybridProfile): EndogenousTextPort {
  const profile = validateHybridProfile(declaredProfile),
    digest = profileDigest(profile),
    generate = raw.generate;
  return (request) => {
    const messages: readonly RawTextMessage[] = Object.freeze([
      Object.freeze({ role: 'system' as const, content: instruction }),
      Object.freeze({
        role: 'user' as const,
        content: JSON.stringify({
          version: 1,
          purpose: 'endogenous-text-choice',
          controlId: request.ownerEpoch,
          decisionId: request.decisionId,
          sequence: request.sequence,
          trigger: request.trigger,
          modelProfile: {
            profileId: profile.profileId,
            digest,
            identity: 'DECLARATION_ONLY',
            loadedModel: 'NOT_AUTHENTICATED',
          },
        }),
      }),
    ]);
    return dispatchRawText(raw, request, messages, generate);
  };
}

/** Shared native lifetime bridge; purpose-specific codecs supply their own messages. */
export function dispatchRawText(
  raw: RawTextPort,
  request: EndogenousTextRequest,
  messages: readonly RawTextMessage[],
  generate = raw.generate,
): Promise<string> {
  // Reservation invokes this port under the authority lock. Leave that guard before
  // any Store/currentness check, but retain the ORIGINAL dispatch deadline.
  return Promise.resolve().then(() => {
    request.validateCurrent();
    let promise: Promise<string>;
    try {
      promise = generate.call(raw, {
        requestId: request.decisionId,
        messages,
        signal: request.signal,
        validateBeforeSend: () => request.validateCurrent(),
      });
    } catch {
      // A violating raw port may have launched work before throwing. No witness:
      // keep the outer native Promise unresolved; E1 timeout retains durable held.
      return new Promise<string>(() => {});
    }
    if (
      !isPromise(promise) ||
      Object.getPrototypeOf(promise) !== Promise.prototype ||
      Object.hasOwn(promise, 'then') ||
      Object.hasOwn(promise, 'constructor')
    )
      return new Promise<string>(() => {});
    return promise; // Settlement follows the raw port's fetch/read/cancel cleanup.
  });
}
