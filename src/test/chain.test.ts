import {
  createChain,
  push,
  fork,
  reduce,
  snapshot,
  diff,
  patch,
  rebase,
  cherry,
  compact,
  chainToJSON,
  chainFromJSON,
  compilationLens,
  schemaLens,
  isImportBinding,
  chainFromFieldType,
  collectStatements,
  evaluateExpr,
  isConcrete,
  chainRange,
  splice,
} from '../chain.js';
import type { ChainSegment } from '../chain.js';
import { concrete, type_, ref, annotate, scope, scopeTerminate, patch as stmtPatch } from '../statement.js';
import type { Expression, AnnotationNode } from '../statement.js';
import { FieldType } from '../type.js';
import { types } from '../builders.js';

// ─────────────────────────────────────────────────────────────────────────────
// createChain / push / fork
// ─────────────────────────────────────────────────────────────────────────────

describe('createChain', () => {
  it('creates empty chain with constructor', () => {
    const c = createChain('object');
    expect(c.constructor).toBe('object');
    expect(c.statements).toHaveLength(0);
    expect(c.head).toBe(-1);
    expect(c.parent).toBeUndefined();
  });
});

describe('push', () => {
  it('appends statement and advances head', () => {
    let c = createChain('object');
    c = push(c, concrete('x', { type: 'literal', value: 1 }));
    expect(c.statements).toHaveLength(1);
    expect(c.head).toBe(0);

    c = push(c, concrete('y', { type: 'literal', value: 2 }));
    expect(c.statements).toHaveLength(2);
    expect(c.head).toBe(1);
  });

  it('is immutable — original chain unchanged', () => {
    const c1 = createChain('object');
    const c2 = push(c1, concrete('x', { type: 'literal', value: 1 }));
    expect(c1.statements).toHaveLength(0);
    expect(c2.statements).toHaveLength(1);
  });
});

