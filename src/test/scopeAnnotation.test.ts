import {
  createChain,
  push,
  fork,
  reduce,
  findScopeConstraints,
  collectEnclosingScopeConstraints,
  chainFromFieldType,
} from '../chain.js';
import {
  concrete,
  type_,
  scope,
  scopeTerminate,
} from '../statement.js';
import type { ScopeStatement } from '../statement.js';
import { createHead } from '../head.js';
import { FieldType } from '../type.js';
import { ConstraintTypes } from '../constraint.js';

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

/** Visibility constraint body: private (hidden from entries). */
const privateVisibility = [concrete('visibility', { type: 'literal', value: { scope: false } })];

/** Visibility constraint body: public (visible in entries). */
const publicVisibility = [concrete('visibility', { type: 'literal', value: { scope: true } })];

/** Build an object FieldType with typed properties. */
function buildObjType(props: Record<string, FieldType>): FieldType {
  let ft = FieldType.object.create();
  for (const [key, valueFT] of Object.entries(props)) {
    (ft.attributes ??= []).push(ConstraintTypes.object.property.create(key, valueFT));
  }
  return ft.save();
}

// ─────────────────────────────────────────────────────────────────────────────
// Phase 1: Scope Statement Grammar + Reduce Tracking
// ─────────────────────────────────────────────────────────────────────────────

describe('scope() / scopeTerminate() factories', () => {
  it('produces valid ScopeStatements with constraint body', () => {
    const open = scope(privateVisibility, 'test-scope');
    expect(open.type).toBe('scope');
    expect('body' in open && open.body).toHaveLength(1);

    const stmt = open as Extract<ScopeStatement, { body: any }>;
    expect(stmt.scopeId).toBe('test-scope');
    expect(stmt.body[0].type).toBe('bind');

    const close = scopeTerminate('test-scope');
    expect(close.type).toBe('scope');
    expect('terminate' in close && close.terminate).toBe(true);
  });

  it('generates scopeId when not provided', () => {
    const open1 = scope([]);
    const open2 = scope([]);
    const id1 = open1.scopeId;
    const id2 = open2.scopeId;
    expect(id1).toBeTruthy();
    expect(id2).toBeTruthy();
    expect(id1).not.toBe(id2);
  });
});

describe('reduce() with no scopes', () => {
  it('produces identical results to before — backward compat', () => {
    let chain = createChain('object');
    chain = push(chain, concrete('x', { type: 'literal', value: 1 }));
    chain = push(chain, concrete('y', { type: 'literal', value: 2 }));

    const { scope: s } = reduce(chain);
    expect(s.bindings.get('x')?.value).toBe(1);
    expect(s.bindings.get('y')?.value).toBe(2);
    expect(s.scopes).toEqual([]);
    expect(s.scopeBindings.size).toBe(0);
    expect(s.closedScopes.size).toBe(0);
    // No scopeId on bindings
    expect(s.bindings.get('x')?.scopeId).toBeUndefined();
    expect(s.bindings.get('y')?.scopeId).toBeUndefined();
  });
});

