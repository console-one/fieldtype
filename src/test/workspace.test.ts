/**
 * workspace.test.ts — Tests for the reactive FieldType workspace
 *
 * patch() is the only state transition. write/delete are convenience wrappers.
 * Every patch is timestamped. REAL_TIME updates on every patch.
 * fork() creates an isolated workspace for interpreters.
 * merge() diffs and patches back.
 */

import { createWorkspace } from '../workspace.js';
import { types } from '../builders.js';
import { FieldType } from '../type.js';
import { constraintRef, ConstraintTypes } from '../constraint.js';

// Deterministic clock for testing
function testClock() {
  let t = 1000;
  return () => t++;
}

// ─────────────────────────────────────────────────────────────────────────────
// 1. Basic write/read (convenience wrappers over patch)
// ─────────────────────────────────────────────────────────────────────────────

describe('Workspace', () => {
  describe('write and read', () => {
    it('writes and reads a string at a top-level path', () => {
      const ws = createWorkspace();
      ws.write('name', 'hello');
      expect(ws.read('name')).toBe('hello');
    });

    it('writes and reads a number', () => {
      const ws = createWorkspace();
      ws.write('count', 42);
      expect(ws.read('count')).toBe(42);
    });

    it('writes and reads a boolean', () => {
      const ws = createWorkspace();
      ws.write('active', true);
      expect(ws.read('active')).toBe(true);
    });

    it('writes and reads null', () => {
      const ws = createWorkspace();
      ws.write('empty', null);
      expect(ws.read('empty')).toBe(null);
    });

    it('writes and reads a nested path', () => {
      const ws = createWorkspace();
      ws.write('config.db.host', 'localhost');
      ws.write('config.db.port', 5432);
      expect(ws.read('config.db.host')).toBe('localhost');
      expect(ws.read('config.db.port')).toBe(5432);
    });

    it('overwrites an existing value', () => {
      const ws = createWorkspace();
      ws.write('x', 1);
      expect(ws.read('x')).toBe(1);
      ws.write('x', 2);
      expect(ws.read('x')).toBe(2);
    });

    it('reads undefined for non-existent paths', () => {
      const ws = createWorkspace();
      expect(ws.read('nope')).toBeUndefined();
    });

    it('accepts a FieldType directly as value', () => {
      const ws = createWorkspace();
      const ft = types.string().literal('typed').save();
      ws.write('key', ft);
      expect(ws.read('key')).toBe('typed');
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // 2. entries()
  // ─────────────────────────────────────────────────────────────────────────

  describe('entries', () => {
    it('lists top-level property keys', () => {
      const ws = createWorkspace();
      ws.write('a', 1);
      ws.write('b', 2);
      ws.write('c', 3);
      const keys = ws.entries();
      expect(keys).toEqual(expect.arrayContaining(['a', 'b', 'c']));
      expect(keys).toHaveLength(3);
    });

    it('lists keys at a nested path', () => {
      const ws = createWorkspace();
      ws.write('config.db.host', 'localhost');
      ws.write('config.db.port', 5432);
      const keys = ws.entries('config.db');
      expect(keys).toEqual(expect.arrayContaining(['host', 'port']));
      expect(keys).toHaveLength(2);
    });

    it('returns empty array for non-object paths', () => {
      const ws = createWorkspace();
      ws.write('x', 'hello');
      expect(ws.entries('x')).toEqual([]);
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // 3. type()
  // ─────────────────────────────────────────────────────────────────────────

  describe('type', () => {
    it('returns the root FieldType when path is empty', () => {
      const ws = createWorkspace();
      ws.write('x', 1);
      const root = ws.type('');
      expect(root.fieldtype).toBe('object');
    });

    it('returns the FieldType at a nested path', () => {
      const ws = createWorkspace();
      ws.write('name', 'Alice');
      const ft = ws.type('name');
      expect(ft.fieldtype).toBe('string');
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // 4. subscribe — direct notifications
  // ─────────────────────────────────────────────────────────────────────────

  describe('subscribe', () => {
    it('fires when the subscribed path is written', () => {
      const ws = createWorkspace();
      const calls: unknown[] = [];
      ws.subscribe('x', (val) => calls.push(val));

      ws.write('x', 'hello');
      expect(calls).toEqual(['hello']);

      ws.write('x', 'world');
      expect(calls).toEqual(['hello', 'world']);
    });

    it('fires parent subscribers when a child path is written', () => {
      const ws = createWorkspace();
      const calls: unknown[] = [];
      ws.subscribe('config', (val) => calls.push(val));

      ws.write('config.key', 'value');
      expect(calls.length).toBe(1);
    });

    it('does not fire unrelated subscribers', () => {
      const ws = createWorkspace();
      const calls: unknown[] = [];
      ws.subscribe('a', (val) => calls.push(val));

      ws.write('b', 'value');
      expect(calls).toEqual([]);
    });

    it('unsubscribe stops notifications', () => {
      const ws = createWorkspace();
      const calls: unknown[] = [];
      const unsub = ws.subscribe('x', (val) => calls.push(val));

      ws.write('x', 1);
      expect(calls).toEqual([1]);

      unsub();
      ws.write('x', 2);
      expect(calls).toEqual([1]);
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // 5. ConstraintRef resolution
  // ─────────────────────────────────────────────────────────────────────────

  describe('ConstraintRef resolution', () => {
    it('read() follows a RefConstraint to its source', () => {
      const ws = createWorkspace();
      ws.write('source', 'original');

      const refType = FieldType.any.create({
        attributes: [ConstraintTypes.any.ref.create('source')],
      });
      ws.write('alias', refType);

      expect(ws.read('alias')).toBe('original');
    });

    it('read() follows a literal ConstraintRef value', () => {
      const ws = createWorkspace();
      ws.write('source', 42);

      const refLiteral = FieldType.any.create({
        attributes: [ConstraintTypes.any.literal.create(constraintRef('source'))],
      });
      ws.write('pointer', refLiteral);

      expect(ws.read('pointer')).toBe(42);
    });

    it('read() handles circular refs gracefully', () => {
      const ws = createWorkspace();
      ws.write('a', FieldType.any.create({
        attributes: [ConstraintTypes.any.ref.create('b')],
      }));
      ws.write('b', FieldType.any.create({
        attributes: [ConstraintTypes.any.ref.create('a')],
      }));
      expect(ws.read('a')).toBeUndefined();
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // 6. Reactive cascade through refs
  // ─────────────────────────────────────────────────────────────────────────

  describe('reactive ref cascade', () => {
    it('notifies ref dependents when source changes', () => {
      const ws = createWorkspace();
      ws.write('source', 'v1');

      ws.write('alias', FieldType.any.create({
        attributes: [ConstraintTypes.any.ref.create('source')],
      }));

      const calls: unknown[] = [];
      ws.subscribe('alias', (val) => calls.push(val));

      ws.write('source', 'v2');
      expect(calls).toContainEqual('v2');
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // 7. delete
  // ─────────────────────────────────────────────────────────────────────────

  describe('delete', () => {
    it('removes a property and notifies subscribers', () => {
      const ws = createWorkspace();
      ws.write('x', 42);
      expect(ws.read('x')).toBe(42);

      const calls: unknown[] = [];
      ws.subscribe('x', (val) => calls.push(val));

      ws.delete('x');
      expect(ws.read('x')).toBeUndefined();
      expect(calls.length).toBe(1);
      expect(calls[0]).toBeUndefined();
    });

    it('removes a nested property', () => {
      const ws = createWorkspace();
      ws.write('a.b', 1);
      ws.write('a.c', 2);

      ws.delete('a.b');
      expect(ws.read('a.b')).toBeUndefined();
      expect(ws.read('a.c')).toBe(2);
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // 8. Initial FieldType
  // ─────────────────────────────────────────────────────────────────────────

  describe('initial state', () => {
    it('accepts an initial FieldType with existing properties', () => {
      const initial = types.object({
        name: types.string().literal('Alice'),
        age: types.number().literal(30),
      });
      const ws = createWorkspace(initial);

      expect(ws.read('name')).toBe('Alice');
      expect(ws.read('age')).toBe(30);
    });

    it('can write over initial properties', () => {
      const initial = types.object({ x: types.number().literal(1) });
      const ws = createWorkspace(initial);

      ws.write('x', 2);
      expect(ws.read('x')).toBe(2);
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // 9. ft property reflects current state
  // ─────────────────────────────────────────────────────────────────────────

  describe('ft property', () => {
    it('reflects writes', () => {
      const ws = createWorkspace();
      const before = ws.ft;
      ws.write('x', 1);
      const after = ws.ft;
      expect(before).not.toBe(after);
      expect(after.fieldtype).toBe('object');
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // 10. patch() — the only state transition
  // ─────────────────────────────────────────────────────────────────────────

  describe('patch', () => {
    it('applies multiple paths atomically', () => {
      const ws = createWorkspace();
      const result = ws.patch({ a: 1, b: 'two', c: true });

      expect(result.applied).toEqual(expect.arrayContaining(['a', 'b', 'c']));
      expect(result.conflicts).toEqual([]);
      expect(ws.read('a')).toBe(1);
      expect(ws.read('b')).toBe('two');
      expect(ws.read('c')).toBe(true);
      expect(ws.tick).toBe(1); // one tick for the whole patch
    });

    it('detects type conflicts', () => {
      const ws = createWorkspace();
      ws.write('x', 'hello'); // x is string

      const result = ws.patch({ x: 42 }); // x ← number: conflict
      expect(result.conflicts).toContain('x');
      expect(result.applied).not.toContain('x');
      expect(ws.read('x')).toBe('hello'); // unchanged
    });

    it('allows same-type overwrites', () => {
      const ws = createWorkspace();
      ws.write('x', 'hello');

      const result = ws.patch({ x: 'world' });
      expect(result.applied).toContain('x');
      expect(ws.read('x')).toBe('world');
    });

    it('undefined value deletes the path', () => {
      const ws = createWorkspace();
      ws.write('x', 42);

      const result = ws.patch({ x: undefined });
      expect(result.applied).toContain('x');
      expect(ws.read('x')).toBeUndefined();
    });

    it('reports unresolved refs as gaps', () => {
      const ws = createWorkspace();
      const refType = FieldType.any.create({
        attributes: [ConstraintTypes.any.ref.create('nonexistent')],
      });

      const result = ws.patch({ ptr: refType });
      expect(result.gaps).toContain('nonexistent');
    });

    it('no gaps when ref target exists', () => {
      const ws = createWorkspace();
      ws.write('target', 'exists');

      const refType = FieldType.any.create({
        attributes: [ConstraintTypes.any.ref.create('target')],
      });
      const result = ws.patch({ ptr: refType });
      expect(result.gaps).toEqual([]);
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // 11. REAL_TIME
  // ─────────────────────────────────────────────────────────────────────────

  describe('REAL_TIME', () => {
    it('updates on every patch', () => {
      const clock = testClock();
      const ws = createWorkspace(undefined, { clock });

      const t0 = ws.REAL_TIME;
      ws.write('x', 1);
      const t1 = ws.REAL_TIME;
      ws.write('y', 2);
      const t2 = ws.REAL_TIME;

      expect(t1).toBeGreaterThan(t0);
      expect(t2).toBeGreaterThan(t1);
    });

    it('is readable via read()', () => {
      const clock = testClock();
      const ws = createWorkspace(undefined, { clock });
      ws.write('x', 1);
      expect(ws.read('REAL_TIME')).toBe(ws.REAL_TIME);
    });

    it('fires subscribers on every patch', () => {
      const ws = createWorkspace();
      const timestamps: unknown[] = [];
      ws.subscribe('REAL_TIME', (val) => timestamps.push(val));

      ws.write('a', 1);
      ws.write('b', 2);
      expect(timestamps).toHaveLength(2);
    });

    it('ticks carry timestamps', () => {
      const clock = testClock();
      const ws = createWorkspace(undefined, { clock });
      ws.write('a', 1);
      ws.write('b', 2);

      expect(ws.history[0].timestamp).toBeDefined();
      expect(ws.history[1].timestamp).toBeGreaterThan(ws.history[0].timestamp);
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // 12. fork / merge
  // ─────────────────────────────────────────────────────────────────────────

  describe('fork and merge', () => {
    it('fork creates an isolated workspace with current state', () => {
      const ws = createWorkspace();
      ws.write('x', 1);

      const fork = ws.fork();
      expect(fork.read('x')).toBe(1);
      expect(fork.root).toBe(ws);
      expect(fork.base).toBe(ws.ft);
    });

    it('fork writes do not affect root', () => {
      const ws = createWorkspace();
      ws.write('x', 1);

      const fork = ws.fork();
      fork.write('y', 2);

      expect(fork.read('y')).toBe(2);
      expect(ws.read('y')).toBeUndefined();
    });

    it('merge applies fork changes to root', () => {
      const ws = createWorkspace();
      ws.write('x', 1);

      const fork = ws.fork();
      fork.write('result', 'computed');

      const result = ws.merge(fork);
      expect(result.applied).toContain('result');
      expect(ws.read('result')).toBe('computed');
      expect(ws.read('x')).toBe(1); // unchanged
    });

    it('merge detects type conflicts with diverged root', () => {
      const ws = createWorkspace();
      ws.write('x', 'hello');

      const fork = ws.fork();
      fork.write('x', 'from-fork'); // same type, ok in fork

      // Root changes x's type while fork is working
      ws.delete('x');
      ws.write('x', 999); // now x is number

      const result = ws.merge(fork);
      // Fork wrote string, root has number → conflict
      expect(result.conflicts).toContain('x');
    });

    it('merge handles deletions in fork', () => {
      const ws = createWorkspace();
      ws.write('keep', 1);
      ws.write('remove', 2);

      const fork = ws.fork();
      fork.delete('remove');

      ws.merge(fork);
      expect(ws.read('keep')).toBe(1);
      expect(ws.read('remove')).toBeUndefined();
    });

    it('merge with no changes is a no-op', () => {
      const ws = createWorkspace();
      ws.write('x', 1);

      const fork = ws.fork();
      // fork makes no changes

      const result = ws.merge(fork);
      expect(result.applied).toEqual([]);
    });

    it('interpreter can subscribe to root for reactive conflict detection', () => {
      const ws = createWorkspace();
      ws.write('x', 1);

      const fork = ws.fork();
      const rootChanges: string[] = [];

      // Interpreter subscribes to root for change notifications
      fork.root!.subscribe('x', (_val, path) => rootChanges.push(path));

      // Root changes while interpreter is working
      ws.write('x', 2);
      expect(rootChanges).toContain('x');
    });

    it('reject merge of non-fork workspace', () => {
      const ws = createWorkspace();
      const other = createWorkspace();

      const result = ws.merge(other);
      expect(result.conflicts).toContain('NOT_A_FORK');
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // 13. Version control — workspace layer
  // ─────────────────────────────────────────────────────────────────────────

  describe('version control', () => {
    it('tick starts at 0 and increments on each write', () => {
      const ws = createWorkspace();
      expect(ws.tick).toBe(0);

      ws.write('a', 1);
      expect(ws.tick).toBe(1);

      ws.write('b', 2);
      expect(ws.tick).toBe(2);
    });

    it('tick increments on delete', () => {
      const ws = createWorkspace();
      ws.write('a', 1);
      ws.delete('a');
      expect(ws.tick).toBe(2);
    });

    it('multi-path patch is one tick', () => {
      const ws = createWorkspace();
      ws.patch({ a: 1, b: 2, c: 3 });
      expect(ws.tick).toBe(1);
    });

    it('history records paths per tick', () => {
      const ws = createWorkspace();
      ws.write('x', 10);
      ws.write('y', 20);
      ws.delete('x');

      expect(ws.history).toHaveLength(3);
      expect(ws.history[0].paths).toEqual(['x']);
      expect(ws.history[1].paths).toEqual(['y']);
      expect(ws.history[2].paths).toEqual(['x']);
    });

    it('each tick stores prev and ft snapshots', () => {
      const ws = createWorkspace();
      const origin = ws.ft;

      ws.write('x', 1);
      const t0 = ws.history[0];
      expect(t0.prev).toBe(origin);
      expect(t0.ft).not.toBe(origin);
    });

    it('undo reverts to previous state', () => {
      const ws = createWorkspace();
      ws.write('x', 1);
      ws.write('x', 2);
      expect(ws.read('x')).toBe(2);

      const undone = ws.undo();
      expect(undone).toBeDefined();
      expect(undone!.paths).toEqual(['x']);
      expect(ws.read('x')).toBe(1);
      expect(ws.tick).toBe(1);
    });

    it('undo fires subscribers for the reverted path', () => {
      const ws = createWorkspace();
      ws.write('x', 'original');
      ws.write('x', 'changed');

      const calls: unknown[] = [];
      ws.subscribe('x', (val) => calls.push(val));

      ws.undo();
      expect(calls).toEqual(['original']);
    });

    it('undo returns undefined when at origin', () => {
      const ws = createWorkspace();
      expect(ws.undo()).toBeUndefined();
    });

    it('multiple undos walk back the full timeline', () => {
      const ws = createWorkspace();
      ws.write('a', 1);
      ws.write('b', 2);
      ws.write('c', 3);

      ws.undo();
      expect(ws.read('c')).toBeUndefined();
      expect(ws.read('b')).toBe(2);

      ws.undo();
      expect(ws.read('b')).toBeUndefined();
      expect(ws.read('a')).toBe(1);

      ws.undo();
      expect(ws.read('a')).toBeUndefined();
      expect(ws.tick).toBe(0);
    });

    it('at() retrieves the FieldType at a specific tick', () => {
      const ws = createWorkspace();
      ws.write('x', 10);
      ws.write('x', 20);
      ws.write('x', 30);

      const ft0 = ws.at(0)!;
      expect(ft0).toBeDefined();

      const ft2 = ws.at(2)!;
      expect(ft2).toBeDefined();
      expect(ft2).not.toBe(ft0);

      expect(ws.at(-1)).toBeUndefined();
      expect(ws.at(99)).toBeUndefined();
    });

    it('undo of a delete restores the deleted property', () => {
      const ws = createWorkspace();
      ws.write('x', 42);
      ws.delete('x');
      expect(ws.read('x')).toBeUndefined();

      ws.undo();
      expect(ws.read('x')).toBe(42);
    });

    it('undo reverts multi-path patch as one step', () => {
      const ws = createWorkspace();
      ws.patch({ a: 1, b: 2 });
      expect(ws.read('a')).toBe(1);
      expect(ws.read('b')).toBe(2);

      ws.undo();
      expect(ws.read('a')).toBeUndefined();
      expect(ws.read('b')).toBeUndefined();
      expect(ws.tick).toBe(0);
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // 14. CallConstraint — computed constraints
  // ─────────────────────────────────────────────────────────────────────────

  describe('CallConstraint', () => {
    it('resolves a call when fn and args are concrete', () => {
      const ws = createWorkspace();
      // Write a function as a literal
      const addFn = (a: number, b: number) => a + b;
      ws.write('add', addFn);
      ws.write('x', 10);
      ws.write('y', 20);

      // Write a computed constraint: result = add(x, y)
      const callType = FieldType.any.create({
        attributes: [ConstraintTypes.any.call.create(
          constraintRef('add'),
          [constraintRef('x'), constraintRef('y')],
        )],
      });
      ws.write('result', callType);

      expect(ws.read('result')).toBe(30);
    });

    it('returns undefined (gap) when fn is not concrete', () => {
      const ws = createWorkspace();
      ws.write('x', 10);

      const callType = FieldType.any.create({
        attributes: [ConstraintTypes.any.call.create(
          constraintRef('missingFn'),
          [constraintRef('x')],
        )],
      });
      ws.write('result', callType);

      expect(ws.read('result')).toBeUndefined();
    });

    it('returns undefined (gap) when an arg is not concrete', () => {
      const ws = createWorkspace();
      const fn = (a: number) => a * 2;
      ws.write('fn', fn);

      const callType = FieldType.any.create({
        attributes: [ConstraintTypes.any.call.create(
          constraintRef('fn'),
          [constraintRef('missingArg')],
        )],
      });
      ws.write('result', callType);

      expect(ws.read('result')).toBeUndefined();
    });

    it('works with literal args (no refs)', () => {
      const ws = createWorkspace();
      const fn = (a: number, b: number) => a * b;
      ws.write('fn', fn);

      const callType = FieldType.any.create({
        attributes: [ConstraintTypes.any.call.create(
          constraintRef('fn'),
          [3, 7],  // literal args, not refs
        )],
      });
      ws.write('result', callType);

      expect(ws.read('result')).toBe(21);
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // 15. TemporalConstraint — timed tells
  // ─────────────────────────────────────────────────────────────────────────

  describe('TemporalConstraint', () => {
    it('shadows base value when REAL_TIME >= after', () => {
      const clock = testClock(); // starts at 1000, increments each call
      const ws = createWorkspace(undefined, { clock });

      // Write base value + temporal constraint that activates after time 1005
      const temporalType = FieldType.any.create({
        attributes: [
          ConstraintTypes.any.literal.create('base-value'),
          ConstraintTypes.any.temporal.create(1005, 'future-value'),
        ],
      });
      ws.write('x', temporalType);  // tick consumes clock → 1001

      // REAL_TIME is 1001, which is < 1005, so should read base value
      expect(ws.read('x')).toBe('base-value');

      // Advance clock past the threshold
      // Each write ticks the clock. We need REAL_TIME >= 1005
      ws.write('pad1', 1); // 1002
      ws.write('pad2', 2); // 1003
      ws.write('pad3', 3); // 1004
      ws.write('pad4', 4); // 1005

      // Now REAL_TIME = 1005 >= 1005, so temporal value should shadow
      expect(ws.read('x')).toBe('future-value');
    });

    it('returns base value when REAL_TIME < after', () => {
      const clock = testClock();
      const ws = createWorkspace(undefined, { clock });

      const temporalType = FieldType.any.create({
        attributes: [
          ConstraintTypes.any.literal.create('initial'),
          ConstraintTypes.any.temporal.create(9999, 'later'),
        ],
      });
      ws.write('x', temporalType);

      expect(ws.read('x')).toBe('initial');
    });

    it('most recent applicable temporal wins when multiple exist', () => {
      const clock = testClock();
      const ws = createWorkspace(undefined, { clock });

      const temporalType = FieldType.any.create({
        attributes: [
          ConstraintTypes.any.literal.create('original'),
          ConstraintTypes.any.temporal.create(1000, 'phase1'),
          ConstraintTypes.any.temporal.create(1002, 'phase2'),
        ],
      });
      ws.write('x', temporalType); // REAL_TIME → 1001

      // REAL_TIME=1001 >= 1000 → phase1 active, but < 1002 → phase2 not active
      // Most recent applicable = phase1
      expect(ws.read('x')).toBe('phase1');

      ws.write('pad', 1); // REAL_TIME → 1002
      // Now REAL_TIME=1002 >= 1002 → phase2 also active, wins (higher threshold)
      expect(ws.read('x')).toBe('phase2');
    });
  });
});
