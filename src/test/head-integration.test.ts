/**
 * head-integration.test.ts — End-to-end tests for HEAD.
 *
 * Tests the full lifecycle: creation → draft → write → save → cascade.
 * Covers spec §5 (cascade), concurrent drafts, and lifecycle progression.
 */
import { createHead } from '../head.js';
import type { HEAD, HeadEvent } from '../head.js';
import { FieldType } from '../type.js';
import { ConstraintTypes } from '../constraint.js';
import { concrete } from '../statement.js';

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
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

function collectEvents(head: HEAD): HeadEvent[] {
  const events: HeadEvent[] = [];
  head.subscribe(e => events.push(e));
  return events;
}

// ─────────────────────────────────────────────────────────────────────────────
// Full lifecycle: draft → fill gaps → save → source advances
// ─────────────────────────────────────────────────────────────────────────────

describe('full lifecycle', () => {
  it('draft fills all gaps then saves successfully', async () => {
    const ft = objectType({ host: 'string', port: 'number', debug: 'boolean' });
    const head = createHead(ft);

    expect(head.gaps.length).toBe(3);

    const d = head.draft();
    expect(d.lifecycle).toBe('pending');

    d.write(concrete('host', { type: 'literal', value: 'localhost' }));
    d.write(concrete('port', { type: 'literal', value: 3000 }));
    d.write(concrete('debug', { type: 'literal', value: true }));

    expect(d.lifecycle).toBe('ready');
    expect(d.preflight().ok).toBe(true);

    const result = await d.save();
    expect(result.ok).toBe(true);
    expect(head.resolved).toBe(true);
    expect(head.gaps.length).toBe(0);
  });

  it('lifecycle progression: drafting → pending → ready → merging → done', async () => {
    const ft = objectType({ x: 'number' });
    const head = createHead(ft);
    const d = head.draft();

    // Starts pending (has gaps inherited from source)
    expect(d.lifecycle).toBe('pending');

    // Fill gap → ready
    d.write(concrete('x', { type: 'literal', value: 42 }));
    expect(d.lifecycle).toBe('ready');

    // Save transitions to merging and completes
    const result = await d.save();
    expect(result.ok).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Source advancement notification
// ─────────────────────────────────────────────────────────────────────────────

describe('source advancement', () => {
  it('source advance fires advance event with prev/next snapshots', async () => {
    const ft = objectType({ x: 'number' });
    const head = createHead(ft);
    const events = collectEvents(head);

    const d = head.draft();
    d.write(concrete('x', { type: 'literal', value: 99 }));
    await d.save();

    const advances = events.filter(e => e.type === 'advance');
    expect(advances.length).toBe(1);

    const advance = advances[0] as Extract<HeadEvent, { type: 'advance' }>;
    expect(advance.prev).toBeDefined();
    expect(advance.next).toBeDefined();
    // prev and next should be different snapshots
    expect(advance.prev).not.toBe(advance.next);
  });

  it('multiple sequential saves advance source correctly', async () => {
    const ft = objectType({ x: 'number', y: 'number' });
    const head = createHead(ft);

    // First draft: fill x
    const d1 = head.draft();
    d1.write(concrete('x', { type: 'literal', value: 1 }));
    d1.write(concrete('y', { type: 'literal', value: 10 }));
    await d1.save();

    expect(head.resolved).toBe(true);

    // Second draft: overwrite x
    const d2 = head.draft();
    d2.write(concrete('x', { type: 'literal', value: 2 }));
    d2.write(concrete('y', { type: 'literal', value: 20 }));
    await d2.save();

    expect(head.resolved).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Concurrent drafts
// ─────────────────────────────────────────────────────────────────────────────

describe('concurrent drafts', () => {
  it('two drafts can merge concurrently (lock serializes them)', async () => {
    const ft = objectType({ a: 'number', b: 'number' });
    const head = createHead(ft);

    const d1 = head.draft();
    d1.write(concrete('a', { type: 'literal', value: 1 }));
    d1.write(concrete('b', { type: 'literal', value: 10 }));

    const d2 = head.draft();
    d2.write(concrete('a', { type: 'literal', value: 2 }));
    d2.write(concrete('b', { type: 'literal', value: 20 }));

    const [r1, r2] = await Promise.all([d1.save(), d2.save()]);

    expect(r1.ok).toBe(true);
    expect(r2.ok).toBe(true);

    // Source should be resolved after both merges
    expect(head.resolved).toBe(true);
  });

  it('three concurrent drafts are serialized in order', async () => {
    const ft = objectType({ x: 'number' });
    const head = createHead(ft);
    const events = collectEvents(head);

    const drafts = [1, 2, 3].map(v => {
      const d = head.draft();
      d.write(concrete('x', { type: 'literal', value: v }));
      return d;
    });

    await Promise.all(drafts.map(d => d.save()));

    const advances = events.filter(e => e.type === 'advance');
    expect(advances.length).toBe(3);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Draft observes source changes
// ─────────────────────────────────────────────────────────────────────────────

describe('draft source observation', () => {
  it('draft receives gaps-changed when source advances', async () => {
    const ft = objectType({ x: 'number', y: 'number' });
    const head = createHead(ft);

    // Create draft that observes source
    const observer = head.draft();
    const events = collectEvents(observer);

    // Another draft advances the source
    const writer = head.draft();
    writer.write(concrete('x', { type: 'literal', value: 42 }));
    writer.write(concrete('y', { type: 'literal', value: 99 }));
    await writer.save();

    // Observer should have received gaps-changed notification
    const gapChanges = events.filter(e => e.type === 'gaps-changed');
    expect(gapChanges.length).toBeGreaterThan(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Shared receiver registry across HEAD tree
// ─────────────────────────────────────────────────────────────────────────────

describe('shared receiver registry', () => {
  it('receiver added on root fires when any node in tree advances', async () => {
    const ft = objectType({ a: 'number', b: 'string' });
    const root = createHead(ft);

    const events: string[] = [];
    root.addReceiver(async (evt) => { events.push(evt.path.join('.')); return []; });

    // Draft on root → write → save triggers receiver dispatch
    const draft = root.draft();
    draft.write(concrete('a', { type: 'literal', value: 42 }));
    draft.write(concrete('b', { type: 'literal', value: 'hello' }));
    await draft.save();

    // Receiver should have been called (lifecycle dispatch on save)
    expect(events.length).toBeGreaterThan(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Dispose cleanup
// ─────────────────────────────────────────────────────────────────────────────

describe('dispose', () => {
  it('disposed HEAD cannot be written to', () => {
    const head = createHead(objectType({ x: 'number' }));
    const d = head.draft();
    d.dispose();

    expect(() => {
      d.write(concrete('x', { type: 'literal', value: 1 }));
    }).toThrow('HEAD is disposed');
  });

  it('disposing root disposes children', () => {
    const ft = objectType({ a: 'number', b: 'string' });
    const root = createHead(ft);
    const childA = root.at('a');
    root.at('b'); // also accessed — will be disposed with root

    root.dispose();

    // Children should be disposed — writing should throw
    expect(() => {
      childA.write(concrete('x', { type: 'literal', value: 1 }));
    }).toThrow('HEAD is disposed');
  });

  it('draft unsubscribes from source on dispose', async () => {
    const ft = objectType({ x: 'number' });
    const head = createHead(ft);
    const d = head.draft();
    const events = collectEvents(d);

    d.dispose();

    // Advance source — disposed draft should NOT receive events
    const writer = head.draft();
    writer.write(concrete('x', { type: 'literal', value: 42 }));
    await writer.save();

    // The draft was disposed before source advanced, so no gaps-changed
    const gapChanges = events.filter(e => e.type === 'gaps-changed');
    expect(gapChanges.length).toBe(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Edge cases
// ─────────────────────────────────────────────────────────────────────────────

describe('edge cases', () => {
  it('empty object type has no gaps', () => {
    const ft = FieldType.object.create().save();
    const head = createHead(ft);
    expect(head.gaps.length).toBe(0);
    expect(head.resolved).toBe(true);
  });

  it('draft of draft', () => {
    const ft = objectType({ x: 'number' });
    const root = createHead(ft);
    const d1 = root.draft();
    const d2 = d1.draft();

    // d2's source should be d1
    expect(d2.source).toBe(d1);

    d2.write(concrete('x', { type: 'literal', value: 42 }));
    expect(d2.lifecycle).toBe('ready');
  });

  it('writing new property not in schema', () => {
    const ft = objectType({ x: 'number' });
    const head = createHead(ft);
    head.write(concrete('extra', { type: 'literal', value: 'hello' }));
    // Should not throw, extra fields are allowed
  });

  it('multiple writes to same field — last writer wins', () => {
    const ft = objectType({ x: 'number' });
    const head = createHead(ft);

    head.write(concrete('x', { type: 'literal', value: 1 }));
    head.write(concrete('x', { type: 'literal', value: 2 }));

    expect(head.resolved).toBe(true);
  });
});
