import { ptr, isPtr } from '../ptr.js';
import type { PtrEvent } from '../ptr.js';
import { FieldType } from '../type.js';
import { ConstraintTypes } from '../constraint.js';
import {
  createChain,
  push,
  fork,
  reduce,
  chainFromFieldType,
} from '../chain.js';
import { concrete } from '../statement.js';

// ─────────────────────────────────────────────────────────────────────────────
// Helper: build a simple object FieldType with typed properties
// ─────────────────────────────────────────────────────────────────────────────

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

// ─────────────────────────────────────────────────────────────────────────────
// Creation
// ─────────────────────────────────────────────────────────────────────────────

describe('ptr creation', () => {
  it('creates from FieldType', () => {
    const ft = objectType({ host: 'string', port: 'number' });
    const p = ptr(ft);
    expect(isPtr(p)).toBe(true);
  });

  it('creates from Chain', () => {
    let chain = createChain('object');
    chain = push(chain, concrete('x', { type: 'literal', value: 1 }));
    const p = ptr(chain);
    expect(isPtr(p)).toBe(true);
    expect(p.x).toBe(1);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Get / Set
// ─────────────────────────────────────────────────────────────────────────────

describe('get / set', () => {
  it('returns undefined for unresolved gates', () => {
    const p = ptr(objectType({ host: 'string' }));
    expect(p.host).toBeUndefined();
  });

  it('set pushes force, get retrieves it', () => {
    const p = ptr(objectType({ host: 'string', port: 'number' }));
    p.host = 'localhost';
    p.port = 8080;
    expect(p.host).toBe('localhost');
    expect(p.port).toBe(8080);
  });

  it('later set overrides earlier', () => {
    const p = ptr(objectType({ host: 'string' }));
    p.host = 'first';
    p.host = 'second';
    expect(p.host).toBe('second');
  });

  it('can set fields not in the type schema', () => {
    const p = ptr(objectType({ host: 'string' }));
    p.extra = 'hello';
    expect(p.extra).toBe('hello');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// ['*'] — push entire value
// ─────────────────────────────────────────────────────────────────────────────

describe("['*'] assign", () => {
  it('maps object fields to force statements', () => {
    const p = ptr(objectType({ host: 'string', port: 'number' }));
    (p as any)['*'] = { host: 'localhost', port: 8080 };
    expect(p.host).toBe('localhost');
    expect(p.port).toBe(8080);
  });

  it('overwrites previous values', () => {
    const p = ptr(objectType({ host: 'string' }));
    p.host = 'old';
    (p as any)['*'] = { host: 'new' };
    expect(p.host).toBe('new');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Display
// ─────────────────────────────────────────────────────────────────────────────

describe('display', () => {
  it('shows *Type<T>:undefined when no values set', () => {
    const p = ptr(objectType({ host: 'string' }));
    expect(p.toString()).toBe('*Type<Object>:undefined');
  });

  it('shows *Type<T, {...}> when values set and mergeable', () => {
    const p = ptr(objectType({ host: 'string' }));
    p.host = 'localhost';
    const display = p.toString();
    expect(display).toMatch(/^\*Type<Object, \{ host: "localhost" \}>$/);
  });

  it('shows *UnmergeableType when type mismatch exists', () => {
    const p = ptr(objectType({ port: 'number' }));
    p.port = 'not-a-number'; // wrong type
    const display = p.toString();
    expect(display).toMatch(/^\*UnmergeableType</);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// ['$'].concreteness()
// ─────────────────────────────────────────────────────────────────────────────

describe('concreteness', () => {
  it('reports all missing when nothing set', () => {
    const p = ptr(objectType({ host: 'string', port: 'number' }));
    const c = p['$'].concreteness();
    expect(c.concrete).toBe(false);
    expect(c.missing).toContain('host');
    expect(c.missing).toContain('port');
    expect(c.resolved).toHaveLength(0);
  });

  it('reports partial resolution', () => {
    const p = ptr(objectType({ host: 'string', port: 'number' }));
    p.host = 'localhost';
    const c = p['$'].concreteness();
    expect(c.concrete).toBe(false);
    expect(c.resolved).toContain('host');
    expect(c.missing).toContain('port');
  });

  it('reports fully concrete', () => {
    const p = ptr(objectType({ host: 'string', port: 'number' }));
    p.host = 'localhost';
    p.port = 8080;
    const c = p['$'].concreteness();
    expect(c.concrete).toBe(true);
    expect(c.missing).toHaveLength(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// ['$'].merge()
// ─────────────────────────────────────────────────────────────────────────────

describe('merge', () => {
  it('succeeds when values match types', () => {
    const p = ptr(objectType({ host: 'string', port: 'number' }));
    p.host = 'localhost';
    p.port = 8080;
    const result = p['$'].merge();
    expect(result.ok).toBe(true);
  });

  it('returns conflicts when value type mismatches', () => {
    const p = ptr(objectType({ port: 'number' }));
    p.port = 'not-a-number';
    const result = p['$'].merge();
    expect(result.ok).toBe(false);
    const failed = result as { ok: false; conflicts: any[] };
    expect(failed.conflicts).toHaveLength(1);
    expect(failed.conflicts[0].name).toBe('port');
    expect(failed.conflicts[0].expected).toBe('number');
    expect(failed.conflicts[0].message).toMatch(/expected number, got string/);
  });

  it('multiple conflicts reported', () => {
    const p = ptr(objectType({ host: 'string', port: 'number' }));
    p.host = 12345;       // wrong — expected string
    p.port = 'not-a-num'; // wrong — expected number
    const result = p['$'].merge();
    expect(result.ok).toBe(false);
    const failed = result as { ok: false; conflicts: any[] };
    expect(failed.conflicts).toHaveLength(2);
  });

  it('merge with type change updates the type head', () => {
    const p = ptr(objectType({ value: 'string' }));
    p.value = 12345; // wrong for string

    // Merge fails with original type
    expect(p['$'].merge().ok).toBe(false);

    // Change the type to number
    const newType = chainFromFieldType(objectType({ value: 'number' }));
    const result = p['$'].merge(newType);
    expect(result.ok).toBe(true);
  });

  it('does not throw by default on conflict', () => {
    const p = ptr(objectType({ port: 'number' }));
    p.port = 'wrong';
    // Should return conflict, not throw
    expect(() => p['$'].merge()).not.toThrow();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// ['$'].fork()
// ─────────────────────────────────────────────────────────────────────────────

describe('fork', () => {
  it('returns a Chain, not a ptr', () => {
    const p = ptr(objectType({ host: 'string' }));
    p.host = 'localhost';
    const forked = p['$'].fork();
    expect(forked).toHaveProperty('constructor');
    expect(forked).toHaveProperty('statements');
    expect(forked).toHaveProperty('head');
  });

  it('forked chain preserves parent values', () => {
    const p = ptr(objectType({ host: 'string' }));
    p.host = 'localhost';
    const forked = p['$'].fork();

    // Push to forked chain
    const extended = push(forked, concrete('host', { type: 'literal', value: 'new-host' }));
    const { scope } = reduce(extended);
    expect(scope.bindings.get('host')!.value).toBe('new-host');

    // Original ptr unchanged
    expect(p.host).toBe('localhost');
  });

  it('writes to ptr after fork do not affect forked chain', () => {
    const p = ptr(objectType({ host: 'string' }));
    p.host = 'before-fork';
    const forked = p['$'].fork();

    // Write to ptr after fork
    p.host = 'after-fork';

    // Forked chain inherits parent bindings but does NOT see post-fork writes
    const { scope } = reduce(forked);
    expect(scope.bindings.get('host')?.value).toBe('before-fork');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// ['$'].diff() / ['$'].patch()
// ─────────────────────────────────────────────────────────────────────────────

describe('diff / patch', () => {
  it('computes delta and applies it', () => {
    const p = ptr(objectType({ host: 'string', port: 'number' }));
    p.host = 'localhost';

    // Fork and modify
    const forked = p['$'].fork();
    const modified = push(forked, concrete('port', { type: 'literal', value: 9090 }));

    // Diff
    const changeset = p['$'].diff(modified);
    expect(changeset.statements.length).toBeGreaterThan(0);

    // Patch
    p['$'].patch(changeset);
    expect(p.port).toBe(9090);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// ['$'].subscribe()
// ─────────────────────────────────────────────────────────────────────────────

describe('subscribe', () => {
  it('receives push events', () => {
    const p = ptr(objectType({ host: 'string' }));
    const events: PtrEvent[] = [];
    p['$'].subscribe((e) => events.push(e));

    p.host = 'localhost';
    // push event + possible concrete event (concreteness tracking)
    const pushEvents = events.filter(e => e.type === 'push');
    expect(pushEvents).toHaveLength(1);
    if (pushEvents[0].type === 'push') {
      expect(pushEvents[0].name).toBe('host');
    }
  });

  it('receives assign events from [*]', () => {
    const p = ptr(objectType({ host: 'string' }));
    const events: PtrEvent[] = [];
    p['$'].subscribe((e) => events.push(e));

    (p as any)['*'] = { host: 'localhost', port: 8080 };
    // assign event + possibly concrete event
    const assignEvents = events.filter(e => e.type === 'assign');
    expect(assignEvents).toHaveLength(1);
    if (assignEvents[0].type === 'assign') {
      expect(assignEvents[0].statements).toHaveLength(2);
    }
  });

  it('receives fork events', () => {
    const p = ptr(objectType({ host: 'string' }));
    const events: PtrEvent[] = [];
    p['$'].subscribe((e) => events.push(e));

    p['$'].fork();
    expect(events).toHaveLength(1);
    expect(events[0].type).toBe('fork');
  });

  it('unsubscribe stops events', () => {
    const p = ptr(objectType({ host: 'string' }));
    const events: PtrEvent[] = [];
    const unsub = p['$'].subscribe((e) => events.push(e));

    p.host = 'first';
    const countAfterFirst = events.length;
    expect(countAfterFirst).toBeGreaterThanOrEqual(1);

    unsub();
    p.host = 'second';
    expect(events).toHaveLength(countAfterFirst); // no new events
  });

  it('subscriber errors do not break ptr', () => {
    const p = ptr(objectType({ host: 'string' }));
    p['$'].subscribe(() => { throw new Error('boom'); });

    // Should not throw
    expect(() => { p.host = 'localhost'; }).not.toThrow();
    expect(p.host).toBe('localhost');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// ['$'].toJSON() / ptr.fromJSON()
// ─────────────────────────────────────────────────────────────────────────────

describe('serialization', () => {
  it('round-trips via toJSON / fromJSON', () => {
    const p = ptr(objectType({ host: 'string', port: 'number' }));
    p.host = 'localhost';
    p.port = 8080;

    const json = p['$'].toJSON();
    const restored = ptr.fromJSON(json);

    expect(restored.host).toBe('localhost');
    expect(restored.port).toBe(8080);
  });

  it('preserves type chain on round-trip', () => {
    const p = ptr(objectType({ host: 'string' }));
    p.host = 'localhost';

    const json = p['$'].toJSON();
    const restored = ptr.fromJSON(json);

    // Merge should succeed (type head preserved)
    expect(restored['$'].merge().ok).toBe(true);

    // Type mismatch still detected
    restored.host = 12345;
    expect(restored['$'].merge().ok).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// ['$'].compact()
// ─────────────────────────────────────────────────────────────────────────────

describe('compact', () => {
  it('preserves values after compaction', () => {
    const p = ptr(objectType({ host: 'string' }));
    p.host = 'v1';
    p.host = 'v2';
    p.host = 'v3';
    p.host = 'v4';
    p.host = 'final';

    p['$'].compact({ keep: 1 });
    expect(p.host).toBe('final');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// ['$'] escape hatches
// ─────────────────────────────────────────────────────────────────────────────

describe('handle properties', () => {
  it('chain returns the raw value chain', () => {
    const p = ptr(objectType({ host: 'string' }));
    p.host = 'localhost';
    const chain = p['$'].chain;
    expect(chain.statements).toHaveLength(1);
  });

  it('typeChain returns the raw type chain', () => {
    const ft = objectType({ host: 'string', port: 'number' });
    const p = ptr(ft);
    const tc = p['$'].typeChain;
    expect(tc.constructor).toBe('object');
  });

  it('id is stable', () => {
    const p = ptr(objectType({ host: 'string' }));
    const id1 = p['$'].id;
    p.host = 'localhost';
    const id2 = p['$'].id;
    expect(id1).toBe(id2);
  });

  it('type returns FieldType snapshot of type head', () => {
    const p = ptr(objectType({ host: 'string' }));
    const ft = p['$'].type;
    expect(FieldType.describes(ft)).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Proxy behavior
// ─────────────────────────────────────────────────────────────────────────────

describe('proxy behavior', () => {
  it('has() works for set fields', () => {
    const p = ptr(objectType({ host: 'string' }));
    p.host = 'localhost';
    expect('host' in p).toBe(true);
  });

  it('has() returns true for $ and *', () => {
    const p = ptr(objectType({}));
    expect('$' in p).toBe(true);
    expect('*' in p).toBe(true);
  });

  it('ownKeys includes type-declared and value keys', () => {
    const p = ptr(objectType({ host: 'string' }));
    p.extra = 'hello';
    const keys = Object.keys(p);
    expect(keys).toContain('host');
    expect(keys).toContain('extra');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// isPtr
// ─────────────────────────────────────────────────────────────────────────────

describe('isPtr', () => {
  it('true for ptrs', () => {
    expect(isPtr(ptr(objectType({})))).toBe(true);
  });

  it('false for plain objects', () => {
    expect(isPtr({})).toBe(false);
    expect(isPtr(null)).toBe(false);
    expect(isPtr(42)).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Event logging scenario (CRDT-style sync hook)
// ─────────────────────────────────────────────────────────────────────────────

describe('event logging scenario', () => {
  it('subscriber captures full mutation history for replay', () => {
    const log: PtrEvent[] = [];
    const p = ptr(objectType({ host: 'string', port: 'number' }));
    p['$'].subscribe((e) => log.push(e));

    p.host = 'localhost';
    p.port = 8080;
    p.host = 'api.example.com';

    // Filter to push events only (concreteness events may also fire)
    const pushEvents = log.filter(e => e.type === 'push');
    expect(pushEvents).toHaveLength(3);

    // Replay into a fresh ptr
    const p2 = ptr(objectType({ host: 'string', port: 'number' }));
    for (const event of pushEvents) {
      if (event.type === 'push') {
        (p2 as any)[event.name] = event.statement.expr.type === 'literal'
          ? (event.statement.expr as any).value
          : undefined;
      }
    }
    expect(p2.host).toBe('api.example.com');
    expect(p2.port).toBe(8080);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Phase 9: type-gated writes (via proxy)
// ─────────────────────────────────────────────────────────────────────────────

describe('type-gated writes', () => {
  it('accepts write when type matches gate', () => {
    const p = ptr(objectType({ host: 'string', port: 'number' }), { gated: true });
    p.host = 'localhost';
    p.port = 8080;
    expect(p.host).toBe('localhost');
    expect(p.port).toBe(8080);
  });

  it('rejects write when type mismatches gate', () => {
    const p = ptr(objectType({ port: 'number' }), { gated: true });
    // Strict mode: set returning false throws TypeError
    expect(() => { p.port = 'not-a-number' as any; }).toThrow(TypeError);
    expect(p.port).toBeUndefined();
  });

  it('accepts write for unknown name (no gate)', () => {
    const p = ptr(objectType({ host: 'string' }), { gated: true });
    p.extra = 42;
    expect(p.extra).toBe(42);
  });

  it('fires push event on acceptance', () => {
    const events: PtrEvent[] = [];
    const p = ptr(objectType({ host: 'string' }), { gated: true });
    p['$'].subscribe(e => events.push(e));

    p.host = 'localhost';

    const pushEvents = events.filter(e => e.type === 'push');
    expect(pushEvents).toHaveLength(1);
    if (pushEvents[0].type === 'push') {
      expect(pushEvents[0].name).toBe('host');
    }
  });

  it('fires rejected event on rejection', () => {
    const events: PtrEvent[] = [];
    const p = ptr(objectType({ port: 'number' }), { gated: true });
    p['$'].subscribe(e => events.push(e));

    try { p.port = 'wrong' as any; } catch {}

    const rejectedEvents = events.filter(e => e.type === 'rejected');
    expect(rejectedEvents).toHaveLength(1);
    if (rejectedEvents[0].type === 'rejected') {
      expect(rejectedEvents[0].name).toBe('port');
      expect(rejectedEvents[0].expected).toBe('number');
      expect(rejectedEvents[0].actual).toBe('string');
    }
  });

  it('value is NOT pushed when rejected', () => {
    const p = ptr(objectType({ port: 'number' }), { gated: true });
    try { p.port = 'wrong' as any; } catch {}
    expect(p.port).toBeUndefined();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Phase 9: concreteness transitions (via proxy)
// ─────────────────────────────────────────────────────────────────────────────

describe('concreteness transitions', () => {
  it('fires concrete event when transitioning false → true', () => {
    const events: PtrEvent[] = [];
    const p = ptr(objectType({ host: 'string' }));
    p['$'].subscribe(e => events.push(e));

    p.host = 'localhost';

    const concreteEvents = events.filter(e => e.type === 'concrete');
    expect(concreteEvents).toHaveLength(1);
    if (concreteEvents[0].type === 'concrete') {
      expect(concreteEvents[0].prev).toBe(false);
      expect(concreteEvents[0].next).toBe(true);
      expect(concreteEvents[0].resolved).toContain('host');
      expect(concreteEvents[0].missing).toHaveLength(0);
    }
  });

  it('does NOT fire when concreteness stays the same', () => {
    const events: PtrEvent[] = [];
    const p = ptr(objectType({ host: 'string', port: 'number' }));
    p['$'].subscribe(e => events.push(e));

    // Set host — still not concrete (port missing), was already not concrete
    p.host = 'localhost';

    const concreteEvents = events.filter(e => e.type === 'concrete');
    expect(concreteEvents).toHaveLength(0);
  });

  it('concrete event includes missing/resolved lists', () => {
    const p = ptr(objectType({ host: 'string', port: 'number' }));
    p.host = 'localhost'; // partial — no transition yet

    const events: PtrEvent[] = [];
    p['$'].subscribe(e => events.push(e));

    p.port = 8080; // now fully concrete → transition fires

    const concreteEvents = events.filter(e => e.type === 'concrete');
    expect(concreteEvents).toHaveLength(1);
    if (concreteEvents[0].type === 'concrete') {
      expect(concreteEvents[0].resolved).toContain('host');
      expect(concreteEvents[0].resolved).toContain('port');
      expect(concreteEvents[0].missing).toHaveLength(0);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Phase 9: gated proxy mode
// ─────────────────────────────────────────────────────────────────────────────

describe('gated proxy mode', () => {
  it('property assignment rejects type mismatch in gated mode', () => {
    const p = ptr(objectType({ port: 'number' }), { gated: true });

    // Rejected — set trap returns false, which throws TypeError in strict mode
    expect(() => { p.port = 'wrong-type' as any; }).toThrow(TypeError);
    // The value should NOT be in the ptr.
    expect(p.port).toBeUndefined();
  });

  it('property assignment accepts correct type in gated mode', () => {
    const p = ptr(objectType({ port: 'number' }), { gated: true });
    p.port = 8080;
    expect(p.port).toBe(8080);
  });

  it('non-gated mode (default) bypasses gate', () => {
    const p = ptr(objectType({ port: 'number' }));
    p.port = 'wrong-type'; // should be accepted (no gating)
    expect(p.port).toBe('wrong-type');
    // But merge will fail
    expect(p['$'].merge().ok).toBe(false);
  });

  it('gated mode fires rejected event on mismatch', () => {
    const events: PtrEvent[] = [];
    const p = ptr(objectType({ port: 'number' }), { gated: true });
    p['$'].subscribe(e => events.push(e));

    // Throws in strict mode, but events still fire before the throw
    try { p.port = 'wrong' as any; } catch {}

    const rejectedEvents = events.filter(e => e.type === 'rejected');
    expect(rejectedEvents).toHaveLength(1);
  });

  it('gated mode fires push + concrete events on success', () => {
    const events: PtrEvent[] = [];
    const p = ptr(objectType({ port: 'number' }), { gated: true });
    p['$'].subscribe(e => events.push(e));

    p.port = 8080;

    const pushEvents = events.filter(e => e.type === 'push');
    expect(pushEvents).toHaveLength(1);

    const concreteEvents = events.filter(e => e.type === 'concrete');
    expect(concreteEvents).toHaveLength(1);
  });
});