describe('fork', () => {
  it('creates child with parent pointer', () => {
    let parent = createChain('object');
    parent = push(parent, concrete('x', { type: 'literal', value: 1 }));

    const child = fork(parent);
    expect(child.parent).toBeDefined();
    expect(child.parent!.chain).toBe(parent);
    expect(child.parent!.at).toBe(parent.head);
    expect(child.statements).toHaveLength(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// reduce
// ─────────────────────────────────────────────────────────────────────────────

describe('reduce', () => {
  it('reduces concrete literal statements to resolved bindings', () => {
    let c = createChain('object');
    c = push(c, concrete('host', { type: 'literal', value: 'localhost' }));
    c = push(c, concrete('port', { type: 'literal', value: 8080 }));
    const { scope, resolved, unresolved } = reduce(c);
    expect(resolved).toEqual(['host', 'port']);
    expect(unresolved).toHaveLength(0);
    expect(scope.bindings.get('host')!.value).toBe('localhost');
    expect(scope.bindings.get('port')!.value).toBe(8080);
  });

  it('concrete ref statements produce unresolved bindings', () => {
    let c = createChain('object');
    c = push(c, concrete('apiKey', { type: 'ref', source: 'string' }));

    const { unresolved } = reduce(c);
    expect(unresolved).toEqual(['apiKey']);
  });

  it('later statement overrides earlier at same name', () => {
    let c = createChain('object');
    c = push(c, concrete('x', { type: 'literal', value: 1 }));
    c = push(c, concrete('x', { type: 'literal', value: 2 }));

    const { scope } = reduce(c);
    expect(scope.bindings.get('x')!.value).toBe(2);
  });

  it('concrete literal overrides concrete ref at same name', () => {
    let c = createChain('object');
    c = push(c, concrete('key', { type: 'ref', source: 'string' }));
    c = push(c, concrete('key', { type: 'literal', value: 'abc' }));

    const { scope, resolved, unresolved } = reduce(c);
    expect(resolved).toContain('key');
    expect(unresolved).not.toContain('key');
    expect(scope.bindings.get('key')!.value).toBe('abc');
  });

  it('includes parent statements in forked chains', () => {
    let parent = createChain('object');
    parent = push(parent, concrete('base', { type: 'literal', value: 'from-parent' }));

    let child = fork(parent);
    child = push(child, concrete('extra', { type: 'literal', value: 'from-child' }));

    const { scope, resolved } = reduce(child);
    expect(resolved).toContain('base');
    expect(resolved).toContain('extra');
    expect(scope.bindings.get('base')!.value).toBe('from-parent');
  });

  it('handles export statements', () => {
    let c = createChain('object');
    c = push(c, concrete('x', { type: 'literal', value: 1 }));
    c = push(c, concrete('y', { type: 'literal', value: 2 }));
    c = push(c, { type: 'export', names: ['x'] });

    const { scope } = reduce(c);
    expect(scope.exports.has('x')).toBe(true);
    expect(scope.exports.has('y')).toBe(false);
  });

  it('handles wildcard export with except', () => {
    let c = createChain('object');
    c = push(c, concrete('a', { type: 'literal', value: 1 }));
    c = push(c, concrete('b', { type: 'literal', value: 2 }));
    c = push(c, concrete('internal', { type: 'literal', value: 3 }));
    c = push(c, { type: 'export', names: '*', except: ['internal'] });

    const { scope } = reduce(c);
    expect(scope.exports.has('a')).toBe(true);
    expect(scope.exports.has('b')).toBe(true);
    expect(scope.exports.has('internal')).toBe(false);
  });

  it('handles import statements as ref gate bindings (structural import detection)', () => {
    let c = createChain('object');
    c = push(c, { type: 'import', source: 'myPackage', scope: 'myPackage' });

    const { scope, unresolved } = reduce(c);
    expect(scope.bindings.has('myPackage')).toBe(true);
    const binding = scope.bindings.get('myPackage')!;
    expect(binding.level).toBe('concrete');
    expect(binding.resolved).toBe(false);
    expect(isImportBinding('myPackage', binding)).toBe(true);
    expect(binding.expr).toEqual({ type: 'ref', source: 'myPackage' });
    expect(unresolved).toContain('myPackage');
  });

  it('preserves scope and default on ref gate bindings', () => {
    let c = createChain('object');
    c = push(c, {
      type: 'bind',
      name: 'steps',
      expr: { type: 'ref', source: 'steps' },
      level: 'concrete',
      scope: 'optional',
      default: { type: 'literal', value: 10 },
    });
    c = push(c, {
      type: 'bind',
      name: 'model',
      expr: { type: 'ref', source: 'InstalledLLM' },
      level: 'concrete',
    });

    const { scope, unresolved } = reduce(c);
    expect(unresolved).toContain('steps');
    expect(unresolved).toContain('model');

    const stepsBinding = scope.bindings.get('steps')!;
    expect(stepsBinding.scope).toBe('optional');
    expect(stepsBinding.default).toEqual({ type: 'literal', value: 10 });

    const modelBinding = scope.bindings.get('model')!;
    expect(modelBinding.scope).toBeUndefined();
    expect(modelBinding.default).toBeUndefined();
  });

  it('handles annotate statements', () => {
    let c = createChain('object');
    c = push(c, { type: 'annotate', body: [{ kind: 'text' as const, content: 'hello' }] });

    const { scope } = reduce(c);
    expect(Object.keys(scope.meta)).toHaveLength(1);
    expect(scope.meta['annotate:0']).toEqual([{ kind: 'text', content: 'hello' }]);
  });

  it('lens can force resolution of blocked bindings', () => {
    let c = createChain('object');
    c = push(c, concrete('key', { type: 'ref', source: 'string' }));

    // Schema lens forces everything
    const { resolved } = reduce(c, schemaLens);
    expect(resolved).toContain('key');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// snapshot
// ─────────────────────────────────────────────────────────────────────────────

describe('snapshot', () => {
  it('produces a FieldType object from a chain', () => {
    let c = createChain('object');
    c = push(c, concrete('host', { type: 'literal', value: 'localhost' }));
    c = push(c, concrete('port', { type: 'literal', value: 8080 }));

    const ft = snapshot(c);
    expect(FieldType.describes(ft)).toBe(true);
    expect(ft.fieldtype).toBe('object');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// diff / patch
// ─────────────────────────────────────────────────────────────────────────────

describe('diff', () => {
  it('computes delta between chains', () => {
    let base = createChain('object');
    base = push(base, concrete('x', { type: 'literal', value: 1 }));

    let branch = fork(base);
    branch = push(branch, concrete('y', { type: 'literal', value: 2 }));

    const changeset = diff(base, branch);
    expect(changeset.statements).toHaveLength(1);
    expect((changeset.statements[0] as any).name).toBe('y');
  });

  it('empty diff for identical chains', () => {
    let c = createChain('object');
    c = push(c, concrete('x', { type: 'literal', value: 1 }));

    const changeset = diff(c, c);
    expect(changeset.statements).toHaveLength(0);
  });
});

describe('patch', () => {
  it('applies changeset to chain', () => {
    let base = createChain('object');
    base = push(base, concrete('x', { type: 'literal', value: 1 }));

    const changeset = {
      statements: [concrete('y', { type: 'literal', value: 2 })],
      fromHead: 0,
      toHead: 1,
    };

    const patched = patch(base, changeset);
    const { scope } = reduce(patched);
    expect(scope.bindings.get('x')!.value).toBe(1);
    expect(scope.bindings.get('y')!.value).toBe(2);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// rebase
// ─────────────────────────────────────────────────────────────────────────────

describe('rebase', () => {
  it('replays branch statements onto new base', () => {
    let base = createChain('object');
    base = push(base, concrete('x', { type: 'literal', value: 1 }));

    let branch = fork(base);
    branch = push(branch, concrete('y', { type: 'literal', value: 2 }));

    // Base evolves
    let newBase = push(base, concrete('z', { type: 'literal', value: 3 }));

    const rebased = rebase(branch, newBase);
    const { scope } = reduce(rebased);
    expect(scope.bindings.has('x')).toBe(true);
    expect(scope.bindings.has('z')).toBe(true);
    expect(scope.bindings.has('y')).toBe(true);
    expect(scope.bindings.get('y')!.value).toBe(2);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// cherry
// ─────────────────────────────────────────────────────────────────────────────

describe('cherry', () => {
  it('applies selected statements from changeset', () => {
    let base = createChain('object');

    const changeset = {
      statements: [
        concrete('a', { type: 'literal', value: 1 }),
        concrete('b', { type: 'literal', value: 2 }),
        concrete('c', { type: 'literal', value: 3 }),
      ],
      fromHead: -1,
      toHead: 2,
    };

    const picked = cherry(base, changeset, (s) => s.type === 'bind' && s.name === 'b');
    const { scope } = reduce(picked);
    expect(scope.bindings.has('a')).toBe(false);
    expect(scope.bindings.has('b')).toBe(true);
    expect(scope.bindings.has('c')).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// compact
// ─────────────────────────────────────────────────────────────────────────────

describe('compact', () => {
  it('compacts prefix and keeps recent tail', () => {
    let c = createChain('object');
    c = push(c, concrete('a', { type: 'literal', value: 1 }));
    c = push(c, concrete('b', { type: 'literal', value: 2 }));
    c = push(c, concrete('a', { type: 'literal', value: 10 })); // overrides
    c = push(c, concrete('c', { type: 'literal', value: 3 }));

    const compacted = compact(c, { keep: 1 });

    // Reduce should produce same result
    const { scope: original } = reduce(c);
    const { scope: comp } = reduce(compacted);

    expect(comp.bindings.get('a')!.value).toBe(original.bindings.get('a')!.value);
    expect(comp.bindings.get('b')!.value).toBe(original.bindings.get('b')!.value);
    expect(comp.bindings.get('c')!.value).toBe(original.bindings.get('c')!.value);
  });

  it('returns same chain when keep >= total statements', () => {
    let c = createChain('object');
    c = push(c, concrete('x', { type: 'literal', value: 1 }));

    const compacted = compact(c, { keep: 10 });
    expect(compacted).toBe(c);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// serialization
// ─────────────────────────────────────────────────────────────────────────────

describe('chainToJSON / chainFromJSON', () => {
  it('round-trips a chain', () => {
    let c = createChain('object');
    c = push(c, concrete('x', { type: 'literal', value: 1 }));
    c = push(c, concrete('y', { type: 'ref', source: 'string' }));

    const json = chainToJSON(c);
    const restored = chainFromJSON(json);

    expect(restored.constructor).toBe(c.constructor);
    expect(restored.statements).toHaveLength(2);
    expect(restored.head).toBe(c.head);
  });

  it('preserves parent reference as chainId', () => {
    let parent = createChain('object');
    parent = push(parent, concrete('x', { type: 'literal', value: 1 }));
    const child = fork(parent);

    const json = chainToJSON(child);
    expect(json.parent).toBeDefined();
    expect(json.parent!.chainId).toBe(parent.id);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Statement types in chain: direct push of union variants
// ─────────────────────────────────────────────────────────────────────────────

describe('push with Statement union variants', () => {
  it('push bind blocks', () => {
    let c = createChain('object');
    c = push(c, { type: 'bind', name: 'x', expr: { type: 'literal', value: 42 }, level: 'concrete' });
    c = push(c, { type: 'bind', name: 'key', expr: { type: 'ref', source: 'string' }, level: 'concrete' });

    const { scope } = reduce(c);
    expect(scope.bindings.has('x')).toBe(true);
    expect(scope.bindings.get('x')!.value).toBe(42);
    expect(scope.bindings.has('key')).toBe(true);
    expect(scope.bindings.get('key')!.resolved).toBe(false);
  });

  it('push import blocks', () => {
    let c = createChain('object');
    c = push(c, { type: 'import', source: 'myPackage', scope: 'myPackage' });

    const { scope } = reduce(c);
    expect(scope.bindings.has('myPackage')).toBe(true);
    expect(isImportBinding('myPackage', scope.bindings.get('myPackage')!)).toBe(true);
    expect(scope.bindings.get('myPackage')!.resolved).toBe(false);
  });

  it('push export blocks', () => {
    let c = createChain('object');
    c = push(c, concrete('x', { type: 'literal', value: 1 }));
    c = push(c, { type: 'export', names: ['x'] });

    const { scope } = reduce(c);
    expect(scope.exports.has('x')).toBe(true);
  });

  it('push annotate blocks', () => {
    let c = createChain('object');
    c = push(c, { type: 'annotate', body: [{ kind: 'text' as const, content: 'hello' }] });

    const { scope } = reduce(c);
    expect(Object.keys(scope.meta)).toHaveLength(1);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// lenses
// ─────────────────────────────────────────────────────────────────────────────

describe('lenses', () => {
  it('compilationLens preserves blocked/resolved status', () => {
    let c = createChain('object');
    c = push(c, concrete('blocked', { type: 'ref', source: 'string' }));
    c = push(c, concrete('resolved', { type: 'literal', value: 'ok' }));

    const { unresolved, resolved } = reduce(c, compilationLens);
    expect(unresolved).toContain('blocked');
    expect(resolved).toContain('resolved');
  });

  it('schemaLens forces everything resolved', () => {
    let c = createChain('object');
    c = push(c, concrete('blocked', { type: 'ref', source: 'string' }));
    c = push(c, concrete('resolved', { type: 'literal', value: 'ok' }));

    const { unresolved, resolved } = reduce(c, schemaLens);
    expect(unresolved).toHaveLength(0);
    expect(resolved).toContain('blocked');
    expect(resolved).toContain('resolved');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// chainFromFieldType — behavioral constraint emission
// ─────────────────────────────────────────────────────────────────────────────

describe('chainFromFieldType behavioral constraints', () => {
  it('emits type-level binds for behavioral constraints on properties', () => {
    const ft = types.object({
      apiKey: types.string().merge('source-wins').persist('encrypted').save(),
    });

    const chain = chainFromFieldType(ft);
    const stmts = collectStatements(chain);

    // Should have: concrete ref gate (apiKey), type-level merge, type-level persist
    const typeLevelBinds = stmts.filter(
      (s: any) => s.type === 'bind' && s.level === 'type',
    );
    expect(typeLevelBinds.length).toBe(2);

    const mergeStmt = typeLevelBinds.find((s: any) => s.name === 'apiKey:merge');
    expect(mergeStmt).toBeDefined();
    expect((mergeStmt as any).expr.type).toBe('literal');
    expect((mergeStmt as any).expr.value.value).toBe('source-wins');

    const persistStmt = typeLevelBinds.find((s: any) => s.name === 'apiKey:persist');
    expect(persistStmt).toBeDefined();
    expect((persistStmt as any).expr.type).toBe('literal');
    expect((persistStmt as any).expr.value.sink).toBe('encrypted');
  });

  it('type-level binds are always resolved in scope', () => {
    const ft = types.object({
      theme: types.string().literal('dark').merge('last-write').save(),
    });

    const chain = chainFromFieldType(ft);
    const { scope, resolved } = reduce(chain);

    // theme:merge should be resolved (type-level)
    expect(resolved).toContain('theme:merge');
    const mergeBinding = scope.bindings.get('theme:merge');
    expect(mergeBinding).toBeDefined();
    expect(mergeBinding!.level).toBe('type');
    expect(mergeBinding!.resolved).toBe(true);
  });

  it('emits no type-level binds when no behavioral constraints present', () => {
    const ft = types.object({
      name: types.string(),
    });

    const chain = chainFromFieldType(ft);
    const stmts = collectStatements(chain);

    const typeLevelBinds = stmts.filter(
      (s: any) => s.type === 'bind' && s.level === 'type',
    );
    expect(typeLevelBinds.length).toBe(0);
  });

  it('existing chainFromFieldType tests pass — behavioral absent = no behavioral binds', () => {
    const ft = types.object({
      host: types.string(),
      port: types.number(),
    });

    const chain = chainFromFieldType(ft);
    const { unresolved } = reduce(chain);

    // Both should still be unresolved ref gates
    expect(unresolved).toContain('host');
    expect(unresolved).toContain('port');
  });

  it('emits all 7 behavioral constraint types', () => {
    const ft = types.object({
      data: types.string()
        .merge('source-wins')
        .persist('encrypted')
        .compact({ retain: 3 })
        .subscribe('events')
        .fork('copy')
        .visibility('owner')
        .decorator('decrypt')
        .save(),
    });

    const chain = chainFromFieldType(ft);
    const stmts = collectStatements(chain);

    const typeLevelNames = stmts
      .filter((s: any) => s.type === 'bind' && s.level === 'type')
      .map((s: any) => s.name);

    expect(typeLevelNames).toContain('data:merge');
    expect(typeLevelNames).toContain('data:persist');
    expect(typeLevelNames).toContain('data:compact');
    expect(typeLevelNames).toContain('data:subscribe');
    expect(typeLevelNames).toContain('data:fork');
    expect(typeLevelNames).toContain('data:visibility');
    expect(typeLevelNames).toContain('data:decorator');
    expect(typeLevelNames.length).toBe(7);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Nameless binds (bare expressions / splices)
// ─────────────────────────────────────────────────────────────────────────────

describe('nameless binds', () => {
  it('nameless bind does not create a scope binding', () => {
    let c = createChain('test');
    c = push(c, concrete('a', { type: 'literal', value: 1 }));
    c = push(c, { type: 'bind', expr: ref('xyz'), level: 'concrete' });
    c = push(c, concrete('b', { type: 'literal', value: 2 }));

    const { scope, unresolved, resolved } = reduce(c);

    // Named binds are in scope
    expect(scope.bindings.has('a')).toBe(true);
    expect(scope.bindings.has('b')).toBe(true);
    // Nameless bind is NOT in scope
    expect(scope.bindings.size).toBe(2);
    // Not in unresolved/resolved lists
    expect(unresolved).toEqual([]);
    expect(resolved).toEqual(['a', 'b']);
  });

  it('nameless bind is preserved in collectStatements', () => {
    let c = createChain('test');
    const bareRef = { type: 'bind' as const, expr: ref('page2'), level: 'concrete' as const };
    c = push(c, concrete('x', { type: 'literal', value: 'hello' }));
    c = push(c, bareRef);

    const stmts = collectStatements(c);
    expect(stmts).toHaveLength(2);
    expect(stmts[1]).toBe(bareRef);
  });

  it('nameless bind survives fork and diff', () => {
    let parent = createChain('test');
    parent = push(parent, concrete('a', { type: 'literal', value: 1 }));

    let child = fork(parent);
    const bareRef = { type: 'bind' as const, expr: ref('splice'), level: 'concrete' as const };
    child = push(child, bareRef);
    child = push(child, concrete('b', { type: 'literal', value: 2 }));

    const delta = diff(parent, child);
    expect(delta.statements).toHaveLength(2);
    expect(delta.statements[0]).toBe(bareRef);
  });

  it('nameless type-level bind acts as annotation', () => {
    let c = createChain('test');
    c = push(c, { type: 'bind', expr: { type: 'literal', value: 'metadata' }, level: 'type' });
    c = push(c, concrete('x', { type: 'literal', value: 42 }));

    const { scope } = reduce(c);
    // Only the named bind is in scope
    expect(scope.bindings.size).toBe(1);
    expect(scope.bindings.get('x')?.value).toBe(42);
    // The nameless type-level bind is in the chain but not in scope
    expect(collectStatements(c)).toHaveLength(2);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// evaluateExpr — expression evaluation against scope
// ─────────────────────────────────────────────────────────────────────────────

describe('evaluateExpr', () => {
  it('name resolves from prior binding in scope', () => {
    let c = createChain('object');
    c = push(c, concrete('a', { type: 'literal', value: 42 }));
    c = push(c, concrete('b', { type: 'name', id: 'a' }));

    const { scope, resolved } = reduce(c);
    expect(resolved).toContain('b');
    expect(scope.bindings.get('b')!.value).toBe(42);
    expect(scope.bindings.get('b')!.resolved).toBe(true);
  });

  it('call resolves when fn and args concrete', () => {
    let c = createChain('object');
    c = push(c, concrete('add', { type: 'literal', value: (x: number, y: number) => x + y }));
    c = push(c, concrete('r', { type: 'call', fn: 'add', args: [
      { type: 'literal', value: 2 },
      { type: 'literal', value: 3 },
    ] }));

    const { scope, resolved } = reduce(c);
    expect(resolved).toContain('r');
    expect(scope.bindings.get('r')!.value).toBe(5);
  });

  it('call with unresolved name arg falls back to extractValue', () => {
    // blocked decision is based on hasRefConstraint, not evaluateExpr success.
    // A call where the fn IS in scope but an arg is missing falls back to
    // extractValue (returns undefined for calls), keeping resolved: true.
    let c = createChain('object');
    c = push(c, concrete('add', { type: 'literal', value: (x: number, y: number) => x + y }));
    c = push(c, concrete('r', { type: 'call', fn: 'add', args: [
      { type: 'name', id: 'missing' },
      { type: 'literal', value: 3 },
    ] }));

    const { scope, resolved } = reduce(c);
    // Not blocked (no ref constraint), but evaluateExpr can't evaluate →
    // falls back to extractValue which returns undefined for calls.
    expect(resolved).toContain('r');
    expect(scope.bindings.get('r')!.resolved).toBe(true);
    expect(scope.bindings.get('r')!.value).toBeUndefined();
  });

  it('forward reference falls back to extractValue (name as symbolic ref)', () => {
    // name expressions where the referent isn't yet in scope fall back to
    // extractValue which returns the name string (symbolic reference).
    let c = createChain('object');
    c = push(c, concrete('b', { type: 'name', id: 'a' }));
    c = push(c, concrete('a', { type: 'literal', value: 42 }));

    const { scope, resolved } = reduce(c);
    // b is resolved (no ref constraint), value = 'a' from extractValue
    expect(resolved).toContain('b');
    expect(scope.bindings.get('b')!.value).toBe('a');
  });

  it('ref expressions still block (unchanged)', () => {
    let c = createChain('object');
    c = push(c, concrete('x', { type: 'ref', source: 'T' }));

    const { unresolved } = reduce(c);
    expect(unresolved).toContain('x');
  });

  it('object expression evaluates properties', () => {
    let c = createChain('object');
    c = push(c, concrete('a', { type: 'literal', value: 1 }));
    c = push(c, concrete('obj', {
      type: 'object',
      properties: {
        x: { type: 'name', id: 'a' } as Expression,
        y: { type: 'literal', value: 2 } as Expression,
      },
    }));

    const { scope, resolved } = reduce(c);
    expect(resolved).toContain('obj');
    expect(scope.bindings.get('obj')!.value).toEqual({ x: 1, y: 2 });
  });

  it('nested calls', () => {
    let c = createChain('object');
    c = push(c, concrete('inc', { type: 'literal', value: (x: number) => x + 1 }));
    c = push(c, concrete('dbl', { type: 'literal', value: (x: number) => x * 2 }));
    c = push(c, concrete('r', {
      type: 'call',
      fn: 'dbl',
      args: [{
        type: 'call',
        fn: 'inc',
        args: [{ type: 'literal', value: 3 }],
      }],
    }));

    const { scope } = reduce(c);
    expect(scope.bindings.get('r')!.value).toBe(8);
  });

  it('lens still overrides blocked decision for refs', () => {
    let c = createChain('object');
    // A ref binding → blocked
    c = push(c, concrete('r', { type: 'ref', source: 'T' }));

    // Without lens: blocked
    const { unresolved } = reduce(c);
    expect(unresolved).toContain('r');

    // With schemaLens: forced resolved
    const { resolved } = reduce(c, schemaLens);
    expect(resolved).toContain('r');
  });

  it('intersect expression merges objects', () => {
    let c = createChain('object');
    c = push(c, concrete('merged', {
      type: 'intersect',
      left: { type: 'literal', value: { a: 1 } },
      right: { type: 'literal', value: { b: 2 } },
    }));

    const { scope } = reduce(c);
    expect(scope.bindings.get('merged')!.value).toEqual({ a: 1, b: 2 });
  });

  it('isConcrete convenience function', () => {
    let c = createChain('object');
    c = push(c, concrete('x', { type: 'literal', value: 10 }));
    const { scope } = reduce(c);

    expect(isConcrete({ type: 'name', id: 'x' }, scope)).toBe(true);
    expect(isConcrete({ type: 'name', id: 'missing' }, scope)).toBe(false);
    expect(isConcrete({ type: 'ref', source: 'T' }, scope)).toBe(false);
  });

  it('call with inline function expression (not name-based)', () => {
    let c = createChain('object');
    c = push(c, concrete('r', {
      type: 'call',
      fn: { type: 'literal', value: (x: number) => x * 10 },
      args: [{ type: 'literal', value: 5 }],
    }));

    const { scope } = reduce(c);
    expect(scope.bindings.get('r')!.value).toBe(50);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Chain Segments (Phase 3)
// ─────────────────────────────────────────────────────────────────────────────

describe('chain segments', () => {
  it('createChain produces single inline segment', () => {
    const c = createChain('object');
    expect(c.segments).toHaveLength(1);
    expect(c.segments[0].kind).toBe('inline');
    expect((c.segments[0] as { kind: 'inline'; statements: any[] }).statements).toHaveLength(0);
  });

  it('fork produces ref + inline segments', () => {
    let parent = createChain('object');
    parent = push(parent, concrete('x', { type: 'literal', value: 1 }));

    const child = fork(parent);
    expect(child.segments).toHaveLength(2);
    expect(child.segments[0].kind).toBe('ref');
    expect(child.segments[1].kind).toBe('inline');

    const refSeg = child.segments[0] as { kind: 'ref'; chain: any; at: number };
    expect(refSeg.chain).toBe(parent);
    expect(refSeg.at).toBe(parent.head);
  });

  it('push appends to last inline segment', () => {
    let c = createChain('object');
    c = push(c, concrete('a', { type: 'literal', value: 1 }));
    c = push(c, concrete('b', { type: 'literal', value: 2 }));

    expect(c.segments).toHaveLength(1);
    const inlineSeg = c.segments[0] as { kind: 'inline'; statements: any[] };
    expect(inlineSeg.statements).toHaveLength(2);
  });

  it('push on forked chain appends to last inline (not ref)', () => {
    let parent = createChain('object');
    parent = push(parent, concrete('x', { type: 'literal', value: 1 }));

    let child = fork(parent);
    child = push(child, concrete('y', { type: 'literal', value: 2 }));

    expect(child.segments).toHaveLength(2);
    expect(child.segments[0].kind).toBe('ref');
    const inlineSeg = child.segments[1] as { kind: 'inline'; statements: any[] };
    expect(inlineSeg.statements).toHaveLength(1);
  });

  it('collectStatements flattens ref + inline into ordered list', () => {
    let parent = createChain('object');
    parent = push(parent, concrete('a', { type: 'literal', value: 1 }));
    parent = push(parent, concrete('b', { type: 'literal', value: 2 }));

    let child = fork(parent);
    child = push(child, concrete('c', { type: 'literal', value: 3 }));

    const stmts = collectStatements(child);
    expect(stmts).toHaveLength(3);
    expect((stmts[0] as any).name).toBe('a');
    expect((stmts[1] as any).name).toBe('b');
    expect((stmts[2] as any).name).toBe('c');
  });

  it('reduce over forked segmented chain equals reduce over flattened', () => {
    let parent = createChain('object');
    parent = push(parent, concrete('x', { type: 'literal', value: 10 }));
    parent = push(parent, concrete('y', { type: 'literal', value: 20 }));

    let child = fork(parent);
    child = push(child, concrete('z', { type: 'literal', value: 30 }));
    child = push(child, concrete('x', { type: 'literal', value: 99 })); // override parent

    // Build flat equivalent
    let flat = createChain('object');
    flat = push(flat, concrete('x', { type: 'literal', value: 10 }));
    flat = push(flat, concrete('y', { type: 'literal', value: 20 }));
    flat = push(flat, concrete('z', { type: 'literal', value: 30 }));
    flat = push(flat, concrete('x', { type: 'literal', value: 99 }));

    const { scope: segScope } = reduce(child);
    const { scope: flatScope } = reduce(flat);

    expect(segScope.bindings.get('x')!.value).toBe(flatScope.bindings.get('x')!.value);
    expect(segScope.bindings.get('y')!.value).toBe(flatScope.bindings.get('y')!.value);
    expect(segScope.bindings.get('z')!.value).toBe(flatScope.bindings.get('z')!.value);
  });

  it('backward compat: chain.parent derived from first ref segment', () => {
    let parent = createChain('object');
    parent = push(parent, concrete('x', { type: 'literal', value: 1 }));

    const child = fork(parent);
    expect(child.parent).toBeDefined();
    expect(child.parent!.chain).toBe(parent);
    expect(child.parent!.at).toBe(parent.head);
  });

  it('backward compat: chain.statements derived from last inline segment', () => {
    let parent = createChain('object');
    parent = push(parent, concrete('x', { type: 'literal', value: 1 }));

    let child = fork(parent);
    child = push(child, concrete('y', { type: 'literal', value: 2 }));
    child = push(child, concrete('z', { type: 'literal', value: 3 }));

    // chain.statements = own inline statements only (not parent's)
    expect(child.statements).toHaveLength(2);
    expect((child.statements[0] as any).name).toBe('y');
    expect((child.statements[1] as any).name).toBe('z');
  });

  it('serialization round-trips segments (via parent + statements compat)', () => {
    let parent = createChain('object');
    parent = push(parent, concrete('x', { type: 'literal', value: 1 }));

    let child = fork(parent);
    child = push(child, concrete('y', { type: 'literal', value: 2 }));

    const json = chainToJSON(child);
    const restored = chainFromJSON(json, parent);

    // Segments reconstructed
    expect(restored.segments).toHaveLength(2);
    expect(restored.segments[0].kind).toBe('ref');
    expect(restored.segments[1].kind).toBe('inline');

    // Reduce produces same result
    const { scope: orig } = reduce(child);
    const { scope: rest } = reduce(restored);
    expect(rest.bindings.get('x')!.value).toBe(orig.bindings.get('x')!.value);
    expect(rest.bindings.get('y')!.value).toBe(orig.bindings.get('y')!.value);
  });
});

describe('chainRange', () => {
  it('creates ref segment for a chain', () => {
    let c = createChain('object');
    c = push(c, concrete('x', { type: 'literal', value: 1 }));
    c = push(c, concrete('y', { type: 'literal', value: 2 }));

    const seg = chainRange(c);
    expect(seg.kind).toBe('ref');
    expect((seg as any).chain).toBe(c);
    expect((seg as any).at).toBe(c.head);
  });

  it('chainRange with explicit at creates bounded ref', () => {
    let c = createChain('object');
    c = push(c, concrete('x', { type: 'literal', value: 1 }));
    c = push(c, concrete('y', { type: 'literal', value: 2 }));
    c = push(c, concrete('z', { type: 'literal', value: 3 }));

    const seg = chainRange(c, 0);
    expect(seg.kind).toBe('ref');
    expect((seg as any).at).toBe(0);
  });
});

describe('splice', () => {
  it('splice appends segments before last inline (default position)', () => {
    let target = createChain('object');
    target = push(target, concrete('a', { type: 'literal', value: 1 }));

    let source = createChain('object');
    source = push(source, concrete('b', { type: 'literal', value: 2 }));
    source = push(source, concrete('c', { type: 'literal', value: 3 }));

    const refSeg = chainRange(source);
    const spliced = splice(target, [refSeg]);

    // Should have: original inline (a), ref segment (b,c), fresh inline
    const stmts = collectStatements(spliced);
    expect(stmts.length).toBeGreaterThanOrEqual(3);

    const { scope } = reduce(spliced);
    expect(scope.bindings.get('a')!.value).toBe(1);
    expect(scope.bindings.get('b')!.value).toBe(2);
    expect(scope.bindings.get('c')!.value).toBe(3);
  });

  it('splice with empty target appends ref segments', () => {
    let target = createChain('object');

    let source = createChain('object');
    source = push(source, concrete('x', { type: 'literal', value: 42 }));

    const spliced = splice(target, [chainRange(source)]);
    const { scope } = reduce(spliced);
    expect(scope.bindings.get('x')!.value).toBe(42);
  });

  it('splice from multiple sources', () => {
    let target = createChain('object');
    target = push(target, concrete('base', { type: 'literal', value: 'origin' }));

    let srcA = createChain('object');
    srcA = push(srcA, concrete('fromA', { type: 'literal', value: 'alpha' }));

    let srcB = createChain('object');
    srcB = push(srcB, concrete('fromB', { type: 'literal', value: 'beta' }));

    const spliced = splice(target, [chainRange(srcA), chainRange(srcB)]);
    const { scope } = reduce(spliced);
    expect(scope.bindings.get('base')!.value).toBe('origin');
    expect(scope.bindings.get('fromA')!.value).toBe('alpha');
    expect(scope.bindings.get('fromB')!.value).toBe('beta');
  });

  it('splice preserves existing chain content', () => {
    let target = createChain('object');
    target = push(target, concrete('x', { type: 'literal', value: 1 }));
    target = push(target, concrete('y', { type: 'literal', value: 2 }));

    let source = createChain('object');
    source = push(source, concrete('z', { type: 'literal', value: 3 }));

    const spliced = splice(target, [chainRange(source)]);
    const { scope } = reduce(spliced);

    // All three bindings present
    expect(scope.bindings.get('x')!.value).toBe(1);
    expect(scope.bindings.get('y')!.value).toBe(2);
    expect(scope.bindings.get('z')!.value).toBe(3);
  });

  it('spliced overrides follow statement order', () => {
    let target = createChain('object');
    target = push(target, concrete('x', { type: 'literal', value: 'original' }));

    let source = createChain('object');
    source = push(source, concrete('x', { type: 'literal', value: 'override' }));

    // Splice appends source after target content
    const spliced = splice(target, [chainRange(source)]);
    const { scope } = reduce(spliced);
    expect(scope.bindings.get('x')!.value).toBe('override');
  });

  it('positional splice inserts at specific index', () => {
    let target = createChain('object');
    target = push(target, concrete('a', { type: 'literal', value: 1 }));
    target = push(target, concrete('b', { type: 'literal', value: 2 }));
    target = push(target, concrete('c', { type: 'literal', value: 3 }));

    let source = createChain('object');
    source = push(source, concrete('inserted', { type: 'literal', value: 99 }));

    // Splice at position 1 (after 'a', before 'b')
    const spliced = splice(target, [chainRange(source)], 1);
    const stmts = collectStatements(spliced);

    // Order: a, inserted, b, c
    expect((stmts[0] as any).name).toBe('a');
    expect((stmts[1] as any).name).toBe('inserted');
    expect((stmts[2] as any).name).toBe('b');
    expect((stmts[3] as any).name).toBe('c');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Patch composition with merge function
// ─────────────────────────────────────────────────────────────────────────────

describe('patch composition with merge function', () => {
  it('dispatches through merge function from type-level binding', () => {
    // Install a string concat merge function + type-level merge binding
    let c = createChain('object');
    c = push(c, concrete('concat', { type: 'literal', value: (a: string, b: string) => a + b }));
    c = push(c, type_('content:merge', { type: 'literal', value: { value: 'concat' } }));
    c = push(c, concrete('content', { type: 'literal', value: 'hello' }));
    c = push(c, stmtPatch('content', { type: 'literal', value: ' world' }));

    const { scope: s } = reduce(c);
    expect(s.bindings.get('content')?.value).toBe('hello world');
  });

  it('dispatches through merge function from scope constraint', () => {
    const replace = (_existing: string, delta: string) => delta.toUpperCase();
    let c = createChain('object');
    c = push(c, concrete('upper-replace', { type: 'literal', value: replace }));
    c = push(c, concrete('msg', { type: 'literal', value: 'old' }));
    // Open scope with merge constraint pointing to the function binding
    c = push(c, scope([concrete('merge', { type: 'literal', value: 'upper-replace' })]));
    c = push(c, stmtPatch('msg', { type: 'literal', value: 'new' }));

    const { scope: s } = reduce(c);
    expect(s.bindings.get('msg')?.value).toBe('NEW');
  });

  it('dispatches through direct function in merge binding', () => {
    const prepend = (existing: string, delta: string) => delta + existing;
    let c = createChain('object');
    c = push(c, type_('title:merge', { type: 'literal', value: prepend }));
    c = push(c, concrete('title', { type: 'literal', value: 'World' }));
    c = push(c, stmtPatch('title', { type: 'literal', value: 'Hello ' }));

    const { scope: s } = reduce(c);
    expect(s.bindings.get('title')?.value).toBe('Hello World');
  });

  it('falls back to shallow object merge when no composer', () => {
    let c = createChain('object');
    c = push(c, concrete('data', { type: 'literal', value: { a: 1, b: 2 } }));
    c = push(c, stmtPatch('data', { type: 'literal', value: { b: 3, c: 4 } }));

    const { scope: s } = reduce(c);
    expect(s.bindings.get('data')?.value).toEqual({ a: 1, b: 3, c: 4 });
  });

  it('last-write replaces when no composer and non-object types', () => {
    let c = createChain('object');
    c = push(c, concrete('count', { type: 'literal', value: 10 }));
    c = push(c, stmtPatch('count', { type: 'literal', value: 20 }));

    const { scope: s } = reduce(c);
    // No merge function, both are numbers → value replaces (last-write)
    expect(s.bindings.get('count')?.value).toBe(20);
  });

  it('scope constraint merge function does not leak past terminate', () => {
    const doubler = (existing: number, delta: number) => existing + delta * 2;
    let c = createChain('object');
    c = push(c, concrete('double-merge', { type: 'literal', value: doubler }));

    // Scope with merge constraint
    const sid = 'scope:merge-test';
    c = push(c, scope([concrete('merge', { type: 'literal', value: 'double-merge' })], sid));
    c = push(c, concrete('x', { type: 'literal', value: 10 }));
    c = push(c, stmtPatch('x', { type: 'literal', value: 5 }));
    c = push(c, scopeTerminate(sid));

    // After scope terminates, patch should fall back to default
    c = push(c, concrete('y', { type: 'literal', value: 100 }));
    c = push(c, stmtPatch('y', { type: 'literal', value: 50 }));

    const { scope: s } = reduce(c);
    expect(s.bindings.get('x')?.value).toBe(20);  // 10 + 5*2
    expect(s.bindings.get('y')?.value).toBe(50);   // number, no composer → last-write
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Named annotations as bindings
// ─────────────────────────────────────────────────────────────────────────────

describe('named annotations as bindings', () => {
  it('promotes named annotation to a binding with decomposed body', () => {
    let c = createChain('object');
    const body: AnnotationNode[] = [
      { kind: 'text', content: '# Hello' },
    ];
    c = push(c, annotate('doc', body));

    const { scope: s } = reduce(c);
    const binding = s.bindings.get('doc');
    expect(binding).toBeDefined();
    expect(binding?.resolved).toBe(true);
    expect(binding?.value).toEqual({
      _segments: ['seg:0'],
      'seg:0': '# Hello',
    });
  });

  it('decomposes mixed body (text + ref + file)', () => {
    let c = createChain('object');
    const body: AnnotationNode[] = [
      { kind: 'text', content: '# Report' },
      { kind: 'ref', artifactType: 'chart', artifactID: 'c1' },
      { kind: 'file', filename: 'data.csv', content: 'a,b\n1,2' },
    ];
    c = push(c, annotate('report', body));

    const { scope: s } = reduce(c);
    const val = s.bindings.get('report')?.value as any;
    expect(val._segments).toEqual(['seg:0', 'seg:1', 'seg:2']);
    expect(val['seg:0']).toBe('# Report');
    expect(val['seg:1']).toEqual({ kind: 'ref', artifactType: 'chart', artifactID: 'c1' });
    expect(val['seg:2']).toEqual({ kind: 'file', filename: 'data.csv', content: 'a,b\n1,2' });
  });

  it('unnamed annotations still go to meta only', () => {
    let c = createChain('object');
    c = push(c, annotate([{ kind: 'text', content: 'just meta' }]));

    const { scope: s } = reduce(c);
    // No binding created
    expect(s.bindings.size).toBe(0);
    // Stored in meta
    expect(s.meta['annotate:0']).toEqual([{ kind: 'text', content: 'just meta' }]);
  });

  it('named annotation also stored in meta for backward compat', () => {
    let c = createChain('object');
    c = push(c, annotate('doc', [{ kind: 'text', content: 'hello' }]));

    const { scope: s } = reduce(c);
    // Both binding AND meta
    expect(s.bindings.has('doc')).toBe(true);
    expect(s.meta['annotate:0']).toEqual([{ kind: 'text', content: 'hello' }]);
  });

  it('named annotation body is patchable via patch bind', () => {
    // Annotation creates object-valued binding → patch composes via shallow merge
    let c = createChain('object');
    c = push(c, annotate('doc', [
      { kind: 'text', content: 'original' },
      { kind: 'text', content: 'second' },
    ]));
    // Patch seg:0 (shallow merge on the body object)
    c = push(c, stmtPatch('doc', { type: 'literal', value: { 'seg:0': 'edited' } }));

    const { scope: s } = reduce(c);
    const val = s.bindings.get('doc')?.value as any;
    expect(val['seg:0']).toBe('edited');
    expect(val['seg:1']).toBe('second');
    expect(val._segments).toEqual(['seg:0', 'seg:1']);
  });
});