describe('reduce() with scope open + terminate', () => {
  it('scopes stack is empty after terminate', () => {
    let chain = createChain('object');
    chain = push(chain, scope(privateVisibility, 'scope-a'));
    chain = push(chain, concrete('x', { type: 'literal', value: 42 }));
    chain = push(chain, scopeTerminate('scope-a'));

    const { scope: s } = reduce(chain);
    expect(s.scopes).toHaveLength(0);
    expect(s.closedScopes.has('scope-a')).toBe(true);
    // closedScopes holds the reduced constraint map
    const closed = s.closedScopes.get('scope-a')!;
    expect(closed.get('visibility')).toEqual({ scope: false });
  });

  it('binding inside scope gets scopeId', () => {
    let chain = createChain('object');
    chain = push(chain, scope(
      [concrete('label', { type: 'literal', value: { value: 'tools' } })],
      'scope-b',
    ));
    chain = push(chain, concrete('tool1', { type: 'literal', value: 'hello' }));
    chain = push(chain, concrete('tool2', { type: 'literal', value: 'world' }));
    chain = push(chain, scopeTerminate('scope-b'));
    chain = push(chain, concrete('outside', { type: 'literal', value: 'free' }));

    const { scope: s } = reduce(chain);
    expect(s.bindings.get('tool1')?.scopeId).toBe('scope-b');
    expect(s.bindings.get('tool2')?.scopeId).toBe('scope-b');
    expect(s.bindings.get('outside')?.scopeId).toBeUndefined();
  });

  it('synthesizes behavioral constraint bindings from scope constraints', () => {
    let chain = createChain('object');
    chain = push(chain, scope(privateVisibility, 'scope-c'));
    chain = push(chain, concrete('secret', { type: 'literal', value: 'hidden' }));
    chain = push(chain, scopeTerminate('scope-c'));

    const { scope: s } = reduce(chain);
    // reduce() should have synthesized 'secret:visibility' type-level binding
    const synthBinding = s.bindings.get('secret:visibility');
    expect(synthBinding).toBeDefined();
    expect(synthBinding?.level).toBe('type');
    expect(synthBinding?.resolved).toBe(true);
    expect(synthBinding?.value).toEqual({ scope: false });
  });

  it('per-binding constraint overrides scope constraint (specificity)', () => {
    let chain = createChain('object');
    // Scope says private
    chain = push(chain, scope(privateVisibility, 'scope-d'));
    // But per-binding override says visible
    chain = push(chain, type_('secret:visibility', { type: 'literal', value: { scope: true } }));
    chain = push(chain, concrete('secret', { type: 'literal', value: 'override' }));
    chain = push(chain, scopeTerminate('scope-d'));

    const { scope: s } = reduce(chain);
    // Per-binding constraint wins — scope doesn't overwrite it
    const vis = s.bindings.get('secret:visibility');
    expect(vis?.value).toEqual({ scope: true });
  });
});

describe('nested scopes', () => {
  it('inner binding gets inner scopeId', () => {
    let chain = createChain('object');
    chain = push(chain, scope(
      [concrete('install', { type: 'literal', value: 'blueprint-x' })],
      'outer',
    ));
    chain = push(chain, concrete('dep', { type: 'literal', value: 'a' }));
    chain = push(chain, scope(
      [concrete('role', { type: 'literal', value: 'definition' })],
      'inner',
    ));
    chain = push(chain, concrete('req', { type: 'literal', value: 'b' }));
    chain = push(chain, scopeTerminate('inner'));
    chain = push(chain, scopeTerminate('outer'));

    const { scope: s } = reduce(chain);
    expect(s.bindings.get('dep')?.scopeId).toBe('outer');
    expect(s.bindings.get('req')?.scopeId).toBe('inner');
  });

  it('scopeBindings tracks bindings in both inner and outer scopes', () => {
    let chain = createChain('object');
    chain = push(chain, scope([], 'outer'));
    chain = push(chain, concrete('a', { type: 'literal', value: 1 }));
    chain = push(chain, scope([], 'inner'));
    chain = push(chain, concrete('b', { type: 'literal', value: 2 }));
    chain = push(chain, scopeTerminate('inner'));
    chain = push(chain, scopeTerminate('outer'));

    const { scope: s } = reduce(chain);
    expect(s.scopeBindings.get('outer')?.has('a')).toBe(true);
    expect(s.scopeBindings.get('inner')?.has('a')).toBe(false);
    expect(s.scopeBindings.get('outer')?.has('b')).toBe(true);
    expect(s.scopeBindings.get('inner')?.has('b')).toBe(true);
  });

  it('inner scope patches outer — inner constraint wins', () => {
    let chain = createChain('object');
    chain = push(chain, scope(privateVisibility, 'outer'));
    chain = push(chain, scope(publicVisibility, 'inner'));
    chain = push(chain, concrete('x', { type: 'literal', value: 'val' }));
    chain = push(chain, scopeTerminate('inner'));
    chain = push(chain, scopeTerminate('outer'));

    const { scope: s } = reduce(chain);
    // Scope constraints are patches: outer → inner, inner overwrites outer.
    // Effective constraint set: { visibility: { scope: true } } (inner's public wins).
    const vis = s.bindings.get('x:visibility');
    expect(vis).toBeDefined();
    expect(vis?.value).toEqual({ scope: true }); // inner (public) overrides outer (private)
  });
});

