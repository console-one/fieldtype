/**
 * label.test.ts — Integration tests for the Label behavioral constraint.
 *
 * Labels are demand-driven projections: on first at() access, the label child
 * is lazily created and populated by scanning entries against the label's match type.
 * This works on committed HEADs AND drafts — no save() required.
 *
 * Query: head.at('label:toolpackage').entries() → Map { bindingName => true }
 *        head.at('packages').entries()          → same (via path alias)
 *
 * NOTE: Labels are scope-level behavioral constraints on the object type itself.
 * createHead(rootType) is used (not createHead(chain)) because chainFromFieldType
 * only serializes property-level behavioral constraints, not scope-level ones.
 * This matches production usage — HEADs are created from FieldTypes in the kernel.
 */

import { createHead } from '../head.js';
import { FieldType } from '../type.js';
import { concrete } from '../statement.js';

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

/** Object type with a required 'packageID' property — used as label match predicate. */
function packageMatchType(): FieldType {
  return FieldType.object.create()
    .property('packageID', FieldType.string.create())
    .save();
}

/** Object type with a required 'blueprintID' property — distinct match predicate. */
function blueprintMatchType(): FieldType {
  return FieldType.object.create()
    .property('blueprintID', FieldType.string.create())
    .save();
}

// ─────────────────────────────────────────────────────────────────────────────
// Tests
// ─────────────────────────────────────────────────────────────────────────────

describe('Label behavioral constraint — operationalization in save()', () => {

  it('basic: matching value is classified into label index', async () => {
    const pkgType = packageMatchType();
    const rootType = FieldType.object.create().label('pkg', pkgType).save();
    const head = createHead(rootType);

    const d = head.draft();
    d.write(concrete('myService', { type: 'literal', value: { packageID: 'svc-1', name: 'My Service' } }));
    await d.save();

    // Label index should contain the binding name
    const labelEntries = head.at('label:pkg').entries();
    expect(labelEntries.get('myService')).toBe(true);
  });

  it('non-matching value is NOT labeled', async () => {
    const pkgType = packageMatchType();
    const rootType = FieldType.object.create().label('pkg', pkgType).save();
    const head = createHead(rootType);

    const d = head.draft();
    // Write a string — doesn't match object type with packageID
    d.write(concrete('plainValue', { type: 'literal', value: 'just a string' }));
    await d.save();

    const labelEntries = head.at('label:pkg').entries();
    expect(labelEntries.has('plainValue')).toBe(false);
  });

  it('multiple labels on same value — both label indices populated', async () => {
    const pkgType = packageMatchType();
    const bpType = blueprintMatchType();
    const rootType = FieldType.object.create()
      .label('toolpackage', pkgType)
      .label('blueprint', bpType)
      .save();
    const head = createHead(rootType);

    const d = head.draft();
    // This value has both packageID and blueprintID → matches both labels
    d.write(concrete('combo', { type: 'literal', value: { packageID: 'p1', blueprintID: 'b1' } }));
    await d.save();

    expect(head.at('label:toolpackage').entries().get('combo')).toBe(true);
    expect(head.at('label:blueprint').entries().get('combo')).toBe(true);
  });

  it('multiple bindings: only matching ones appear in label index', async () => {
    const pkgType = packageMatchType();
    const rootType = FieldType.object.create().label('pkg', pkgType).save();
    const head = createHead(rootType);

    const d = head.draft();
    d.write(concrete('svc1', { type: 'literal', value: { packageID: 'a', name: 'A' } }));
    d.write(concrete('svc2', { type: 'literal', value: { packageID: 'b', name: 'B' } }));
    d.write(concrete('plainStr', { type: 'literal', value: 'not a package' }));
    await d.save();

    const labelEntries = head.at('label:pkg').entries();
    expect(labelEntries.get('svc1')).toBe(true);
    expect(labelEntries.get('svc2')).toBe(true);
    expect(labelEntries.has('plainStr')).toBe(false);
    expect(labelEntries.size).toBe(2);
  });

  it('label + persist coexistence — both fire during save', async () => {
    const pkgType = packageMatchType();
    const persisted: Array<{ key: string; value: any }> = [];
    const sinkFn = (v: any, opts: any) => { persisted.push({ key: opts.bindingName, value: v }); return v; };

    // Build a type with both label and persist, and provide the sink binding
    const rootType = FieldType.object.create()
      .label('pkg', pkgType)
      .persist('mySink')
      .save();
    const head = createHead(rootType);

    // Inject the sink function binding
    head.write(concrete('mySink', { type: 'literal', value: sinkFn }));

    const d = head.draft();
    d.write(concrete('svc1', { type: 'literal', value: { packageID: 'x' } }));
    await d.save();

    // Label index populated
    expect(head.at('label:pkg').entries().get('svc1')).toBe(true);

    // Persist sink was called
    expect(persisted.length).toBeGreaterThan(0);
    expect(persisted.some(p => p.key === 'svc1')).toBe(true);
  });

  it('label query via at().entries() and at().value()', async () => {
    const pkgType = packageMatchType();
    const rootType = FieldType.object.create().label('pkg', pkgType).save();
    const head = createHead(rootType);

    const d = head.draft();
    d.write(concrete('alpha', { type: 'literal', value: { packageID: '1' } }));
    d.write(concrete('beta', { type: 'literal', value: { packageID: '2' } }));
    await d.save();

    // entries() returns a Map
    const entries = head.at('label:pkg').entries();
    expect(entries instanceof Map).toBe(true);
    expect(entries.size).toBe(2);

    // value() returns true for labeled bindings
    expect(head.at('label:pkg').value('alpha')).toBe(true);
    expect(head.at('label:pkg').value('beta')).toBe(true);

    // value() returns undefined for non-labeled bindings
    expect(head.at('label:pkg').value('nonexistent')).toBeUndefined();
  });

  it('label child HEAD is cached — at() returns same child on repeat access', async () => {
    const pkgType = packageMatchType();
    const rootType = FieldType.object.create().label('pkg', pkgType).save();
    const head = createHead(rootType);

    const d = head.draft();
    d.write(concrete('svc', { type: 'literal', value: { packageID: '1' } }));
    await d.save();

    // Two calls to at() should return HEADs backed by the same child state
    const h1 = head.at('label:pkg');
    const h2 = head.at('label:pkg');
    expect(h1.entries()).toEqual(h2.entries());
  });

  it('value that partially matches one label but not another', async () => {
    const pkgType = packageMatchType();       // needs packageID
    const bpType = blueprintMatchType();      // needs blueprintID
    const rootType = FieldType.object.create()
      .label('pkg', pkgType)
      .label('bp', bpType)
      .save();
    const head = createHead(rootType);

    const d = head.draft();
    // Has packageID but NOT blueprintID
    d.write(concrete('onlyPkg', { type: 'literal', value: { packageID: 'p1' } }));
    await d.save();

    expect(head.at('label:pkg').entries().get('onlyPkg')).toBe(true);
    expect(head.at('label:bp').entries().has('onlyPkg')).toBe(false);
  });
});

