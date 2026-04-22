/**
 * patchResolve.test.ts — Tests for HEAD-based patchResolve resolution + pending
 *
 * Phase A (resolution): match chain ref gates against ctx.rootType
 * Phase A.1 (constraint ref substitution): substitute constraint refs in schemas
 * Phase A.2 (constraint-aware matching): disambiguate by compose compatibility
 * Phase B (policy): missing → throw (default) or → pending (allowDefer)
 */

import { types } from '../builders.js';
import { chainFromFieldType, collectStatements, push } from '../chain.js';
import { FieldType } from '../type.js';
import { createHead } from '../head.js';
import type { HEAD } from '../head.js';
import { concrete } from '../statement.js';
import {
  patchResolve,
  kitSchemaFromPending,
  type ResolvedResult,
  type PendingResult,
} from '../patchResolve.js';
import * as find from '../find.js';
import { constraintRef, ConstraintTypes } from '../constraint.js';
import { ref } from '../statement.js';
import type { CallExpr, Expression } from '../statement.js';
import { extractBounds } from '../numericProjection.js';

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

// Shared type constants — same instance = type identity matching
const StorageType = types.object({ read: types.fn(types.string(), types.string()) }).meta({ name: 'StorageType' });
const EventBusType = types.object({ publish: types.fn(types.any(), types.null()) }).meta({ name: 'EventBusType' });

/**
 * Create a HEAD with typed bindings and concrete values.
 * Replaces the old ptr-based createEnv.
 */
function createEnvHead(bindings: Record<string, { type: any; value: any }>): HEAD {
  const surfaceProps: Record<string, any> = {};
  for (const [key, { type }] of Object.entries(bindings)) {
    surfaceProps[key] = type;
  }

  const head = createHead(types.object(surfaceProps));

  // Write concrete values to resolve the ref gates created by chainFromFieldType
  for (const [key, { value }] of Object.entries(bindings)) {
    head.write(concrete(key, { type: 'literal', value }));
  }

  return head;
}

/**
 * Create a draft from a source HEAD and write ref gate statements into it.
 * The ref gates come from chainFromFieldType(types.object(deps)).
 */
function createDraftWithDeps(source: HEAD, deps: Record<string, any>): HEAD {
  const draft = source.draft();
  const depsChain = chainFromFieldType(types.object(deps));
  for (const stmt of collectStatements(depsChain)) {
    draft.write(stmt);
  }
  return draft;
}

// ─────────────────────────────────────────────────────────────────────────────
// Tests: Phase A — Resolution
// ─────────────────────────────────────────────────────────────────────────────

