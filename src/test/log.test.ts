import { ptr } from '../ptr.js';
import type { PtrEvent } from '../ptr.js';
import { PtrLog } from '../log.js';
import type { LogEntry } from '../log.js';
import { FieldType } from '../type.js';
import { ConstraintTypes } from '../constraint.js';
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
// PtrLog
// ─────────────────────────────────────────────────────────────────────────────

describe('PtrLog', () => {
  it('append creates entry with incrementing lamport', () => {
    const log = new PtrLog('r1');
    const e1 = log.append(concrete('host', { type: 'literal', value: 'a' }));
    const e2 = log.append(concrete('port', { type: 'literal', value: 1 }));

    expect(e1.lamport).toBe(1);
    expect(e2.lamport).toBe(2);
    expect(e1.id).toBe('r1:1');
    expect(e2.id).toBe('r1:2');
    expect(e1.replica).toBe('r1');
    expect(log.entries).toHaveLength(2);
    expect(log.lamport).toBe(2);
  });

  it('since(null) returns all entries', () => {
    const log = new PtrLog('r1');
    log.append(concrete('a', { type: 'literal', value: 1 }));
    log.append(concrete('b', { type: 'literal', value: 2 }));
    log.append(concrete('c', { type: 'literal', value: 3 }));

    const all = log.since(null);
    expect(all).toHaveLength(3);
  });

  it('since(entryId) returns entries after marker', () => {
    const log = new PtrLog('r1');
    const e1 = log.append(concrete('a', { type: 'literal', value: 1 }));
    const e2 = log.append(concrete('b', { type: 'literal', value: 2 }));
    const e3 = log.append(concrete('c', { type: 'literal', value: 3 }));

    const after = log.since(e1.id);
    expect(after).toHaveLength(2);
    expect(after[0].id).toBe(e2.id);
    expect(after[1].id).toBe(e3.id);
  });

  it('since(nonexistent) returns empty', () => {
    const log = new PtrLog('r1');
    log.append(concrete('a', { type: 'literal', value: 1 }));

    const result = log.since('nonexistent:99');
    expect(result).toHaveLength(0);
  });

  it('toJSON/fromJSON round-trip', () => {
    const log = new PtrLog('r1');
    log.append(concrete('host', { type: 'literal', value: 'localhost' }));
    log.append(concrete('port', { type: 'literal', value: 8080 }));

    const json = log.toJSON();
    const restored = PtrLog.fromJSON(json);

    expect(restored.replica).toBe('r1');
    expect(restored.lamport).toBe(2);
    expect(restored.entries).toHaveLength(2);
    expect(restored.entries[0].id).toBe('r1:1');
    expect(restored.entries[1].id).toBe('r1:2');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// CRDT sync
// ─────────────────────────────────────────────────────────────────────────────

describe('CRDT sync', () => {
  it('two replicas sync via delta exchange', () => {
    const schema = objectType({ host: 'string', port: 'number' });

    const p1 = ptr(schema, { log: { replica: 'r1' } });
    const p2 = ptr(schema, { log: { replica: 'r2' } });

    // r1 sets host
    p1.host = 'localhost';
    // r2 sets port
    p2.port = 8080;

    // Exchange deltas
    const delta1 = p1['$'].log!.since(null);
    const delta2 = p2['$'].log!.since(null);

    const result1 = p2['$'].importEntries(delta1);
    const result2 = p1['$'].importEntries(delta2);

    // Both should have host + port
    expect(p1.host).toBe('localhost');
    expect(p1.port).toBe(8080);
    expect(p2.host).toBe('localhost');
    expect(p2.port).toBe(8080);

    expect(result1.applied).toHaveLength(1);
    expect(result2.applied).toHaveLength(1);
  });

  it('concurrent writes converge (LWW by lamport)', () => {
    const schema = objectType({ value: 'string' });

    const p1 = ptr(schema, { log: { replica: 'r1' } });
    const p2 = ptr(schema, { log: { replica: 'r2' } });

    // Both write to 'value' — r1 writes first (lamport 1), r2 writes second (lamport 1)
    p1.value = 'from-r1';
    p2.value = 'from-r2';

    // Import r2's entries into r1 (r2 has same lamport, tiebreak by replica ID: r1 < r2)
    const delta2 = p2['$'].log!.since(null);
    p1['$'].importEntries(delta2);

    // Import r1's entries into r2
    const delta1 = p1['$'].log!.since(null);
    p2['$'].importEntries(delta1);

    // Both should converge — r2 wins tiebreak (r2 > r1, applied later in sort)
    expect(p1.value).toBe(p2.value);
  });

  it('duplicate entries are skipped on import', () => {
    const schema = objectType({ host: 'string' });

    const p1 = ptr(schema, { log: { replica: 'r1' } });
    const p2 = ptr(schema, { log: { replica: 'r2' } });

    p1.host = 'localhost';

    const delta = p1['$'].log!.since(null);

    // Import once
    const result1 = p2['$'].importEntries(delta);
    expect(result1.applied).toHaveLength(1);
    expect(result1.duplicates).toHaveLength(0);

    // Import again — should be duplicate
    const result2 = p2['$'].importEntries(delta);
    expect(result2.applied).toHaveLength(0);
    expect(result2.duplicates).toHaveLength(1);
  });

  it('type gate rejects incompatible entries on import', () => {
    const schema = objectType({ port: 'number' });

    const p2 = ptr(schema, { log: { replica: 'r2' }, gated: true });

    // Manually create an entry with wrong type
    const badEntry: LogEntry = {
      id: 'r1:99',
      lamport: 99,
      replica: 'r1',
      timestamp: Date.now(),
      statement: concrete('port', { type: 'literal', value: 'not-a-number' }),
    };

    const result = p2['$'].importEntries([badEntry]);
    expect(result.rejected).toHaveLength(1);
    expect(result.applied).toHaveLength(0);
    expect(p2.port).toBeUndefined();
  });

  it('import returns applied/rejected/duplicates breakdown', () => {
    const schema = objectType({ host: 'string', port: 'number' });

    const p1 = ptr(schema, { log: { replica: 'r1' }, gated: true });
    const p2 = ptr(schema, { log: { replica: 'r2' }, gated: true });

    p1.host = 'localhost';

    const delta = p1['$'].log!.since(null);

    // Create a bad entry and a duplicate
    const badEntry: LogEntry = {
      id: 'r3:1',
      lamport: 1,
      replica: 'r3',
      timestamp: Date.now(),
      statement: concrete('port', { type: 'literal', value: 'bad' }),
    };

    // First import the good delta
    p2['$'].importEntries(delta);

    // Now import: delta (duplicate) + bad entry
    const result = p2['$'].importEntries([...delta, badEntry]);
    expect(result.duplicates).toHaveLength(1);
    expect(result.rejected).toHaveLength(1);
    expect(result.applied).toHaveLength(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Compressed sync
// ─────────────────────────────────────────────────────────────────────────────

describe('compressed sync', () => {
  it('snapshot + tail round-trips correctly', () => {
    const schema = objectType({ host: 'string', port: 'number' });
    const p1 = ptr(schema, { log: { replica: 'r1' } });

    p1.host = 'v1';
    p1.host = 'v2';
    p1.host = 'v3';
    p1.port = 8080;
    p1.host = 'final';

    // Snapshot with 2 tail entries
    const snap = p1['$'].log!.snapshot(p1['$'].chain, 2);
    expect(snap.tailEntries).toHaveLength(2);
    expect(snap.lamport).toBe(5);
  });

  it('snapshot + import produces same state as full replay', () => {
    const schema = objectType({ host: 'string', port: 'number' });
    const p1 = ptr(schema, { log: { replica: 'r1' } });

    p1.host = 'a';
    p1.port = 1;
    p1.host = 'b';
    p1.port = 2;
    p1.host = 'final-host';
    p1.port = 9999;

    // Full replay into p2 — through the proxy, standard object notation
    const p2 = ptr(schema);
    const allEntries = p1['$'].log!.since(null);
    for (const entry of allEntries) {
      const { name, expr } = entry.statement;
      if (expr.type === 'literal') p2[name] = expr.value;
    }

    // Compressed: snapshot + tail
    const snap = p1['$'].log!.snapshot(p1['$'].chain, 2);
    const p3 = ptr.fromSnapshot(snap, schema);

    expect(p2.host).toBe('final-host');
    expect(p2.port).toBe(9999);
    expect(p3.host).toBe('final-host');
    expect(p3.port).toBe(9999);
  });

  it('compacted ptr has same values as original', () => {
    const schema = objectType({ host: 'string', port: 'number' });
    const p1 = ptr(schema, { log: { replica: 'r1' } });

    p1.host = 'first';
    p1.host = 'second';
    p1.host = 'third';
    p1.port = 42;

    const snap = p1['$'].log!.snapshot(p1['$'].chain, 0);
    const p2 = ptr.fromSnapshot(snap, schema);

    expect(p2.host).toBe('third');
    expect(p2.port).toBe(42);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Integration
// ─────────────────────────────────────────────────────────────────────────────

describe('integration', () => {
  it('logged ptr captures all mutations', () => {
    const schema = objectType({ host: 'string', port: 'number' });
    const p = ptr(schema, { log: { replica: 'r1' } });

    p.host = 'localhost';
    p.port = 8080;
    p.host = 'updated';

    expect(p['$'].log).toBeDefined();
    expect(p['$'].log!.entries).toHaveLength(3);
    expect(p['$'].log!.lamport).toBe(3);
  });

  it('event log subscriber captures push + rejected events', () => {
    const events: PtrEvent[] = [];
    const schema = objectType({ port: 'number' });
    const p = ptr(schema, { log: { replica: 'r1' }, gated: true });
    p['$'].subscribe(e => events.push(e));

    p.port = 8080;  // accepted
    try { p.port = 'bad' as any; } catch {} // rejected — throws in strict mode

    const pushEvents = events.filter(e => e.type === 'push');
    const rejectedEvents = events.filter(e => e.type === 'rejected');

    expect(pushEvents).toHaveLength(1);
    expect(rejectedEvents).toHaveLength(1);
  });

  it('concreteness transition appears in events', () => {
    const events: PtrEvent[] = [];
    const schema = objectType({ host: 'string' });
    const p = ptr(schema, { log: { replica: 'r1' } });
    p['$'].subscribe(e => events.push(e));

    p.host = 'localhost';

    const concreteEvents = events.filter(e => e.type === 'concrete');
    expect(concreteEvents).toHaveLength(1);
    if (concreteEvents[0].type === 'concrete') {
      expect(concreteEvents[0].prev).toBe(false);
      expect(concreteEvents[0].next).toBe(true);
    }
  });

  it('log lamport advances on import', () => {
    const schema = objectType({ host: 'string' });
    const p1 = ptr(schema, { log: { replica: 'r1' } });
    const p2 = ptr(schema, { log: { replica: 'r2' } });

    // r1 makes 5 mutations
    for (let i = 0; i < 5; i++) {
      p1.host = `v${i}`;
    }

    // Import into r2 — lamport should advance
    const delta = p1['$'].log!.since(null);
    p2['$'].importEntries(delta);

    expect(p2['$'].log!.lamport).toBeGreaterThanOrEqual(5);
  });

  it('[*] assign is logged', () => {
    const schema = objectType({ host: 'string', port: 'number' });
    const p = ptr(schema, { log: { replica: 'r1' } });

    (p as any)['*'] = { host: 'localhost', port: 8080 };

    expect(p['$'].log!.entries).toHaveLength(2);
    expect(p['$'].log!.entries[0].statement.name).toBe('host');
    expect(p['$'].log!.entries[1].statement.name).toBe('port');
  });
});
