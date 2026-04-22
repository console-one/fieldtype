/**
 * persistGrammar.test.ts — Integration test: HEAD persist constraint + async sinks.
 *
 * Verifies that save() properly:
 *   1. Awaits async sink functions (not fire-and-forget)
 *   2. Passes metadata (target, bindingName) to the sink
 *   3. Scope-level persist applies to all bindings
 *   4. Non-grammar values pass through unchanged (sink returns same ref)
 */

import { createHead } from '../head.js';
import { concrete, typed } from '../statement.js';
import { FieldType } from '../type.js';
import { ConstraintTypes } from '../constraint.js';

// ── Helpers ───────────────────────────────────────────────────────────

/** Build an object type with a scope-level persist constraint. */
function typeWithPersist(sinkName: string): FieldType {
  return FieldType.object.create()
    .persist(sinkName)
    .save();
}

// ── Async sink tests ──────────────────────────────────────────────────

describe('save() with async persist sink', () => {
  it('awaits an async sink function', async () => {
    const callLog: unknown[] = [];
    const asyncSink = async (value: unknown) => {
      // Simulate async work (e.g., disk I/O)
      await new Promise(resolve => setTimeout(resolve, 10));
      callLog.push(value);
      return `ref:${value}`;
    };

    const ft = typeWithPersist('mySink');
    const head = createHead(ft);

    // Bind the async sink
    head.write(concrete('mySink', typed(FieldType.function.create().save(), asyncSink)));

    // Write and save via draft
    const d = head.draft();
    d.write(concrete('key', { type: 'literal', value: 'hello' }));
    const result = await d.save();

    expect(result.ok).toBe(true);
    // The async sink was called and awaited
    expect(callLog).toEqual(['hello']);
    // Value was substituted with the sink's return value
    expect(head.value('key')).toBe('ref:hello');
  });

  it('passes metadata to the sink: target and bindingName', async () => {
    const receivedMeta: any[] = [];
    const sink = (value: unknown, meta?: any) => {
      receivedMeta.push(meta);
      return value; // return same ref → no replacement
    };

    const ft = typeWithPersist('mySink');
    const head = createHead(ft);
    head.write(concrete('mySink', typed(FieldType.function.create().save(), sink)));

    const d = head.draft();
    d.write(concrete('myPackage', { type: 'literal', value: { packageID: 'test' } }));
    await d.save();

    expect(receivedMeta).toHaveLength(1);
    expect(receivedMeta[0].bindingName).toBe('myPackage');
    // target is undefined for scope-level persist (no specific target)
    // it would be the string param if a property-level persist had target set
  });

  it('awaits an async transform + async sink', async () => {
    const order: string[] = [];
    const asyncTransform = async (v: unknown) => {
      order.push('transform');
      return `transformed:${v}`;
    };
    const asyncSink = async (v: unknown) => {
      order.push('sink');
      return v;
    };

    // Property-level persist with transform
    const keyFT = FieldType.string.create()
      .persist('mySink', { transform: 'myTransform' })
      .save();
    let ft = FieldType.object.create();
    (ft.attributes ??= []).push(ConstraintTypes.object.property.create('key', keyFT));
    ft = ft.save();

    const head = createHead(ft);
    head.write(concrete('mySink', typed(FieldType.function.create().save(), asyncSink)));
    head.write(concrete('myTransform', typed(FieldType.function.create().save(), asyncTransform)));

    const d = head.draft();
    d.write(concrete('key', { type: 'literal', value: 'raw' }));
    await d.save();

    expect(order).toEqual(['transform', 'sink']);
    // Sink returned the transformed value as-is, so it replaces the original
    expect(head.value('key')).toBe('transformed:raw');
  });

  it('scope-level persist: fires for every binding in the draft', async () => {
    const sinkCalls: string[] = [];
    const sink = (value: unknown, meta?: any) => {
      sinkCalls.push(meta?.bindingName ?? 'unknown');
      return value; // same ref → no replacement
    };

    const ft = typeWithPersist('mySink');
    const head = createHead(ft);
    head.write(concrete('mySink', typed(FieldType.function.create().save(), sink)));

    const d = head.draft();
    d.write(concrete('alpha', { type: 'literal', value: 'a' }));
    d.write(concrete('beta', { type: 'literal', value: 'b' }));
    d.write(concrete('gamma', { type: 'literal', value: 'c' }));
    await d.save();

    // All three bindings triggered the persist sink
    expect(sinkCalls).toContain('alpha');
    expect(sinkCalls).toContain('beta');
    expect(sinkCalls).toContain('gamma');
    expect(sinkCalls).toHaveLength(3);
  });

  it('sink returning same value reference: no chain replacement', async () => {
    const data = { packageID: 'test', blocks: [] };
    const sink = (value: unknown) => value; // same ref

    const ft = typeWithPersist('mySink');
    const head = createHead(ft);
    head.write(concrete('mySink', typed(FieldType.function.create().save(), sink)));

    const d = head.draft();
    d.write(concrete('pkg', { type: 'literal', value: data }));
    await d.save();

    // Value is the same object — no replacement pushed
    expect(head.value('pkg')).toBe(data);
  });

  it('sink not in scope: persist is inert', async () => {
    // Create type with persist referencing a sink that doesn't exist
    const ft = typeWithPersist('nonexistentSink');
    const head = createHead(ft);

    const d = head.draft();
    d.write(concrete('key', { type: 'literal', value: 'plain' }));
    const result = await d.save();

    expect(result.ok).toBe(true);
    // Value passes through unchanged — no sink to call
    expect(head.value('key')).toBe('plain');
  });
});