describe('patchResolve — Phase A: Resolution', () => {

  it('resolves all deps immediately when env has matching types', () => {
    const source = createEnvHead({
      mainStorage: { type: StorageType, value: { read: () => 'data' } },
    });

    const draft = createDraftWithDeps(source, { storage: StorageType });
    const result = patchResolve(draft) as ResolvedResult;

    expect(result.status).toBe('resolved');
    expect(result.deps.storage).toBeDefined();
    expect(typeof result.deps.storage.read).toBe('function');
  });

  it('resolves multiple deps by type metadata matching', () => {
    const source = createEnvHead({
      mainStorage: { type: StorageType, value: { read: () => 'data' } },
      eventBus: { type: EventBusType, value: { publish: () => null } },
    });

    const draft = createDraftWithDeps(source, {
      storage: StorageType,
      bus: EventBusType,
    });

    const result = patchResolve(draft) as ResolvedResult;
    expect(result.status).toBe('resolved');
    expect(result.deps.storage).toBeDefined();
    expect(result.deps.bus).toBeDefined();
  });

  it('skips optional deps that are missing from env', () => {
    const source = createEnvHead({
      mainStorage: { type: StorageType, value: { read: () => 'data' } },
    });

    const draft = createDraftWithDeps(source, {
      storage: StorageType,
      'bus?': EventBusType, // optional
    });

    const result = patchResolve(draft) as ResolvedResult;
    expect(result.status).toBe('resolved');
    expect(result.deps.storage).toBeDefined();
  });

  it('suspends with candidates on ambiguous match (multiple env entries with same type)', () => {
    const source = createEnvHead({
      storage1: { type: StorageType, value: { read: () => 'a' } },
      storage2: { type: StorageType, value: { read: () => 'b' } },
    });

    const draft = createDraftWithDeps(source, { storage: StorageType });

    // Without allowDefer: throws as unresolved (ambiguity is now a suspension, not a separate error)
    expect(() => patchResolve(draft)).toThrow(/unresolved/);

    // With allowDefer: returns pending with candidates attached
    // Need fresh draft since the previous one may have state changes
    const draft2 = createDraftWithDeps(source, { storage: StorageType });
    const result = patchResolve(draft2, { allowDefer: true });
    expect(result.status).toBe('pending');
    if (result.status === 'pending') {
      const ambiguous = result.missing.find(m => m.key === 'storage');
      expect(ambiguous).toBeDefined();
      expect(ambiguous!.candidates).toBeDefined();
      expect(ambiguous!.candidates).toHaveLength(2);
      const candidateKeys = ambiguous!.candidates!.map(c => c.key);
      expect(candidateKeys).toContain('storage1');
      expect(candidateKeys).toContain('storage2');
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Tests: Phase B — Policy (default: throw)
// ─────────────────────────────────────────────────────────────────────────────

describe('patchResolve — Phase B: Default policy (throw)', () => {

  it('throws when required dep is missing and no allowDefer', () => {
    const source = createEnvHead({
      mainStorage: { type: StorageType, value: { read: () => 'data' } },
    });

    const draft = createDraftWithDeps(source, {
      storage: StorageType,
      bus: EventBusType, // required, missing from env
    });

    expect(() => patchResolve(draft)).toThrow(/unresolved/);
  });

  it('includes missing field names in error message', () => {
    const source = createEnvHead({});

    const draft = createDraftWithDeps(source, {
      storage: StorageType,
      bus: EventBusType,
    });

    expect(() => patchResolve(draft)).toThrow(/StorageType/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Tests: Phase B — Policy (allowDefer → pending)
// ─────────────────────────────────────────────────────────────────────────────

describe('patchResolve — Phase B: Pending policy', () => {

  it('returns PendingResult when allowDefer is true and deps are missing', () => {
    const source = createEnvHead({
      mainStorage: { type: StorageType, value: { read: () => 'data' } },
    });

    const draft = createDraftWithDeps(source, {
      storage: StorageType,
      bus: EventBusType, // missing
    });

    const result = patchResolve(draft, { allowDefer: true });

    expect(result.status).toBe('pending');
    expect((result as PendingResult).missing).toHaveLength(1);
    expect((result as PendingResult).missing[0].key).toBe('bus');
    expect((result as PendingResult).chain).toBeDefined();
  });

  it('includes already-resolved deps in pending result', () => {
    const source = createEnvHead({
      mainStorage: { type: StorageType, value: { read: () => 'data' } },
    });

    const draft = createDraftWithDeps(source, {
      storage: StorageType,
      bus: EventBusType, // missing
    });

    const result = patchResolve(draft, { allowDefer: true }) as PendingResult;

    expect(result.deps.storage).toBeDefined();
    expect(typeof result.deps.storage.read).toBe('function');
  });

  it('reports concreteness via HEAD', () => {
    const source = createEnvHead({});

    const draft = createDraftWithDeps(source, {
      storage: StorageType,
      bus: EventBusType,
    });

    const result = patchResolve(draft, { allowDefer: true }) as PendingResult;

    expect(result.missing).toHaveLength(2);
    expect(result.missing.map(m => m.key)).toContain('storage');
    expect(result.missing.map(m => m.key)).toContain('bus');
  });

  it('still resolves immediately when allowDefer is true but all deps exist', () => {
    const source = createEnvHead({
      mainStorage: { type: StorageType, value: { read: () => 'data' } },
      eventBus: { type: EventBusType, value: { publish: () => null } },
    });

    const draft = createDraftWithDeps(source, {
      storage: StorageType,
      bus: EventBusType,
    });

    const result = patchResolve(draft, { allowDefer: true }) as ResolvedResult;

    // Should NOT be pending — all deps resolved
    expect(result.status).toBe('resolved');
    expect(result.deps.storage).toBeDefined();
    expect(result.deps.bus).toBeDefined();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Tests: kitSchemaFromPending — block schema derivation from missing deps
// ─────────────────────────────────────────────────────────────────────────────

describe('kitSchemaFromPending', () => {

  it('produces block schema from a single missing dep', () => {
    const source = createEnvHead({});

    const draft = createDraftWithDeps(source, { storage: StorageType });
    const pending = patchResolve(draft, { allowDefer: true }) as PendingResult;
    expect(pending.status).toBe('pending');

    const schema = kitSchemaFromPending(pending);

    expect(schema.fieldtype).toBe('array');
    const named = find.arrayNamed(schema);
    expect(named).toHaveLength(1);
    expect(named[0].key).toBe('storage');
  });

  it('produces block schema with multiple missing deps', () => {
    const source = createEnvHead({});

    const draft = createDraftWithDeps(source, {
      storage: StorageType,
      bus: EventBusType,
    });
    const pending = patchResolve(draft, { allowDefer: true }) as PendingResult;

    const schema = kitSchemaFromPending(pending);

    const named = find.arrayNamed(schema);
    expect(named).toHaveLength(2);
    const keys = named.map((n: any) => n.key).sort();
    expect(keys).toEqual(['bus', 'storage']);
  });

  it('only includes missing deps, not already-resolved ones', () => {
    const source = createEnvHead({
      mainStorage: { type: StorageType, value: { read: () => 'data' } },
    });

    const draft = createDraftWithDeps(source, {
      storage: StorageType,
      bus: EventBusType, // missing
    });
    const pending = patchResolve(draft, { allowDefer: true }) as PendingResult;

    const schema = kitSchemaFromPending(pending);

    const named = find.arrayNamed(schema);
    expect(named).toHaveLength(1);
    expect(named[0].key).toBe('bus');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Tests: Constraint ref substitution + discovery
// ─────────────────────────────────────────────────────────────────────────────

describe('patchResolve — Constraint ref substitution', () => {

  it('substitutes constraint refs when scope has the value', () => {
    // Env has the named budget type + the ref target 'limit' as a string (avoids number ambiguity)
    const BudgetType = types.number().meta({ name: 'budgetType' });
    const LimitType = types.string().meta({ name: 'limitType' });
    const source = createEnvHead({
      myBudget: { type: BudgetType, value: 42 },
      limit: { type: LimitType, value: 100 },
    });

    // Gate matches by name 'budgetType', so only myBudget matches — no ambiguity
    // Build a chain with a gate whose constraint schema has a constraint ref
    const refConstraint = ConstraintTypes.number.max.create(constraintRef('limit'));
    const schema: any = {
      eventtype: 'state',
      type: 'event',
      id: 'test-budget',
      fieldtype: 'number',
      attributes: [refConstraint],
      extensions: [],
      metadata: { name: 'budgetType' },
    };

    const draft = source.draft();
    draft.write({
      type: 'bind',
      name: 'budget',
      expr: { type: 'ref', source: 'budgetType' },
      level: 'concrete',
      constraint: { type: 'literal', value: schema },
    });

    const result = patchResolve(draft, { allowDefer: true });

    // The gate should resolve (budgetType matches myBudget)
    // 'limit' is in the env scope, so constraintRefs should be empty
    expect(result.constraintRefs).toHaveLength(0);
  });

  it('discovers unresolved constraint refs and adds them to missing', () => {
    // Env has the gate type but NOT the constraint ref target
    const source = createEnvHead({
      myNumber: { type: types.number().meta({ name: 'budgetType' }), value: 42 },
    });

    // Chain gate requires 'number' type (matches myNumber) but has
    // constraintRef('limit') which is NOT in the env
    const refConstraint = ConstraintTypes.number.max.create(constraintRef('limit'));
    const schema: any = {
      eventtype: 'state',
      type: 'event',
      id: 'test-budget',
      fieldtype: 'number',
      attributes: [refConstraint],
      extensions: [],
      metadata: { name: 'budgetType' },
    };

    const draft = source.draft();
    draft.write({
      type: 'bind',
      name: 'budget',
      expr: { type: 'ref', source: 'budgetType' },
      level: 'concrete',
      constraint: { type: 'literal', value: schema },
    });

    const result = patchResolve(draft, { allowDefer: true });

    // 'budget' resolves (type matches), but 'limit' is unresolved constraint ref
    expect(result.constraintRefs).toContain('limit');

    // 'limit' should appear in missing since it's not in scope
    if (result.status === 'pending') {
      expect(result.missing.some(m => m.key === 'limit')).toBe(true);
      expect(result.missing.find(m => m.key === 'limit')!.typeName).toContain('constraint ref');
    }
  });

  it('reports constraintRefs on resolved result when all refs are in scope', () => {
    const source = createEnvHead({
      mainStorage: { type: StorageType, value: { read: () => 'data' } },
    });

    const draft = createDraftWithDeps(source, { storage: StorageType });
    const result = patchResolve(draft) as ResolvedResult;

    expect(result.status).toBe('resolved');
    // No constraint refs in a simple case
    expect(result.constraintRefs).toHaveLength(0);
  });

  it('cascade: resolving dep A reveals constraint ref B which joins missing', () => {
    // Env has storage but not eventBus, and chain has a constraint ref on 'maxRetries'
    const source = createEnvHead({
      mainStorage: { type: StorageType, value: { read: () => 'data' } },
    });

    // Build a draft with two gates:
    // 1. storage: StorageType (will resolve)
    // 2. bus: EventBusType with constraintRef('maxRetries') (won't resolve — EventBusType missing)
    const refConstraint = ConstraintTypes.number.max.create(constraintRef('maxRetries'));
    const busSchema: any = {
      eventtype: 'state',
      type: 'event',
      id: 'test-bus',
      fieldtype: 'object',
      attributes: [refConstraint],
      extensions: [],
      metadata: { name: 'EventBusType' },
    };

    const draft = createDraftWithDeps(source, { storage: StorageType });
    draft.write({
      type: 'bind',
      name: 'bus',
      expr: { type: 'ref', source: 'EventBusType' },
      level: 'concrete',
      constraint: { type: 'literal', value: busSchema },
    });

    const result = patchResolve(draft, { allowDefer: true }) as PendingResult;

    expect(result.status).toBe('pending');
    // bus is missing (EventBusType not in env)
    expect(result.missing.some(m => m.key === 'bus')).toBe(true);
    // maxRetries should also be discovered as a constraint ref
    expect(result.constraintRefs).toContain('maxRetries');
    // maxRetries should join the missing list
    expect(result.missing.some(m => m.key === 'maxRetries')).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Tests: Compose fallback — structural matching when key/name match fails
// ─────────────────────────────────────────────────────────────────────────────

describe('patchResolve — Compose fallback', () => {

  // Simulate derived package types with [kind] discriminant (as produced by derivePackageType)
  const ModelPkgType = types.object({
    '[kind]': types.string().literal('model'),
    prompt: types.any(),
  }).meta({ name: 'connection:model-openai:default' });

  const ModelPkgType2 = types.object({
    '[kind]': types.string().literal('model'),
    prompt: types.any(),
  }).meta({ name: 'connection:model-anthropic:default' });

  const GeneralPkgType = types.object({
    '[kind]': types.string().literal('general'),
    apiKey: types.any(),
  }).meta({ name: 'connection:github:default' });

  const BlueprintPkgType = types.object({
    '[kind]': types.string().literal('blueprint'),
    createChat: types.any(),
  }).meta({ name: 'blueprint:chat-service' });

  // ModelProviderRef — same shape as domain.ts but inline for test isolation
  const ModelProviderRef = types.object({
    '[kind]': types.string().literal('model'),
  }).meta({ name: 'ModelProvider', description: 'Reference to an installed model provider package' });

  it('compose fallback finds model packages by [kind] discriminant', () => {
    const source = createEnvHead({
      'connection:model-openai:default': {
        type: ModelPkgType,
        value: { provider: 'openai', model: 'gpt-5.2' },
      },
      'connection:github:default': {
        type: GeneralPkgType,
        value: { apiKey: 'xxx' },
      },
    });

    // Chain with a ModelProviderRef gate — metadata.name = 'ModelProvider'
    // won't key/name match anything in env, so compose fallback fires
    const draft = createDraftWithDeps(source, { model: ModelProviderRef });
    const result = patchResolve(draft) as ResolvedResult;

    expect(result.status).toBe('resolved');
    expect(result.deps.model).toBeDefined();
    expect(result.deps.model.provider).toBe('openai');
  });

  it('rejects non-model packages (conflicting [kind] literal)', () => {
    const source = createEnvHead({
      'connection:github:default': {
        type: GeneralPkgType,
        value: { apiKey: 'xxx' },
      },
      'blueprint:chat-service': {
        type: BlueprintPkgType,
        value: { createChat: () => {} },
      },
    });

    // No model packages in env — compose fallback finds 0 matches
    const draft = createDraftWithDeps(source, { model: ModelProviderRef });
    expect(() => patchResolve(draft)).toThrow(/unresolved/);
  });

  it('does not fire when name match succeeds (compose is fallback only)', () => {
    // Env has a type with metadata.name === 'StorageType' — initial filter matches by name
    const source = createEnvHead({
      mainStorage: { type: StorageType, value: { read: () => 'data' } },
      'connection:model-openai:default': {
        type: ModelPkgType,
        value: { provider: 'openai', model: 'gpt-5.2' },
      },
    });

    const draft = createDraftWithDeps(source, { storage: StorageType });
    const result = patchResolve(draft) as ResolvedResult;

    expect(result.status).toBe('resolved');
    expect(result.deps.storage).toBeDefined();
    // Should have matched by name, not by compose fallback — so mainStorage, not the model
    expect(typeof result.deps.storage.read).toBe('function');
  });

  it('multiple model packages → all surfaced as candidates', () => {
    const source = createEnvHead({
      'connection:model-openai:default': {
        type: ModelPkgType,
        value: { provider: 'openai', model: 'gpt-5.2' },
      },
      'connection:model-anthropic:default': {
        type: ModelPkgType2,
        value: { provider: 'anthropic', model: 'claude-4' },
      },
      'connection:github:default': {
        type: GeneralPkgType,
        value: { apiKey: 'xxx' },
      },
    });

    const draft = createDraftWithDeps(source, { model: ModelProviderRef });
    const result = patchResolve(draft, { allowDefer: true }) as PendingResult;

    expect(result.status).toBe('pending');
    const modelMissing = result.missing.find(m => m.key === 'model');
    expect(modelMissing).toBeDefined();
    expect(modelMissing!.candidates).toBeDefined();
    expect(modelMissing!.candidates).toHaveLength(2);
    const candidateKeys = modelMissing!.candidates!.map(c => c.key);
    expect(candidateKeys).toContain('connection:model-openai:default');
    expect(candidateKeys).toContain('connection:model-anthropic:default');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Tests: SolveResult enrichment — scopeMap, varBindings, candidateDomains
// ─────────────────────────────────────────────────────────────────────────────

describe('SolveResult — rich context fields', () => {

  it('scopeMap is populated with resolved bindings', () => {
    const source = createEnvHead({
      mainStorage: { type: StorageType, value: { read: () => 'data' } },
    });

    const draft = createDraftWithDeps(source, { storage: StorageType });
    const result = patchResolve(draft) as ResolvedResult;

    expect(result.status).toBe('resolved');
    expect(result.scopeMap).toBeDefined();
    expect(result.scopeMap instanceof Map).toBe(true);
    // scopeMap should contain the resolved dep value
    expect(result.scopeMap.get('storage')).toBeDefined();
    expect(typeof (result.scopeMap.get('storage') as any)?.read).toBe('function');
  });

  it('scopeMap includes source ctx values', () => {
    const source = createEnvHead({
      mainStorage: { type: StorageType, value: { read: () => 'data' } },
      eventBus: { type: EventBusType, value: { publish: () => null } },
    });

    const draft = createDraftWithDeps(source, { storage: StorageType });
    const result = patchResolve(draft) as ResolvedResult;

    // scopeMap should include both ctx values (from source rootType)
    // and resolved dep mappings
    expect(result.scopeMap.get('mainStorage')).toBeDefined();
    expect(result.scopeMap.get('eventBus')).toBeDefined();
  });

  it('varBindings is empty for non-VarType constraints', () => {
    const source = createEnvHead({
      mainStorage: { type: StorageType, value: { read: () => 'data' } },
    });

    const draft = createDraftWithDeps(source, { storage: StorageType });
    const result = patchResolve(draft) as ResolvedResult;

    expect(result.varBindings).toBeDefined();
    expect(result.varBindings instanceof Map).toBe(true);
    expect(result.varBindings.size).toBe(0);
  });

  it('candidateDomains records matches for resolved gates', () => {
    const source = createEnvHead({
      mainStorage: { type: StorageType, value: { read: () => 'data' } },
    });

    const draft = createDraftWithDeps(source, { storage: StorageType });
    const result = patchResolve(draft) as ResolvedResult;

    expect(result.candidateDomains).toBeDefined();
    expect(result.candidateDomains instanceof Map).toBe(true);
    // Single match for 'storage' gate
    const candidates = result.candidateDomains.get('storage');
    expect(candidates).toBeDefined();
    expect(candidates).toHaveLength(1);
    expect(candidates![0].key).toBe('mainStorage');
  });

  it('candidateDomains has multiple entries for ambiguous match', () => {
    const source = createEnvHead({
      storage1: { type: StorageType, value: { read: () => 'a' } },
      storage2: { type: StorageType, value: { read: () => 'b' } },
    });

    const draft = createDraftWithDeps(source, { storage: StorageType });
    const result = patchResolve(draft, { allowDefer: true }) as PendingResult;

    expect(result.status).toBe('pending');
    const candidates = result.candidateDomains.get('storage');
    expect(candidates).toBeDefined();
    expect(candidates).toHaveLength(2);
  });

  it('behavioralActions is empty when no behavioral constraints exist', () => {
    const source = createEnvHead({
      mainStorage: { type: StorageType, value: { read: () => 'data' } },
    });

    const draft = createDraftWithDeps(source, { storage: StorageType });
    const result = patchResolve(draft) as ResolvedResult;

    expect(result.behavioralActions).toBeDefined();
    expect(result.behavioralActions).toHaveLength(0);
  });

  it('missing is empty array on fully resolved result', () => {
    const source = createEnvHead({
      mainStorage: { type: StorageType, value: { read: () => 'data' } },
    });

    const draft = createDraftWithDeps(source, { storage: StorageType });
    const result = patchResolve(draft) as ResolvedResult;

    expect(result.missing).toBeDefined();
    expect(result.missing).toHaveLength(0);
  });

  it('behavioralActions discovers persist on concrete bindings (not ref gates)', () => {
    // Build a rootType with persist constraint on 'apiKey'
    const keyFT = FieldType.string.create().persist('mySink').save();
    let ft = FieldType.object.create();
    (ft.attributes ??= []).push(ConstraintTypes.object.property.create('apiKey', keyFT));
    ft = ft.save();

    // Create HEAD from the FieldType — chainFromFieldType generates ref gates
    let chain = chainFromFieldType(ft);
    // Provide the sink adapter as a concrete binding
    const storeFn = (v: unknown) => v;
    chain = push(chain, concrete('mySink', { type: 'literal', value: storeFn }));
    const head = createHead(chain);

    // Write a concrete value (NOT a ref gate) — this is the gap we're closing
    const draft = head.draft();
    draft.write(concrete('apiKey', { type: 'literal', value: 'sk-123' }));

    const result = patchResolve(draft, { allowDefer: true });

    // The solver should discover the persist action on the concrete 'apiKey' binding
    expect(result.behavioralActions.length).toBeGreaterThanOrEqual(1);
    const persistAction = result.behavioralActions.find(
      a => a.bindingName === 'apiKey' && a.constrainttype === 'persist',
    );
    expect(persistAction).toBeDefined();
    expect(persistAction!.params.sink).toBe(storeFn); // resolved from scopeMap
  });

  it('behavioralActions discovers subscribe on concrete bindings', () => {
    const configFT = FieldType.string.create().subscribe('configTopic').save();
    let ft = FieldType.object.create();
    (ft.attributes ??= []).push(ConstraintTypes.object.property.create('config', configFT));
    ft = ft.save();

    const head = createHead(chainFromFieldType(ft));
    const draft = head.draft();
    draft.write(concrete('config', { type: 'literal', value: 'dark-mode' }));

    const result = patchResolve(draft, { allowDefer: true });

    const subAction = result.behavioralActions.find(
      a => a.bindingName === 'config' && a.constrainttype === 'subscribe',
    );
    expect(subAction).toBeDefined();
    expect(subAction!.params.target).toBe('configTopic');
  });

  it('behavioralActions includes both ref-gate and concrete-binding actions', () => {
    // Build rootType: apiKey (persist), storage (no constraint)
    const keyFT = FieldType.string.create().persist('mySink').save();
    let ft = FieldType.object.create();
    (ft.attributes ??= []).push(ConstraintTypes.object.property.create('apiKey', keyFT));
    (ft.attributes ??= []).push(ConstraintTypes.object.property.create('mainStorage', StorageType));
    ft = ft.save();

    let chain = chainFromFieldType(ft);
    const storeFn = (v: unknown) => v;
    chain = push(chain, concrete('mySink', { type: 'literal', value: storeFn }));
    chain = push(chain, concrete('mainStorage', { type: 'literal', value: { read: () => 'data' } }));
    const head = createHead(chain);

    const draft = head.draft();
    // Write concrete apiKey (non-blocked) AND a ref gate for storage
    draft.write(concrete('apiKey', { type: 'literal', value: 'sk-abc' }));
    const depsChain = chainFromFieldType(types.object({ storage: StorageType }));
    for (const stmt of collectStatements(depsChain)) {
      draft.write(stmt);
    }

    const result = patchResolve(draft, { allowDefer: true });

    // Should have persist action from concrete binding
    const persistAction = result.behavioralActions.find(
      a => a.bindingName === 'apiKey' && a.constrainttype === 'persist',
    );
    expect(persistAction).toBeDefined();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Tests: Phase A.4 — Projection-based constraint propagation
// ─────────────────────────────────────────────────────────────────────────────

describe('patchResolve — Phase A.4: Projection-based constraint propagation', () => {

  /**
   * Helper: create a draft with a concrete binding that uses a call expression.
   * The source HEAD provides the resolution context (rootType + values).
   */
  function createDraftWithCallBinding(
    source: HEAD,
    bindingName: string,
    callExpr: Expression,
    constraint?: Expression,
  ): HEAD {
    const draft = source.draft();
    draft.write({
      type: 'bind',
      name: bindingName,
      expr: callExpr,
      level: 'concrete',
      constraint,
    });
    return draft;
  }

  it('single unknown: add(10, ref("y1")) output max(20) → y1 surfaced as number.max(10)', () => {
    const source = createEnvHead({});

    const callExpr: CallExpr = {
      type: 'call',
      fn: 'add',
      args: [
        { type: 'literal', value: 10 },
        ref('y1'),
      ],
    };
    // Output constraint: number ≤ 20
    const outputConstraint: Expression = {
      type: 'fieldtype',
      fieldtype: 'number',
      attributes: [ConstraintTypes.number.max.create(20)],
    };

    const draft = createDraftWithCallBinding(source, 'c1', callExpr, outputConstraint);
    const result = patchResolve(draft, { allowDefer: true });

    expect(result.status).toBe('pending');
    const y1Missing = result.missing.find(m => m.key === 'y1');
    expect(y1Missing).toBeDefined();
    expect(y1Missing!.typeName).toBe('number');

    // Check the narrowed constraint: y1 ≤ max(20) - literal(10) = max(10)
    const narrowed = y1Missing!.type;
    expect(FieldType.describes(narrowed)).toBe(true);
    const bounds = extractBounds(narrowed);
    expect(bounds.max).toBe(10);
  });

  it('two unknowns: add(10, ref("y1"), ref("y2")) output max(20) → both surfaced with max(10)', () => {
    const source = createEnvHead({});

    const callExpr: CallExpr = {
      type: 'call',
      fn: 'add',
      args: [
        { type: 'literal', value: 10 },
        ref('y1'),
        ref('y2'),
      ],
    };
    const outputConstraint: Expression = {
      type: 'fieldtype',
      fieldtype: 'number',
      attributes: [ConstraintTypes.number.max.create(20)],
    };

    const draft = createDraftWithCallBinding(source, 'c1', callExpr, outputConstraint);
    const result = patchResolve(draft, { allowDefer: true });

    expect(result.status).toBe('pending');
    const y1 = result.missing.find(m => m.key === 'y1');
    const y2 = result.missing.find(m => m.key === 'y2');
    expect(y1).toBeDefined();
    expect(y2).toBeDefined();

    // Both get the same conservative narrowing: max(20-10) = max(10)
    expect(extractBounds(y1!.type).max).toBe(10);
    expect(extractBounds(y2!.type).max).toBe(10);
  });

  it('mul: mul(ref("y1"), literal(5)) output max(35) → y1 surfaced as number.max(7)', () => {
    const source = createEnvHead({});

    const callExpr: CallExpr = {
      type: 'call',
      fn: 'mul',
      args: [
        ref('y1'),
        { type: 'literal', value: 5 },
      ],
    };
    const outputConstraint: Expression = {
      type: 'fieldtype',
      fieldtype: 'number',
      attributes: [ConstraintTypes.number.max.create(35)],
    };

    const draft = createDraftWithCallBinding(source, 'c1', callExpr, outputConstraint);
    const result = patchResolve(draft, { allowDefer: true });

    expect(result.status).toBe('pending');
    const y1 = result.missing.find(m => m.key === 'y1');
    expect(y1).toBeDefined();

    // y1 = div(max(35), literal(5)) = max(7)
    const bounds = extractBounds(y1!.type);
    expect(bounds.max).toBe(7);
  });

  it('cross-equation compose: y1 in both add and mul → constraints intersected', () => {
    const source = createEnvHead({});

    // Equation 1: add(5, ref('y1')) ≤ 20 → y1 ≤ 15
    const addExpr: CallExpr = {
      type: 'call',
      fn: 'add',
      args: [{ type: 'literal', value: 5 }, ref('y1')],
    };
    const addConstraint: Expression = {
      type: 'fieldtype',
      fieldtype: 'number',
      attributes: [ConstraintTypes.number.max.create(20)],
    };

    // Equation 2: mul(ref('y1'), literal(3)) ≤ 30 → y1 ≤ 10
    const mulExpr: CallExpr = {
      type: 'call',
      fn: 'mul',
      args: [ref('y1'), { type: 'literal', value: 3 }],
    };
    const mulConstraint: Expression = {
      type: 'fieldtype',
      fieldtype: 'number',
      attributes: [ConstraintTypes.number.max.create(30)],
    };

    const draft = source.draft();
    draft.write({
      type: 'bind', name: 'c1', expr: addExpr, level: 'concrete',
      constraint: addConstraint,
    });
    draft.write({
      type: 'bind', name: 'c2', expr: mulExpr, level: 'concrete',
      constraint: mulConstraint,
    });

    const result = patchResolve(draft, { allowDefer: true });

    expect(result.status).toBe('pending');
    const y1 = result.missing.find(m => m.key === 'y1');
    expect(y1).toBeDefined();

    // y1 should have the tightest constraint: compose(max(15), max(10)) = max(10)
    const bounds = extractBounds(y1!.type);
    expect(bounds.max).toBe(10);
  });

  it('non-arithmetic fn → refs NOT surfaced via Phase A.4', () => {
    const source = createEnvHead({});

    // A call to a non-arithmetic function — no projection
    const callExpr: CallExpr = {
      type: 'call',
      fn: 'customFn',
      args: [ref('y1')],
    };

    const draft = createDraftWithCallBinding(source, 'c1', callExpr);
    const result = patchResolve(draft, { allowDefer: true });

    // y1 should NOT be surfaced as missing (no projection for 'customFn')
    expect(result.missing.find(m => m.key === 'y1')).toBeUndefined();
  });

  it('already-resolved ref → skipped (not surfaced again)', () => {
    const NumberType = types.number().meta({ name: 'NumberType' });
    const source = createEnvHead({
      y1: { type: NumberType, value: 7 },
    });

    const callExpr: CallExpr = {
      type: 'call',
      fn: 'add',
      args: [
        { type: 'literal', value: 10 },
        ref('y1'),
      ],
    };
    const outputConstraint: Expression = {
      type: 'fieldtype',
      fieldtype: 'number',
      attributes: [ConstraintTypes.number.max.create(20)],
    };

    const draft = createDraftWithCallBinding(source, 'c1', callExpr, outputConstraint);
    const result = patchResolve(draft, { allowDefer: true });

    // y1 is in scopeMap (from source env), so should NOT be in missing
    expect(result.missing.find(m => m.key === 'y1')).toBeUndefined();
  });

  it('no output constraint → skipped', () => {
    const source = createEnvHead({});

    const callExpr: CallExpr = {
      type: 'call',
      fn: 'add',
      args: [
        { type: 'literal', value: 10 },
        ref('y1'),
      ],
    };

    // No constraint on the binding
    const draft = createDraftWithCallBinding(source, 'c1', callExpr);
    const result = patchResolve(draft, { allowDefer: true });

    // Without an output constraint, projection can't derive anything
    expect(result.missing.find(m => m.key === 'y1')).toBeUndefined();
  });

  it('does not interfere with existing ref gate resolution (Phase A.1)', () => {
    const source = createEnvHead({
      mainStorage: { type: StorageType, value: { read: () => 'data' } },
    });

    // Normal ref gate (Phase A.1)
    const draft = createDraftWithDeps(source, { storage: StorageType });
    // Also add a call-based binding with ref
    draft.write({
      type: 'bind', name: 'sum', level: 'concrete',
      expr: {
        type: 'call', fn: 'add',
        args: [{ type: 'literal', value: 5 }, ref('y1')],
      },
      constraint: {
        type: 'fieldtype', fieldtype: 'number',
        attributes: [ConstraintTypes.number.max.create(20)],
      },
    });

    const result = patchResolve(draft, { allowDefer: true });

    // Phase A.1 should have resolved storage
    expect(result.deps.storage).toBeDefined();

    // Phase A.4 should have surfaced y1
    const y1 = result.missing.find(m => m.key === 'y1');
    expect(y1).toBeDefined();
    expect(extractBounds(y1!.type).max).toBe(15);
  });
});
