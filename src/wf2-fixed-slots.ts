import { canonical, copyJson, hash, parseJson, shape, stop, Wf1Error } from './wf1-json.ts';
import { strictDataBinding, strictDataBody, strictDataSchema, WF2_STRICT_PROFILE_DIGEST } from './wf2-strict-data.ts';
import { WF1 } from './wf1-types.ts';
import type { Json, Operation, Provider, ProviderResult, RequestBinding } from './wf1-types.ts';

function freeze<T>(value: T): T {
  if (value !== null && typeof value === 'object') {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}
const object = (properties: Record<string, unknown>) => ({
  type: 'object',
  properties,
  required: Object.keys(properties),
  additionalProperties: false,
});
const keys = (prefix: string, count: number) =>
  Array.from({ length: count }, (_, i) => prefix + String(i + 1).padStart(2, '0'));
const CASE_KEYS = Object.freeze(keys('case', 12)),
  FAMILY_KEYS = Object.freeze(keys('family', 16)),
  PAIR_KEYS = Object.freeze(keys('pair', 8));
const ref = (name: string) => ({ $ref: '#/$def/' + name }),
  slots = (names: readonly string[], value: (i: number) => unknown) =>
    object(Object.fromEntries(names.map((name, i) => [name, value(i)])));
const baseSeal = copyJson(strictDataSchema('seal')) as {
  properties: { rubric: Json; cases: { items: Json } };
  $def: Record<string, Json>;
};
const basePlan = copyJson(strictDataSchema('plan')) as {
  properties: { plan: Json; families: { items: { properties: Record<string, Json> } } };
  $def: Record<string, Json>;
};
const family = (split: 'train' | 'dev') =>
  object({ ...basePlan.properties.families.items.properties, split: { type: 'string', enum: [split] } });
const schemas = freeze({
  seal: {
    ...object({
      version: { type: 'string', enum: ['wf2-seal-slots/1'] },
      rubric: baseSeal.properties.rubric,
      cases: slots(CASE_KEYS, () => ref('sealedCase')),
    }),
    $def: { ...baseSeal.$def, sealedCase: baseSeal.properties.cases.items },
  },
  plan: {
    ...object({
      version: { type: 'string', enum: ['wf2-plan-slots/1'] },
      plan: basePlan.properties.plan,
      families: slots(FAMILY_KEYS, (i) => ref((i + 1) % 4 === 0 ? 'devFamily' : 'trainFamily')),
      pairedFamilyIds: slots(PAIR_KEYS, () => ref('identifier')),
    }),
    $def: {
      ...basePlan.$def,
      trainFamily: family('train'),
      devFamily: family('dev'),
      identifier: { type: 'string', pattern: '^[A-Za-z0-9][A-Za-z0-9_.:-]{0,95}$' },
    },
  },
});
const INSTRUCTION =
  ' Wire codec wf2-fixed-slots/1: produce the complete required named-slot object. Every slot is mandatory and independently authored; do not use an array, omit a slot, duplicate an item to fill a slot, or copy a format example. Seal cases are case01 through case12. Plan families are family01 through family16; explicitly set split to dev in family04, family08, family12, family16 and train in all other slots. Paired IDs are pair01 through pair08 and must be eight distinct IDs from the authored plan. The host only projects all slots in their fixed order to the existing local contract; it supplies no missing teaching data. All original exact oracle, roots, source and size gates still apply.';
export const WF2_SLOTS_POLICY = freeze({
  version: 'wf2-fixed-slots/1',
  campaignSchema: 'wf1-campaign/0.6',
  baseProfile: WF2_STRICT_PROFILE_DIGEST,
  instruction: INSTRUCTION,
  caseKeys: CASE_KEYS,
  familyKeys: FAMILY_KEYS,
  pairKeys: PAIR_KEYS,
  domain: 'RATIONAL_ONLY',
  projection: 'COMPLETE_FIXED_ORDER_WITH_CANONICAL_INVERSE',
  retry: false,
  repair: false,
});
export const WF2_SLOTS_PROFILE_DIGEST = hash(canonical({ limits: WF1, policy: WF2_SLOTS_POLICY, schemas }));
export function fixedSlotSchema(operation: Operation): unknown {
  return operation === 'seal' || operation === 'plan' ? schemas[operation] : strictDataSchema(operation);
}
export function fixedSlotBinding(provider: Provider, operation: Operation): RequestBinding {
  const fixed = operation === 'seal' || operation === 'plan';
  if (fixed && provider !== 'deepseek') stop('WF2_SLOT_ROUTE');
  return {
    ...strictDataBinding(provider, operation),
    toolName: fixed ? 'wf2_slots_' + operation : provider === 'deepseek' ? 'wf2_data_' + operation : null,
    schemaDigest: hash(canonical(fixedSlotSchema(operation))),
    payloadCodec: fixed ? 'WF2_FIXED_SLOTS_V1' : 'WF2_CANONICAL_V1',
  };
}
export function fixedSlotBody(provider: Provider, payload: unknown, operation: Operation): string {
  const base = strictDataBody(provider, payload, operation);
  if (operation !== 'seal' && operation !== 'plan') return base;
  const binding = fixedSlotBinding(provider, operation),
    body = JSON.parse(base) as {
      messages: Array<{ role: string; content: string }>;
      tools: Array<{
        type: string;
        function: { name: string; description: string; strict: boolean; parameters: unknown };
      }>;
      tool_choice: { type: string; function: { name: string } };
    };
  body.messages[0]!.content += INSTRUCTION;
  body.tools[0]!.function.name = binding.toolName!;
  body.tools[0]!.function.parameters = fixedSlotSchema(operation);
  body.tool_choice.function.name = binding.toolName!;
  const raw = canonical(body);
  if (Buffer.byteLength(raw) > WF1.requestBytes) stop('WF1_REQUEST_BYTES');
  return raw;
}
export function validateFixedSlotRequest(
  provider: Provider,
  operation: Operation,
  body: string,
  binding: RequestBinding,
): void {
  if (canonical(binding) !== canonical(fixedSlotBinding(provider, operation))) stop('WF2_SLOT_BINDING');
  const b = shape(
    parseJson(body),
    provider === 'deepseek'
      ? ['model', 'stream', 'messages', 'max_tokens', 'thinking', 'tools', 'tool_choice']
      : ['model', 'stream', 'messages', 'max_tokens', 'response_format', 'reasoning_effort'],
  );
  if (!Array.isArray(b.messages) || b.messages.length !== 2) stop('WF2_SLOT_BINDING');
  const user = shape(b.messages[1], ['role', 'content']);
  if (typeof user.content !== 'string') stop('WF2_SLOT_BINDING');
  const p = shape(parseJson(user.content), ['protocol', 'operation', 'role', 'jsonProfile', 'data']);
  if (p.protocol !== 'wf2-private-rational-role/1' || p.operation !== operation) stop('WF2_SLOT_BINDING');
  const expected = fixedSlotBody(
    provider,
    {
      protocol: 'wf1-private-role/1',
      operation,
      role: p.role,
      protocolInstruction: '',
      jsonProfile: p.jsonProfile,
      outputSchema: null,
      data: p.data,
    },
    operation,
  );
  if (body !== expected) stop('WF2_SLOT_BINDING');
}
/** No response-based codec detection. Only a consumed .6 seal/plan operation can enter this projection. */
export function projectFixedSlots(
  operation: 'seal' | 'plan',
  input: unknown,
  origin: ProviderResult['payloadOrigin'],
  expectedOrigin: 'STRICT_TOOL_ARGUMENTS' | 'NAMED_TOOL_ARGUMENTS' | 'NATIVE_FINAL' = 'STRICT_TOOL_ARGUMENTS',
): Json {
  try {
    if (operation !== 'seal' && operation !== 'plan') stop('WF2_SLOT_OPERATION');
    if (
      !['STRICT_TOOL_ARGUMENTS', 'NAMED_TOOL_ARGUMENTS', 'NATIVE_FINAL'].includes(expectedOrigin) ||
      origin !== expectedOrigin
    )
      stop('WF2_SLOT_ORIGIN');
    const own = copyJson(input),
      top = shape(
        own,
        operation === 'seal' ? ['version', 'rubric', 'cases'] : ['version', 'plan', 'families', 'pairedFamilyIds'],
      );
    if (top.version !== (operation === 'seal' ? 'wf2-seal-slots/1' : 'wf2-plan-slots/1')) stop('WF2_SLOT_VERSION');
    const names = operation === 'seal' ? CASE_KEYS : FAMILY_KEYS,
      table = shape(top[operation === 'seal' ? 'cases' : 'families'], names),
      items = names.map((name, i) => {
        const item = shape(
          table[name],
          operation === 'seal' ? ['id', 'roots', 'formal', 'target'] : ['id', 'roots', 'split', 'formal'],
        );
        if (operation === 'plan' && item.split !== ((i + 1) % 4 === 0 ? 'dev' : 'train')) stop('WF2_SLOT_SPLIT');
        return item;
      });
    const pairs = operation === 'plan' ? shape(top.pairedFamilyIds, PAIR_KEYS) : undefined;
    const projected =
      operation === 'seal'
        ? { version: 'wf1-seal/1', rubric: top.rubric, cases: items }
        : {
            version: 'wf1-plan/1',
            plan: top.plan,
            families: items,
            pairedFamilyIds: PAIR_KEYS.map((name) => pairs![name]),
          };
    const inverse =
      operation === 'seal'
        ? {
            version: 'wf2-seal-slots/1',
            rubric: projected.rubric,
            cases: Object.fromEntries(CASE_KEYS.map((name, i) => [name, items[i]])),
          }
        : {
            version: 'wf2-plan-slots/1',
            plan: projected.plan,
            families: Object.fromEntries(FAMILY_KEYS.map((name, i) => [name, items[i]])),
            pairedFamilyIds: Object.fromEntries(PAIR_KEYS.map((name, i) => [name, projected.pairedFamilyIds![i]])),
          };
    if (canonical(inverse) !== canonical(own)) stop('WF2_SLOT_ROUNDTRIP');
    return copyJson(projected);
  } catch (e) {
    if (e instanceof Wf1Error) stop('WF2_SLOT_WIRE_REJECTED');
    throw e;
  }
}
export const FIXED_SLOT_STOP_REASONS = [
  'WIRE_DECODE',
  'LOCAL_SCHEMA',
  'EXACT_ORACLE',
  'SOURCE',
  'REVIEW',
  'UNKNOWN',
] as const;
/** Only fixed source-owned codes are classified; no error messages or response values are projected. */
export function fixedSlotStopReason(code: unknown): (typeof FIXED_SLOT_STOP_REASONS)[number] {
  if (typeof code !== 'string') return 'UNKNOWN';
  if (code === 'WF2_SLOT_WIRE_REJECTED') return 'WIRE_DECODE';
  if (
    [
      'WF1_SPLIT',
      'WF1_PAIR_BINDING',
      'WF1_ENUM',
      'WF1_UNICODE',
      'WF1_JSON',
      'WF1_JSON_LIMIT',
      'WF1_DUPLICATE_KEY',
      'WF1_POINTER',
      'WF1_CANDIDATE_LIMIT',
      'WF1_LIMIT',
      'WF1_FIELDS',
      'WF1_SHAPE',
      'WF1_VERSION',
      'WF1_PROTOCOL',
      'WF1_NUMBER',
      'WF1_TEXT',
      'WF1_ID',
      'WF1_DUPLICATE',
      'WF1_FORMAL_LIMIT',
      'WF1_FORMAL_NUMBER',
      'WF1_FORMAL_SHAPE',
      'WF1_FORMAL_DIV_ZERO',
      'WF2_RATIONAL_ONLY',
      'WF2_FIRST_LOCAL_SCHEMA',
    ].includes(code)
  )
    return 'LOCAL_SCHEMA';
  if (code === 'WF1_SEAL_FORMAL_FAIL' || code === 'WF2_FIRST_EXACT_ORACLE') return 'EXACT_ORACLE';
  if (code === 'WF1_SOURCE_EXCLUSION' || code === 'WF1_FAMILY_COLLISION') return 'SOURCE';
  if (code === 'WF2_FIRST_REVIEW') return 'REVIEW';
  return 'UNKNOWN';
}
