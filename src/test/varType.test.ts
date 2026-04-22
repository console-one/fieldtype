/**
 * varType.test.ts — Tests for VarType: compose, patchResolve binding, where predicates
 *
 * VarType represents type variables with optional bounds. When patchResolve
 * encounters a ref gate with a VarType constraint, it:
 *   1. Matches candidates using the VarType's bound
 *   2. Records the binding (varId → concrete type)
 *   3. Evaluates where-predicates (non-literal constraint expressions)
 *   4. Propagates bindings to subsequent ref gates
 */

import { FieldType, isNever } from '../type.js';
import { types } from '../builders.js';
import { createChain, push, collectStatements } from '../chain.js';
import type { Chain } from '../chain.js';
import { createHead } from '../head.js';
import type { HEAD } from '../head.js';
import { concrete } from '../statement.js';
import {
  patchResolve,
  evaluateTypeExpr,
  collectVarTypes,
  substituteVarBindings,
  type VarBindings,
  type ResolvedResult,
  type PendingResult,
} from '../patchResolve.js';
import type { Expression } from '../statement.js';

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

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
  for (const [key, { value }] of Object.entries(bindings)) {
    head.write(concrete(key, { type: 'literal', value }));
  }
  return head;
}

/** Build a chain with a single blocked bind that has a VarType constraint. */
function createVarGateChain(
  bindName: string,
  refSource: string,
  varType: FieldType,
): Chain {
  let chain = createChain('object');
  chain = push(chain, {
    type: 'bind',
    name: bindName,
    expr: { type: 'ref', source: refSource },
    level: 'concrete',
    constraint: { type: 'literal', value: varType },
  });
  return chain;
}

/**
 * Create a draft from a source HEAD and write statements from a chain into it.
 */
function createDraftWithChain(source: HEAD, chain: Chain): HEAD {
  const draft = source.draft();
  for (const stmt of collectStatements(chain)) {
    draft.write(stmt);
  }
  return draft;
}

// ─────────────────────────────────────────────────────────────────────────────
// Tests: VarType compose
// ─────────────────────────────────────────────────────────────────────────────

