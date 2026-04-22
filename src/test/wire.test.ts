import { djb2, WireRegistry } from "@console-one/wire";
import { ConstraintTypes } from "../constraint.js";
import { FieldType } from "../type.js";
import { types, validate } from "../builders.js";
import { FTAdapter, FTAdapterSnapshot } from "@console-one/wire";

describe("key()", () => {
  it("produces a stable djb2 key over JSON.stringify(ft)", () => {
    const ft = FieldType.string.create().length({ min: 1 }).save();
    const expected = "ft:" + djb2(JSON.stringify(ft));
    expect(FTAdapter.key!(ft)).toBe(expected);
  });
});

describe("deps()", () => {
  it("collects object children: property, index.value, index.when, and additional (when present)", () => {
    const propChild = FieldType.string.create();
    const indexValue = FieldType.object.create().property("id", FieldType.string.create()).save();
    const whenGuard = FieldType.number.create().min(0).save();
    const additional = FieldType.number.create();

    const obj = FieldType.object
      .create()
      .property("name", propChild)
      .indexBy("id", indexValue, { key: /^usr_/, when: whenGuard })
      .additional(additional)
      .save();

    const deps = FTAdapter.deps!(obj) as any[];

    // We don't rely on identity, just presence of respective fieldtypes.
    expect(deps.some((d: any) => FieldType.string.describes(d))).toBe(true);       // property 'name'
    expect(deps.some((d: any) => FieldType.object.describes(d))).toBe(true);       // index.value
    expect(deps.some((d: any) => FieldType.number.describes(d))).toBe(true);       // index.when or additional
    // Ensure we actually got at least 3 deps (name, index.value, index.when/additional)
    expect(deps.length).toBeGreaterThanOrEqual(3);
  });

  it("collects array children: values.value and contains.value (when present)", () => {
    const elt = FieldType.string.create();
    const contains = FieldType.number.create();

    // Build via low-level create to inject a 'contains' constraint alongside 'values'
    const arr: any = FieldType.create("array", [
      ConstraintTypes.array.values.create(elt),
      ConstraintTypes.array.contains.create(contains),
    ]);

    const deps = FTAdapter.deps!(arr) as any[];
    expect(deps.some((d: any) => FieldType.string.describes(d))).toBe(true); // from values
    expect(deps.some((d: any) => FieldType.number.describes(d))).toBe(true); // from contains
  });

  it("returns children of or/and/not nodes", () => {
    const a = FieldType.string.create();
    const b = FieldType.number.create();
    const or = FieldType.or.create([a, b]);
    const and = FieldType.and.create([a, b]);
    const not = FieldType.not.create(a);

    const orDeps = FTAdapter.deps!(or);
    const andDeps = FTAdapter.deps!(and);
    const notDeps = FTAdapter.deps!(not);

    expect(orDeps.length).toBe(2);
    expect(andDeps.length).toBe(2);
    expect(notDeps.length).toBe(1);
  });
});

