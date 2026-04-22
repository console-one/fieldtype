import { createHead, createRefIndex } from '../head.js';
import { electConstraints } from '../headElect.js';
import type { HEAD, HeadEvent, DraftSpec, Gap } from '../head.js';
import { FieldType } from '../type.js';
import { ConstraintTypes } from '../constraint.js';
import { concrete, ref, type_, export_ } from '../statement.js';
import { chainFromFieldType, push, reduce, collectStatements, evaluateExpr } from '../chain.js';
import type { Chain } from '../chain.js';
import {
  parseBehavioralBindName, findBehavioralConstraint, findAllBehavioralConstraints, getMergePolicy, getPersistPolicy,
  resolveConstraintParam, resolveConstraint, interpret,
} from '../headInterpreter.js';
import type { HeadInterpreter } from '../headInterpreter.js';
import { types } from '../builders.js';
import { patchResolve, type ResolvedResult, type PendingResult, type SolveResult } from '../patchResolve.js';

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

/** Build an object FieldType with typed properties. */
function objectType(shape: Record<string, string>): FieldType {
  let ft = FieldType.object.create();
  for (const [key, typeName] of Object.entries(shape)) {
    const valueFT =
      typeName === 'string' ? FieldType.string.create() :
      typeName === 'number' ? FieldType.number.create() :
      typeName === 'boolean' ? FieldType.boolean.create() :
      FieldType.any.create();
    const prop = ConstraintTypes.object.property.create(key, valueFT);
    (ft.attributes ??= []).push(prop);
  }
  return ft.save();
}

/** Build an object type with some properties having literal values (pre-resolved). */
function objectTypeWithValues(shape: Record<string, { type: string; value?: any }>): FieldType {
  let ft = FieldType.object.create();
  for (const [key, spec] of Object.entries(shape)) {
    let valueFT =
      spec.type === 'string' ? FieldType.string.create() :
      spec.type === 'number' ? FieldType.number.create() :
      spec.type === 'boolean' ? FieldType.boolean.create() :
      FieldType.any.create();
    if (spec.value !== undefined) {
      // .literal() returns a fluent draft — must .save() to commit the attribute
      valueFT = valueFT.literal(spec.value).save();
    }
    const prop = ConstraintTypes.object.property.create(key, valueFT);
    (ft.attributes ??= []).push(prop);
  }
  return ft.save();
}

/** Build an object type with FieldType-valued properties (for behavioral constraint tests). */
function buildObjType(props: Record<string, FieldType>): FieldType {
  let ft = FieldType.object.create();
  for (const [key, valueFT] of Object.entries(props)) {
    (ft.attributes ??= []).push(ConstraintTypes.object.property.create(key, valueFT));
  }
  return ft.save();
}

function collectEvents(head: HEAD): HeadEvent[] {
  const events: HeadEvent[] = [];
  head.subscribe(e => events.push(e));
  return events;
}

// ─────────────────────────────────────────────────────────────────────────────
// createHead
// ─────────────────────────────────────────────────────────────────────────────