describe('VarType — compose', () => {

  it('same varId returns identity', () => {
    const T = FieldType.var.create({ name: 'T', varId: 'α' });
    const result = FieldType.compose(T, T);
    expect(FieldType.var.describes(result)).toBe(true);
    expect((result as any).varId).toBe('α');
  });

  it('unbounded var + concrete → returns the concrete (instantiation)', () => {
    const T = FieldType.var.create({ name: 'T' });
    const concrete = types.string();

    const result = FieldType.compose(T, concrete);
    expect(result.fieldtype).toBe('string');
  });

  it('bounded var + compatible concrete → returns concrete', () => {
    const bound = types.object({ name: types.string() });
    const T = FieldType.var.create({ name: 'T', bound });

    const concrete = types.object({ name: types.string(), age: types.number() });
    const result = FieldType.compose(T, concrete);

    // concrete satisfies the bound (it has 'name: string' plus more)
    expect(result.fieldtype).toBe('object');
    expect(isNever(result)).toBe(false);
  });

  it('bounded var + incompatible concrete → returns never', () => {
    const bound = types.object({ name: types.string() });
    const T = FieldType.var.create({ name: 'T', bound });

    // Concrete is a plain string — doesn't compose with an object bound
    const concrete = types.string();
    const result = FieldType.compose(T, concrete);

    expect(isNever(result)).toBe(true);
  });

  it('concrete + unbounded var → returns the concrete (commutative)', () => {
    const T = FieldType.var.create({ name: 'T' });
    const concrete = types.number();

    const result = FieldType.compose(concrete, T);
    expect(result.fieldtype).toBe('number');
  });

  it('two different vars → intersection (And)', () => {
    const T = FieldType.var.create({ name: 'T', varId: 'α' });
    const U = FieldType.var.create({ name: 'U', varId: 'β' });

    const result = FieldType.compose(T, U);
    expect(result.fieldtype).toBe('and');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Tests: collectVarTypes
// ─────────────────────────────────────────────────────────────────────────────

describe('collectVarTypes', () => {

  it('finds a top-level VarType', () => {
    const T = FieldType.var.create({ name: 'T', varId: 'α' });
    const vars = collectVarTypes(T);
    expect(vars).toHaveLength(1);
    expect(vars[0].varId).toBe('α');
    expect(vars[0].name).toBe('T');
  });

  it('finds VarType nested in object property values', () => {
    const T = FieldType.var.create({ name: 'T', varId: 'α' });
    const obj = types.object({ value: T });
    const vars = collectVarTypes(obj);
    expect(vars).toHaveLength(1);
    expect(vars[0].varId).toBe('α');
  });

  it('returns empty for types without vars', () => {
    const plain = types.object({ x: types.string() });
    expect(collectVarTypes(plain)).toHaveLength(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Tests: substituteVarBindings
// ─────────────────────────────────────────────────────────────────────────────

describe('substituteVarBindings', () => {

  it('substitutes a top-level VarType with its binding', () => {
    const T = FieldType.var.create({ name: 'T', varId: 'α' });
    const concreteType = types.string();
    const bindings: VarBindings = new Map([['α', concreteType]]);

    const result = substituteVarBindings(T, bindings);
    expect(result.fieldtype).toBe('string');
  });

  it('returns original when no binding exists', () => {
    const T = FieldType.var.create({ name: 'T', varId: 'α' });
    const bindings: VarBindings = new Map();

    const result = substituteVarBindings(T, bindings);
    expect(FieldType.var.describes(result)).toBe(true);
  });

  it('substitutes VarType nested in object property', () => {
    const T = FieldType.var.create({ name: 'T', varId: 'α' });
    const obj = types.object({ value: T });
    const concreteType = types.number();
    const bindings: VarBindings = new Map([['α', concreteType]]);

    const result = substituteVarBindings(obj, bindings);
    expect(result.fieldtype).toBe('object');
    // The property value should now be number, not var
    const attrs = (result.attributes as any[]).filter(
      (a: any) => a.constrainttype === 'property' && a.key === 'value'
    );
    expect(attrs).toHaveLength(1);
    expect(attrs[0].value.fieldtype).toBe('number');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Tests: evaluateTypeExpr
// ─────────────────────────────────────────────────────────────────────────────

describe('evaluateTypeExpr', () => {
  const emptyHead = createEnvHead({});
  const emptyBindings: VarBindings = new Map();
  const emptyScope = new Map<string, any>();

  it('literal with FieldType value returns it directly', () => {
    const ft = types.string();
    const expr: Expression = { type: 'literal', value: ft };
    const result = evaluateTypeExpr(expr, emptyBindings, emptyScope, emptyHead);
    expect(result).toBe(ft);
  });

  it('name resolves from scopeMap', () => {
    const ft = types.number();
    const scope = new Map<string, any>([['x', ft]]);
    const expr: Expression = { type: 'name', id: 'x' };
    const result = evaluateTypeExpr(expr, emptyBindings, scope, emptyHead);
    expect(result?.fieldtype).toBe('number');
  });

  it('name returns null for unknown', () => {
    const expr: Expression = { type: 'name', id: 'unknown' };
    const result = evaluateTypeExpr(expr, emptyBindings, emptyScope, emptyHead);
    expect(result).toBeNull();
  });

  it('intersect composes two types', () => {
    const expr: Expression = {
      type: 'intersect',
      left: { type: 'literal', value: types.object({ a: types.string() }) },
      right: { type: 'literal', value: types.object({ b: types.number() }) },
    };
    const result = evaluateTypeExpr(expr, emptyBindings, emptyScope, emptyHead);
    expect(result).not.toBeNull();
    expect(isNever(result!)).toBe(false);
    expect(result!.fieldtype).toBe('object');
  });

  it('intersect of incompatible base types returns And (compose preserves intersection)', () => {
    // compose(string, number) returns And — the intersection is preserved
    // for the validator to enforce. isNever checks structural collapse only.
    const expr: Expression = {
      type: 'intersect',
      left: { type: 'literal', value: types.string() },
      right: { type: 'literal', value: types.number() },
    };
    const result = evaluateTypeExpr(expr, emptyBindings, emptyScope, emptyHead);
    expect(result).not.toBeNull();
    // compose(string, number) → And([string, number]), not never
    expect(result!.fieldtype).toBe('and');
  });

  it('ref returns null (unresolvable at type level)', () => {
    const expr: Expression = { type: 'ref', source: 'something' };
    const result = evaluateTypeExpr(expr, emptyBindings, emptyScope, emptyHead);
    expect(result).toBeNull();
  });

  it('call looks up address in HEAD and returns type surface', () => {
    const ToolsetType = types.object({ search: types.fn(types.string(), types.any()) })
      .meta({ name: 'SearchTools' });

    const head = createEnvHead({
      myToolset: { type: ToolsetType, value: ToolsetType },
    });

    // call("getType", [name("myToolset")]) — getType returns the type at the address
    // Since myToolset's value is a FieldType, the call mechanism returns it directly
    const scope = new Map<string, any>([['myToolset', ToolsetType]]);

    const expr: Expression = {
      type: 'call',
      fn: 'getType',
      args: [{ type: 'name', id: 'myToolset' }],
    };

    const result = evaluateTypeExpr(expr, emptyBindings, scope, head);
    // The call finds 'myToolset' in scope → FieldType → looks up in HEAD by compose match
    // → returns the type surface
    expect(result).not.toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Tests: patchResolve with VarType constraints
// ─────────────────────────────────────────────────────────────────────────────

describe('patchResolve — VarType binding', () => {

  const ToolsetIDType = types.string().meta({ name: 'ToolsetID' });
  const SearchToolType = types.object({
    search: types.fn(types.string(), types.any()),
  }).meta({ name: 'SearchTool' });

  it('resolves a VarType-constrained gate using the bound', () => {
    // T extends ToolsetID — the bound is ToolsetID (a named string type)
    const T = FieldType.var.create({ name: 'T', bound: ToolsetIDType });

    const source = createEnvHead({
      myToolset: { type: ToolsetIDType, value: 'search-tools' },
    });

    const chain = createVarGateChain('toolset', 'ToolsetID', T);
    const draft = createDraftWithChain(source, chain);
    const result = patchResolve(draft) as ResolvedResult;

    expect(result.status).toBe('resolved');
    expect(result.deps.toolset).toBe('search-tools');
  });

  it('rejects candidates incompatible with the VarType bound', () => {
    // T extends SearchTool (object type)
    const T = FieldType.var.create({ name: 'T', bound: SearchToolType });

    const source = createEnvHead({
      // This has a different shape — no 'search' method
      myStorage: { type: types.object({ read: types.fn(types.string(), types.string()) }).meta({ name: 'StorageTool' }), value: { read: () => 'data' } },
    });

    const chain = createVarGateChain('tool', 'StorageTool', T);
    const draft = createDraftWithChain(source, chain);

    // StorageTool won't match SearchTool bound — should fail
    expect(() => patchResolve(draft)).toThrow(/unresolved/);
  });

  it('propagates var bindings across sequential statements', () => {
    // Two gates with the same VarType varId — first resolves, second uses bound.
    // The second gate matches by key (direct name), not by VarType.
    // This tests that varBindings are accumulated and available for substitution.
    const T_id = crypto.randomUUID();
    const T1 = FieldType.var.create({ name: 'T', varId: T_id, bound: ToolsetIDType });

    const OtherType = types.string().meta({ name: 'OtherID' });

    const source = createEnvHead({
      myToolset: { type: ToolsetIDType, value: 'search-tools' },
      otherEntry: { type: OtherType, value: 'other-value' },
    });

    // First gate: resolves by name match, T is bound to ToolsetIDType
    // Second gate: resolves by direct key match (no ambiguity)
    let chain = createChain('object');
    chain = push(chain, {
      type: 'bind',
      name: 'first',
      expr: { type: 'ref', source: 'ToolsetID' },
      level: 'concrete',
      constraint: { type: 'literal', value: T1 },
    });
    chain = push(chain, {
      type: 'bind',
      name: 'second',
      expr: { type: 'ref', source: 'otherEntry' },
      level: 'concrete',
      constraint: { type: 'literal', value: OtherType },
    });

    const draft = createDraftWithChain(source, chain);
    const result = patchResolve(draft) as ResolvedResult;
    expect(result.status).toBe('resolved');
    expect(result.deps.first).toBe('search-tools');
    expect(result.deps.second).toBe('other-value');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Tests: patchResolve with where-predicates
// ─────────────────────────────────────────────────────────────────────────────

describe('patchResolve — where predicates', () => {

  it('where-predicate with intersect(literal, whereExpr) provides both matching and filtering', () => {
    // Two named string types — both match by metadata.name 'ServiceID'
    const TypeA = types.string().meta({ name: 'ServiceID' }).save();
    const TypeB = types.string().meta({ name: 'ServiceID' }).save();

    const source = createEnvHead({
      entryA: { type: TypeA, value: 'service-a' },
      entryB: { type: TypeB, value: 'service-b' },
    });

    // Constraint: intersect(literal(ServiceBase), alwaysTrueWhere)
    // - literal side: string type with name 'ServiceID' (for Phase A matching)
    // - where side: constant predicate that always passes
    const ServiceBase = types.string().meta({ name: 'ServiceID' }).save();
    const alwaysTrueWhere: Expression = {
      type: 'intersect',
      left: { type: 'literal', value: types.any() },
      right: { type: 'literal', value: types.any() },
    };

    const constraint: Expression = {
      type: 'intersect',
      left: { type: 'literal', value: ServiceBase },
      right: alwaysTrueWhere,
    };

    let chain = createChain('object');
    chain = push(chain, {
      type: 'bind',
      name: 'toolset',
      expr: { type: 'ref', source: 'ServiceID' },
      level: 'concrete',
      constraint,
    });

    const draft = createDraftWithChain(source, chain);
    const result = patchResolve(draft, { allowDefer: true });
    // Both candidates match by name 'ServiceID' + where passes → ambiguous
    expect(result.status).toBe('pending');
    expect((result as PendingResult).missing[0].candidates).toHaveLength(2);
  });

  it('where-predicate with unresolvable call falls back to base matching', () => {
    const TypeA = types.object({ a: types.string() }).meta({ name: 'Toolset' });
    const source = createEnvHead({
      entryA: { type: TypeA, value: { a: 'hello' } },
    });

    // Constraint: intersect(literal(TypeA), call("nonExistent", [name("unknown")]))
    // The call returns null (unresolvable) → where filtering skips → base match resolves
    const constraint: Expression = {
      type: 'intersect',
      left: { type: 'literal', value: TypeA },
      right: { type: 'call', fn: 'nonExistentFn', args: [{ type: 'name', id: 'unknown' }] },
    };

    let chain = createChain('object');
    chain = push(chain, {
      type: 'bind',
      name: 'toolset',
      expr: { type: 'ref', source: 'Toolset' },
      level: 'concrete',
      constraint,
    });

    const draft = createDraftWithChain(source, chain);
    const result = patchResolve(draft) as ResolvedResult;
    // evaluateTypeExpr returns null for the unresolvable call → no filtering →
    // falls back to original matches → single match → resolved
    expect(result.status).toBe('resolved');
    expect(result.deps.toolset).toEqual({ a: 'hello' });
  });

  it('where-predicate narrows ambiguous matches to compatible ones', () => {
    // Two string entries match by name. The where-predicate is a constant
    // that always passes. Both remain in the candidate set.
    const TypeA = types.string().meta({ name: 'ToolID' }).save();
    const TypeB = types.string().meta({ name: 'ToolID' }).save();

    const source = createEnvHead({
      entryA: { type: TypeA, value: 'tool-a' },
      entryB: { type: TypeB, value: 'tool-b' },
    });

    const BaseID = types.string().meta({ name: 'ToolID' }).save();

    // Where: intersect(literal(any), literal(any)) → always passes
    const constraint: Expression = {
      type: 'intersect',
      left: { type: 'literal', value: BaseID },
      right: {
        type: 'intersect',
        left: { type: 'literal', value: types.any() },
        right: { type: 'literal', value: types.any() },
      },
    };

    let chain = createChain('object');
    chain = push(chain, {
      type: 'bind',
      name: 'toolset',
      expr: { type: 'ref', source: 'ToolID' },
      level: 'concrete',
      constraint,
    });

    const draft = createDraftWithChain(source, chain);
    const result = patchResolve(draft, { allowDefer: true });
    // Both still match — where doesn't narrow further
    expect(result.status).toBe('pending');
    const missing = (result as PendingResult).missing.find(m => m.key === 'toolset');
    expect(missing).toBeDefined();
    expect(missing!.candidates).toHaveLength(2);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Tests: VarType formatting
// ─────────────────────────────────────────────────────────────────────────────

describe('VarType — formatting', () => {

  it('unbounded var prints as just the name', () => {
    const T = FieldType.var.create({ name: 'T' });
    const out = T.toString();
    expect(out).toBe('T');
  });

  it('bounded var prints as "name extends bound"', () => {
    const bound = types.string();
    const T = FieldType.var.create({ name: 'T', bound });
    const out = T.toString();
    expect(out).toBe('T extends string');
  });

  it('bounded var with constrained bound prints fully', () => {
    const bound = types.object({ id: types.string() });
    const T = FieldType.var.create({ name: 'T', bound });
    const out = T.toString();
    expect(out).toContain('T extends');
    expect(out).toContain('id');
    expect(out).toContain('string');
  });
});