describe("toJSON()/fromJSON()", () => {
  
  it("encodes object.property/value and object.index (value+when) as {$ref}, normalizes RegExp key to string", () => {
    const child = FieldType.string.create().length({ min: 2 }).save();
    const ixValue = FieldType.object.create().property("id", FieldType.string.create()).save();
    const whenGuard = FieldType.number.create().integer().save();

    const obj = FieldType.object
      .create()
      .property("name", child)
      .indexBy("id", ixValue, { key: /^usr_/, when: whenGuard })
      .save();

    const refs: { id: string; node: any }[] = [];
    const ref = (n: any) => {
      const id = `k${refs.length + 1}`;
      refs.push({ id, node: n });
      return { $ref: id };
    };

    const json = FTAdapterSnapshot.toJSON(obj, ref) as any;
    const state = json.events[0];
    expect(state.eventtype).toBe("state");
    expect(state.fieldtype).toBe("object");
    
    
    const propAttr = (state.attributes as any[]).find(ConstraintTypes.object.property.describes)!;
    expect(propAttr.value && propAttr.value.$ref).toBeDefined();
    
    const idxAttr = (state.attributes as any[]).find(ConstraintTypes.object.index.describes)!;
    expect(idxAttr.value && idxAttr.value.$ref).toBeDefined();
    expect(idxAttr.when && idxAttr.when.$ref).toBeDefined();
    expect(typeof idxAttr.key).toBe("string");
    
    // Decode back (events-in, events-out)
    const map = new Map(refs.map(({ id, node }) => [id, node]));
    const decoded = FTAdapter.fromJSON(json, (k: string) => map.get(k)) as any;

    expect(decoded.fieldtype).toBe("object");
    const dProp = decoded.attributes.find(ConstraintTypes.object.property.describes);
    expect(FieldType.string.describes(dProp.value)).toBe(true);
    const dIdx = decoded.attributes.find(ConstraintTypes.object.index.describes);
    expect(FieldType.object.describes(dIdx.value)).toBe(true);
    expect(FieldType.number.describes(dIdx.when)).toBe(true);
  });

  it("encodes array.values and array.accumulate value as {$ref}; tuple round-trip smoke", () => {
    const t = types.tuple(types.string(), types.number().integer().save());
    // enforce min==max==2 already set by tuple(); values entries exist for index 0 and 1
    const refs: { id: string; node: any }[] = [];
    const ref = (n: any) => {
      const id = `k${refs.length + 1}`;
      refs.push({ id, node: n });
      return { $ref: id };
    };

   
    const json = FTAdapter.toJSON(t, ref) as any;
    const state = json.events[0];
    expect(state.fieldtype).toBe("array");

    const vals = (state.attributes as any[]).filter(
      (a: any) => a.basetype === "array" && a.constrainttype === "values",
    );
    const acc = (state.attributes as any[]).find(
      (a: any) => a.basetype === "array" && a.constrainttype === "accumulate",
    );

    vals.forEach((v: any) => {
      expect(v.value && v.value.$ref).toBeDefined();
    });
    if (acc?.value) expect(acc.value.$ref).toBeDefined();

    // Round-trip
    const map = new Map(refs.map(({ id, node }) => [id, node]));
    const decoded = FTAdapter.fromJSON(json, (k: string) => map.get(k)) as any;
    expect(decoded.fieldtype).toBe("array");
    const dVals = (decoded.attributes as any[]).filter(
      (a: any) => a.basetype === "array" && a.constrainttype === "values",
    );
    expect(dVals.length).toBeGreaterThanOrEqual(2);
    dVals.forEach((v: any) => {
      expect(v.value).toBeDefined();
    });

    // quick validation smoke: our tuple accepts ["x", 1]
    expect(validate(t, ["x", 1]).status).toBe("valid");
  });

  it("passes through array.contains without $ref (by design in current adapter), but still discoverable via deps()", () => {
    const containsChild = FieldType.number.create().min(0).save();
    const arr: any = FieldType.create("array", [
      ConstraintTypes.array.contains.create(containsChild),
    ]);

    const refs: { id: string; node: any }[] = [];
    const ref = (n: any) => {
      const id = `k${refs.length + 1}`;
      refs.push({ id, node: n });
      return { $ref: id };
    };

    const json = FTAdapter.toJSON(arr, ref) as any;
    const state = json.events[0];
    const contains = (state.attributes as any[]).find(
      (a: any) => a.basetype === "array" && a.constrainttype === "contains",
    ) as any;

    // Still not hoisted to $ref by design:
    expect(contains.value && contains.value.$ref).toBeUndefined();

    // deps() still exposes the child:
    const deps = FTAdapter.deps!(arr);
    expect(deps.length).toBe(1);
    expect(FieldType.number.describes(deps[0])).toBe(true);


  });

  it("preserves node.metadata in toJSON / fromJSON", () => {

    const ft = FieldType.string.create().meta({ ui: { label: "Name" } }).save();
    const json = FTAdapterSnapshot.toJSON(ft, () => ({ $ref: "ignored" })) as any;

    const state = json.events[0];            // a single creation event
    expect(state.eventtype).toBe("state");
    expect(state.metadata).toEqual({ ui: { label: "Name" } });

    const round = FTAdapterSnapshot.fromJSON(json, () => null) as any;
    expect(round.metadata).toEqual({ ui: { label: "Name" } });
    expect(round.fieldtype).toBe("string");

  });
});


describe("FTAdapter (wire) – event round-trip, chain mode", () => {

  it("bundle/unbundle includes full event chain and reconstructs preserving metadata", () => {
   
    let t = FieldType.string.create().length({ min: 2 }).save();
    t = t.includes("x").meta({ patch: 1 }).save();
    t = t.meta({ audit: true }).save();

    const evs = t.toEvents();
    expect(evs.length > 1).toBe(true);

    const reg = new WireRegistry([FTAdapter]); // chain
    const bundle = reg.bundle([t]);

    const rootKey = bundle.roots[0];
    const rec = bundle.table[rootKey];


    expect(rec.nodeType).toBe("fieldtype");
    expect(Array.isArray((rec.data as any).events)).toBe(true);
    expect((rec.data as any).events.length > 1).toBe(true);

    const [rebuilt] = reg.unbundle(bundle) as [typeof t];
    expect(FieldType.string.describes(rebuilt)).toBe(true);

    expect(rebuilt.metadata).toEqual({ patch: 1, audit: true });

    expect(validate(rebuilt, "xx")).toEqual({ status: "valid" });
    expect(validate(rebuilt, "x")).toEqual({
      status: "invalid",
      errors: expect.any(Array),
    });
  });
});


describe("FTAdapter (wire) – snapshot mode", () => {
  it("serializes a single creation event representing the current state", () => {
    let t = FieldType.string.create().length({ min: 2 }).save();
    t = t.includes("x").meta({ a: 1 }).save();
    t = t.meta({ a: 2, b: 3 }).save(); // effective meta: { a: 2, b: 3 }

    const reg = new WireRegistry([FTAdapterSnapshot]); // snapshot
    const bundle = reg.bundle([t]);

    const rootKey = bundle.roots[0];
    const rec = bundle.table[rootKey];

    expect(rec.nodeType).toBe("fieldtype");
    const events = (rec.data as any).events;
    expect(Array.isArray(events)).toBe(true);
    expect(events.length).toBe(1);           // ← single state event
    expect(events[0].eventtype).toBe("state");
    expect(events[0].fieldtype).toBe("string");
    // Rolled-up metadata
    expect(events[0].metadata).toEqual({ a: 2, b: 3 });

    const [rebuilt] = reg.unbundle(bundle) as [typeof t];
    expect(FieldType.string.describes(rebuilt)).toBe(true);
    expect(rebuilt.metadata).toEqual({ a: 2, b: 3 });

    // Behavior identical to original
    expect(validate(rebuilt, "xx").status).toBe("valid");
    expect(validate(rebuilt, "x").status).toBe("invalid");
  });
});