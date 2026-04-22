/**
 * history.test.ts — Tests for chain history reconstruction and snapshot diffing.
 */

import { createChain, push, fork, snapshot } from '../chain.js';
import { snapshotAt, diffSnapshot, chainHistory } from '../history.js';
import type { Statement } from '../statement.js';

// ── Helpers ────────────────────────────────────────────────────────────────

function bind(name: string, value: unknown): Statement {
  return {
    type: 'bind',
    name,
    expr: { type: 'literal', value },
    level: 'concrete',
  } as Statement;
}

function ref(name: string, source: string): Statement {
  return {
    type: 'bind',
    name,
    expr: { type: 'ref', source },
    level: 'concrete',
  } as Statement;
}

// ── snapshotAt ────────────────────────────────────────────────────────────

describe('snapshotAt', () => {
  test('returns snapshot after first statement', () => {
    let chain = createChain('test');
    chain = push(chain, bind('x', 42));
    chain = push(chain, bind('y', 'hello'));

    const ft = snapshotAt(chain, 0);
    // At position 0, only 'x' should exist
    const attrs = (ft as any).attributes ?? [];
    const names = attrs
      .filter((a: any) => a.constrainttype === 'property')
      .map((a: any) => a.key);
    expect(names).toContain('x');
    expect(names).not.toContain('y');
  });

  test('returns full snapshot when position omitted', () => {
    let chain = createChain('test');
    chain = push(chain, bind('a', 1));
    chain = push(chain, bind('b', 2));
    chain = push(chain, bind('c', 3));

    const ftFull = snapshotAt(chain);
    const ftDirect = snapshot(chain);

    // Both should have the same properties
    const namesFromSnapshotAt = ((ftFull as any).attributes ?? [])
      .filter((a: any) => a.constrainttype === 'property')
      .map((a: any) => a.key)
      .sort();
    const namesDirect = ((ftDirect as any).attributes ?? [])
      .filter((a: any) => a.constrainttype === 'property')
      .map((a: any) => a.key)
      .sort();
    expect(namesFromSnapshotAt).toEqual(namesDirect);
  });

  test('position beyond chain length returns full snapshot', () => {
    let chain = createChain('test');
    chain = push(chain, bind('x', 10));

    const ft = snapshotAt(chain, 999);
    const names = ((ft as any).attributes ?? [])
      .filter((a: any) => a.constrainttype === 'property')
      .map((a: any) => a.key);
    expect(names).toContain('x');
  });

  test('position 0 with empty chain returns empty snapshot', () => {
    const chain = createChain('test');
    const ft = snapshotAt(chain, 0);
    const props = ((ft as any).attributes ?? [])
      .filter((a: any) => a.constrainttype === 'property');
    expect(props).toHaveLength(0);
  });
});

// ── diffSnapshot ──────────────────────────────────────────────────────────

describe('diffSnapshot', () => {
  test('detects added properties', () => {
    let chain1 = createChain('test');
    chain1 = push(chain1, bind('x', 1));

    let chain2 = createChain('test');
    chain2 = push(chain2, bind('x', 1));
    chain2 = push(chain2, bind('y', 2));

    const prev = snapshot(chain1);
    const next = snapshot(chain2);
    const diff = diffSnapshot(prev, next, 0, 1);

    expect(diff.patches).toHaveLength(1);
    expect(diff.patches[0]).toEqual({ name: 'y', kind: 'added', next: 2 });
  });

  test('detects removed properties', () => {
    // A later bind with undefined removes a property from the snapshot
    // (snapshot only includes bindings with defined values)
    let chain1 = createChain('test');
    chain1 = push(chain1, bind('x', 1));
    chain1 = push(chain1, bind('y', 2));

    let chain2 = createChain('test');
    chain2 = push(chain2, bind('x', 1));

    const prev = snapshot(chain1);
    const next = snapshot(chain2);
    const diff = diffSnapshot(prev, next, 0, 1);

    expect(diff.patches).toHaveLength(1);
    expect(diff.patches[0]).toEqual({ name: 'y', kind: 'removed', prev: 2 });
  });

  test('detects changed properties', () => {
    let chain1 = createChain('test');
    chain1 = push(chain1, bind('x', 'old'));

    let chain2 = createChain('test');
    chain2 = push(chain2, bind('x', 'new'));

    const prev = snapshot(chain1);
    const next = snapshot(chain2);
    const diff = diffSnapshot(prev, next, 0, 1);

    expect(diff.patches).toHaveLength(1);
    expect(diff.patches[0]).toEqual({ name: 'x', kind: 'changed', prev: 'old', next: 'new' });
  });

  test('identical snapshots produce empty patches', () => {
    let chain = createChain('test');
    chain = push(chain, bind('x', 42));

    const ft = snapshot(chain);
    const diff = diffSnapshot(ft, ft, 0, 0);
    expect(diff.patches).toHaveLength(0);
  });

  test('preserves position metadata', () => {
    const chain = createChain('test');
    const ft = snapshot(chain);
    const diff = diffSnapshot(ft, ft, 5, 10);
    expect(diff.fromPosition).toBe(5);
    expect(diff.toPosition).toBe(10);
  });
});