describe('scope edge cases', () => {
  it('unterminated scope — scopes stack still contains the region', () => {
    let chain = createChain('object');
    chain = push(chain, scope(
      [concrete('lifecycle', { type: 'literal', value: 'session' })],
      'unclosed',
    ));
    chain = push(chain, concrete('x', { type: 'literal', value: 1 }));
    // No scopeTerminate

    const { scope: s } = reduce(chain);
    expect(s.scopes).toHaveLength(1);
    expect(s.scopes[0].scopeId).toBe('unclosed');
    expect(s.bindings.get('x')?.scopeId).toBe('unclosed');
  });

  it('terminate without open — no-op, no crash', () => {
    let chain = createChain('object');
    chain = push(chain, scopeTerminate('nonexistent'));
    chain = push(chain, concrete('x', { type: 'literal', value: 1 }));

    const { scope: s } = reduce(chain);
    expect(s.bindings.get('x')?.value).toBe(1);
    expect(s.bindings.get('x')?.scopeId).toBeUndefined();
    expect(s.scopes).toHaveLength(0);
  });

  it('multiple scopes with different constraints', () => {
    let chain = createChain('object');
    chain = push(chain, scope(privateVisibility, 'scope-1'));
    chain = push(chain, concrete('a', { type: 'literal', value: 1 }));
    chain = push(chain, scopeTerminate('scope-1'));
    chain = push(chain, scope(
      [concrete('label', { type: 'literal', value: { value: 'public-tools' } })],
      'scope-2',
    ));
    chain = push(chain, concrete('b', { type: 'literal', value: 2 }));
    chain = push(chain, scopeTerminate('scope-2'));

    const { scope: s } = reduce(chain);
    expect(s.bindings.get('a')?.scopeId).toBe('scope-1');
    expect(s.bindings.get('b')?.scopeId).toBe('scope-2');
    expect(s.closedScopes.get('scope-1')?.get('visibility')).toEqual({ scope: false });
    expect(s.closedScopes.get('scope-2')?.get('label')).toEqual({ value: 'public-tools' });
  });
});

describe('scope in forked chain', () => {
  it('carries through collectStatements', () => {
    let parent = createChain('object');
    parent = push(parent, scope(
      [concrete('install', { type: 'literal', value: 'bp' })],
      'parent-scope',
    ));
    parent = push(parent, concrete('x', { type: 'literal', value: 1 }));

    let child = fork(parent);
    child = push(child, concrete('y', { type: 'literal', value: 2 }));
    child = push(child, scopeTerminate('parent-scope'));

    const { scope: s } = reduce(child);
    expect(s.bindings.get('x')?.scopeId).toBe('parent-scope');
    expect(s.bindings.get('y')?.scopeId).toBe('parent-scope');
    expect(s.scopeBindings.get('parent-scope')?.has('x')).toBe(true);
    expect(s.scopeBindings.get('parent-scope')?.has('y')).toBe(true);
    expect(s.scopes).toHaveLength(0);
    expect(s.closedScopes.has('parent-scope')).toBe(true);
  });
});

