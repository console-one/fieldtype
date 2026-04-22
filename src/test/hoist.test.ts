import { FieldType } from "../type.js";
import { types, validate } from "../builders.js";
import { HoistCompilerBuilder } from "@console-one/wire";
import {
  makeFieldTypeHoistHandler,
  FieldTypeHoistHandler,
  createFTCollector,
  ftStructuralKey,
} from "../hoist.js";

/* small helper: compute the structural key exactly like the handler */
const ftKey = (ft: FieldType) => ftStructuralKey(ft);

describe("Hoist compiler + FieldType handler", () => {
  it("hoists a complex object and its non-simple children; dedup + topo order child→parent", () => {
    // child #1 (non-simple): string with 2 constraints → hoisted
    const Id = FieldType.string.create().length({ min: 2 }).includes("x").save();

    // child #2 (non-simple): number with 2 constraints → hoisted
    const Age = FieldType.number.create().integer().min(0).save();

    // parent (object is non-simple by default) → hoisted
    const User = FieldType.object
      .create()
      .property("id", Id)
      .property("age", Age)
      .meta({ doc: "User record" })
      .save();

    const collector = createFTCollector({ metaKeys: ["notes"], merge: "array" });

    const { compileAll } = new HoistCompilerBuilder()
      .add(makeFieldTypeHoistHandler({ collector }))
      .build();

    const res = compileAll([User]);

    // We expect: 3 hoisted types (Id, Age, User) in the "type" bucket.
    const section = res.sections["type"] ?? [];
    expect(section.length).toBeGreaterThanOrEqual(3);

    const kId = ftKey(Id);
    const kAge = ftKey(Age);
    const kUser = ftKey(User);

    // Keys should exist exactly once (dedupe)
    const keys = section.map((h) => h.key);
    expect(keys.filter((k) => k === kId)).toHaveLength(1);
    expect(keys.filter((k) => k === kAge)).toHaveLength(1);
    expect(keys.filter((k) => k === kUser)).toHaveLength(1);

    // Topological order: child definitions appear before the parent using them
    const pos = (k: string) => section.findIndex((h) => h.key === k);
    expect(pos(kId)).toBeGreaterThanOrEqual(0);
    expect(pos(kAge)).toBeGreaterThanOrEqual(0);
    expect(pos(kUser)).toBeGreaterThanOrEqual(0);
    expect(pos(kId)).toBeLessThan(pos(kUser));
    expect(pos(kAge)).toBeLessThan(pos(kUser));

    // The parent hoisted body should reference children by name (not inline).
    const userDef = section.find((h) => h.key === kUser)!;
    const idDef = section.find((h) => h.key === kId)!;
    const ageDef = section.find((h) => h.key === kAge)!;
    expect(userDef.body).toContain(idDef.name);
    expect(userDef.body).toContain(ageDef.name);

    // Doc string (from metadata.doc) should be carried over
    expect(userDef.doc).toBe("User record");

    // The compiled body of roots should reference the hoisted user symbol
    expect(res.body).toContain(userDef.name);
  });

  it("inlines simple types by default but still aggregates metadata for those inlined nodes", () => {
    // Simple: single constraint → inline by default handler
    const Tag = FieldType.string.create().includes("#").meta({ notes: ["hashtags only"] }).save();

    const collector = createFTCollector({ metaKeys: ["notes"], merge: "array" });

    const { compileAll } = new HoistCompilerBuilder()
      .add(makeFieldTypeHoistHandler({ collector }))
      .build();

    const res = compileAll([Tag]);

    // No hoisted types expected for a simple string
    const section = res.sections["type"] ?? [];
    expect(section.length).toBe(0);

    // Inline formatting should appear in the root body (CUE-style constraint)
    expect(res.body).toContain('has("#")');

    // Aggregation must include Tag's notes even though it was inlined
    const agg = collector.result();
    expect(Array.isArray(agg.notes)).toBe(true);
    expect(agg.notes).toContain("hashtags only");
  });

  it("custom isSimple override can force hoisting everything (incl. simple types)", () => {
    const S = FieldType.string.create().includes("x").save();

    const { compileAll } = new HoistCompilerBuilder()
      .add(makeFieldTypeHoistHandler({ isSimple: () => false }))
      .build();

    const res = compileAll([S]);
    const section = res.sections["type"] ?? [];
    expect(section.length).toBeGreaterThanOrEqual(1);

    // Definition exists and looks like a string with has() constraint
    const key = ftKey(S);
    const def = section.find((h) => h.key === key)!;
    expect(def).toBeTruthy();
    expect(def.body).toContain('has("x")');

    // Root body should reference the hoisted symbol name rather than inline
    expect(res.body).toContain(def.name);
  });

  it("refName transform is honored for references to hoisted children", () => {
    // Non-simple child
    const Child = FieldType.number.create().integer().min(1).save();
    // Non-simple parent (object)
    const Parent = FieldType.object.create().property("n", Child).save();

    const { compileAll } = new HoistCompilerBuilder()
      .add(
        makeFieldTypeHoistHandler({
          // Prefix references with FT_ but keep def names normal
          refName: (_ft, assigned) => `FT_${assigned}`,
        }),
      )
      .build();

    const res = compileAll([Parent]);
    const section = res.sections["type"] ?? [];

    const kChild = ftKey(Child);
    const kParent = ftKey(Parent);

    const dChild = section.find((h) => h.key === kChild)!;
    const dParent = section.find((h) => h.key === kParent)!;

    // In the *parent definition body*, references to child should be rewritten via refName
    expect(dParent.body).toContain(`FT_${dChild.name}`);

    // The definitions themselves keep the assigned names (no FT_ prefix in the def header)
    expect(dChild.name.startsWith("FT_")).toBe(false);
    expect(dParent.name.startsWith("FT_")).toBe(false);

    // Body (roots) references the hoisted parent symbol as-is
    expect(res.body).toContain(dParent.name);
  });

  it("dedupes across multiple roots and records dependencies for topo order", () => {
    const ComplexStr = FieldType.string.create().length({ min: 2 }).includes("z").save();
    const A = FieldType.object.create().property("s", ComplexStr).save();
    const B = FieldType.object.create().property("t", ComplexStr).save();

    const { compileAll } = new HoistCompilerBuilder()
      .add(FieldTypeHoistHandler)
      .build();

    const res = compileAll([A, B]);
    const section = res.sections["type"] ?? [];

    const kS = ftKey(ComplexStr);
    const kA = ftKey(A);
    const kB = ftKey(B);

    // ComplexStr appears only once even though used twice
    expect(section.filter((h) => h.key === kS)).toHaveLength(1);

    const defS = section.find((h) => h.key === kS)!;
    const defA = section.find((h) => h.key === kA)!;
    const defB = section.find((h) => h.key === kB)!;

    // Parents depend on the shared child
    expect(defA.deps ?? []).toContain(kS);
    expect(defB.deps ?? []).toContain(kS);

    // Child placed before both parents
    const idx = (k: string) => section.findIndex((h) => h.key === k);
    expect(idx(kS)).toBeLessThan(idx(kA));
    expect(idx(kS)).toBeLessThan(idx(kB));
  });

  it("tuple/array/object formatting uses tryCompile(child) so hoisted names show up (not full inline)", () => {
    // Force children non-simple
    const S = FieldType.string.create().length({ min: 2 }).includes("x").save();
    const N = FieldType.number.create().integer().min(0).save();
    const Tup = types.tuple(S, N); // array form (non-simple) → hoisted

    const { compileAll } = new HoistCompilerBuilder()
      .add(FieldTypeHoistHandler)
      .build();

    const res = compileAll([Tup]);
    const section = res.sections["type"] ?? [];

    const kS = ftKey(S);
    const kN = ftKey(N);
    const kT = ftKey(Tup);

    const dS = section.find((h) => h.key === kS)!;
    const dN = section.find((h) => h.key === kN)!;
    const dT = section.find((h) => h.key === kT)!;

    // The tuple body should reference child names (not fully inline bodies)
    expect(dT.body).toContain(dS.name);
    expect(dT.body).toContain(dN.name);

    // round-trip smoke: ensure original tuple still validates ["xx", 1]
    expect(validate(Tup, ["xx", 1]).status).toBe("valid");
  });

  it("aggregation modes: 'array' dedups values; 'object' shallow merges", () => {
    const U1 = FieldType.string.create().meta({ notes: ["n1"], perm: { a: true } }).save();
    const U2 = FieldType.string.create().meta({ notes: ["n1", "n2"], perm: { b: 3 } }).save();

    // Collect both notes (array-merge dedup) and perm (object merge)
    const collector = createFTCollector({ metaKeys: ["notes", "perm"], merge: "array" });
    const handler = makeFieldTypeHoistHandler({ collector });

    // NB: We'll run a second pass for 'object' merge on perm (shallow)
    const collector2 = createFTCollector({ metaKeys: ["perm"], merge: "object" });
    const handler2 = makeFieldTypeHoistHandler({ collector: collector2 });

    const { compileAll: run1 } = new HoistCompilerBuilder().add(handler).build();
    run1([U1, U2]); // visit

    const agg1 = collector.result();
    expect(agg1.notes).toEqual(["n1", "n2"]); // dedup + union
    // perm is not merged in this pass (array mode) – ignored or last, we don't assert

    const { compileAll: run2 } = new HoistCompilerBuilder().add(handler2).build();
    run2([U1, U2]);

    const agg2 = collector2.result();
    // shallow-merge → { a: true, b: 3 }
    expect(agg2.perm).toEqual({ a: true, b: 3 });
  });
});