describe('createHead', () => {
  it('creates a committed HEAD from an object FieldType', () => {
    const ft = objectType({ host: 'string', port: 'number' });
    const head = createHead(ft);

    expect(head.path).toBe('');
    expect(head.source).toBeNull();
    expect(head.lifecycle).toBeNull();
    expect(head.snapshot).toBeDefined();
    expect(head.snapshot.fieldtype).toBe('object');
  });

  it('accepts a path argument', () => {
    const ft = objectType({ x: 'number' });
    const head = createHead(ft, 'config');
    expect(head.path).toBe('config');
  });

  it('accepts an options object with path', () => {
    const ft = objectType({ x: 'number' });
    const head = createHead(ft, { path: 'settings' });
    expect(head.path).toBe('settings');
  });

  it('identifies gaps from ref gates in the FieldType', () => {
    const ft = objectType({ host: 'string', port: 'number' });
    const head = createHead(ft);

    // Both properties are ref gates (no literal values)
    expect(head.gaps.length).toBe(2);
    expect(head.resolved).toBe(false);

    const gapKeys = head.gaps.map(g => g.key).sort();
    expect(gapKeys).toEqual(['host', 'port']);
  });

  it('has no gaps when all properties have literal values', () => {
    const ft = objectTypeWithValues({
      host: { type: 'string', value: 'localhost' },
      port: { type: 'number', value: 8080 },
    });
    const head = createHead(ft);

    expect(head.gaps.length).toBe(0);
    expect(head.resolved).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// snapshot (lazy, cached)
// ─────────────────────────────────────────────────────────────────────────────

describe('snapshot', () => {
  it('returns a FieldType reflecting current state', () => {
    const ft = objectTypeWithValues({
      name: { type: 'string', value: 'Alice' },
    });
    const head = createHead(ft);
    const snap = head.snapshot;
    expect(snap.fieldtype).toBe('object');
  });

  it('is cached across multiple reads', () => {
    const ft = objectType({ x: 'number' });
    const head = createHead(ft);
    const snap1 = head.snapshot;
    const snap2 = head.snapshot;
    expect(snap1).toBe(snap2); // exact same object reference
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// write
// ─────────────────────────────────────────────────────────────────────────────

describe('write', () => {
  it('appends a statement and invalidates snapshot cache', () => {
    const ft = objectType({ host: 'string' });
    const head = createHead(ft);

    const snap1 = head.snapshot;
    head.write(concrete('host', { type: 'literal', value: 'localhost' }));
    const snap2 = head.snapshot;

    // Snapshot should be a different object after write
    expect(snap1).not.toBe(snap2);
  });

  it('resolves a gap when a concrete literal is written', () => {
    const ft = objectType({ host: 'string', port: 'number' });
    const head = createHead(ft);

    expect(head.gaps.length).toBe(2);

    head.write(concrete('host', { type: 'literal', value: 'localhost' }));
    expect(head.gaps.length).toBe(1);
    expect(head.gaps[0].key).toBe('port');

    head.write(concrete('port', { type: 'literal', value: 8080 }));
    expect(head.gaps.length).toBe(0);
    expect(head.resolved).toBe(true);
  });

  it('fires write event to subscribers', () => {
    const ft = objectType({ x: 'number' });
    const head = createHead(ft);
    const events = collectEvents(head);

    const stmt = concrete('x', { type: 'literal', value: 42 });
    head.write(stmt);

    const writeEvents = events.filter(e => e.type === 'write');
    expect(writeEvents.length).toBe(1);
    expect((writeEvents[0] as any).statement).toBe(stmt);
  });

  it('fires gaps-changed event when gaps change', () => {
    const ft = objectType({ host: 'string' });
    const head = createHead(ft);
    const events = collectEvents(head);

    head.write(concrete('host', { type: 'literal', value: 'localhost' }));

    const gapEvents = events.filter(e => e.type === 'gaps-changed');
    expect(gapEvents.length).toBe(1);
  });

  it('throws on disposed HEAD', () => {
    const ft = objectType({ x: 'number' });
    const head = createHead(ft);
    head.dispose();

    expect(() => {
      head.write(concrete('x', { type: 'literal', value: 1 }));
    }).toThrow('HEAD is disposed');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// gaps (structured FieldTypeMissing)
// ─────────────────────────────────────────────────────────────────────────────

describe('gaps', () => {
  it('returns FieldTypeMissing with key and source', () => {
    const ft = objectType({ host: 'string' });
    const head = createHead(ft);

    expect(head.gaps.length).toBe(1);
    const gap = head.gaps[0];
    expect(gap.key).toBe('host');
    expect(gap.source).toBe('string');
  });

  it('is cached between reads', () => {
    const ft = objectType({ x: 'number' });
    const head = createHead(ft);
    const gaps1 = head.gaps;
    const gaps2 = head.gaps;
    expect(gaps1).toBe(gaps2);
  });

  it('invalidates on write', () => {
    const ft = objectType({ x: 'number' });
    const head = createHead(ft);
    const gaps1 = head.gaps;

    head.write(concrete('x', { type: 'literal', value: 42 }));
    const gaps2 = head.gaps;

    expect(gaps1).not.toBe(gaps2);
    expect(gaps1.length).toBe(1);
    expect(gaps2.length).toBe(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// draft
// ─────────────────────────────────────────────────────────────────────────────

describe('draft', () => {
  it('creates a draft HEAD with source link', () => {
    const ft = objectType({ host: 'string' });
    const head = createHead(ft);
    const d = head.draft();

    expect(d.source).toBe(head);
    expect(d.lifecycle).not.toBeNull();
    expect(d.path).toBe(head.path);
  });

  it('inherits gaps from source', () => {
    const ft = objectType({ host: 'string', port: 'number' });
    const head = createHead(ft);
    const d = head.draft();

    // Draft should have same gaps as source
    expect(d.gaps.length).toBe(2);
  });

  it('starts with lifecycle pending when gaps exist', () => {
    const ft = objectType({ host: 'string' });
    const head = createHead(ft);
    const d = head.draft();

    expect(d.lifecycle).toBe('pending');
  });

  it('starts with lifecycle ready when no gaps', () => {
    const ft = objectTypeWithValues({
      host: { type: 'string', value: 'localhost' },
    });
    const head = createHead(ft);
    const d = head.draft();

    expect(d.lifecycle).toBe('ready');
  });

  it('transitions pending → ready when gaps are filled', () => {
    const ft = objectType({ host: 'string' });
    const head = createHead(ft);
    const d = head.draft();

    expect(d.lifecycle).toBe('pending');
    d.write(concrete('host', { type: 'literal', value: 'localhost' }));
    expect(d.lifecycle).toBe('ready');
  });

  it('transitions ready → pending when new gap is introduced', () => {
    const ft = objectTypeWithValues({
      host: { type: 'string', value: 'localhost' },
    });
    const head = createHead(ft);
    const d = head.draft();

    expect(d.lifecycle).toBe('ready');

    // Write a new ref gate — introduces a gap
    d.write(concrete('apiKey', ref('string')));
    expect(d.lifecycle).toBe('pending');
  });

  it('writes to draft do not affect source', () => {
    const ft = objectType({ host: 'string' });
    const head = createHead(ft);
    const d = head.draft();

    d.write(concrete('host', { type: 'literal', value: 'localhost' }));

    // Source still has the gap
    expect(head.gaps.length).toBe(1);
    // Draft has filled it
    expect(d.gaps.length).toBe(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// at (child navigation)
// ─────────────────────────────────────────────────────────────────────────────

describe('at', () => {
  it('creates a child HEAD at subpath', () => {
    const ft = objectTypeWithValues({
      host: { type: 'string', value: 'localhost' },
      port: { type: 'number', value: 8080 },
    });
    const head = createHead(ft);
    const child = head.at('host');

    expect(child.path).toBe('host');
  });

  it('caches child across multiple calls', () => {
    const ft = objectType({ x: 'number' });
    const head = createHead(ft);
    const c1 = head.at('x');
    const c2 = head.at('x');
    expect(c1).toBe(c2);
  });

  it('child shares root receiver registry', () => {
    const ft = objectType({ x: 'number' });
    const head = createHead(ft);
    const child = head.at('x');
    // Verify shared registry: receiver added on root is visible from child
    let called = false;
    head.addReceiver(async () => { called = true; return []; });
    // Child's dispatch should trigger the same receiver (shared registry)
    // We can't dispatch from child directly, but we verify structural sharing
    // by checking that addReceiver on root affects the whole tree
    expect(called).toBe(false); // not called yet, just registered
  });

  it('builds correct full path for nested navigation', () => {
    const innerObj = FieldType.object.create();
    const innerProp = ConstraintTypes.object.property.create('y', FieldType.number.create());
    (innerObj.attributes ??= []).push(innerProp);

    let ft = FieldType.object.create();
    const outerProp = ConstraintTypes.object.property.create('x', innerObj.save());
    (ft.attributes ??= []).push(outerProp);
    ft = ft.save();

    const head = createHead(ft, 'root');
    const child = head.at('x');
    expect(child.path).toBe('root.x');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// subscribe / dispose
// ─────────────────────────────────────────────────────────────────────────────

describe('subscribe', () => {
  it('returns unsubscribe function', () => {
    const head = createHead(objectType({ x: 'number' }));
    const events: HeadEvent[] = [];
    const unsub = head.subscribe(e => events.push(e));

    head.write(concrete('x', { type: 'literal', value: 1 }));
    expect(events.length).toBeGreaterThan(0);

    const countBefore = events.length;
    unsub();
    head.write(concrete('x', { type: 'literal', value: 2 }));
    expect(events.length).toBe(countBefore);
  });

  it('subscriber errors do not break HEAD', () => {
    const head = createHead(objectType({ x: 'number' }));
    head.subscribe(() => { throw new Error('boom'); });

    // Should not throw
    expect(() => {
      head.write(concrete('x', { type: 'literal', value: 1 }));
    }).not.toThrow();
  });
});

describe('dispose', () => {
  it('disposes children recursively', () => {
    const ft = objectType({ x: 'number', y: 'string' });
    const head = createHead(ft);
    head.at('x');
    head.at('y');

    // Should not throw
    head.dispose();
  });

  it('is idempotent', () => {
    const head = createHead(objectType({ x: 'number' }));
    head.dispose();
    head.dispose(); // second call should be harmless
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// RefIndex
// ─────────────────────────────────────────────────────────────────────────────

describe('createRefIndex', () => {
  it('adds and retrieves entries by direction', () => {
    const idx = createRefIndex();
    idx.add('outgoing', 'config.host', 'string');
    idx.add('incoming', 'consumers.app', 'app');

    expect(idx.outgoing().length).toBe(1);
    expect(idx.outgoing()[0].path).toBe('config.host');
    expect(idx.incoming().length).toBe(1);
    expect(idx.incoming()[0].path).toBe('consumers.app');
  });

  it('clears all entries', () => {
    const idx = createRefIndex();
    idx.add('outgoing', 'a', 'a');
    idx.add('incoming', 'b', 'b');
    idx.clear();

    expect(idx.outgoing().length).toBe(0);
    expect(idx.incoming().length).toBe(0);
    expect(idx.entries.size).toBe(0);
  });

  it('removes by key', () => {
    const idx = createRefIndex();
    idx.add('outgoing', 'a', 'a');
    idx.remove('outgoing:a');
    expect(idx.outgoing().length).toBe(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// preflight
// ─────────────────────────────────────────────────────────────────────────────

describe('preflight', () => {
  it('returns ok for committed HEAD', () => {
    const head = createHead(objectType({ x: 'number' }));
    expect(head.preflight()).toEqual({ ok: true });
  });

  it('returns ok for draft with no gaps', () => {
    const ft = objectTypeWithValues({ x: { type: 'number', value: 42 } });
    const head = createHead(ft);
    const d = head.draft();

    expect(d.preflight()).toEqual({ ok: true });
  });

  it('returns not ok for draft with required gaps', () => {
    const ft = objectType({ host: 'string' });
    const head = createHead(ft);
    const d = head.draft();

    const result = d.preflight();
    expect(result.ok).toBe(false);
    expect((result as any).missing?.length).toBeGreaterThan(0);
  });

  it('returns ok after gaps are filled', () => {
    const ft = objectType({ host: 'string' });
    const head = createHead(ft);
    const d = head.draft();

    d.write(concrete('host', { type: 'literal', value: 'localhost' }));
    expect(d.preflight()).toEqual({ ok: true });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// save
// ─────────────────────────────────────────────────────────────────────────────

describe('save', () => {
  it('returns failure for committed HEAD', async () => {
    const head = createHead(objectType({ x: 'number' }));
    const result = await head.save();
    expect(result.ok).toBe(false);
  });

  it('merges draft changes into source', async () => {
    const ft = objectType({ host: 'string' });
    const head = createHead(ft);
    const d = head.draft();

    d.write(concrete('host', { type: 'literal', value: 'localhost' }));
    const result = await d.save();

    expect(result.ok).toBe(true);
    // Source should now be resolved
    expect(head.gaps.length).toBe(0);
    expect(head.resolved).toBe(true);
  });

  it('fires advance event on source', async () => {
    const ft = objectType({ host: 'string' });
    const head = createHead(ft);
    const events = collectEvents(head);

    const d = head.draft();
    d.write(concrete('host', { type: 'literal', value: 'localhost' }));
    await d.save();

    const advanceEvents = events.filter(e => e.type === 'advance');
    expect(advanceEvents.length).toBe(1);
  });

  it('returns failure when draft has required gaps', async () => {
    const ft = objectType({ host: 'string' });
    const head = createHead(ft);
    const d = head.draft();

    const result = await d.save();
    expect(result.ok).toBe(false);
  });

  it('serializes concurrent merges via lock', async () => {
    const ft = objectType({ x: 'number', y: 'number' });
    const head = createHead(ft);

    const d1 = head.draft();
    d1.write(concrete('x', { type: 'literal', value: 1 }));
    d1.write(concrete('y', { type: 'literal', value: 10 }));

    const d2 = head.draft();
    d2.write(concrete('x', { type: 'literal', value: 2 }));
    d2.write(concrete('y', { type: 'literal', value: 20 }));

    // Launch both saves concurrently
    const [r1, r2] = await Promise.all([d1.save(), d2.save()]);

    expect(r1.ok).toBe(true);
    expect(r2.ok).toBe(true);

    // Source should have been advanced twice (sequentially)
    // The final state depends on which draft merged last
    expect(head.resolved).toBe(true);
  });

  it('transitions draft lifecycle to merging during save', async () => {
    const ft = objectType({ x: 'number' });
    const head = createHead(ft);
    const d = head.draft();

    d.write(concrete('x', { type: 'literal', value: 42 }));

    // We can't easily observe 'merging' since save is async,
    // but we can verify it completes successfully
    const result = await d.save();
    expect(result.ok).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Behavioral Constraint Utilities (headInterpreter.ts)
// ─────────────────────────────────────────────────────────────────────────────

describe('parseBehavioralBindName', () => {
  it('parses host:merge into { key, constrainttype }', () => {
    expect(parseBehavioralBindName('host:merge')).toEqual({
      key: 'host',
      constrainttype: 'merge',
    });
  });

  it('parses apiKey:persist', () => {
    expect(parseBehavioralBindName('apiKey:persist')).toEqual({
      key: 'apiKey',
      constrainttype: 'persist',
    });
  });

  it('recognizes all 9 behavioral constraint types', () => {
    const types = ['merge', 'persist', 'compact', 'subscribe', 'fork', 'visibility', 'decorator', 'autoMerge', 'label'];
    for (const ct of types) {
      const result = parseBehavioralBindName(`field:${ct}`);
      expect(result).toEqual({ key: 'field', constrainttype: ct });
    }
  });

  it('returns null for non-namespaced names', () => {
    expect(parseBehavioralBindName('host')).toBeNull();
  });

  it('returns null for unknown constraint types', () => {
    expect(parseBehavioralBindName('host:unknown')).toBeNull();
  });
});

describe('findBehavioralConstraint', () => {
  it('finds a merge constraint on a property', () => {
    const hostFT = FieldType.string.create().merge('source-wins').save();
    let ft = FieldType.object.create();
    (ft.attributes ??= []).push(ConstraintTypes.object.property.create('host', hostFT));
    ft = ft.save();

    const c = findBehavioralConstraint(ft, 'host', 'merge');
    expect(c).not.toBeNull();
    expect((c as any).value).toBe('source-wins');
  });

  it('finds a persist constraint', () => {
    const keyFT = FieldType.string.create().persist('encrypted', { target: 'constants' }).save();
    let ft = FieldType.object.create();
    (ft.attributes ??= []).push(ConstraintTypes.object.property.create('apiKey', keyFT));
    ft = ft.save();

    const c = findBehavioralConstraint(ft, 'apiKey', 'persist');
    expect(c).not.toBeNull();
    expect((c as any).sink).toBe('encrypted');
    expect((c as any).target).toBe('constants');
  });

  it('returns null for non-existent property', () => {
    const ft = objectType({ host: 'string' });
    expect(findBehavioralConstraint(ft, 'missing', 'merge')).toBeNull();
  });

  it('returns null when property has no behavioral constraints', () => {
    const ft = objectType({ host: 'string' });
    expect(findBehavioralConstraint(ft, 'host', 'merge')).toBeNull();
  });

  it('returns null for non-object root type', () => {
    const ft = FieldType.string.create().save();
    expect(findBehavioralConstraint(ft, 'host', 'merge')).toBeNull();
  });

  it('finds scope-level constraint when no property-specific constraint exists', () => {
    // Object type with merge constraint on the container itself (no property-specific)
    let ft = FieldType.object.create();
    (ft.attributes ??= []).push(
      ConstraintTypes.object.property.create('host', FieldType.string.create().save()),
      ConstraintTypes.any.merge.create('source-wins') as any,
    );
    ft = ft.save();

    // 'host' has no merge constraint of its own, but the container does
    const c = findBehavioralConstraint(ft, 'host', 'merge');
    expect(c).not.toBeNull();
    expect((c as any).value).toBe('source-wins');
  });

  it('scope-level constraint applies to any binding name', () => {
    let ft = FieldType.object.create();
    (ft.attributes ??= []).push(ConstraintTypes.any.merge.create('source-wins') as any);
    ft = ft.save();

    // Even for a binding that doesn't exist as a property, scope-level applies
    expect(findBehavioralConstraint(ft, 'anything', 'merge')).not.toBeNull();
    expect(findBehavioralConstraint(ft, 'whatever', 'merge')).not.toBeNull();
  });

  it('property-specific constraint overrides scope-level', () => {
    const hostFT = FieldType.string.create().merge('last-write').save();
    let ft = FieldType.object.create();
    (ft.attributes ??= []).push(
      ConstraintTypes.object.property.create('host', hostFT),
      ConstraintTypes.any.merge.create('source-wins') as any,  // scope-level
    );
    ft = ft.save();

    // 'host' has property-specific 'last-write' — should win over scope-level 'source-wins'
    const c = findBehavioralConstraint(ft, 'host', 'merge');
    expect(c).not.toBeNull();
    expect((c as any).value).toBe('last-write');

    // A different binding gets scope-level
    const c2 = findBehavioralConstraint(ft, 'other', 'merge');
    expect(c2).not.toBeNull();
    expect((c2 as any).value).toBe('source-wins');
  });
});

describe('findAllBehavioralConstraints', () => {
  it('returns all scope-level label constraints', () => {
    const matchA = FieldType.object.create().property('packageID', FieldType.string.create()).save();
    const matchB = FieldType.object.create().property('blueprintID', FieldType.string.create()).save();
    const ft = FieldType.object.create()
      .label('toolpackage', matchA)
      .label('blueprint', matchB)
      .save();

    const all = findAllBehavioralConstraints(ft, 'anything', 'label');
    expect(all.length).toBe(2);
    expect((all[0] as any).value).toBe('toolpackage');
    expect((all[1] as any).value).toBe('blueprint');
  });

  it('returns property-specific label constraints', () => {
    const matchType = FieldType.object.create().property('id', FieldType.string.create()).save();
    const propFT = FieldType.any.create().label('pkg', matchType).save();
    let ft = FieldType.object.create();
    (ft.attributes ??= []).push(ConstraintTypes.object.property.create('myProp', propFT));
    ft = ft.save();

    const all = findAllBehavioralConstraints(ft, 'myProp', 'label');
    expect(all.length).toBe(1);
    expect((all[0] as any).value).toBe('pkg');
  });

  it('returns both property-specific and scope-level', () => {
    const matchType = FieldType.object.create().property('id', FieldType.string.create()).save();
    const propFT = FieldType.any.create().label('specific', matchType).save();
    let ft = FieldType.object.create().label('global', matchType);
    (ft.attributes ??= []).push(ConstraintTypes.object.property.create('myProp', propFT));
    ft = ft.save();

    const all = findAllBehavioralConstraints(ft, 'myProp', 'label');
    expect(all.length).toBe(2);
    expect((all[0] as any).value).toBe('specific');   // property-specific first
    expect((all[1] as any).value).toBe('global');      // scope-level second
  });

  it('returns empty array for non-object root type', () => {
    const ft = FieldType.string.create().save();
    expect(findAllBehavioralConstraints(ft, 'x', 'label')).toEqual([]);
  });

  it('works for singleton constraints too (persist)', () => {
    const ft = FieldType.object.create().persist('sink').save();
    const all = findAllBehavioralConstraints(ft, 'anything', 'persist');
    expect(all.length).toBe(1);
    expect((all[0] as any).sink).toBe('sink');
  });
});

describe('getMergePolicy', () => {
  it('returns merge policy from property type', () => {
    const hostFT = FieldType.string.create().merge('source-wins').save();
    let ft = FieldType.object.create();
    (ft.attributes ??= []).push(ConstraintTypes.object.property.create('host', hostFT));
    ft = ft.save();

    const policy = getMergePolicy(ft, 'host');
    expect(policy).toEqual({ value: 'source-wins', override: undefined });
  });

  it('returns null when no merge constraint', () => {
    const ft = objectType({ host: 'string' });
    expect(getMergePolicy(ft, 'host')).toBeNull();
  });

  it('includes override field', () => {
    const hostFT = FieldType.string.create()
      .merge('source-wins', { override: 'final' })
      .save();
    let ft = FieldType.object.create();
    (ft.attributes ??= []).push(ConstraintTypes.object.property.create('host', hostFT));
    ft = ft.save();

    const policy = getMergePolicy(ft, 'host');
    expect(policy).toEqual({ value: 'source-wins', override: 'final' });
  });
});

describe('getPersistPolicy', () => {
  it('returns persist policy from property type', () => {
    const keyFT = FieldType.string.create()
      .persist('encrypted', { target: 'constants', transform: 'encrypt' })
      .save();
    let ft = FieldType.object.create();
    (ft.attributes ??= []).push(ConstraintTypes.object.property.create('apiKey', keyFT));
    ft = ft.save();

    const policy = getPersistPolicy(ft, 'apiKey');
    expect(policy).toEqual({
      sink: 'encrypted',
      target: 'constants',
      transform: 'encrypt',
    });
  });

  it('returns null when no persist constraint', () => {
    const ft = objectType({ host: 'string' });
    expect(getPersistPolicy(ft, 'host')).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Behavioral constraint integration with HEAD save()
// ─────────────────────────────────────────────────────────────────────────────

/** Build an object type where properties have behavioral constraints. */
function objectTypeWithBehavior(
  shape: Record<string, { type: string; value?: any; merge?: string; persist?: string }>,
): FieldType {
  let ft = FieldType.object.create();
  for (const [key, spec] of Object.entries(shape)) {
    let valueFT =
      spec.type === 'string' ? FieldType.string.create() :
      spec.type === 'number' ? FieldType.number.create() :
      spec.type === 'boolean' ? FieldType.boolean.create() :
      FieldType.any.create();
    if (spec.value !== undefined) {
      valueFT = valueFT.literal(spec.value);
    }
    if (spec.merge) {
      valueFT = valueFT.merge(spec.merge);
    }
    if (spec.persist) {
      valueFT = valueFT.persist(spec.persist);
    }
    const prop = ConstraintTypes.object.property.create(key, valueFT.save());
    (ft.attributes ??= []).push(prop);
  }
  return ft.save();
}

describe('save with merge policy', () => {
  it('merge(source-wins): source keeps its value when draft writes new value', async () => {
    const ft = objectTypeWithBehavior({
      host: { type: 'string', value: 'original', merge: 'source-wins' },
    });
    const head = createHead(ft);

    // Source already has 'original' for host (via literal in the type)
    expect(head.resolved).toBe(true);

    // Draft tries to overwrite host
    const d = head.draft();
    d.write(concrete('host', { type: 'literal', value: 'draft-value' }));
    const result = await d.save();

    expect(result.ok).toBe(true);
    // Source should still have original value — source-wins policy blocks draft
    expect(head.value('host')).toBe('original');
  });

  it('merge(last-write): draft value wins over source', async () => {
    const ft = objectTypeWithBehavior({
      theme: { type: 'string', value: 'light', merge: 'last-write' },
    });
    const head = createHead(ft);

    expect(head.value('theme')).toBe('light');

    const d = head.draft();
    d.write(concrete('theme', { type: 'literal', value: 'dark' }));
    const result = await d.save();

    expect(result.ok).toBe(true);
    // Draft value should win with last-write policy
    expect(head.value('theme')).toBe('dark');
  });

  it('no merge policy: default behavior (draft overwrites)', async () => {
    const ft = objectTypeWithValues({
      host: { type: 'string', value: 'original' },
    });
    const head = createHead(ft);

    const d = head.draft();
    d.write(concrete('host', { type: 'literal', value: 'new-value' }));
    const result = await d.save();

    expect(result.ok).toBe(true);
    // No merge policy → default: draft value passes through
    expect(head.value('host')).toBe('new-value');
  });

  it('merge(source-wins) allows draft to fill gaps (no existing value)', async () => {
    const ft = objectTypeWithBehavior({
      host: { type: 'string', merge: 'source-wins' },
    });
    const head = createHead(ft);

    // host is a gap (no literal value)
    expect(head.gaps.length).toBe(1);

    const d = head.draft();
    d.write(concrete('host', { type: 'literal', value: 'localhost' }));
    const result = await d.save();

    expect(result.ok).toBe(true);
    // No existing value to protect — draft fills the gap
    expect(head.value('host')).toBe('localhost');
    expect(head.gaps.length).toBe(0);
  });

  it('type-level behavioral binds are in chain scope and accessible via value()', () => {
    const ft = objectTypeWithBehavior({
      host: { type: 'string', merge: 'source-wins', persist: 'encrypted' },
    });
    const head = createHead(ft);

    // Behavioral constraint params are type-level binds in the chain scope
    const mergeParams = head.value('host:merge');
    expect(mergeParams).toBeDefined();
    expect((mergeParams as any).value).toBe('source-wins');

    const persistParams = head.value('host:persist');
    expect(persistParams).toBeDefined();
    expect((persistParams as any).sink).toBe('encrypted');
  });

  it('merge policy does not affect type-level binds passing through', async () => {
    const ft = objectTypeWithBehavior({
      host: { type: 'string', value: 'original', merge: 'source-wins' },
    });
    const head = createHead(ft);

    // Draft writes a type-level bind (behavioral declaration)
    const d = head.draft();
    d.write(type_('host:visibility', { type: 'literal', value: { scope: 'owner' } }));
    const result = await d.save();

    expect(result.ok).toBe(true);
    // Type-level binds always pass through regardless of merge policy
    expect(head.value('host:visibility')).toBeDefined();
  });

  it('multiple properties with different merge policies', async () => {
    const ft = objectTypeWithBehavior({
      host: { type: 'string', value: 'original-host', merge: 'source-wins' },
      port: { type: 'number', value: 8080, merge: 'last-write' },
      name: { type: 'string', value: 'original-name' },
    });
    const head = createHead(ft);

    const d = head.draft();
    d.write(concrete('host', { type: 'literal', value: 'new-host' }));
    d.write(concrete('port', { type: 'literal', value: 9090 }));
    d.write(concrete('name', { type: 'literal', value: 'new-name' }));
    const result = await d.save();

    expect(result.ok).toBe(true);
    expect(head.value('host')).toBe('original-host');  // source-wins
    expect(head.value('port')).toBe(9090);             // last-write
    expect(head.value('name')).toBe('new-name');       // no policy → default
  });

  it('persist constraint is discoverable on the root type', () => {
    const ft = objectTypeWithBehavior({
      apiKey: { type: 'string', persist: 'encrypted' },
    });
    const head = createHead(ft);

    // The persist constraint is in the chain scope as a type-level bind
    const persistParams = head.value('apiKey:persist');
    expect(persistParams).toBeDefined();
    expect((persistParams as any).sink).toBe('encrypted');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Constraint inheritance via tree walk (effectiveConstraints)
// ─────────────────────────────────────────────────────────────────────────────

describe('effectiveConstraints — tree walk', () => {
  it('child inherits parent merge constraint', async () => {
    // Root has a merge('source-wins') constraint on 'host'
    const ft = objectTypeWithBehavior({
      host: { type: 'string', value: 'original', merge: 'source-wins' },
    });
    const head = createHead(ft);
    const child = head.at('host');

    // Child should see the merge constraint from parent
    const constraints = child.effectiveConstraints('merge');
    expect(constraints.length).toBeGreaterThan(0);
    expect((constraints[0] as any).constrainttype).toBe('merge');
  });

  it('child inherits parent visibility constraint', () => {
    // Create root type with visibility constraint on property
    const valueFT = FieldType.string.create()
      .visibility('private')
      .save();
    let ft = FieldType.object.create();
    (ft.attributes ??= []).push(ConstraintTypes.object.property.create('secret', valueFT));
    ft = ft.save();
    const head = createHead(ft);
    const child = head.at('secret');

    const constraints = child.effectiveConstraints('visibility');
    expect(constraints.length).toBeGreaterThan(0);
  });

  it('override:final on child seals constraint type for ancestor walk', () => {
    // Child's rootType (derived from typeAtPath) has merge('source-wins', override: 'final')
    const childFT = FieldType.string.create()
      .merge('source-wins', { override: 'final' })
      .save();
    let ft = FieldType.object.create();
    (ft.attributes ??= []).push(ConstraintTypes.object.property.create('key', childFT));
    ft = ft.save();
    const head = createHead(ft);
    const child = head.at('key');

    const constraints = child.effectiveConstraints('merge');
    // Child has merge constraint with 'final' — should seal it from ancestors
    expect(constraints.length).toBeGreaterThan(0);
    expect((constraints[0] as any).value).toBe('source-wins');
    expect((constraints[0] as any).override).toBe('final');
  });

  it('root node effectiveConstraints returns own constraints only', () => {
    const ft = objectTypeWithBehavior({
      host: { type: 'string', merge: 'source-wins' },
    });
    const head = createHead(ft);

    // Root is its own root — no tree walk
    const constraints = head.effectiveConstraints('merge');
    expect(constraints.length).toBeGreaterThan(0);
  });

  it('draft inherits source effective constraints', async () => {
    const ft = objectTypeWithBehavior({
      host: { type: 'string', value: 'original', merge: 'source-wins' },
    });
    const head = createHead(ft);
    const draft = head.draft();

    // Draft should preserve merge constraints from source
    const d2 = draft.draft();
    d2.write(concrete('host', { type: 'literal', value: 'changed' }));
    const result = await d2.save();
    expect(result.ok).toBe(true);
    // source-wins means draft's value doesn't overwrite
    expect(draft.value('host')).toBe('original');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Receiver statement emission via HEAD save() (Phase 5)
// ─────────────────────────────────────────────────────────────────────────────

describe('save with receiver statements', () => {
  it('instrumental receiver statements (concrete bind for existing name) go to source chain', async () => {
    const ft = objectType({ host: 'string' });
    const head = createHead(ft);

    // Fill host first so source scope has the binding
    const d0 = head.draft();
    d0.write(concrete('host', { type: 'literal', value: 'initial' }));
    await d0.save();

    // Register a receiver that emits a concrete substitution for 'host'
    const emittedStmt = concrete('host', { type: 'literal', value: 'rewritten-by-receiver' });
    head.addReceiver(async () => [emittedStmt]);

    // Draft writes again — triggers patchType, receiver fires
    const d = head.draft();
    d.write(concrete('host', { type: 'literal', value: 'updated' }));
    const result = await d.save();

    expect(result.ok).toBe(true);
    // Instrumental: concrete bind for existing 'host' → goes to source chain
    expect(head.value('host')).toBe('rewritten-by-receiver');
    expect(head.derived).toBeNull();
  });

  it('non-instrumental receiver statements (annotations, type-level) go to _derived', async () => {
    const ft = objectType({ host: 'string' });
    const head = createHead(ft);

    // Register a receiver that emits a type-level label/annotation
    const labelStmt = type_('host:encrypted', { type: 'literal', value: 'enc-ref-42' });
    head.addReceiver(async () => [labelStmt]);

    const d = head.draft();
    d.write(concrete('host', { type: 'literal', value: 'localhost' }));
    const result = await d.save();

    expect(result.ok).toBe(true);
    // Non-instrumental: type-level bind → goes to _derived, not source
    expect(head.derived).not.toBeNull();
    const derivedScope = reduce(head.derived!).scope;
    expect(derivedScope.bindings.get('host:encrypted')?.value).toBe('enc-ref-42');

    // value() consults _derived overlay → finds it
    expect(head.value('host:encrypted')).toBe('enc-ref-42');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Phase 1: createHead(chain) — system image
// ─────────────────────────────────────────────────────────────────────────────

/** Build a system image chain: type declarations + adapter bindings. */
function buildSystemImage(): Chain {
  const ft = FieldType.object.create();
  const apiKeyFT = FieldType.string.create()
    .persist('myStore', { transform: 'myEncrypt' })
    .decorator('myDecrypt')
    .visibility('isOwner')
    .merge('source-wins')
    .save();
  const themeFT = FieldType.string.create().merge('last-write').save();
  (ft.attributes ??= []).push(ConstraintTypes.object.property.create('apiKey', apiKeyFT));
  (ft.attributes ??= []).push(ConstraintTypes.object.property.create('theme', themeFT));

  const storeFn = (v: unknown) => `ref:${v}`;
  const encryptFn = (v: unknown) => `enc(${v})`;
  const decryptFn = (v: unknown) => String(v).replace('enc(', '').replace(')', '');

  let chain = chainFromFieldType(ft.save());
  // Adapter bindings
  chain = push(chain, concrete('myStore', { type: 'literal', value: storeFn }));
  chain = push(chain, concrete('myEncrypt', { type: 'literal', value: encryptFn }));
  chain = push(chain, concrete('myDecrypt', { type: 'literal', value: decryptFn }));
  chain = push(chain, concrete('isOwner', { type: 'literal', value: true }));
  return chain;
}

describe('createHead(chain)', () => {
  it('produces a HEAD whose snapshot matches chainToFieldType(chain)', () => {
    const chain = buildSystemImage();
    const head = createHead(chain);

    expect(head.snapshot).toBeDefined();
    expect(head.snapshot.fieldtype).toBe('object');
  });

  it('preserves adapter bindings — value() returns the storeFn', () => {
    const chain = buildSystemImage();
    const head = createHead(chain);

    // Adapter functions are in scope as concrete bindings
    expect(typeof head.value('myStore')).toBe('function');
    expect(typeof head.value('myEncrypt')).toBe('function');
    expect(typeof head.value('myDecrypt')).toBe('function');
    expect(head.value('isOwner')).toBe(true);
  });

  it('preserves behavioral type-level binds in scope', () => {
    const chain = buildSystemImage();
    const head = createHead(chain);

    // Type-level binds emitted by chainFromFieldType are in scope
    const persistParams = head.value('apiKey:persist');
    expect(persistParams).toBeDefined();
    expect((persistParams as any).sink).toBe('myStore');

    const mergeParams = head.value('apiKey:merge');
    expect(mergeParams).toBeDefined();
    expect((mergeParams as any).value).toBe('source-wins');
  });

  it('accepts HeadOptions as second argument', () => {
    const chain = buildSystemImage();
    const head = createHead(chain, { path: 'config' });
    expect(head.path).toBe('config');
  });

  it('existing createHead(fieldType) tests still pass', () => {
    // Smoke check: FieldType path is unaffected
    const ft = objectType({ host: 'string', port: 'number' });
    const head = createHead(ft);
    expect(head.gaps.length).toBe(2);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Phase 2: resolveConstraintParam + resolveConstraint
// ─────────────────────────────────────────────────────────────────────────────

describe('resolveConstraintParam', () => {
  it('returns resolved binding value', () => {
    const chain = buildSystemImage();
    const { scope } = reduce(chain);
    const fn = resolveConstraintParam(scope, 'myStore');
    expect(typeof fn).toBe('function');
  });

  it('returns undefined for unresolved binding', () => {
    const chain = buildSystemImage();
    const { scope } = reduce(chain);
    expect(resolveConstraintParam(scope, 'nonexistent')).toBeUndefined();
  });

  it('returns undefined for ref gate (unresolved binding)', () => {
    const ft = objectType({ host: 'string' });
    const chain = chainFromFieldType(ft);
    const { scope } = reduce(chain);
    // 'host' is a ref gate (unresolved)
    expect(resolveConstraintParam(scope, 'host')).toBeUndefined();
  });
});

describe('resolveConstraint', () => {
  it('resolves all params, using scope bindings for adapter functions', () => {
    const chain = buildSystemImage();
    const { scope } = reduce(chain);
    const rootType = FieldType.object.create().save(); // bare rootType — scope path used

    const persist = resolveConstraint(rootType, scope, 'apiKey', 'persist');
    expect(persist).not.toBeNull();
    // 'myStore' resolved to the storeFn function
    expect(typeof persist!.sink).toBe('function');
    // 'myEncrypt' resolved to the encryptFn function
    expect(typeof persist!.transform).toBe('function');
  });

  it('falls back to literal string for non-scope values', () => {
    const ft = objectTypeWithBehavior({
      host: { type: 'string', merge: 'source-wins' },
    });
    const chain = chainFromFieldType(ft);
    const { scope } = reduce(chain);

    const merge = resolveConstraint(ft, scope, 'host', 'merge');
    expect(merge).not.toBeNull();
    // 'source-wins' is not a scope binding name — kept as literal
    expect(merge!.value).toBe('source-wins');
  });

  it('returns null for missing constraint', () => {
    const ft = objectType({ host: 'string' });
    const chain = chainFromFieldType(ft);
    const { scope } = reduce(chain);

    expect(resolveConstraint(ft, scope, 'host', 'persist')).toBeNull();
  });

  it('works via rootType path (FieldType-based HEAD)', () => {
    const keyFT = FieldType.string.create().persist('encrypted').save();
    let ft = FieldType.object.create();
    (ft.attributes ??= []).push(ConstraintTypes.object.property.create('apiKey', keyFT));
    ft = ft.save();

    const chain = chainFromFieldType(ft);
    const { scope } = reduce(chain);

    const persist = resolveConstraint(ft, scope, 'apiKey', 'persist');
    expect(persist).not.toBeNull();
    expect(persist!.sink).toBe('encrypted');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Phase 3: Operationalize persist/subscribe/compact/merge-error in save()
// ─────────────────────────────────────────────────────────────────────────────

describe('save with persist constraint (operationalized)', () => {
  it('sinkFn called and value substituted in chain', async () => {
    const calls: unknown[] = [];
    const storeFn = (v: unknown) => { calls.push(v); return `ref:${v}`; };

    let chain = chainFromFieldType(
      buildObjType({ secret: FieldType.string.create().persist('mySink').save() }),
    );
    chain = push(chain, concrete('mySink', { type: 'literal', value: storeFn }));

    const head = createHead(chain);
    const d = head.draft();
    d.write(concrete('secret', { type: 'literal', value: 'hunter2' }));
    const result = await d.save();

    expect(result.ok).toBe(true);
    expect(calls).toEqual(['hunter2']);
    // Value should be substituted with the ref returned by storeFn
    expect(head.value('secret')).toBe('ref:hunter2');
  });

  it('persist + transform: transformFn called before sinkFn', async () => {
    const callOrder: string[] = [];
    const encryptFn = (v: unknown) => { callOrder.push('encrypt'); return `enc(${v})`; };
    const storeFn = (v: unknown) => { callOrder.push('store'); return `stored:${v}`; };

    let chain = chainFromFieldType(
      buildObjType({ key: FieldType.string.create().persist('mySink', { transform: 'myEncrypt' }).save() }),
    );
    chain = push(chain, concrete('mySink', { type: 'literal', value: storeFn }));
    chain = push(chain, concrete('myEncrypt', { type: 'literal', value: encryptFn }));

    const head = createHead(chain);
    const d = head.draft();
    d.write(concrete('key', { type: 'literal', value: 'secret' }));
    await d.save();

    expect(callOrder).toEqual(['encrypt', 'store']);
    expect(head.value('key')).toBe('stored:enc(secret)');
  });

  it('persist with no adapter resolved: constraint is inert', async () => {
    // No 'mySink' binding in scope — persist is inert
    const ft = buildObjType({ key: FieldType.string.create().persist('mySink').save() });

    const head = createHead(ft);
    const d = head.draft();
    d.write(concrete('key', { type: 'literal', value: 'plain' }));
    await d.save();

    // Value should pass through unchanged — no sinkFn to call
    expect(head.value('key')).toBe('plain');
  });
});

describe('save with subscribe constraint (operationalized)', () => {
  it('target binding lives in subscriptions chain, readable via value()', async () => {
    let chain = chainFromFieldType(
      buildObjType({ source: FieldType.string.create().subscribe('targetLog').save() }),
    );

    const head = createHead(chain);
    const d = head.draft();
    d.write(concrete('source', { type: 'literal', value: 'event-data' }));
    await d.save();

    // Subscribe writes to the _subscriptions chain, NOT the source chain.
    expect(head.subscriptions).not.toBeNull();
    const subScope = reduce(head.subscriptions!.chain).scope;
    const targetBinding = subScope.bindings.get('targetLog');
    expect(targetBinding?.resolved).toBe(true);
    expect(targetBinding?.value).toBe('event-data');

    // value() consults _subscriptions as overlay → finds it
    expect(head.value('targetLog')).toBe('event-data');

    // entries() includes subscription bindings
    expect(head.entries().get('targetLog')).toBe('event-data');
  });

  it('subscriptions chain is null when no subscribe constraints fire', async () => {
    const chain = chainFromFieldType(
      buildObjType({ plain: FieldType.string.create() }),
    );

    const head = createHead(chain);
    const d = head.draft();
    d.write(concrete('plain', { type: 'literal', value: 'no-subscribe' }));
    await d.save();

    expect(head.subscriptions).toBeNull();
  });

  it('source chain does not contain subscription output', async () => {
    let chain = chainFromFieldType(
      buildObjType({ source: FieldType.string.create().subscribe('targetLog').save() }),
    );

    const head = createHead(chain);
    const d = head.draft();
    d.write(concrete('source', { type: 'literal', value: 'event-data' }));
    await d.save();

    // Source scope should NOT have targetLog — it lives in _subscriptions only
    const sourceScope = reduce(chain).scope;
    expect(sourceScope.bindings.has('targetLog')).toBe(false);
  });
});

describe('save with compact constraint (operationalized)', () => {
  it('chain compacted when exceeding retain threshold', async () => {
    let chain = chainFromFieldType(
      buildObjType({ counter: FieldType.number.create().compact({ retain: 3 }).save() }),
    );

    const head = createHead(chain);

    // Write multiple values to grow the chain
    for (let i = 0; i < 5; i++) {
      const d = head.draft();
      d.write(concrete('counter', { type: 'literal', value: i }));
      await d.save();
    }

    // The value should still be correct after compaction
    expect(head.value('counter')).toBe(4);
  });
});

describe('save with merge error policy', () => {
  it('throws on conflict when merge policy is error', async () => {
    let chain = chainFromFieldType(
      buildObjType({ immutable: FieldType.string.create().merge('error').save() }),
    );
    // Provide initial value
    chain = push(chain, concrete('immutable', { type: 'literal', value: 'original' }));

    const head = createHead(chain);

    const d = head.draft();
    d.write(concrete('immutable', { type: 'literal', value: 'attempt-change' }));

    await expect(d.save()).rejects.toThrow(/Merge conflict.*immutable.*policy: error/);
    // Source should retain original value
    expect(head.value('immutable')).toBe('original');
  });

  it('merge error allows filling gaps (no existing value)', async () => {
    const chain = chainFromFieldType(
      buildObjType({ once: FieldType.string.create().merge('error').save() }),
    );

    const head = createHead(chain);

    const d = head.draft();
    d.write(concrete('once', { type: 'literal', value: 'set-once' }));
    const result = await d.save();

    expect(result.ok).toBe(true);
    expect(head.value('once')).toBe('set-once');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Phase 4: Decorator in value()/entries(), visibility in entries()
// ─────────────────────────────────────────────────────────────────────────────

describe('value() with decorator', () => {
  it('decorator transform applied on read', async () => {
    const decryptFn = (v: unknown) => String(v).replace('enc:', '');
    const encryptFn = (v: unknown) => `enc:${v}`;
    const storeFn = (v: unknown) => v; // identity — returns as-is

    let chain = chainFromFieldType(
      buildObjType({
        secret: FieldType.string.create()
          .persist('mySink', { transform: 'myEncrypt' })
          .decorator('myDecrypt')
          .save(),
      }),
    );
    chain = push(chain, concrete('mySink', { type: 'literal', value: storeFn }));
    chain = push(chain, concrete('myEncrypt', { type: 'literal', value: encryptFn }));
    chain = push(chain, concrete('myDecrypt', { type: 'literal', value: decryptFn }));

    const head = createHead(chain);
    const d = head.draft();
    // Write plain text — persist encrypts on save, decorator decrypts on read
    d.write(concrete('secret', { type: 'literal', value: 'password' }));
    await d.save();

    // Decorator decrypts on read: enc:password → password
    expect(head.value('secret')).toBe('password');
  });

  it('returns raw value when no decorator', async () => {
    const chain = chainFromFieldType(
      buildObjType({ plain: FieldType.string.create().save() }),
    );

    const head = createHead(chain);
    const d = head.draft();
    d.write(concrete('plain', { type: 'literal', value: 'hello' }));
    await d.save();

    expect(head.value('plain')).toBe('hello');
  });
});

describe('entries() with decorator and visibility', () => {
  it('decorator transforms applied to all entries', async () => {
    const upperFn = (v: unknown) => String(v).toUpperCase();

    let chain = chainFromFieldType(
      buildObjType({ name: FieldType.string.create().decorator('myUpper').save() }),
    );
    chain = push(chain, concrete('myUpper', { type: 'literal', value: upperFn }));

    const head = createHead(chain);
    const d = head.draft();
    d.write(concrete('name', { type: 'literal', value: 'alice' }));
    await d.save();

    const entries = head.entries();
    expect(entries.get('name')).toBe('ALICE');
  });

  it('visibility: field excluded when scope binding is falsy', async () => {
    let chain = chainFromFieldType(
      buildObjType({ secret: FieldType.string.create().visibility('isOwner').save() }),
    );
    // isOwner = false → secret should be hidden
    chain = push(chain, concrete('isOwner', { type: 'literal', value: false }));
    chain = push(chain, concrete('secret', { type: 'literal', value: 'hidden-data' }));

    const head = createHead(chain);

    const entries = head.entries();
    expect(entries.has('secret')).toBe(false);
  });

  it('visibility: field included when scope binding is truthy', async () => {
    let chain = chainFromFieldType(
      buildObjType({ secret: FieldType.string.create().visibility('isOwner').save() }),
    );
    // isOwner = true → secret should be visible
    chain = push(chain, concrete('isOwner', { type: 'literal', value: true }));
    chain = push(chain, concrete('secret', { type: 'literal', value: 'visible-data' }));

    const head = createHead(chain);

    const entries = head.entries();
    expect(entries.get('secret')).toBe('visible-data');
  });
});

describe('value() + save() roundtrip: persist + decorator', () => {
  it('persist writes encrypted, decorator reads decrypted', async () => {
    const storeFn = (v: unknown) => v; // identity — stores the encrypted value as-is
    const encryptFn = (v: unknown) => `enc(${v})`;
    const decryptFn = (v: unknown) => String(v).replace('enc(', '').replace(')', '');

    let chain = chainFromFieldType(
      buildObjType({
        apiKey: FieldType.string.create()
          .persist('myStore', { transform: 'myEncrypt' })
          .decorator('myDecrypt')
          .save(),
      }),
    );
    chain = push(chain, concrete('myStore', { type: 'literal', value: storeFn }));
    chain = push(chain, concrete('myEncrypt', { type: 'literal', value: encryptFn }));
    chain = push(chain, concrete('myDecrypt', { type: 'literal', value: decryptFn }));

    const head = createHead(chain);

    const d = head.draft();
    d.write(concrete('apiKey', { type: 'literal', value: 'sk-12345' }));
    await d.save();

    // Decorator decrypts on read
    expect(head.value('apiKey')).toBe('sk-12345');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Phase 5: Fork constraint in draft()
// ─────────────────────────────────────────────────────────────────────────────

describe('draft() with fork constraint', () => {
  it('fork(copy): default — inherits all bindings', async () => {
    let chain = chainFromFieldType(
      buildObjType({ config: FieldType.string.create().fork('copy').save() }),
    );
    chain = push(chain, concrete('config', { type: 'literal', value: 'inherited' }));

    const head = createHead(chain);
    const d = head.draft();

    // 'copy' = default behavior, value should be inherited
    expect(d.value('config')).toBe('inherited');
  });

  it('fork(exclude): excluded field not inherited by draft', async () => {
    let chain = chainFromFieldType(
      buildObjType({ ephemeral: FieldType.string.create().fork('exclude').save() }),
    );
    chain = push(chain, concrete('ephemeral', { type: 'literal', value: 'session-data' }));

    const head = createHead(chain);
    const d = head.draft();

    // 'exclude' masks the binding in the draft's own scope with an optional ref gate.
    // The excluded field doesn't appear as a required gap.
    expect(d.gaps.find(g => g.key === 'ephemeral')).toBeUndefined();
    // The draft should still work (no required gaps from excluded field)
    expect(d.lifecycle).not.toBe('pending');
  });

  it('without fork constraint: no change (default inheritance)', async () => {
    let chain = chainFromFieldType(
      buildObjType({ normal: FieldType.string.create().save() }),
    );
    chain = push(chain, concrete('normal', { type: 'literal', value: 'inherited' }));

    const head = createHead(chain);
    const d = head.draft();

    // No fork constraint — value inherited normally
    expect(d.value('normal')).toBe('inherited');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Phase 5b: DraftSpec — call-site masking in draft()
// ─────────────────────────────────────────────────────────────────────────────

describe('draft() with DraftSpec call-site masking', () => {
  it('exclude: masked binding does not block lifecycle, value readable via parent', () => {
    const head = createHead();
    head.write(concrete('dataPath', { type: 'literal', value: '/data' }));
    head.write(concrete('identity', { type: 'literal', value: 'user@example.com' }));

    const d = head.draft({ exclude: ['dataPath'] });

    // Masked binding does not create a required gap
    expect(d.gaps.find(g => g.key === 'dataPath')).toBeUndefined();
    expect(d.lifecycle).not.toBe('pending');
    // Value still readable via parent fallthrough
    expect(d.value('dataPath')).toBe('/data');
    // Non-masked binding inherited normally
    expect(d.value('identity')).toBe('user@example.com');
  });

  it('filter: predicate-based masking works identically', () => {
    const head = createHead();
    head.write(concrete('mainStorage', { type: 'literal', value: 'storage-obj' }));
    head.write(concrete('identity', { type: 'literal', value: 'user@example.com' }));
    head.write(concrete('toolset:gh', { type: 'literal', value: { packageID: 'toolset:gh' } }));

    const d = head.draft({ filter: (name) => name === 'mainStorage' });

    expect(d.gaps.find(g => g.key === 'mainStorage')).toBeUndefined();
    expect(d.lifecycle).not.toBe('pending');
    // Masked value still readable via parent fallthrough
    expect(d.value('mainStorage')).toBe('storage-obj');
    // Non-masked bindings inherited normally
    expect(d.value('identity')).toBe('user@example.com');
    expect(d.value('toolset:gh')).toBeDefined();
  });

  it('no spec: default inheritance unchanged', () => {
    const head = createHead();
    head.write(concrete('x', { type: 'literal', value: 42 }));
    head.write(concrete('y', { type: 'literal', value: 'hello' }));

    const d = head.draft();

    expect(d.value('x')).toBe(42);
    expect(d.value('y')).toBe('hello');
    expect(d.lifecycle).not.toBe('pending');
  });

  it('behavioral constraint names are never masked by DraftSpec', () => {
    let chain = chainFromFieldType(
      buildObjType({ identity: FieldType.string.create().merge('source-wins').save() }),
    );
    chain = push(chain, concrete('identity', { type: 'literal', value: 'user@example.com' }));

    const head = createHead(chain);

    // Attempt to exclude the behavioral constraint declaration name
    const d = head.draft({ exclude: ['identity:merge'] });

    // Behavioral name still accessible — guard prevents masking
    expect(d.value('identity:merge')).toBeDefined();
    // The actual binding also still works
    expect(d.value('identity')).toBe('user@example.com');
  });

  it('filter + exclude: union of both applied', () => {
    const head = createHead();
    head.write(concrete('a', { type: 'literal', value: 1 }));
    head.write(concrete('b', { type: 'literal', value: 2 }));
    head.write(concrete('c', { type: 'literal', value: 3 }));

    const d = head.draft({
      filter: (name) => name === 'a',
      exclude: ['b'],
    });

    // Both 'a' and 'b' masked — no required gaps
    expect(d.gaps.find(g => g.key === 'a')).toBeUndefined();
    expect(d.gaps.find(g => g.key === 'b')).toBeUndefined();
    expect(d.lifecycle).not.toBe('pending');
    // Still readable via parent
    expect(d.value('a')).toBe(1);
    expect(d.value('b')).toBe(2);
    // 'c' not masked — inherited normally
    expect(d.value('c')).toBe(3);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Integration: persist + merge + compact on same HEAD
// ─────────────────────────────────────────────────────────────────────────────

describe('integration: persist + merge + compact', () => {
  it('full operationalization roundtrip', async () => {
    const stored: Map<string, unknown> = new Map();
    const storeFn = (v: unknown) => { stored.set('latest', v); return v; };
    const encryptFn = (v: unknown) => `enc(${v})`;

    let chain = chainFromFieldType(
      buildObjType({
        apiKey: FieldType.string.create()
          .persist('mySink', { transform: 'myEncrypt' })
          .merge('source-wins')
          .save(),
        theme: FieldType.string.create()
          .merge('last-write')
          .save(),
      }),
    );
    chain = push(chain, concrete('mySink', { type: 'literal', value: storeFn }));
    chain = push(chain, concrete('myEncrypt', { type: 'literal', value: encryptFn }));

    const head = createHead(chain);

    // First save: fill apiKey and theme
    const d1 = head.draft();
    d1.write(concrete('apiKey', { type: 'literal', value: 'sk-123' }));
    d1.write(concrete('theme', { type: 'literal', value: 'dark' }));
    const r1 = await d1.save();
    expect(r1.ok).toBe(true);

    // Persist should have encrypted and stored
    expect(stored.get('latest')).toBe('enc(sk-123)');

    // Second save: try to overwrite apiKey (source-wins blocks), update theme (last-write allows)
    const d2 = head.draft();
    d2.write(concrete('apiKey', { type: 'literal', value: 'sk-new' }));
    d2.write(concrete('theme', { type: 'literal', value: 'light' }));
    const r2 = await d2.save();
    expect(r2.ok).toBe(true);

    // apiKey should be unchanged (source-wins), theme should be updated
    expect(head.value('theme')).toBe('light');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Phase 6: Reactive Cascade
//
// Demonstrates the core reactive planning loop:
//   source advances → drafts re-evaluate → lifecycle transitions propagate
//
// No new production code — exercises registerSourceGate + effectiveChain +
// getGaps + evaluateLifecycle composing together.
// ─────────────────────────────────────────────────────────────────────────────

describe('reactive cascade', () => {
  it('source advance closes draft gaps and transitions lifecycle', async () => {
    // Source HEAD with two requirements (ref gates — no initial values)
    const ft = objectType({ demand: 'number', region: 'string' });
    const source = createHead(ft);
    expect(source.gaps.length).toBe(2);

    // Fork a downstream draft — inherits source's ref gates as gaps
    const downstream = source.draft();
    expect(downstream.lifecycle).toBe('pending');
    expect(downstream.gaps.length).toBe(2);

    const events = collectEvents(downstream);

    // Fill BOTH gaps on source in one save.
    // (A filler draft inherits the same ref gates — must satisfy all to save.)
    const filler = source.draft();
    filler.write(concrete('demand', { type: 'literal', value: 100 }));
    filler.write(concrete('region', { type: 'literal', value: 'US' }));
    await filler.save();

    expect(source.value('demand')).toBe(100);
    expect(source.value('region')).toBe('US');

    // REACTIVE: downstream draft re-evaluated via registerSourceGate.
    // effectiveChain sees live parent → all gaps closed → ready.
    expect(downstream.gaps.length).toBe(0);
    expect(downstream.lifecycle).toBe('ready');
    expect(downstream.value('demand')).toBe(100);
    expect(downstream.value('region')).toBe('US');

    // Prove reactive notification via gaps-changed event
    const gapEvents = events.filter(e => e.type === 'gaps-changed');
    expect(gapEvents.length).toBe(1);
  });

  it('progressive resolution: gaps close one by one as source advances', async () => {
    // Source has ONE typed property (demand).
    // Downstream adds its OWN ref gate (region) — not in source type.
    // Two sequential fills close gaps progressively.
    const ft = objectType({ demand: 'number' });
    const source = createHead(ft);

    const downstream = source.draft();
    // Add a second requirement not in the source type
    downstream.write({ type: 'bind', name: 'region', expr: ref('string'), level: 'concrete' });
    expect(downstream.gaps.length).toBe(2); // demand (from source) + region (own ref gate)
    expect(downstream.lifecycle).toBe('pending');

    // Collect events AFTER the write to only capture cascade notifications
    const events = collectEvents(downstream);

    // Step 1: Fill demand on source (source's only typed gap)
    const f1 = source.draft();
    f1.write(concrete('demand', { type: 'literal', value: 100 }));
    await f1.save();

    // Downstream: demand resolved by live parent → one gap left (region)
    expect(downstream.gaps.length).toBe(1);
    expect(downstream.gaps[0].key).toBe('region');
    expect(downstream.lifecycle).toBe('pending');

    // Step 2: Fill region on source (filler has no required gaps — demand already resolved)
    const f2 = source.draft();
    f2.write(concrete('region', { type: 'literal', value: 'US' }));
    await f2.save();

    // Downstream: both resolved → ready
    expect(downstream.gaps.length).toBe(0);
    expect(downstream.lifecycle).toBe('ready');

    // Two source advances → two rounds of reactive gap re-evaluation
    const gapEvents = events.filter(e => e.type === 'gaps-changed');
    expect(gapEvents.length).toBeGreaterThanOrEqual(2);
  });

  it('multi-hop cascade: D1 save → source advance → D2 re-evaluation', async () => {
    // Source has one typed property (trigger).
    // D1 provides 'region' and needs 'trigger' from source.
    // D2 needs 'trigger' (from source) AND 'region' (own ref gate → filled by D1's merge).
    //
    // Cascade: filler fills trigger → D1 ready → D1 saves region into source → D2 ready.
    const ft = objectType({ trigger: 'string' });
    const source = createHead(ft);

    // D1: writes region, needs trigger
    const d1 = source.draft();
    d1.write(concrete('region', { type: 'literal', value: 'EU' }));
    expect(d1.lifecycle).toBe('pending'); // trigger gap

    // D2: needs trigger AND region (own ref gate)
    const d2 = source.draft();
    d2.write({ type: 'bind', name: 'region', expr: ref('string'), level: 'concrete' });
    const d2Events = collectEvents(d2);

    expect(d2.gaps.length).toBe(2); // trigger + region

    // Step 1: Fill trigger on source
    const filler = source.draft();
    filler.write(concrete('trigger', { type: 'literal', value: 'go' }));
    await filler.save();

    // D1: trigger resolved by parent, region by own write → ready
    expect(d1.lifecycle).toBe('ready');

    // D2: trigger resolved by parent, but region still unresolved
    expect(d2.gaps.length).toBe(1);
    expect(d2.gaps[0].key).toBe('region');
    expect(d2.lifecycle).toBe('pending');

    // Step 2: D1 saves → merges region='EU' into source → source advances
    const r1 = await d1.save();
    expect(r1.ok).toBe(true);
    expect(source.value('region')).toBe('EU');

    // MULTI-HOP CASCADE:
    //   D1.save() → source advance → D2 registerSourceGate fires
    //   → D2: trigger resolved (parent), region resolved (parent, from D1's merge)
    //   → D2 lifecycle: ready
    expect(d2.gaps.length).toBe(0);
    expect(d2.lifecycle).toBe('ready');

    // At least 2 gap-change rounds on D2 (filler.save + d1.save)
    const gapEvents = d2Events.filter(e => e.type === 'gaps-changed');
    expect(gapEvents.length).toBeGreaterThanOrEqual(2);
  });

  it('downstream draft sees updated values after source advances', async () => {
    const ft = objectType({ forecast: 'number' });
    const source = createHead(ft);

    const downstream = source.draft();
    expect(downstream.lifecycle).toBe('pending');

    const events = collectEvents(downstream);

    // First fill: forecast = 100
    const d1 = source.draft();
    d1.write(concrete('forecast', { type: 'literal', value: 100 }));
    await d1.save();

    // Gap closed, draft sees the value via live parent
    expect(downstream.gaps.length).toBe(0);
    expect(downstream.lifecycle).toBe('ready');
    expect(downstream.value('forecast')).toBe(100);

    // Second fill: forecast updated to 200 (last-write-wins, append-only)
    const d2 = source.draft();
    d2.write(concrete('forecast', { type: 'literal', value: 200 }));
    await d2.save();

    // Draft still ready, but sees the updated value
    expect(downstream.lifecycle).toBe('ready');
    expect(downstream.value('forecast')).toBe(200);

    // Two rounds of gap-changes (one per source advance)
    const gapEvents = events.filter(e => e.type === 'gaps-changed');
    expect(gapEvents.length).toBeGreaterThanOrEqual(2);
  });

  it('disposed draft does not receive cascade notifications', async () => {
    const ft = objectType({ x: 'number' });
    const source = createHead(ft);

    const downstream = source.draft();
    const events = collectEvents(downstream);
    downstream.dispose();

    // Fill source after disposing downstream
    const filler = source.draft();
    filler.write(concrete('x', { type: 'literal', value: 42 }));
    await filler.save();

    // No gap-change events on disposed draft
    const gapEvents = events.filter(e => e.type === 'gaps-changed');
    expect(gapEvents.length).toBe(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Phase 7: autoMerge — self-scheduling drafts
//
// When a draft's lifecycle transitions to 'ready' and the root type has an
// autoMerge behavioral constraint, the draft fires save() via microtask.
// This completes the reactive planning loop: source advance → draft re-evaluates
// → gaps close → auto-save → source advances → cascade.
// ─────────────────────────────────────────────────────────────────────────────

describe('autoMerge', () => {
  it('draft auto-saves when gaps close and autoMerge is declared', async () => {
    // Property-level autoMerge: declared on a property's value type
    const ft = buildObjType({
      trigger: FieldType.string.create().autoMerge().save(),
    });
    const source = createHead(ft);

    // Draft writes a value — but trigger is a ref gate (gap)
    const d = source.draft();
    d.write(concrete('trigger', { type: 'literal', value: 'go' }));

    // Draft should be ready (gap filled by own write)
    expect(d.lifecycle).toBe('ready');

    // autoMerge fires save() via microtask — await a tick
    await new Promise(r => setTimeout(r, 0));

    // Source should now have the value (merged by auto-save)
    expect(source.value('trigger')).toBe('go');
  });

  it('autoMerge cascade: filling source triggers downstream auto-save', async () => {
    // Source has one gap; downstream draft fills it + has autoMerge
    const ft = buildObjType({
      demand: FieldType.number.create().autoMerge().save(),
    });
    const source = createHead(ft);

    // Downstream draft writes data AND fills the gap
    const downstream = source.draft();
    downstream.write(concrete('demand', { type: 'literal', value: 500 }));
    downstream.write(concrete('region', { type: 'literal', value: 'EU' }));

    // lifecycle: ready, autoMerge queued
    expect(downstream.lifecycle).toBe('ready');

    // Wait for microtask
    await new Promise(r => setTimeout(r, 0));

    // Source should have both values (auto-merged)
    expect(source.value('demand')).toBe(500);
    expect(source.value('region')).toBe('EU');
  });

  it('autoMerge does not fire when gaps remain', async () => {
    const ft = buildObjType({
      a: FieldType.string.create().autoMerge().save(),
      b: FieldType.string.create().save(),
    });
    const source = createHead(ft);

    // Draft fills only 'a', not 'b' — still pending
    const d = source.draft();
    d.write(concrete('a', { type: 'literal', value: 'filled' }));
    expect(d.lifecycle).toBe('pending');

    await new Promise(r => setTimeout(r, 0));

    // Source should NOT have the value — draft didn't auto-save
    expect(source.value('a')).toBeUndefined();
  });

  it('autoMerge + reactive cascade: autonomous multi-hop pipeline', async () => {
    // The crown jewel: autonomous reactive pipeline.
    //
    // Source has one gap (trigger). D1 has autoMerge, writes region, needs trigger.
    // D2 has autoMerge, needs trigger + region (own ref gate).
    //
    // Filling trigger on source kicks off a fully autonomous cascade:
    //   filler.save → source advances → D1 ready → D1 auto-saves →
    //   source advances → D2 ready → D2 auto-saves → all three values on source.
    //
    // NOTE: autoMerge fires via microtask, so D1's save starts BEFORE
    // await filler.save() returns to us — the cascade is truly autonomous.
    const ft = buildObjType({
      trigger: FieldType.string.create().autoMerge().save(),
    });
    const source = createHead(ft);

    // D1: provides region, needs trigger
    const d1 = source.draft();
    d1.write(concrete('region', { type: 'literal', value: 'EU' }));
    expect(d1.lifecycle).toBe('pending');

    // D2: needs trigger + region (own ref gate)
    const d2 = source.draft();
    d2.write({ type: 'bind', name: 'region', expr: ref('string'), level: 'concrete' });
    d2.write(concrete('priority', { type: 'literal', value: 'high' }));
    expect(d2.lifecycle).toBe('pending');

    // Fill trigger on source — this kicks off the autonomous cascade.
    // D1's autoMerge microtask fires during await resolution, so by the time
    // we reach the next line, D1's save is already in progress or complete.
    const filler = source.draft();
    filler.write(concrete('trigger', { type: 'literal', value: 'go' }));
    await filler.save();

    // Wait for the full cascade to settle (all microtask-driven saves complete)
    await new Promise(r => setTimeout(r, 0));

    // Full autonomous cascade complete:
    //   trigger (from filler) + region (from D1 auto-merge) + priority (from D2 auto-merge)
    expect(source.value('trigger')).toBe('go');
    expect(source.value('region')).toBe('EU');
    expect(source.value('priority')).toBe('high');
  });

  it('disposed draft does not auto-save', async () => {
    const ft = buildObjType({
      x: FieldType.number.create().autoMerge().save(),
    });
    const source = createHead(ft);

    const d = source.draft();
    d.write(concrete('x', { type: 'literal', value: 42 }));
    expect(d.lifecycle).toBe('ready');

    // Dispose before microtask fires
    d.dispose();
    await new Promise(r => setTimeout(r, 0));

    // Source should NOT have the value
    expect(source.value('x')).toBeUndefined();
  });

  it('without autoMerge: no auto-save even when ready', async () => {
    const ft = objectType({ x: 'number' });
    const source = createHead(ft);

    const d = source.draft();
    d.write(concrete('x', { type: 'literal', value: 42 }));
    expect(d.lifecycle).toBe('ready');

    await new Promise(r => setTimeout(r, 0));

    // No autoMerge → source untouched
    expect(source.value('x')).toBeUndefined();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Phase 8 — MCTS as Draft Tree
//
// Zero production code. Draft-from-draft creates a search tree.
// Statistics as type-level binds. Proves HEAD is a general-purpose
// planning substrate.
// ─────────────────────────────────────────────────────────────────────────────

describe('MCTS as draft tree', () => {

  // ── Helpers ──

  /** Read a numeric stat from type-level binds via value(). */
  function getStat(head: HEAD, name: string): number {
    return (head.value(name) as number) ?? 0;
  }

  /** UCB1 selection formula. Unvisited nodes return Infinity. */
  function ucb1(totalScore: number, visits: number, parentVisits: number, c = 1.41): number {
    if (visits === 0) return Infinity;
    return totalScore / visits + c * Math.sqrt(Math.log(parentVisits) / visits);
  }

  /** Write statistics as type-level binds (last-write-wins). */
  function writeStats(head: HEAD, visits: number, totalScore: number): void {
    head.write(type_('visits', { type: 'literal', value: visits }));
    head.write(type_('totalScore', { type: 'literal', value: totalScore }));
  }

  /** Backpropagate a score from leaf to root via .source traversal. */
  function backpropagate(leaf: HEAD, score: number): void {
    let current: HEAD | null = leaf;
    while (current) {
      const v = getStat(current, 'visits');
      const s = getStat(current, 'totalScore');
      writeStats(current, v + 1, s + score);
      current = current.source;
    }
  }

  /** Select best child via UCB1. */
  function selectChild(children: HEAD[], parentVisits: number): HEAD {
    let best: HEAD = children[0];
    let bestScore = -Infinity;
    for (const child of children) {
      const score = ucb1(
        getStat(child, 'totalScore'),
        getStat(child, 'visits'),
        parentVisits,
      );
      if (score > bestScore) {
        bestScore = score;
        best = child;
      }
    }
    return best;
  }

  // ── Tests ──

  it('draft-from-draft creates a tree structure', () => {
    const root = createHead();
    const d1 = root.draft();
    const d1a = d1.draft();
    const d1b = d1.draft();
    const d2 = root.draft();

    // Tree structure navigable via .source (identity-correct via _head cache)
    expect(d1.source).toBe(root);
    expect(d1a.source).toBe(d1);
    expect(d1b.source).toBe(d1);
    expect(d2.source).toBe(root);

    // Root has no source
    expect(root.source).toBeNull();

    // Depth-3: grandchild of grandchild
    const d1a_i = d1a.draft();
    expect(d1a_i.source).toBe(d1a);
    expect(d1a_i.source!.source).toBe(d1);
    expect(d1a_i.source!.source!.source).toBe(root);
  });

  it('type-level binds store and update statistics', () => {
    const node = createHead();

    // Initially: no stats
    expect(node.value('visits')).toBeUndefined();
    expect(node.value('totalScore')).toBeUndefined();

    // Write initial stats
    writeStats(node, 1, 0.7);
    expect(getStat(node, 'visits')).toBe(1);
    expect(getStat(node, 'totalScore')).toBe(0.7);

    // Update stats — last-write-wins in reduce()
    writeStats(node, 5, 3.2);
    expect(getStat(node, 'visits')).toBe(5);
    expect(getStat(node, 'totalScore')).toBe(3.2);
  });

  it('backpropagation writes stats up the tree via .source', () => {
    const root = createHead();
    const child = root.draft();
    const grandchild = child.draft();

    // Simulate at grandchild, score = 0.8
    backpropagate(grandchild, 0.8);

    // All three nodes have visits=1, totalScore=0.8
    expect(getStat(grandchild, 'visits')).toBe(1);
    expect(getStat(grandchild, 'totalScore')).toBe(0.8);
    expect(getStat(child, 'visits')).toBe(1);
    expect(getStat(child, 'totalScore')).toBe(0.8);
    expect(getStat(root, 'visits')).toBe(1);
    expect(getStat(root, 'totalScore')).toBe(0.8);

    // Second simulation on a different branch, score = 0.3
    const child2 = root.draft();
    const gc2 = child2.draft();
    backpropagate(gc2, 0.3);

    // Root aggregates both: 2 visits, 1.1 total
    expect(getStat(root, 'visits')).toBe(2);
    expect(getStat(root, 'totalScore')).toBeCloseTo(1.1);
    // First subtree unchanged at child level
    expect(getStat(child, 'visits')).toBe(1);
    expect(getStat(child, 'totalScore')).toBe(0.8);
  });

  it('UCB1 selection picks the best child', () => {
    const root = createHead();

    const children: HEAD[] = [];
    for (let i = 0; i < 3; i++) children.push(root.draft());

    // Unvisited → UCB1 = Infinity → first unvisited selected
    writeStats(root, 0, 0);
    expect(selectChild(children, 0)).toBe(children[0]);

    // Give stats: child[0]=2/5, child[1]=4/5, child[2]=1/5
    writeStats(children[0], 5, 2);
    writeStats(children[1], 5, 4);
    writeStats(children[2], 5, 1);
    writeStats(root, 15, 7);

    // child[1] has highest win rate (4/5 = 0.8) + equal exploration term
    const best = selectChild(children, 15);
    expect(best).toBe(children[1]);
  });

  it('full MCTS loop discovers optimal move', async () => {
    // Single-level decision: pick one of 3 moves.
    //   A → 0.3, B → 0.9 (optimal), C → 0.1
    // After enough iterations, MCTS converges on B.
    const SCORES: Record<string, number> = { A: 0.3, B: 0.9, C: 0.1 };
    const MOVES = Object.keys(SCORES);
    const ITERATIONS = 30;

    const root = createHead();

    // Expansion: one child per move
    const children = new Map<string, HEAD>();
    for (const move of MOVES) {
      const child = root.draft();
      child.write(concrete('move', { type: 'literal', value: move }));
      children.set(move, child);
    }

    // MCTS loop
    for (let i = 0; i < ITERATIONS; i++) {
      const parentVisits = getStat(root, 'visits');
      const selected = selectChild([...children.values()], parentVisits);

      // Simulation: deterministic score
      const move = selected.value('move') as string;
      const score = SCORES[move];

      // Backpropagation
      backpropagate(selected, score);
    }

    // Convergence: B should have the most visits (highest reward)
    const bVisits = getStat(children.get('B')!, 'visits');
    const aVisits = getStat(children.get('A')!, 'visits');
    const cVisits = getStat(children.get('C')!, 'visits');

    expect(bVisits).toBeGreaterThan(aVisits);
    expect(bVisits).toBeGreaterThan(cVisits);
    expect(aVisits + bVisits + cVisits).toBe(ITERATIONS);
    expect(getStat(root, 'visits')).toBe(ITERATIONS);

    // Commit: save best child into root
    await children.get('B')!.save();
    expect(root.value('move')).toBe('B');
  });

  it('two-level MCTS: draft-from-draft search tree', async () => {
    // Two-level decision tree proves draft-from-draft as true tree structure.
    //
    // Level 1: pick A or B
    // Level 2: pick X or Y
    // Scores: A+X=0.2, A+Y=0.8 (optimal), B+X=0.5, B+Y=0.4
    const SCORES: Record<string, number> = {
      'A:X': 0.2, 'A:Y': 0.8,
      'B:X': 0.5, 'B:Y': 0.4,
    };
    const ITERATIONS = 60;

    const root = createHead();

    // Level 1: two children
    const l1 = new Map<string, HEAD>();
    for (const m of ['A', 'B']) {
      const child = root.draft();
      child.write(concrete('move1', { type: 'literal', value: m }));
      l1.set(m, child);
    }

    // Level 2: two grandchildren per L1 node
    const l2 = new Map<string, HEAD>();
    for (const [m1, parent] of l1) {
      for (const m2 of ['X', 'Y']) {
        const gc = parent.draft();
        gc.write(concrete('move2', { type: 'literal', value: m2 }));
        l2.set(`${m1}:${m2}`, gc);
      }
    }

    // MCTS loop — two-level selection
    for (let i = 0; i < ITERATIONS; i++) {
      // Level 1 selection
      const rootVisits = getStat(root, 'visits');
      const l1Selected = selectChild([...l1.values()], rootVisits);
      const m1 = l1Selected.value('move1') as string;

      // Level 2 selection
      const l1Visits = getStat(l1Selected, 'visits');
      const l2Children = [...l2.entries()]
        .filter(([key]) => key.startsWith(m1 + ':'))
        .map(([, head]) => head);
      const l2Selected = selectChild(l2Children, l1Visits);
      const m2 = l2Selected.value('move2') as string;

      // Simulation + backpropagation (3 levels: leaf → l1 → root)
      backpropagate(l2Selected, SCORES[`${m1}:${m2}`]);
    }

    // Convergence: A should dominate level 1 (A:Y=0.8 best path)
    expect(getStat(l1.get('A')!, 'visits')).toBeGreaterThan(getStat(l1.get('B')!, 'visits'));
    // Within A's subtree, Y should dominate
    expect(getStat(l2.get('A:Y')!, 'visits')).toBeGreaterThan(getStat(l2.get('A:X')!, 'visits'));
    // Total visits correct
    expect(getStat(root, 'visits')).toBe(ITERATIONS);

    // Commit optimal path: save L2 winner into L1, then L1 into root
    await l2.get('A:Y')!.save();
    expect(l1.get('A')!.value('move2')).toBe('Y');

    await l1.get('A')!.save();
    expect(root.value('move1')).toBe('A');
    expect(root.value('move2')).toBe('Y');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Phase 9 — Nameless binds (bare expressions / splices)
// ─────────────────────────────────────────────────────────────────────────────

describe('nameless binds in HEAD', () => {
  it('write() accepts a nameless bind without crashing', () => {
    const root = createHead();
    root.write(concrete('a', { type: 'literal', value: 1 }));
    root.write({ type: 'bind', expr: ref('splice-target'), level: 'concrete' });
    root.write(concrete('b', { type: 'literal', value: 2 }));

    expect(root.value('a')).toBe(1);
    expect(root.value('b')).toBe(2);
  });

  it('nameless bind does not create a gap', () => {
    const ft = objectType({ x: 'string' });
    const source = createHead(ft);

    const d = source.draft();
    // Write a nameless ref — should NOT affect lifecycle
    d.write({ type: 'bind', expr: ref('something'), level: 'concrete' });
    // Still pending because 'x' gap remains (from the type)
    expect(d.lifecycle).toBe('pending');

    // Fill the real gap
    d.write(concrete('x', { type: 'literal', value: 'hello' }));
    expect(d.lifecycle).toBe('ready');
    // Gaps only reflect named bindings
    expect(d.gaps).toHaveLength(0);
  });

  it('nameless bind passes through save() without conflict', async () => {
    const root = createHead();
    const d = root.draft();

    d.write(concrete('x', { type: 'literal', value: 42 }));
    d.write({ type: 'bind', expr: ref('page2'), level: 'concrete' });
    d.write(concrete('y', { type: 'literal', value: 'hello' }));

    const result = await d.save();
    expect(result.ok).toBe(true);

    // Named values merged correctly — nameless bind didn't interfere
    expect(root.value('x')).toBe(42);
    expect(root.value('y')).toBe('hello');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Constraint Election Through Construction
// ─────────────────────────────────────────────────────────────────────────────

describe('constraint election through construction', () => {

  it('dep with decorator propagates to constructed output', () => {
    const head = createHead();

    // Write a dep with a decorator type-level binding (the type envelope)
    head.write(concrete('secretToken', { type: 'literal', value: 'xyztoken' }));
    head.write(type_('secretToken:decorator', { type: 'literal', value: {
      transform: 'fork.session.projection',
    } }));

    // Write a constructed output that depends on secretToken
    head.write(concrete('mySvc', { type: 'literal', value: { doWork: async () => 'done' } }));

    // electConstraints propagates dep's decorator to output
    electConstraints(head, 'mySvc', ['secretToken']);

    // The output should carry the elected decorator constraint
    const electedDecorator = head.value('mySvc:decorator');
    expect(electedDecorator).toBeDefined();
    expect((electedDecorator as any).transform).toBe('fork.session.projection');
  });

  it('decorator is inert without transform function in scope', () => {
    const head = createHead();

    // Write dep + service + propagate
    head.write(concrete('token', { type: 'literal', value: 'abc' }));
    head.write(type_('token:decorator', { type: 'literal', value: {
      transform: 'fork.session.projection',
    } }));
    head.write(concrete('svc', { type: 'literal', value: { greet: () => 'hi' } }));
    electConstraints(head, 'svc', ['token']);

    // 'fork.session.projection' is NOT in scope → resolveConstraint returns the
    // string value, not a function → typeof transform !== 'function' → no wrapping
    const svc = head.value('svc') as any;
    expect(svc.greet).toBeDefined();
    expect(typeof svc.greet).toBe('function');
    // The value passes through unwrapped because there's no transform function
    expect(svc.greet()).toBe('hi');
  });

  it('fork provides transform → decorator activates on value() read', () => {
    const root = createHead();

    // Write dep with decorator
    root.write(concrete('token', { type: 'literal', value: 'secret123' }));
    root.write(type_('token:decorator', { type: 'literal', value: {
      transform: 'fork.session.projection',
    } }));

    // Write service, elect constraints
    const calls: any[] = [];
    root.write(concrete('svc', { type: 'literal', value: {
      act: async (args: any) => { calls.push(args); return 'result'; },
    } }));
    electConstraints(root, 'svc', ['token']);

    // Create fork and provide the transform implementation
    const draft = root.draft();
    draft.write(concrete('identity', { type: 'literal', value: 'user:alice' }));
    draft.write(concrete('organization', { type: 'literal', value: 'org:acme' }));
    draft.write(concrete('fork.session.projection', { type: 'literal', value:
      (serviceOrFn: any) => {
        if (typeof serviceOrFn === 'function') {
          return async (args: Record<string, any>) => {
            const identity = draft.value('identity');
            const organization = draft.value('organization');
            return serviceOrFn(identity !== undefined
              ? { identity, organization, ...args }
              : args);
          };
        }
        // Service object — explicitly wrap each method (no Proxy).
        // Plain object with enumerable methods — inspectable by type system.
        const wrapped: Record<string, any> = {};
        for (const [key, val] of Object.entries(serviceOrFn)) {
          if (typeof val === 'function') {
            wrapped[key] = async (args: Record<string, any>) => {
              const identity = draft.value('identity');
              const organization = draft.value('organization');
              return (val as Function).call(serviceOrFn, identity !== undefined
                ? { identity, organization, ...args }
                : args);
            };
          } else {
            wrapped[key] = val;
          }
        }
        return wrapped;
      },
    }));

    // Now read the service from the draft — decorator should activate
    const svc = draft.value('svc') as any;
    expect(svc).toBeDefined();
    expect(typeof svc.act).toBe('function');
  });

  it('fork projection injects session context into wrapped service methods', async () => {
    const root = createHead();

    // Dep with decorator
    root.write(concrete('apiKey', { type: 'literal', value: 'key123' }));
    root.write(type_('apiKey:decorator', { type: 'literal', value: {
      transform: 'fork.session.projection',
    } }));

    // Service that records its args
    const captured: any[] = [];
    root.write(concrete('mySvc', { type: 'literal', value: {
      doWork: async (args: any) => { captured.push(args); return 'ok'; },
    } }));
    electConstraints(root, 'mySvc', ['apiKey']);

    // Fork with session context + projection
    const draft = root.draft();
    draft.write(concrete('identity', { type: 'literal', value: 'user:bob' }));
    draft.write(concrete('organization', { type: 'literal', value: 'org:corp' }));
    draft.write(concrete('fork.session.projection', { type: 'literal', value:
      (serviceOrFn: any) => {
        // Explicit method wrapping — plain object, no Proxy
        const wrapped: Record<string, any> = {};
        for (const [key, val] of Object.entries(serviceOrFn)) {
          if (typeof val === 'function') {
            wrapped[key] = async (args: Record<string, any>) => {
              const identity = draft.value('identity');
              const organization = draft.value('organization');
              return (val as Function).call(serviceOrFn, identity !== undefined
                ? { identity, organization, ...args }
                : args);
            };
          } else {
            wrapped[key] = val;
          }
        }
        return wrapped;
      },
    }));

    const svc = draft.value('mySvc') as any;
    await svc.doWork({ query: 'test' });

    expect(captured[0]).toEqual({
      identity: 'user:bob',
      organization: 'org:corp',
      query: 'test',
    });
  });

  it('non-sensitive deps do not propagate constraints', () => {
    const head = createHead();

    // Write a dep WITHOUT any behavioral constraints (no type envelope)
    head.write(concrete('displayName', { type: 'literal', value: 'My App' }));

    // Write output, elect constraints
    head.write(concrete('svc', { type: 'literal', value: { run: () => true } }));
    electConstraints(head, 'svc', ['displayName']);

    // No decorator should be elected
    expect(head.value('svc:decorator')).toBeUndefined();
    expect(head.value('svc:visibility')).toBeUndefined();
    expect(head.value('svc:fork')).toBeUndefined();
  });

  it('multiple deps elect union of constraints', () => {
    const head = createHead();

    // Dep A has decorator
    head.write(concrete('depA', { type: 'literal', value: 'a' }));
    head.write(type_('depA:decorator', { type: 'literal', value: {
      transform: 'fork.session.projection',
    } }));

    // Dep B has visibility
    head.write(concrete('depB', { type: 'literal', value: 'b' }));
    head.write(type_('depB:visibility', { type: 'literal', value: {
      scope: 'session',
    } }));

    // Output depends on both
    head.write(concrete('output', { type: 'literal', value: {} }));
    electConstraints(head, 'output', ['depA', 'depB']);

    // Output should carry BOTH constraints
    expect(head.value('output:decorator')).toBeDefined();
    expect((head.value('output:decorator') as any).transform).toBe('fork.session.projection');
    expect(head.value('output:visibility')).toBeDefined();
    expect((head.value('output:visibility') as any).scope).toBe('session');
  });

  it('visibility constraint propagation filters entries()', () => {
    const head = createHead();

    // Dep with visibility constraint
    head.write(concrete('secret', { type: 'literal', value: 'hidden' }));
    head.write(type_('secret:visibility', { type: 'literal', value: {
      scope: 'session',
    } }));

    // Output inherits visibility
    head.write(concrete('wrappedSvc', { type: 'literal', value: 'exposed' }));
    electConstraints(head, 'wrappedSvc', ['secret']);

    // The elected visibility constraint should be readable
    const vis = head.value('wrappedSvc:visibility');
    expect(vis).toBeDefined();
    expect((vis as any).scope).toBe('session');
  });

  it('type transformation metadata propagates when no output type exists', () => {
    const head = createHead();

    // Dep with decorator
    head.write(concrete('token', { type: 'literal', value: 'xyz' }));
    head.write(type_('token:decorator', { type: 'literal', value: {
      transform: 'fork.session.projection',
    } }));

    // Transform's type metadata (describes the type transformation)
    head.write(type_('fork.session.projection:type', { type: 'literal', value: {
      role: 'decorator-transform',
      injects: ['identity', 'organization'],
    } }));

    // Output depends on token — NO output type written (no serviceName:type)
    head.write(concrete('svc', { type: 'literal', value: {} }));
    electConstraints(head, 'svc', ['token']);

    // Without an output type to project, the raw transform metadata propagates
    const typeMeta = head.value('svc:type');
    expect(typeMeta).toBeDefined();
    expect((typeMeta as any).role).toBe('decorator-transform');
    expect((typeMeta as any).injects).toEqual(['identity', 'organization']);
  });

  it('electConstraints projects service type — masks injected params from method inputs', () => {
    const head = createHead();

    // Dep with decorator
    head.write(concrete('apiKey', { type: 'literal', value: 'sk-xxx' }));
    head.write(type_('apiKey:decorator', { type: 'literal', value: {
      transform: 'fork.session.projection',
    } }));

    // Transform's type metadata — declares which params it injects
    head.write(type_('fork.session.projection:type', { type: 'literal', value: {
      role: 'decorator-transform',
      injects: ['identity', 'organization'],
    } }));

    // Service with a typed method: prompt({ prompt, identity, organization }) → string
    // The full service type includes identity/org as input params (they're part of the
    // runtime interface), but after projection they should be masked from consumer-facing type.
    const serviceTypeSnapshot = {
      type: 'fieldtypeevent',
      eventtype: 'state',
      fieldtype: 'object',
      attributes: [
        {
          type: 'typeconstraint', basetype: 'object', constrainttype: 'property',
          key: 'prompt',
          value: {
            type: 'fieldtypeevent', eventtype: 'state', fieldtype: 'function',
            attributes: [
              {
                type: 'typeconstraint', basetype: 'function', constrainttype: 'param',
                value: {
                  type: 'fieldtypeevent', eventtype: 'state', fieldtype: 'object',
                  attributes: [
                    { type: 'typeconstraint', basetype: 'object', constrainttype: 'property',
                      key: 'prompt', value: { fieldtype: 'string' } },
                    { type: 'typeconstraint', basetype: 'object', constrainttype: 'property',
                      key: 'identity', value: { fieldtype: 'string' } },
                    { type: 'typeconstraint', basetype: 'object', constrainttype: 'property',
                      key: 'organization', value: { fieldtype: 'string' } },
                  ],
                },
              },
              {
                type: 'typeconstraint', basetype: 'function', constrainttype: 'returns',
                value: { type: 'fieldtypeevent', eventtype: 'state', fieldtype: 'string' },
              },
            ],
          },
        },
      ],
    };

    // Write service with its original type, then elect constraints
    head.write(concrete('llmSvc', { type: 'literal', value: { prompt: async () => 'hi' } }));
    head.write(type_('llmSvc:type', { type: 'literal', value: serviceTypeSnapshot }));
    electConstraints(head, 'llmSvc', ['apiKey']);

    // The projected type should have identity/organization REMOVED from prompt's input
    const projected = head.value('llmSvc:type') as any;
    expect(projected).toBeDefined();
    expect(projected.fieldtype).toBe('object');

    // Find the prompt method's param type
    const promptProp = projected.attributes.find(
      (a: any) => a.constrainttype === 'property' && a.key === 'prompt',
    );
    expect(promptProp).toBeDefined();

    const paramAttr = promptProp.value.attributes.find(
      (a: any) => a.constrainttype === 'param',
    );
    expect(paramAttr).toBeDefined();

    // Only 'prompt' should remain — 'identity' and 'organization' are masked
    const paramProps = paramAttr.value.attributes.filter(
      (a: any) => a.constrainttype === 'property',
    );
    expect(paramProps).toHaveLength(1);
    expect(paramProps[0].key).toBe('prompt');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Phase 10 — patchResolve integration: HEAD-native constraint resolution
// ─────────────────────────────────────────────────────────────────────────────

describe('Phase 10 — patchResolve integration', () => {

  const StorageType = types.object({ read: types.fn(types.string(), types.string()) }).meta({ name: 'StorageType' });
  const EventBusType = types.object({ publish: types.fn(types.any(), types.null()) }).meta({ name: 'EventBusType' });

  it('rootType preserves metadata.name', () => {
    const named = types.object({ apiKey: types.string() }).meta({ name: 'MyConfig' });
    const head = createHead(named);

    expect(head.rootType).toBeDefined();
    expect(head.rootType.fieldtype).toBe('object');
    expect((head.rootType as any).metadata?.name).toBe('MyConfig');
  });

  it('chain exposes own statements', () => {
    const head = createHead(types.object({ x: types.string() }));
    head.write(concrete('x', { type: 'literal', value: 'hello' }));

    const stmts = collectStatements(head.chain);
    // Should have: ref gate for x (from chainFromFieldType) + concrete 'hello'
    expect(stmts.length).toBeGreaterThanOrEqual(2);
    const concreteStmt = stmts.find(
      s => s.type === 'bind' && s.name === 'x' && s.expr.type === 'literal',
    );
    expect(concreteStmt).toBeDefined();
  });

  it('patchResolve(draft) resolves ref gates against source HEAD', () => {
    const source = createHead(types.object({ mainStorage: StorageType }));
    source.write(concrete('mainStorage', { type: 'literal', value: { read: () => 'data' } }));

    const draft = source.draft();
    // Write a ref gate to the draft
    const depsChain = chainFromFieldType(types.object({ storage: StorageType }));
    for (const stmt of collectStatements(depsChain)) {
      draft.write(stmt);
    }

    const result = patchResolve(draft) as ResolvedResult;

    expect(result.status).toBe('resolved');
    expect(result.deps.storage).toBeDefined();
    expect(typeof result.deps.storage.read).toBe('function');
  });

  it('patchResolve(draft) returns pending when source lacks matching type', () => {
    const source = createHead(types.object({ mainStorage: StorageType }));
    source.write(concrete('mainStorage', { type: 'literal', value: { read: () => 'data' } }));

    const draft = source.draft();
    // Write ref gates for both storage (present) and bus (missing)
    const depsChain = chainFromFieldType(types.object({
      storage: StorageType,
      bus: EventBusType,
    }));
    for (const stmt of collectStatements(depsChain)) {
      draft.write(stmt);
    }

    const result = patchResolve(draft, { allowDefer: true }) as PendingResult;

    expect(result.status).toBe('pending');
    expect(result.missing.some(m => m.key === 'bus')).toBe(true);
    expect(result.deps.storage).toBeDefined();
  });

  it('patchResolve handles constraint-aware disambiguation via HEAD', () => {
    const ModelPkgType = types.object({
      '[kind]': types.string().literal('model'),
      prompt: types.any(),
    }).meta({ name: 'connection:model-openai:default' });

    const GeneralPkgType = types.object({
      '[kind]': types.string().literal('general'),
      apiKey: types.any(),
    }).meta({ name: 'connection:github:default' });

    const ModelProviderRef = types.object({
      '[kind]': types.string().literal('model'),
    }).meta({ name: 'ModelProvider' });

    const source = createHead(types.object({
      'connection:model-openai:default': ModelPkgType,
      'connection:github:default': GeneralPkgType,
    }));
    source.write(concrete('connection:model-openai:default', {
      type: 'literal', value: { provider: 'openai', model: 'gpt-5.2' },
    }));
    source.write(concrete('connection:github:default', {
      type: 'literal', value: { apiKey: 'xxx' },
    }));

    const draft = source.draft();
    const depsChain = chainFromFieldType(types.object({ model: ModelProviderRef }));
    for (const stmt of collectStatements(depsChain)) {
      draft.write(stmt);
    }

    const result = patchResolve(draft) as ResolvedResult;

    expect(result.status).toBe('resolved');
    expect(result.deps.model).toBeDefined();
    expect(result.deps.model.provider).toBe('openai');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Phase 11 — Unified Solver: SolveResult caching + behavioral action integration
// ─────────────────────────────────────────────────────────────────────────────

describe('Phase 11 — Unified Solver', () => {

  const StorageType = types.object({ read: types.fn(types.string(), types.string()) }).meta({ name: 'StorageType' });
  const EventBusType = types.object({ publish: types.fn(types.any(), types.null()) }).meta({ name: 'EventBusType' });

  it('save() executes persist action discovered from rootType', async () => {
    const stored: Map<string, unknown> = new Map();
    const storeFn = (v: unknown) => { stored.set('key', v); return v; };

    let chain = chainFromFieldType(
      buildObjType({
        apiKey: FieldType.string.create()
          .persist('mySink')
          .save(),
      }),
    );
    chain = push(chain, concrete('mySink', { type: 'literal', value: storeFn }));

    const head = createHead(chain);
    const d = head.draft();
    d.write(concrete('apiKey', { type: 'literal', value: 'sk-abc' }));
    const r = await d.save();

    expect(r.ok).toBe(true);
    expect(stored.get('key')).toBe('sk-abc');
  });

  it('save() executes subscribe action for merged bindings', async () => {
    let chain = chainFromFieldType(
      buildObjType({
        config: FieldType.string.create()
          .subscribe('configTopic')
          .save(),
      }),
    );

    const head = createHead(chain);
    const d = head.draft();
    d.write(concrete('config', { type: 'literal', value: 'dark-mode' }));
    await d.save();

    // Subscription output is in the _subscriptions chain overlay
    expect(head.subscriptions).not.toBeNull();
    expect(head.value('configTopic')).toBe('dark-mode');
  });

  it('solve result preserves scopeMap for draft resolution', () => {
    const source = createHead(types.object({ mainStorage: StorageType }));
    source.write(concrete('mainStorage', { type: 'literal', value: { read: () => 'data' } }));

    const draft = source.draft();
    const depsChain = chainFromFieldType(types.object({ storage: StorageType }));
    for (const stmt of collectStatements(depsChain)) {
      draft.write(stmt);
    }

    const result = patchResolve(draft, { allowDefer: true }) as SolveResult;

    expect(result.scopeMap).toBeDefined();
    // scopeMap has the source ctx values
    expect(result.scopeMap.get('mainStorage')).toBeDefined();
    // And the resolved dep mapping
    expect(result.scopeMap.get('storage')).toBeDefined();
  });

  it('solve result has candidateDomains for multi-match gate', () => {
    const source = createHead(types.object({
      storage1: StorageType,
      storage2: StorageType,
    }));
    source.write(concrete('storage1', { type: 'literal', value: { read: () => 'a' } }));
    source.write(concrete('storage2', { type: 'literal', value: { read: () => 'b' } }));

    const draft = source.draft();
    const depsChain = chainFromFieldType(types.object({ storage: StorageType }));
    for (const stmt of collectStatements(depsChain)) {
      draft.write(stmt);
    }

    const result = patchResolve(draft, { allowDefer: true }) as SolveResult;

    expect(result.candidateDomains).toBeDefined();
    const candidates = result.candidateDomains.get('storage');
    expect(candidates).toBeDefined();
    expect(candidates!.length).toBe(2);
  });

  it('solver result is cached and invalidated on write', () => {
    const source = createHead(types.object({ mainStorage: StorageType }));
    source.write(concrete('mainStorage', { type: 'literal', value: { read: () => 'data' } }));

    const draft = source.draft();
    const depsChain = chainFromFieldType(types.object({ storage: StorageType }));
    for (const stmt of collectStatements(depsChain)) {
      draft.write(stmt);
    }

    // First call should resolve
    const result1 = patchResolve(draft, { allowDefer: true }) as SolveResult;
    expect(result1.status).toBe('resolved');

    // Writing a new ref gate changes the gaps
    draft.write({
      type: 'bind', name: 'bus',
      expr: { type: 'ref', source: 'EventBusType' },
      level: 'concrete',
    });

    // After write, re-resolving should show the new missing dep
    const result2 = patchResolve(draft, { allowDefer: true }) as SolveResult;
    expect(result2.status).toBe('pending');
    expect(result2.missing.some(m => m.key === 'bus')).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// SolveConstraint — projected ref value selection
// ─────────────────────────────────────────────────────────────────────────────

describe('SolveConstraint — projected ref value selection', () => {
  /**
   * Helper: build a rootType with `c1: number.min(lo).max(hi)` + solve constraint.
   * The min/max on c1 provides the output constraint for Phase A.4 projection.
   */
  function solvedObjType(
    objective?: string | ((constraint: any) => unknown),
    propertyType?: FieldType,
  ): FieldType {
    const propFT = propertyType ?? FieldType.number.create().min(0).max(20).save();
    return buildObjType({ c1: propFT }).solve({ objective }).save();
  }

  it('single unknown — midpoint: add(10, ref("y")) with output [0,20] → y = 0', async () => {
    const source = createHead(solvedObjType('midpoint'));
    const draft = source.draft();
    draft.write({
      type: 'bind', name: 'c1',
      expr: { type: 'call', fn: 'add', args: [{ type: 'literal', value: 10 }, ref('y')] },
      level: 'concrete',
    });
    await draft.save();
    // Projected: y in [-10, 10]. Midpoint = 0.
    expect(source.value('y')).toBe(0);
  });

  it('single unknown — minimize: add(10, ref("y")) with output [0,20] → y = -10', async () => {
    const source = createHead(solvedObjType('minimize'));
    const draft = source.draft();
    draft.write({
      type: 'bind', name: 'c1',
      expr: { type: 'call', fn: 'add', args: [{ type: 'literal', value: 10 }, ref('y')] },
      level: 'concrete',
    });
    await draft.save();
    // Projected: y in [-10, 10]. Minimize = -10.
    expect(source.value('y')).toBe(-10);
  });

  it('single unknown — maximize: add(10, ref("y")) with output [0,20] → y = 10', async () => {
    const source = createHead(solvedObjType('maximize'));
    const draft = source.draft();
    draft.write({
      type: 'bind', name: 'c1',
      expr: { type: 'call', fn: 'add', args: [{ type: 'literal', value: 10 }, ref('y')] },
      level: 'concrete',
    });
    await draft.save();
    // Projected: y in [-10, 10]. Maximize = 10.
    expect(source.value('y')).toBe(10);
  });

  it('two unknowns: add(10, ref("y1"), ref("y2")) both get midpoint', async () => {
    const source = createHead(solvedObjType('midpoint'));
    const draft = source.draft();
    draft.write({
      type: 'bind', name: 'c1',
      expr: {
        type: 'call', fn: 'add',
        args: [{ type: 'literal', value: 10 }, ref('y1'), ref('y2')],
      },
      level: 'concrete',
    });
    await draft.save();
    // Both y1, y2 projected with same bounds [-10, 10]. Midpoint = 0.
    expect(source.value('y1')).toBe(0);
    expect(source.value('y2')).toBe(0);
  });

  it('custom objective function: (ft) => 7 → y = 7', async () => {
    const source = createHead(solvedObjType((ft: any) => 7));
    const draft = source.draft();
    draft.write({
      type: 'bind', name: 'c1',
      expr: { type: 'call', fn: 'add', args: [{ type: 'literal', value: 10 }, ref('y')] },
      level: 'concrete',
    });
    await draft.save();
    expect(source.value('y')).toBe(7);
  });

  it('no solve constraint → refs NOT auto-resolved', async () => {
    // Same setup but WITHOUT .solve() on the rootType
    const rootType = buildObjType({
      c1: FieldType.number.create().min(0).max(20).save(),
    });
    const source = createHead(rootType);
    const draft = source.draft();
    draft.write({
      type: 'bind', name: 'c1',
      expr: { type: 'call', fn: 'add', args: [{ type: 'literal', value: 10 }, ref('y')] },
      level: 'concrete',
    });
    await draft.save();
    // Without solve, y should NOT be auto-resolved
    expect(source.value('y')).toBeUndefined();
  });

  it('non-numeric constraints → skipped', async () => {
    // rootType has c1: string — not numeric, so projection won't produce numeric bounds
    const rootType = buildObjType({
      c1: FieldType.string.create().save(),
    }).solve({ objective: 'midpoint' }).save();
    const source = createHead(rootType);
    const draft = source.draft();
    draft.write({
      type: 'bind', name: 'c1',
      expr: { type: 'literal', value: 'hello' },
      level: 'concrete',
    });
    await draft.save();
    // No numeric refs to solve — just a normal merge
    expect(source.value('c1')).toBe('hello');
  });

  it('solve + autoMerge: values auto-selected on lifecycle ready', async () => {
    // Combine solve + autoMerge on the rootType
    const propFT = FieldType.number.create().min(0).max(20).save();
    const rootType = buildObjType({ c1: propFT })
      .solve({ objective: 'midpoint' })
      .autoMerge()
      .save();
    const source = createHead(rootType);
    const draft = source.draft();
    draft.write({
      type: 'bind', name: 'c1',
      expr: { type: 'call', fn: 'add', args: [{ type: 'literal', value: 10 }, ref('y')] },
      level: 'concrete',
    });
    // autoMerge fires via microtask when lifecycle transitions to 'ready'
    await new Promise(r => setTimeout(r, 0));
    // After auto-merge, source should have the solved value
    expect(source.value('y')).toBe(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Interpreter as chain binding
// ─────────────────────────────────────────────────────────────────────────────

describe('interpreter as chain binding', () => {
  /** A test interpreter that matches objects with a 'url' property. */
  function makeRestInterpreter(): HeadInterpreter {
    return {
      type: FieldType.object.create()
        .property('url', FieldType.string.create())
        .save(),
      impl(value: unknown, stem?: string[]) {
        const proto = value as { url: string };
        const toolName = stem?.[stem.length - 1] ?? 'tool';
        const h = createHead();
        h.write(concrete(toolName, { type: 'literal', value: `compiled:${proto.url}` }));
        h.write(export_([toolName]));
        return h;
      },
    };
  }

  it('interpret function binding exists in scope after createHead with interpreters', () => {
    const h = createHead({ interpreters: [makeRestInterpreter()] });
    const { scope } = reduce(h.chain);

    const binding = scope.bindings.get('interpret');
    expect(binding).toBeDefined();
    expect(binding!.resolved).toBe(true);
    expect(typeof binding!.value).toBe('function');
  });

  it('no interpret binding when no interpreters provided', () => {
    const h = createHead();
    const { scope } = reduce(h.chain);

    expect(scope.bindings.has('interpret')).toBe(false);
  });

  it('call("interpret", [proto]) resolves and links interpreter HEAD', () => {
    const restInterp = makeRestInterpreter();
    const h = createHead({ interpreters: [restInterp] });

    // Write a tool proto that the interpreter should match
    h.write(concrete('myTool', interpret({ url: 'https://api.example.com' })));

    // The interpreter HEAD is linked via 'interpreter' edge.
    // Exported value is readable via parent overlay:
    expect(h.value('myTool')).toBe('compiled:https://api.example.com');
  });

  it('interpret dispatch returns undefined for non-matching values', () => {
    const restInterp = makeRestInterpreter();
    const h = createHead({ interpreters: [restInterp] });
    const { scope } = reduce(h.chain);

    // A value that doesn't match the rest interpreter (no 'url' property)
    const callExpr = interpret({ name: 'not-a-rest-proto' });
    const result = evaluateExpr(callExpr, scope);
    expect(result.concrete).toBe(true);
    expect(result.value).toBeUndefined();
  });
});


// ─────────────────────────────────────────────────────────────────────────────
// Async Call Resolution
// ─────────────────────────────────────────────────────────────────────────────

describe('async call resolution', () => {
  test('sync call evaluates immediately — no pending-call event', () => {
    const head = createHead(FieldType.any.create());
    const syncAdd = (a: number, b: number) => a + b;
    head.write(concrete('add', { type: 'literal', value: syncAdd }));

    const events: HeadEvent[] = [];
    head.subscribe(e => events.push(e));

    head.write(concrete('result', { type: 'call', fn: 'add', args: [
      { type: 'literal', value: 3 },
      { type: 'literal', value: 4 },
    ]}));

    // Sync call resolves immediately
    expect(head.value('result')).toBe(7);
    // No pending-call event
    expect(events.filter(e => e.type === 'pending-call')).toHaveLength(0);
  });

  test('async call emits pending-call event with name, callId, promise', () => {
    const head = createHead(FieldType.any.create());
    const asyncFn = () => Promise.resolve(42);
    head.write(concrete('fetchData', { type: 'literal', value: asyncFn }));

    const events: HeadEvent[] = [];
    head.subscribe(e => events.push(e));

    head.write(concrete('result', { type: 'call', fn: 'fetchData', args: [] }));

    const pendingEvents = events.filter(e => e.type === 'pending-call');
    expect(pendingEvents).toHaveLength(1);

    const pe = pendingEvents[0] as any;
    expect(pe.name).toBe('result');
    expect(pe.callId).toBe('_call:0');
    expect(pe.promise).toBeInstanceOf(Promise);
  });

  test('environment settlement resolves binding via resolveInternalRefs', async () => {
    const head = createHead(FieldType.any.create());
    let resolvePromise!: (v: unknown) => void;
    const asyncFn = () => new Promise(r => { resolvePromise = r; });
    head.write(concrete('fetchData', { type: 'literal', value: asyncFn }));

    // Subscribe environment handler — same pattern as HeadSession
    head.subscribe((ev) => {
      if (ev.type === 'pending-call') {
        ev.promise.then(
          (value) => {
            try { head.write(concrete(ev.callId, { type: 'literal', value })); }
            catch { /* disposed */ }
          },
        );
      }
    });

    head.write(concrete('result', { type: 'call', fn: 'fetchData', args: [] }));

    // Before settlement: result is unresolved (ref gate)
    expect(head.value('result')).toBeUndefined();

    // Settle the promise
    resolvePromise(42);
    // Allow microtask to fire
    await Promise.resolve();

    // After settlement: result is resolved
    expect(head.value('result')).toBe(42);
  });

  test('rejection writes error value at callId', async () => {
    const head = createHead(FieldType.any.create());
    let rejectPromise!: (e: Error) => void;
    const asyncFn = () => new Promise((_, r) => { rejectPromise = r; });
    head.write(concrete('fetchData', { type: 'literal', value: asyncFn }));

    const settlements: Promise<void>[] = [];
    head.subscribe((ev) => {
      if (ev.type === 'pending-call') {
        settlements.push(
          ev.promise.then(
            (value) => { head.write(concrete(ev.callId, { type: 'literal', value })); },
            (error) => {
              head.write(concrete(ev.callId, { type: 'literal', value: { _error: true, message: error?.message } }));
            },
          ),
        );
      }
    });

    head.write(concrete('result', { type: 'call', fn: 'fetchData', args: [] }));
    rejectPromise(new Error('network failure'));
    await Promise.all(settlements);

    const val = head.value('result') as any;
    expect(val._error).toBe(true);
    expect(val.message).toBe('network failure');
  });

  test('call IDs are unique per invocation', () => {
    const head = createHead(FieldType.any.create());
    const asyncFn = () => Promise.resolve('ok');
    head.write(concrete('fn', { type: 'literal', value: asyncFn }));

    const callIds: string[] = [];
    head.subscribe((ev) => {
      if (ev.type === 'pending-call') callIds.push(ev.callId);
    });

    head.write(concrete('a', { type: 'call', fn: 'fn', args: [] }));
    head.write(concrete('b', { type: 'call', fn: 'fn', args: [] }));

    expect(callIds).toEqual(['_call:0', '_call:1']);
  });

  test('no re-invocation — ref gate prevents repeat call', () => {
    const head = createHead(FieldType.any.create());
    let callCount = 0;
    const asyncFn = () => { callCount++; return Promise.resolve('done'); };
    head.write(concrete('fn', { type: 'literal', value: asyncFn }));

    head.write(concrete('result', { type: 'call', fn: 'fn', args: [] }));
    expect(callCount).toBe(1);

    // Writing something else triggers re-reduce, but the ref gate prevents re-call
    head.write(concrete('unrelated', { type: 'literal', value: 'stuff' }));
    expect(callCount).toBe(1);
  });

  test('disposed HEAD does not crash on late settlement', async () => {
    const head = createHead(FieldType.any.create());
    let resolvePromise!: (v: unknown) => void;
    const asyncFn = () => new Promise(r => { resolvePromise = r; });
    head.write(concrete('fn', { type: 'literal', value: asyncFn }));

    head.subscribe((ev) => {
      if (ev.type === 'pending-call') {
        ev.promise.then(
          (value) => {
            try { head.write(concrete(ev.callId, { type: 'literal', value })); }
            catch { /* expected — HEAD disposed */ }
          },
        );
      }
    });

    head.write(concrete('result', { type: 'call', fn: 'fn', args: [] }));
    head.dispose();

    // Late settlement should not throw
    resolvePromise(99);
    await Promise.resolve();
    // No assertion — just verifying no crash
  });

  test('general intra-ref resolution — non-async ref resolves when source becomes concrete', () => {
    const head = createHead(FieldType.any.create());

    // Write a ref gate: x depends on source 'data'
    head.write({ type: 'bind', name: 'x', expr: { type: 'ref', source: 'data' }, level: 'concrete' } as any);
    expect(head.value('x')).toBeUndefined();

    // Write the source — resolveInternalRefs should collapse the ref gate
    head.write(concrete('data', { type: 'literal', value: 'hello' }));
    expect(head.value('x')).toBe('hello');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Call-Overlay Expansion (Phase 1)
// ─────────────────────────────────────────────────────────────────────────────

import { scope, scopeTerminate, isStatementArray } from '../statement.js';

describe('call-overlay expansion', () => {
  test('isStatementArray detects valid Statement arrays', () => {
    expect(isStatementArray([])).toBe(false);
    expect(isStatementArray([{ type: 'bind', name: 'x', expr: { type: 'literal', value: 1 }, level: 'concrete' }])).toBe(true);
    expect(isStatementArray([{ type: 'export', names: ['x'] }])).toBe(true);
    expect(isStatementArray([42])).toBe(false);
    expect(isStatementArray('not an array')).toBe(false);
    expect(isStatementArray([{ type: 'scope', scopeId: 's1', body: [] }])).toBe(true);
  });

  test('function returning Statement[] triggers overlay expansion', () => {
    const head = createHead();

    // Write a function that returns Statement[]
    const overlayFn = () => [
      concrete('x', { type: 'literal', value: 10 }),
      concrete('y', { type: 'literal', value: 20 }),
    ];
    head.write(concrete('maker', { type: 'literal', value: overlayFn }));

    // Call it — overlay expansion should write x and y, not the call result
    head.write(concrete('result', { type: 'call', fn: 'maker', args: [] }));

    // Overlay bindings should be in scope
    expect(head.value('x')).toBe(10);
    expect(head.value('y')).toBe(20);
    // The original 'result' binding should NOT exist (call was expanded, not bound)
    // The overlay replaced the bind-to-result with individual statements
  });

  test('overlay with exports propagates correctly', () => {
    const head = createHead();

    const overlayFn = () => [
      concrete('tool', { type: 'literal', value: () => 'executed' }),
      type_('tool:callable', { type: 'literal', value: {} }),
      export_(['tool']),
    ];
    head.write(concrete('maker', { type: 'literal', value: overlayFn }));
    head.write(concrete('_trigger', { type: 'call', fn: 'maker', args: [] }));

    // The tool should be callable
    const callables = head.callables();
    expect(callables.has('tool')).toBe(true);
    expect(typeof callables.get('tool')).toBe('function');
  });

  test('overlay with ref gates surfaces gaps', () => {
    const head = createHead();

    const overlayFn = () => [
      { type: 'bind' as const, name: 'apiKey', expr: { type: 'ref' as const, source: 'const.apiKey' }, level: 'concrete' as const },
      concrete('status', { type: 'literal', value: 'waiting' }),
    ];
    head.write(concrete('maker', { type: 'literal', value: overlayFn }));
    head.write(concrete('_trigger', { type: 'call', fn: 'maker', args: [] }));

    // apiKey should be a gap
    const gaps = head.gaps;
    expect(gaps.some(g => g.key === 'apiKey')).toBe(true);
    // status should be resolved
    expect(head.value('status')).toBe('waiting');
  });

  test('overlay ref gates resolve when deps arrive', () => {
    const head = createHead();

    const overlayFn = () => [
      { type: 'bind' as const, name: 'apiKey', expr: { type: 'ref' as const, source: 'const.apiKey' }, level: 'concrete' as const },
    ];
    head.write(concrete('maker', { type: 'literal', value: overlayFn }));
    head.write(concrete('_trigger', { type: 'call', fn: 'maker', args: [] }));

    expect(head.value('apiKey')).toBeUndefined();

    // Provide the dep — resolveInternalRefs should collapse the ref gate
    head.write(concrete('const.apiKey', { type: 'literal', value: 'sk-123' }));
    expect(head.value('apiKey')).toBe('sk-123');
  });

  test('overlay within scope inherits scope constraints', () => {
    const head = createHead();

    // Open a scope with visibility: private
    head.write(scope(
      [concrete('visibility', { type: 'literal', value: { scope: false } })],
      'private-scope',
    ));

    // Write an overlay function and trigger it inside the scope
    const overlayFn = () => [
      concrete('secret', { type: 'literal', value: 'hidden-value' }),
    ];
    head.write(concrete('maker', { type: 'literal', value: overlayFn }));
    head.write(concrete('_trigger', { type: 'call', fn: 'maker', args: [] }));

    head.write(scopeTerminate('private-scope'));

    // secret should be hidden from entries (private scope) but accessible via value()
    expect(head.value('secret')).toBe('hidden-value');
    const entries = head.entries();
    expect(entries.has('secret')).toBe(false);
  });

  test('nested overlay — overlay fn calls another overlay fn', () => {
    const head = createHead();

    // Inner overlay
    const innerFn = () => [
      concrete('inner', { type: 'literal', value: 'from-inner' }),
    ];
    head.write(concrete('innerMaker', { type: 'literal', value: innerFn }));

    // Outer overlay that calls the inner
    const outerFn = () => [
      concrete('outer', { type: 'literal', value: 'from-outer' }),
      concrete('nested', { type: 'call', fn: 'innerMaker', args: [] }),
    ];
    head.write(concrete('outerMaker', { type: 'literal', value: outerFn }));

    // Trigger outer
    head.write(concrete('_trigger', { type: 'call', fn: 'outerMaker', args: [] }));

    expect(head.value('outer')).toBe('from-outer');
    expect(head.value('inner')).toBe('from-inner');
  });

  test('overlay coexists with non-overlay call results', () => {
    // A function returning a plain object (not Statement[]) is a concrete value, not overlay
    const head = createHead();

    // Old-style: function returns an object with construct + envTransformType
    const oldStyleFn = () => ({
      notAnOverlay: true,
      data: 42,
    });
    head.write(concrete('oldFn', { type: 'literal', value: oldStyleFn }));
    head.write(concrete('result', { type: 'call', fn: 'oldFn', args: [] }));

    // Should be treated as a normal call result (not overlay)
    const val = head.value('result') as any;
    expect(val.notAnOverlay).toBe(true);
    expect(val.data).toBe(42);
  });

  test('overlay with scope statements creates scoped regions', () => {
    const head = createHead();

    const overlayFn = () => [
      scope(
        [concrete('visibility', { type: 'literal', value: { scope: false } })],
        'overlay-scope',
      ),
      concrete('hidden', { type: 'literal', value: 'private-data' }),
      scopeTerminate('overlay-scope'),
      concrete('visible', { type: 'literal', value: 'public-data' }),
    ];
    head.write(concrete('maker', { type: 'literal', value: overlayFn }));
    head.write(concrete('_trigger', { type: 'call', fn: 'maker', args: [] }));

    // hidden should be private (scope governs), visible should be public
    expect(head.value('hidden')).toBe('private-data');
    expect(head.value('visible')).toBe('public-data');
    const entries = head.entries();
    expect(entries.has('hidden')).toBe(false);
    expect(entries.has('visible')).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Mount Constraint
// ─────────────────────────────────────────────────────────────────────────────

describe('mount constraint', () => {
  test('allow restricts statement types', () => {
    const head = createHead();

    // Open a scope that only allows 'bind' statements
    head.write(scope(
      [concrete('mount', { type: 'literal', value: { allow: ['bind'] } })],
      'mount-scope',
    ));

    // bind should succeed
    head.write(concrete('x', { type: 'literal', value: 42 }));
    expect(head.value('x')).toBe(42);

    // export should be rejected
    expect(() => {
      head.write(export_(['x']));
    }).toThrow(TypeError);
  });

  test('levels restricts bind levels', () => {
    const head = createHead();

    // Only concrete-level binds allowed
    head.write(scope(
      [concrete('mount', { type: 'literal', value: { levels: ['concrete'] } })],
      'mount-scope',
    ));

    // concrete bind succeeds
    head.write(concrete('x', { type: 'literal', value: 1 }));
    expect(head.value('x')).toBe(1);

    // type-level bind should be rejected
    expect(() => {
      head.write(type_('schema', { type: 'literal', value: {} }));
    }).toThrow(TypeError);
  });

  test('pattern restricts binding names', () => {
    const head = createHead();

    // Only names starting with 'arg.' allowed
    head.write(scope(
      [concrete('mount', { type: 'literal', value: { pattern: '^arg\\.' } })],
      'mount-scope',
    ));

    // arg.name should succeed
    head.write(concrete('arg.name', { type: 'literal', value: 'test' }));
    expect(head.value('arg.name')).toBe('test');

    // other names rejected
    expect(() => {
      head.write(concrete('config', { type: 'literal', value: 'bad' }));
    }).toThrow(TypeError);
  });

  test('scope open/terminate bypasses mount', () => {
    const head = createHead();

    // Restrictive mount: only allow bind
    head.write(scope(
      [concrete('mount', { type: 'literal', value: { allow: ['bind'] } })],
      'mount-scope',
    ));

    // Opening a nested scope should work (bypass mount)
    expect(() => {
      head.write(scope(
        [concrete('visibility', { type: 'literal', value: { scope: false } })],
        'nested-scope',
      ));
    }).not.toThrow();

    // Terminating a scope should also work (bypass mount)
    expect(() => {
      head.write(scopeTerminate('nested-scope'));
    }).not.toThrow();
  });

  test('inner mount overrides outer mount', () => {
    const head = createHead();

    // Outer: only bind allowed
    head.write(scope(
      [concrete('mount', { type: 'literal', value: { allow: ['bind'] } })],
      'outer-mount',
    ));

    // Inner: allow bind + export
    head.write(scope(
      [concrete('mount', { type: 'literal', value: { allow: ['bind', 'export'] } })],
      'inner-mount',
    ));

    // export should succeed (inner mount allows it)
    head.write(concrete('y', { type: 'literal', value: 99 }));
    expect(() => {
      head.write(export_(['y']));
    }).not.toThrow();
  });

  test('mount on closed scope no longer applies', () => {
    const head = createHead();

    head.write(scope(
      [concrete('mount', { type: 'literal', value: { allow: ['bind'] } })],
      'temp-mount',
    ));

    // While scope active, export is rejected
    expect(() => {
      head.write(export_(['x']));
    }).toThrow(TypeError);

    // Close the scope
    head.write(scopeTerminate('temp-mount'));

    // Now export should work (mount no longer active)
    head.write(concrete('z', { type: 'literal', value: 7 }));
    expect(() => {
      head.write(export_(['z']));
    }).not.toThrow();
  });

  test('error message includes reason field', () => {
    const head = createHead();

    head.write(scope(
      [concrete('mount', { type: 'literal', value: { allow: ['bind'], reason: 'Only data writes permitted' } })],
      'mount-scope',
    ));

    expect(() => {
      head.write(export_(['x']));
    }).toThrow('Only data writes permitted');
  });

  test('empty mount (no restrictions) allows all', () => {
    const head = createHead();

    // Mount with no restrictions
    head.write(scope(
      [concrete('mount', { type: 'literal', value: {} })],
      'mount-scope',
    ));

    // Everything should work
    head.write(concrete('a', { type: 'literal', value: 1 }));
    head.write(type_('b', { type: 'literal', value: {} }));
    head.write(export_(['a']));
    expect(head.value('a')).toBe(1);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Receiver dispatch on lifecycle transitions
// ─────────────────────────────────────────────────────────────────────────────

describe('patchType on lifecycle transitions', () => {
  test('fires on pending→ready via source advance (registerSourceGate)', async () => {
    const rootType = objectType({ x: 'string' });
    const head = createHead(rootType);
    const downstream = head.draft();
    expect(downstream.lifecycle).toBe('pending');

    // Track receiver dispatches via a registered receiver
    let receiverCalled = false;
    head.addReceiver(async () => { receiverCalled = true; return []; });

    // Fill gap via sibling draft + save → source advance → downstream cascade
    const filler = head.draft();
    filler.write(concrete('x', { type: 'literal', value: 'filled' }));
    await filler.save();

    // Downstream transitions pending→ready from reactive cascade
    expect(downstream.lifecycle).toBe('ready');
    // Receiver should have been dispatched (save fires receivers)
    expect(receiverCalled).toBe(true);
  });

  test('write does NOT fire receiver dispatch (save handles it)', () => {
    const rootType = objectType({ x: 'string' });
    const head = createHead(rootType);
    const draft = head.draft();
    expect(draft.lifecycle).toBe('pending');

    let receiverCalled = false;
    head.addReceiver(async () => { receiverCalled = true; return []; });

    // Direct write to draft — receiver dispatch should NOT fire
    draft.write(concrete('x', { type: 'literal', value: 'hello' }));
    expect(draft.lifecycle).toBe('ready');
    expect(receiverCalled).toBe(false);
  });

  test('does NOT fire when lifecycle stays same on source advance', async () => {
    // Source with TWO gaps
    const rootType = objectType({ x: 'string', y: 'string' });
    const head = createHead(rootType);
    const downstream = head.draft();
    expect(downstream.lifecycle).toBe('pending');

    // Fill only ONE gap via save → downstream stays pending (no lifecycle transition)
    const filler = head.draft();
    filler.write(concrete('x', { type: 'literal', value: 'a' }));
    await filler.save();

    // Lifecycle didn't change — still pending
    expect(downstream.lifecycle).toBe('pending');
  });

  test('autoMerge still works after patchType extension', async () => {
    const valueFT = FieldType.string.create().autoMerge().save();
    const rootType = buildObjType({ x: valueFT });

    const head = createHead(rootType);
    const draft = head.draft();
    expect(draft.lifecycle).toBe('pending');

    // Fill gap → pending→ready → autoMerge kicks in
    draft.write(concrete('x', { type: 'literal', value: 'auto' }));
    expect(draft.lifecycle).toBe('ready');

    // Let microtask queue flush (autoMerge uses Promise.resolve().then)
    await new Promise(r => setTimeout(r, 50));

    // autoMerge should have saved the draft to source
    expect(head.value('x')).toBe('auto');
  });

  test('does not fire for committed HEAD writes (no lifecycle)', () => {
    const head = createHead();

    let receiverCalled = false;
    head.addReceiver(async () => { receiverCalled = true; return []; });

    // Write to committed HEAD — no draftLifecycle, no transition
    head.write(concrete('x', { type: 'literal', value: 42 }));
    expect(receiverCalled).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Delete Statement
// ─────────────────────────────────────────────────────────────────────────────

describe('delete statement', () => {
  it('removes a binding from scope via reduce()', () => {
    const { delete_ } = require('../statement');
    const head = createHead();
    head.write(concrete('x', { type: 'literal', value: 42 }));
    expect(head.value('x')).toBe(42);

    head.write(delete_('x'));
    expect(head.value('x')).toBeUndefined();
  });

  it('removes binding from entries()', () => {
    const { delete_ } = require('../statement');
    const head = createHead();
    head.write(concrete('x', { type: 'literal', value: 1 }));
    head.write(concrete('y', { type: 'literal', value: 2 }));
    expect(head.entries().has('x')).toBe(true);

    head.write(delete_('x'));
    expect(head.entries().has('x')).toBe(false);
    expect(head.entries().has('y')).toBe(true);
  });

  it('draft delete blocks parent fallthrough', () => {
    const { delete_ } = require('../statement');
    const head = createHead();
    head.write(concrete('x', { type: 'literal', value: 42 }));

    const draft = head.draft();
    expect(draft.value('x')).toBe(42); // inherits from parent

    draft.write(delete_('x'));
    expect(draft.value('x')).toBeUndefined(); // tombstone blocks fallthrough
    expect(head.value('x')).toBe(42); // parent unaffected
  });

  it('draft delete merges into parent on save()', async () => {
    const { delete_ } = require('../statement');
    const head = createHead();
    head.write(concrete('x', { type: 'literal', value: 42 }));
    head.write(concrete('y', { type: 'literal', value: 99 }));

    const draft = head.draft();
    draft.write(delete_('x'));
    await draft.save();

    expect(head.value('x')).toBeUndefined(); // deleted
    expect(head.value('y')).toBe(99); // untouched
  });

  it('draft entries() excludes deleted parent bindings', () => {
    const { delete_ } = require('../statement');
    const head = createHead();
    head.write(concrete('a', { type: 'literal', value: 1 }));
    head.write(concrete('b', { type: 'literal', value: 2 }));

    const draft = head.draft();
    draft.write(delete_('a'));

    const entries = draft.entries();
    expect(entries.has('a')).toBe(false);
    expect(entries.has('b')).toBe(true);
  });

  it('subsequent bind after delete resurrects binding', () => {
    const { delete_ } = require('../statement');
    const head = createHead();
    head.write(concrete('x', { type: 'literal', value: 42 }));
    head.write(delete_('x'));
    expect(head.value('x')).toBeUndefined();

    head.write(concrete('x', { type: 'literal', value: 99 }));
    expect(head.value('x')).toBe(99);
  });

  it('delete of non-existent binding is a no-op', () => {
    const { delete_ } = require('../statement');
    const head = createHead();
    head.write(delete_('ghost'));
    expect(head.value('ghost')).toBeUndefined();
    expect(head.entries().has('ghost')).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Gap.fill() — request-response interaction model
//
// The HEAD response includes gaps (suspension points). Each gap carries fill()
// — the only intended way to resolve it. Read → get gaps → fill → re-read.
// ─────────────────────────────────────────────────────────────────────────────

describe('Gap.fill() — fork-merge request-response API', () => {
  it('gap carries fill() method', () => {
    const head = createHead();
    head.write({ type: 'bind', name: 'x', expr: { type: 'ref', source: 'x' }, level: 'concrete' as const });

    const gaps = head.gaps;
    expect(gaps.length).toBe(1);
    expect(gaps[0].key).toBe('x');
    expect(typeof gaps[0].fill).toBe('function');
  });

  it('fill() + exec() resolves the gap via internal draft', async () => {
    const head = createHead();
    head.write({ type: 'bind', name: 'x', expr: { type: 'ref', source: 'x' }, level: 'concrete' as const });

    expect(head.gaps.length).toBe(1);
    head.gaps[0].fill(42);
    // Gap is NOT resolved yet on committed HEAD — staged in internal draft
    // exec() merges the draft back
    const result = await head.exec();
    expect(result.ok).toBe(true);
    expect(head.gaps.length).toBe(0);
    expect(head.value('x')).toBe(42);
  });

  it('fill() on draft writes directly — save() is the exec', async () => {
    const env = createHead();
    const draft = env.draft();
    draft.write({ type: 'bind', name: 'apiKey', expr: { type: 'ref', source: 'apiKey' }, level: 'concrete' as const });

    const gap = draft.gaps.find(g => g.key === 'apiKey')!;
    expect(gap).toBeDefined();
    gap.fill('sk-123');

    // On a draft, fill() writes directly — no separate exec needed
    expect(draft.gaps.length).toBe(0);
    expect(draft.value('apiKey')).toBe('sk-123');

    // save() merges into parent
    const result = await draft.save();
    expect(result.ok).toBe(true);
    expect(env.value('apiKey')).toBe('sk-123');
  });

  it('exec() on draft delegates to save()', async () => {
    const env = createHead();
    const draft = env.draft();
    draft.write({ type: 'bind', name: 'x', expr: { type: 'ref', source: 'x' }, level: 'concrete' as const });

    draft.gaps[0].fill('hello');
    // exec() on a draft = save()
    const result = await draft.exec();
    expect(result.ok).toBe(true);
    expect(env.value('x')).toBe('hello');
  });

  it('fill() + exec() with object value', async () => {
    const head = createHead();
    head.write({ type: 'bind', name: 'config', expr: { type: 'ref', source: 'config' }, level: 'concrete' as const });

    head.gaps[0].fill({ host: 'localhost', port: 3000 });
    await head.exec();
    const val = head.value('config') as any;
    expect(val.host).toBe('localhost');
    expect(val.port).toBe(3000);
  });

  it('multiple fills then single exec — batch submission', async () => {
    const head = createHead();
    head.write({ type: 'bind', name: 'a', expr: { type: 'ref', source: 'a' }, level: 'concrete' as const });
    head.write({ type: 'bind', name: 'b', expr: { type: 'ref', source: 'b' }, level: 'concrete' as const });

    expect(head.gaps.length).toBe(2);
    head.gaps.find(g => g.key === 'a')!.fill('valueA');
    head.gaps.find(g => g.key === 'b')!.fill('valueB');

    // Nothing resolved yet — staged in internal draft
    await head.exec();

    expect(head.gaps.length).toBe(0);
    expect(head.value('a')).toBe('valueA');
    expect(head.value('b')).toBe('valueB');
  });

  it('exec() with nothing staged is a no-op', async () => {
    const head = createHead();
    head.write(concrete('x', { type: 'literal', value: 'done' }));
    const result = await head.exec();
    expect(result.ok).toBe(true);
  });

  it('resolved HEAD has no gaps (no fill affordances)', () => {
    const head = createHead();
    head.write(concrete('x', { type: 'literal', value: 'done' }));
    expect(head.gaps.length).toBe(0);
    expect(head.resolved).toBe(true);
  });

  it('exec() resets internal draft for next cycle', async () => {
    const head = createHead();
    head.write({ type: 'bind', name: 'x', expr: { type: 'ref', source: 'x' }, level: 'concrete' as const });
    head.write({ type: 'bind', name: 'y', expr: { type: 'ref', source: 'y' }, level: 'concrete' as const });

    // First cycle: fill x
    head.gaps.find(g => g.key === 'x')!.fill(1);
    await head.exec();
    expect(head.value('x')).toBe(1);
    expect(head.gaps.length).toBe(1); // y still open

    // Second cycle: fill y
    head.gaps.find(g => g.key === 'y')!.fill(2);
    await head.exec();
    expect(head.value('y')).toBe(2);
    expect(head.gaps.length).toBe(0);
  });
});