describe('findScopeConstraints / collectEnclosingScopeConstraints', () => {
  it('findScopeConstraints returns constraints for active scope', () => {
    let chain = createChain('object');
    chain = push(chain, scope(privateVisibility, 'active'));
    chain = push(chain, concrete('x', { type: 'literal', value: 1 }));

    const { scope: s } = reduce(chain);
    const constraints = findScopeConstraints(s, 'active');
    expect(constraints).not.toBeNull();
    expect(constraints?.get('visibility')).toEqual({ scope: false });
  });

  it('findScopeConstraints returns constraints for terminated scope', () => {
    let chain = createChain('object');
    chain = push(chain, scope(
      [concrete('merge', { type: 'literal', value: { value: 'source-wins' } })],
      'closed',
    ));
    chain = push(chain, concrete('x', { type: 'literal', value: 1 }));
    chain = push(chain, scopeTerminate('closed'));

    const { scope: s } = reduce(chain);
    const constraints = findScopeConstraints(s, 'closed');
    expect(constraints).not.toBeNull();
    expect(constraints?.get('merge')).toEqual({ value: 'source-wins' });
  });

  it('findScopeConstraints returns null for unknown scope', () => {
    const { scope: s } = reduce(createChain('object'));
    expect(findScopeConstraints(s, 'nope')).toBeNull();
  });

  it('collectEnclosingScopeConstraints returns all enclosing scope constraints', () => {
    let chain = createChain('object');
    chain = push(chain, scope(
      [concrete('install', { type: 'literal', value: 'bp' })],
      'outer',
    ));
    chain = push(chain, scope(
      [concrete('role', { type: 'literal', value: 'definition' })],
      'inner',
    ));
    chain = push(chain, concrete('req', { type: 'literal', value: 'x' }));
    chain = push(chain, scopeTerminate('inner'));
    chain = push(chain, scopeTerminate('outer'));

    const { scope: s } = reduce(chain);
    const maps = collectEnclosingScopeConstraints(s, 'req');
    expect(maps).toHaveLength(2);
    const allKeys = maps.flatMap(m => [...m.keys()]);
    expect(allKeys).toContain('install');
    expect(allKeys).toContain('role');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Phase 2: Scope-Governed Visibility (HEAD level)
//
// Scope constraints are synthesized into per-binding behavioral constraint
// bindings by reduce(). The existing resolveConstraint() in head.ts handles
// them uniformly — no separate scope visibility code needed.
// ─────────────────────────────────────────────────────────────────────────────

describe('entries() with scope visibility', () => {
  it('private scope bindings excluded from entries()', () => {
    const rootType = buildObjType({});
    let chain = chainFromFieldType(rootType);
    chain = push(chain, scope(privateVisibility, 'priv'));
    chain = push(chain, concrete('secret', { type: 'literal', value: 'hidden' }));
    chain = push(chain, scopeTerminate('priv'));
    chain = push(chain, concrete('visible', { type: 'literal', value: 'shown' }));

    const head = createHead(chain);
    const entries = head.entries();
    expect(entries.has('secret')).toBe(false);
    expect(entries.get('visible')).toBe('shown');
  });

  it('public scope bindings appear normally in entries()', () => {
    const rootType = buildObjType({});
    let chain = chainFromFieldType(rootType);
    chain = push(chain, scope(publicVisibility, 'pub'));
    chain = push(chain, concrete('open', { type: 'literal', value: 'accessible' }));
    chain = push(chain, scopeTerminate('pub'));

    const head = createHead(chain);
    const entries = head.entries();
    expect(entries.get('open')).toBe('accessible');
  });

  it('value() returns private-scope bindings (direct access bypass)', () => {
    const rootType = buildObjType({});
    let chain = chainFromFieldType(rootType);
    chain = push(chain, scope(privateVisibility, 'priv'));
    chain = push(chain, concrete('secret', { type: 'literal', value: 'hidden' }));
    chain = push(chain, scopeTerminate('priv'));

    const head = createHead(chain);
    expect(head.entries().has('secret')).toBe(false);
    expect(head.value('secret')).toBe('hidden');
  });

  it('nested: inner public scope patches outer private — inner wins', () => {
    const rootType = buildObjType({});
    let chain = chainFromFieldType(rootType);
    chain = push(chain, scope(privateVisibility, 'outer'));
    chain = push(chain, concrete('outer-only', { type: 'literal', value: 'hidden' }));
    chain = push(chain, scope(publicVisibility, 'inner'));
    chain = push(chain, concrete('inner-item', { type: 'literal', value: 'visible' }));
    chain = push(chain, scopeTerminate('inner'));
    chain = push(chain, scopeTerminate('outer'));

    const head = createHead(chain);
    const entries = head.entries();
    // outer-only: only in outer scope (private) → hidden
    expect(entries.has('outer-only')).toBe(false);
    // inner-item: effective constraints = outer patched by inner → visibility = public → visible
    expect(entries.get('inner-item')).toBe('visible');
  });

  it('nested: inner scope without visibility inherits outer (patch semantics)', () => {
    const rootType = buildObjType({});
    let chain = chainFromFieldType(rootType);
    chain = push(chain, scope(privateVisibility, 'outer'));
    chain = push(chain, concrete('outer-item', { type: 'literal', value: 'hidden' }));
    // Inner scope has label but no visibility → outer's private persists in effective set
    chain = push(chain, scope(
      [concrete('label', { type: 'literal', value: { value: 'tools' } })],
      'inner',
    ));
    chain = push(chain, concrete('inner-item', { type: 'literal', value: 'also-hidden' }));
    chain = push(chain, scopeTerminate('inner'));
    chain = push(chain, scopeTerminate('outer'));

    const head = createHead(chain);
    const entries = head.entries();
    // Both items are in a private effective context — hidden
    expect(entries.has('outer-item')).toBe(false);
    expect(entries.has('inner-item')).toBe(false);
    // But value() still works (direct access bypass)
    expect(head.value('inner-item')).toBe('also-hidden');
  });
});

describe('callables() with scope visibility', () => {
  it('private scope callables excluded from callables()', () => {
    const rootType = buildObjType({
      tool: FieldType.any.create().callable().save(),
    });
    let chain = chainFromFieldType(rootType);
    chain = push(chain, scope(privateVisibility, 'priv'));
    chain = push(chain, concrete('tool', { type: 'literal', value: () => 'internal' }));
    chain = push(chain, scopeTerminate('priv'));

    const head = createHead(chain);
    expect(head.callables().has('tool')).toBe(false);
    expect(head.value('tool')).toBeDefined();
  });

  it('public scope callables appear normally', () => {
    const rootType = buildObjType({
      tool: FieldType.any.create().callable().save(),
    });
    let chain = chainFromFieldType(rootType);
    chain = push(chain, scope(publicVisibility, 'pub'));
    chain = push(chain, concrete('tool', { type: 'literal', value: () => 'external' }));
    chain = push(chain, scopeTerminate('pub'));

    const head = createHead(chain);
    expect(head.callables().has('tool')).toBe(true);
  });
});

describe('draft inherits source scope visibility', () => {
  it('draft entries() respects source chain scope visibility', async () => {
    const rootType = buildObjType({});
    let chain = chainFromFieldType(rootType);
    chain = push(chain, scope(privateVisibility, 'priv'));
    chain = push(chain, concrete('secret', { type: 'literal', value: 'hidden' }));
    chain = push(chain, scopeTerminate('priv'));
    chain = push(chain, concrete('visible', { type: 'literal', value: 'shown' }));

    const head = createHead(chain);
    const draft = head.draft();
    draft.write(concrete('extra', { type: 'literal', value: 'draft-data' }));
    await draft.save();

    const entries = head.entries();
    expect(entries.has('secret')).toBe(false);
    expect(entries.get('visible')).toBe('shown');
    expect(entries.get('extra')).toBe('draft-data');
  });
});