// ── chainHistory ──────────────────────────────────────────────────────────

describe('chainHistory', () => {
  test('returns cumulative diffs across chain', () => {
    let chain = createChain('test');
    chain = push(chain, bind('x', 1));
    chain = push(chain, bind('y', 2));
    chain = push(chain, bind('z', 3));

    const history = chainHistory(chain);
    // Each bind adds a new property → 3 diffs
    expect(history.length).toBe(3);

    // First diff: empty → x
    expect(history[0].patches[0]).toMatchObject({ name: 'x', kind: 'added' });
    // Second diff: x → x,y
    expect(history[1].patches[0]).toMatchObject({ name: 'y', kind: 'added' });
    // Third diff: x,y → x,y,z
    expect(history[2].patches[0]).toMatchObject({ name: 'z', kind: 'added' });
  });

  test('with range restricts output', () => {
    let chain = createChain('test');
    chain = push(chain, bind('a', 1));
    chain = push(chain, bind('b', 2));
    chain = push(chain, bind('c', 3));
    chain = push(chain, bind('d', 4));

    // Only positions 1-2
    const history = chainHistory(chain, { from: 1, to: 2 });
    expect(history.length).toBe(2);
    expect(history[0].patches[0]).toMatchObject({ name: 'b', kind: 'added' });
    expect(history[1].patches[0]).toMatchObject({ name: 'c', kind: 'added' });
  });

  test('empty chain returns no diffs', () => {
    const chain = createChain('test');
    const history = chainHistory(chain);
    expect(history).toHaveLength(0);
  });

  test('overwrite shows changed patch', () => {
    let chain = createChain('test');
    chain = push(chain, bind('x', 'first'));
    chain = push(chain, bind('x', 'second'));

    const history = chainHistory(chain);
    // First: added x='first'
    expect(history[0].patches[0]).toMatchObject({ name: 'x', kind: 'added', next: 'first' });
    // Second: changed x='first' → 'second'
    expect(history[1].patches[0]).toMatchObject({ name: 'x', kind: 'changed', prev: 'first', next: 'second' });
  });

  test('works with forked chains (ref segments)', () => {
    let parent = createChain('test');
    parent = push(parent, bind('x', 1));
    parent = push(parent, bind('y', 2));

    let child = fork(parent);
    child = push(child, bind('z', 3));

    const history = chainHistory(child);
    // Should see: x added, y added, z added
    const allNames = history.flatMap(d => d.patches.map(p => p.name));
    expect(allNames).toContain('x');
    expect(allNames).toContain('y');
    expect(allNames).toContain('z');
  });

  test('path filter returns only matching binding history', () => {
    let chain = createChain('test');
    chain = push(chain, bind('x', 1));
    chain = push(chain, bind('y', 2));
    chain = push(chain, bind('x', 10));
    chain = push(chain, bind('z', 3));

    const history = chainHistory(chain, { path: 'x' });
    // Should only contain diffs affecting 'x'
    const allNames = history.flatMap(d => d.patches.map(p => p.name));
    expect(allNames.every(n => n === 'x')).toBe(true);
    expect(history.length).toBe(2); // added, then changed
  });

  test('path filter with dot-prefix matches sub-bindings', () => {
    let chain = createChain('test');
    chain = push(chain, bind('config.host', 'localhost'));
    chain = push(chain, bind('config.port', 8080));
    chain = push(chain, bind('other', 'unrelated'));

    const history = chainHistory(chain, { path: 'config' });
    const allNames = history.flatMap(d => d.patches.map(p => p.name));
    expect(allNames).toContain('config.host');
    expect(allNames).toContain('config.port');
    expect(allNames).not.toContain('other');
  });

  test('ref gates do not appear as literal properties', () => {
    let chain = createChain('test');
    chain = push(chain, bind('resolved', 42));
    chain = push(chain, ref('unresolved', 'some.source'));

    const history = chainHistory(chain);
    // Only the resolved binding should appear as a literal property
    const allNames = history.flatMap(d => d.patches.map(p => p.name));
    expect(allNames).toContain('resolved');
    // Ref gate has no literal value, so it's either absent or has undefined value
    const unresolvedPatch = history.flatMap(d => d.patches).find(p => p.name === 'unresolved');
    // If it appears, its value should be undefined (typed hole, not literal)
    if (unresolvedPatch) {
      expect(unresolvedPatch.next).toBeUndefined();
    }
  });
});