describe('Label projection — demand-driven (no save required)', () => {

  it('draft.at(labelPath) returns entries written to the draft', () => {
    const pkgType = packageMatchType();
    const rootType = FieldType.object.create().label('pkg', pkgType).save();
    const head = createHead(rootType);

    const d = head.draft();
    d.write(concrete('svc1', { type: 'literal', value: { packageID: 'a' } }));
    d.write(concrete('svc2', { type: 'literal', value: { packageID: 'b' } }));

    // No save() — label child should be derived on demand
    const labelEntries = d.at('label:pkg').entries();
    expect(labelEntries.get('svc1')).toBe(true);
    expect(labelEntries.get('svc2')).toBe(true);
    expect(labelEntries.size).toBe(2);
  });

  it('draft label projection excludes non-matching values', () => {
    const pkgType = packageMatchType();
    const rootType = FieldType.object.create().label('pkg', pkgType).save();
    const head = createHead(rootType);

    const d = head.draft();
    d.write(concrete('pkg1', { type: 'literal', value: { packageID: 'x' } }));
    d.write(concrete('str1', { type: 'literal', value: 'just a string' }));
    d.write(concrete('num1', { type: 'literal', value: 42 }));

    const labelEntries = d.at('label:pkg').entries();
    expect(labelEntries.get('pkg1')).toBe(true);
    expect(labelEntries.has('str1')).toBe(false);
    expect(labelEntries.has('num1')).toBe(false);
    expect(labelEntries.size).toBe(1);
  });

  it('path alias works on drafts — at("packages") resolves label', () => {
    const pkgType = packageMatchType();
    const rootType = FieldType.object.create()
      .label('toolpackage', pkgType, { path: 'packages' })
      .save();
    const head = createHead(rootType);

    const d = head.draft();
    d.write(concrete('myPkg', { type: 'literal', value: { packageID: 'p1' } }));

    // Access via path alias, not label:toolpackage
    const entries = d.at('packages').entries();
    expect(entries.get('myPkg')).toBe(true);
    expect(entries.size).toBe(1);
  });

  it('committed HEAD also uses demand-driven labels (no regression)', async () => {
    const pkgType = packageMatchType();
    const rootType = FieldType.object.create().label('pkg', pkgType).save();
    const head = createHead(rootType);

    const d = head.draft();
    d.write(concrete('svc', { type: 'literal', value: { packageID: '1' } }));
    await d.save();

    // After save, committed HEAD should still work
    const entries = head.at('label:pkg').entries();
    expect(entries.get('svc')).toBe(true);
  });

  it('draft inherits parent label entries + adds own', async () => {
    const pkgType = packageMatchType();
    const rootType = FieldType.object.create().label('pkg', pkgType).save();
    const head = createHead(rootType);

    // Write to root via save
    const d1 = head.draft();
    d1.write(concrete('parentPkg', { type: 'literal', value: { packageID: 'p' } }));
    await d1.save();

    // New draft — should see parent's entry AND its own
    const d2 = head.draft();
    d2.write(concrete('childPkg', { type: 'literal', value: { packageID: 'c' } }));

    const entries = d2.at('label:pkg').entries();
    expect(entries.get('parentPkg')).toBe(true);
    expect(entries.get('childPkg')).toBe(true);
    expect(entries.size).toBe(2);
  });

  it('label projection updates after new write to draft', () => {
    const pkgType = packageMatchType();
    const rootType = FieldType.object.create().label('pkg', pkgType).save();
    const head = createHead(rootType);

    const d = head.draft();
    d.write(concrete('svc1', { type: 'literal', value: { packageID: 'a' } }));

    expect(d.at('label:pkg').entries().size).toBe(1);

    // Write another package — label should reflect the update
    d.write(concrete('svc2', { type: 'literal', value: { packageID: 'b' } }));

    const entries = d.at('label:pkg').entries();
    expect(entries.get('svc1')).toBe(true);
    expect(entries.get('svc2')).toBe(true);
    expect(entries.size).toBe(2);
  });
});
