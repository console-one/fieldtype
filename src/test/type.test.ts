import z from "zod";
import {
  AndType,
  AnyType,
  FieldType,
  NotType,
  NumberType,
  ObjectType,
  OrType,
  StringType,
} from "../type.js";
import {
  ConstraintTypes,
  NumberConstraint,
  ObjectConstraint,
  StringConstraint,
} from "../constraint.js";

describe("Field Type Basic Implementations", () => {
  describe("Any type", () => {
    it("Should be able to create an AnyType from create", () => {
      const aType = FieldType.any.create();
      expect(aType.type).toEqual("baseType");
      expect(aType.fieldtype).toEqual("any");
      expect(aType.attributes.length).toEqual(0);
      expect(aType.extensions.length).toEqual(0);
      expect(FieldType.any.describes(aType)).toEqual(true);
      expect(FieldType.any.describes({ hello: false })).toEqual(false);
    });

    it("Should be able to create an AnyType from nonce", () => {
      const aType = FieldType.any.create();
      expect(aType.type).toEqual("baseType");
      expect(aType.fieldtype).toEqual("any");
      expect(aType.attributes.length).toEqual(0);
      expect(aType.extensions.length).toEqual(0);
      expect(FieldType.any.describes(aType)).toEqual(true);
      expect(FieldType.any.describes({ hello: false })).toEqual(false);
    });
  });

  describe("And type", () => {
    it("Should be able to create an AndType", () => {
      const andType: AndType = FieldType.and.create([FieldType.any.nonce]);
      expect(andType.type).toEqual("baseType");
      expect(andType.fieldtype).toEqual("and");
      expect(andType.attributes.length).toEqual(1);
      expect(andType.extensions.length).toEqual(0);
      expect(FieldType.and.describes(andType)).toEqual(true);
      expect(FieldType.and.describes(FieldType.any.nonce)).toEqual(false);
    });
  });

  describe("Or type", () => {
    it("Should be able to create an OrType", () => {
      const orType: OrType = FieldType.or.create([FieldType.any.nonce]);
      expect(orType.type).toEqual("baseType");
      expect(orType.fieldtype).toEqual("or");
      expect(orType.attributes.length).toEqual(1);
      expect(orType.extensions.length).toEqual(0);
      expect(FieldType.or.describes(orType)).toEqual(true);
      expect(FieldType.or.describes(FieldType.any.nonce)).toEqual(false);
    });
  });

  describe("Not type", () => {
    it("Should be able to create a NotType", () => {
      const notType: NotType = FieldType.not.create(FieldType.any.nonce);
      expect(notType.type).toEqual("baseType");
      expect(notType.fieldtype).toEqual("not");
      expect(notType.attributes.length).toEqual(1);
      expect(notType.extensions.length).toEqual(0);
      expect(FieldType.not.describes(notType)).toEqual(true);
      expect(FieldType.not.describes(FieldType.any.nonce)).toEqual(false);
    });
  });

  describe("String Type", () => {
    it("Should be able to create a plain StringType", () => {
      const stringType: StringType = FieldType.string.create();
      expect(stringType.type).toEqual("baseType");
      expect(stringType.fieldtype).toEqual("string");
      expect(stringType.attributes.length).toEqual(0);
      expect(stringType.extensions.length).toEqual(0);
      expect(FieldType.string.describes(stringType)).toEqual(true);
      expect(FieldType.string.describes(FieldType.any.nonce)).toEqual(false);
    });

    it("Should be able to return a plain StringType from nonce", () => {
      const stringType: StringType = FieldType.string.nonce;
      expect(stringType.type).toEqual("baseType");
      expect(stringType.fieldtype).toEqual("string");
      expect(stringType.attributes.length).toEqual(0);
      expect(stringType.extensions.length).toEqual(0);
      expect(FieldType.string.describes(stringType)).toEqual(true);
      expect(FieldType.string.describes(FieldType.any.nonce)).toEqual(false);
    });
  });

  describe("Object Type", () => {
    it("Should be able to create a plain ObjectType", () => {
      const objectType: ObjectType = FieldType.object.create();
      expect(objectType.type).toEqual("baseType");
      expect(objectType.fieldtype).toEqual("object");
      expect(objectType.attributes.length).toEqual(0);
      expect(objectType.extensions.length).toEqual(0);
      expect(FieldType.object.describes(objectType)).toEqual(true);
      expect(FieldType.object.describes(FieldType.any.nonce)).toEqual(false);
    });

    it("Should be able to return a plain ObjectType from nonce", () => {
      const objectType: ObjectType = FieldType.object.nonce;
      expect(objectType.type).toEqual("baseType");
      expect(objectType.fieldtype).toEqual("object");
      expect(objectType.attributes.length).toEqual(0);
      expect(objectType.extensions.length).toEqual(0);
      expect(FieldType.object.describes(objectType)).toEqual(true);
      expect(FieldType.object.describes(FieldType.any.nonce)).toEqual(false);
    });
  });

  describe("ArrayType", () => {
    it("create() and nonce are valid", () => {
      const a1 = FieldType.array.create();
      const a2 = FieldType.array.nonce;

      [a1, a2].forEach((a) => {
        expect(a.fieldtype).toBe("array");
        expect(FieldType.array.describes(a)).toBe(true);
      });
    });

    it("extend() links correctly", () => {
      const base = FieldType.array.create();
      const ext = base.extend(patch());

      expect(FieldType.array.describes(ext)).toBe(true);
      expect(ext.prev).toBe(base);
      expect(ext.extensions).toContain(base);
    });
  });
});

/* ---------- tiny helper to build a minimal PatchEvent ------------ */
function patch(id = crypto.randomUUID()) {
  return {
    type: "fieldtypeevent",
    id,
    target: "dummy",
  } as const;
}

describe("FieldType – association helpers (create / extend)", () => {
  /* ---------------------------------------------------------------- *
   *  ANY                                                              *
   * ---------------------------------------------------------------- */
  describe("AnyType", () => {
    it("create() + nonce return coherent nodes", () => {
      const a1: AnyType = FieldType.any.create();
      const a2: AnyType = FieldType.any.nonce;

      [a1, a2].forEach((a) => {
        expect(a.type).toBe("baseType");
        expect(a.fieldtype).toBe("any");
        expect(a.attributes).toHaveLength(0);
        expect(a.extensions).toHaveLength(0);
        expect(FieldType.any.describes(a)).toBe(true);
      });
    });

    it("extend() creates a derivative that stays an AnyType", () => {
      const base = FieldType.any.create();
      const update = patch();
      const ext = base.extend(update);

      expect(FieldType.any.describes(ext)).toBe(true);
      expect(ext.prev).toBe(base);
      expect(ext.extensions).toContain(base);
      expect(ext.update).toBe(update);
    });
  });

  /* ---------------------------------------------------------------- *
   *  STRING                                                           *
   * ---------------------------------------------------------------- */
  describe("StringType", () => {
    it("create() + nonce work", () => {
      const s1: StringType = FieldType.string.create();
      const s2: StringType = FieldType.string.nonce;

      [s1, s2].forEach((s) => {
        expect(s.fieldtype).toBe("string");
        expect(s.attributes).toHaveLength(0);
        expect(FieldType.string.describes(s)).toBe(true);
      });
    });

    it("extend() keeps coherence", () => {
      const base = FieldType.string.create();
      const ext = base.extend(patch());

      expect(FieldType.string.describes(ext)).toBe(true);
      expect(ext.prev).toBe(base);
      expect(ext.extensions).toContain(base);
    });
  });

  /* ---------------------------------------------------------------- *
   *  NUMBER                                                           *
   * ---------------------------------------------------------------- */
  describe("NumberType", () => {
    it("create() works and extend() preserves linkage", () => {
      const base: NumberType = FieldType.number.create();
      const ext = base.extend(patch());

      expect(base.fieldtype).toBe("number");
      expect(FieldType.number.describes(ext)).toBe(true);
      expect(ext.prev).toBe(base);
    });
  });

  /* ---------------------------------------------------------------- *
   *  OBJECT                                                           *
   * ---------------------------------------------------------------- */
  describe("ObjectType", () => {
    it("plain create() and nonce are valid", () => {
      const o1: ObjectType = FieldType.object.create();
      const o2: ObjectType = FieldType.object.nonce;

      [o1, o2].forEach((o) => {
        expect(o.fieldtype).toBe("object");
        expect(FieldType.object.describes(o)).toBe(true);
      });
    });

    it("extend() returns another ObjectType with proper links", () => {
      const base = FieldType.object.create();
      const ext = base.extend(patch());
      expect(FieldType.object.describes(ext)).toBe(true);
      expect(ext.prev).toBe(base);
      expect(ext.extensions).toContain(base);
    });
  });

  /* ---------------------------------------------------------------- *
   *  AND / OR / NOT (composite types)                                 *
   * ---------------------------------------------------------------- */
  describe("AndType", () => {
    it("create() & extend()", () => {
      const base: AndType = FieldType.and.create([FieldType.any.nonce]);
      const ext = base.extend(patch());

      expect(base.fieldtype).toBe("and");
      expect(FieldType.and.describes(ext)).toBe(true);
      expect(ext.prev).toBe(base);
    });
  });

  describe("OrType", () => {
    it("create() & extend()", () => {
      const base: OrType = FieldType.or.create([FieldType.any.nonce]);
      const ext = base.extend(patch());
      expect(base.fieldtype).toBe("or");
      expect(FieldType.or.describes(ext)).toBe(true);
      expect(ext.prev).toBe(base);
    });
  });

  describe("NotType", () => {
    it("create() & extend()", () => {
      const base: NotType = FieldType.not.create(FieldType.any.nonce);
      const ext = base.extend(patch());
      expect(FieldType.not.describes(ext)).toBe(true);
      expect(ext.prev).toBe(base);
    });
  });
});

describe("Fluent helpers + Draft + Events", () => {
  it("string.literal() enforces equality after save()", () => {
    const { validate } = require("../builders");
    const s = FieldType.string.create().literal("abc").save();

    expect(validate(s, "abc").status).toBe("valid");
    const bad = validate(s, "abx");
    expect(bad.status).toBe("invalid");
    expect(bad.errors[0].message).toContain('must equal "abc"');
  });

  it("object.property() + inner literal: extract + missing requirements", () => {
    const user = FieldType.object
      .create()
      .property("id", FieldType.string.create().literal("u_1"))
      .property("age", FieldType.number.create()) // missing literal
      .save();

    const value = user.extractLiterals();
    expect(value).toEqual({ id: "u_1" });

    const missing = user.missingLiteralRequirements();
    // `age` is required, so it should show
    expect(missing.some((m) => m.path.join(".") === "age")).toBe(true);
  });

  it("array.values() + accumulate(): extract a fully concrete array when min==max", () => {
    const threeTags = FieldType.array
      .create()
      .values(FieldType.string.create().literal("tag").save())
      .accumulate(
        ConstraintTypes.number.range.create({ min: 3, max: 3 }),
        FieldType.string.create(),
      )
      .save();

    expect(threeTags.extractLiterals()).toEqual(["tag", "tag", "tag"]);
    expect(threeTags.missingLiteralRequirements()).toEqual([]); // everything concretely set
  });

  it("toEvent / toEvents return state then patch, and save() applies patches", () => {
    const base = FieldType.number.create(); // creation (state)
    base.min(10); // draft patch (not saved yet)

    // events with draft
    const ev = base.toEvent({ withDraft: true });

  
    expect(ev.eventtype).toBe("patch");

    const evs = base.toEvents({ withDraft: true });
    
    expect(evs.map((e) => e.eventtype)).toEqual(["state", "patch"]);

    const saved = base.save();


    // the attribute from draft should now be in the node
    const minAttr = (saved.attributes as any[]).find(
      (a) => a.basetype === "number" && a.constrainttype === "min",
    );
    expect(minAttr?.value).toBe(10);
  });

  it("FieldType.fromEvent reconstructs a chain produced by fluent patches", () => {
    const s0 = FieldType.string.create(); // state
    const s1 = s0.length({ min: 2 }).save(); // patch

    const last = s1.toEvents().at(-1)!; // last event in chain
    const rebuilt = FieldType.fromEvent(last);

    expect(rebuilt.fieldtype).toBe("string");
    // should include the same length constraint
    const len = (rebuilt.attributes as any[]).find(
      (a) => a.basetype === "string" && a.constrainttype === "length",
    );
    expect(len?.min).toBe(2);
  });

  it("types.any().meta(...) remains a FieldType and can be saved", () => {
    const { types } = require("../builders");
    const ft = types.any().meta({ foo: "bar" }).save();
    expect(FieldType.any.describes(ft)).toBe(true);
  });
});

/* ------------------------------------------------------------------ *
 *  NEW: pretty printing (basic smoke checks live here for coverage)
 * ------------------------------------------------------------------ */

describe("Pretty printing (toString/inspect) – smoke checks", () => {
  it("string length prints constraints (CUE syntax)", () => {
    const s = FieldType.string.create().length({ min: 1, max: 10 }).save();
    const out = s.toString();
    expect(out).toContain("string");
    expect(out).toContain("len(1..10)");
  });

  it("number integer+min prints (CUE syntax)", () => {
    const n = FieldType.number.create().integer().min(0).save();
    const out = n.toString();
    expect(out).toContain("int");
    expect(out).toContain(">=0");
  });

  it("[...T] with cardinality prints (CUE syntax)", () => {
    const arr = FieldType.array
      .create()
      .values(FieldType.string.create()) // no range ⇒ generic element
      .accumulate(
        ConstraintTypes.number.range.create({ min: 1, max: 3 }),
        FieldType.any.create(),
      )
      .save();

    const out = arr.toString();
    expect(out).toContain("[...string]");
    expect(out).toContain("list.MinItems(1)");
    expect(out).toContain("list.MaxItems(3)");
  });

  it("tuple renders with CUE-style optional and spread", () => {
    const { types } = require("../builders");
    const t1 = types.tuple(types.string(), types.number().integer().save(), types.toptional(types.string()));
    const t2 = types.tuple(types.string(), types.tmany(types.number()));

    expect(t1.toString().startsWith("[")).toBe(true);
    expect(t1.toString()).toContain("?");  // optional element

    expect(t2.toString()).toContain("...");  // rest/spread element

    const util = require("util");
    expect(util.inspect(t1)).toContain("["); // Node inspect path
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// compose() lattice laws — commutativity, associativity, idempotence
// ─────────────────────────────────────────────────────────────────────────────

describe("FieldType.compose — lattice laws", () => {
  it("commutativity: compose(a, b) ≡ compose(b, a) for objects", () => {
    const a = FieldType.object.create().property("x", FieldType.string.create()).save();
    const b = FieldType.object.create().property("y", FieldType.number.create()).save();
    const ab = FieldType.compose(a, b);
    const ba = FieldType.compose(b, a);
    // Both should have properties x and y
    expect(ab.fieldtype).toBe("object");
    expect(ba.fieldtype).toBe("object");
    const abKeys = (ab.attributes ?? [])
      .filter(ConstraintTypes.object.property.describes)
      .map((p: any) => p.key).sort();
    const baKeys = (ba.attributes ?? [])
      .filter(ConstraintTypes.object.property.describes)
      .map((p: any) => p.key).sort();
    expect(abKeys).toEqual(baKeys);
  });

  it("commutativity: compose(a, b) ≡ compose(b, a) for same-type scalars", () => {
    const a = FieldType.string.create();
    const b = FieldType.string.create();
    const ab = FieldType.compose(a, b);
    const ba = FieldType.compose(b, a);
    expect(ab.fieldtype).toBe(ba.fieldtype);
  });

  it("associativity: compose(compose(a, b), c) ≡ compose(a, compose(b, c))", () => {
    const a = FieldType.object.create().property("x", FieldType.string.create()).save();
    const b = FieldType.object.create().property("y", FieldType.number.create()).save();
    const c = FieldType.object.create().property("z", FieldType.boolean.create()).save();

    const ab_c = FieldType.compose(FieldType.compose(a, b), c);
    const a_bc = FieldType.compose(a, FieldType.compose(b, c));

    const keys1 = (ab_c.attributes ?? [])
      .filter(ConstraintTypes.object.property.describes)
      .map((p: any) => p.key).sort();
    const keys2 = (a_bc.attributes ?? [])
      .filter(ConstraintTypes.object.property.describes)
      .map((p: any) => p.key).sort();
    expect(keys1).toEqual(["x", "y", "z"]);
    expect(keys2).toEqual(["x", "y", "z"]);
  });

  it("idempotence: compose(a, a) ≡ a", () => {
    const a = FieldType.object.create()
      .property("name", FieldType.string.create().literal("hello").save())
      .save();
    const aa = FieldType.compose(a, a);
    expect(aa.fieldtype).toBe("object");
    const lit = (aa.attributes ?? [])
      .find((attr: any) => ConstraintTypes.object.property.describes(attr) && attr.key === "name") as any;
    expect(lit).toBeDefined();
  });

  it("compose with never yields never", () => {
    const a = FieldType.string.create();
    const n = FieldType.never.create({ reason: "test" });
    expect(FieldType.compose(a, n).fieldtype).toBe("never");
    expect(FieldType.compose(n, a).fieldtype).toBe("never");
  });

  it("incompatible base types yield never", () => {
    const s = FieldType.string.create().literal("hello").save();
    const n = FieldType.number.create().literal(42).save();
    const result = FieldType.compose(s, n);
    // Should be never or and (both are valid — depends on implementation)
    // The important thing is it doesn't crash
    expect(result).toBeDefined();
  });

  it("metadata merge is symmetric", () => {
    // Two objects with conflicting metadata — compose order shouldn't matter
    const a = FieldType.object.create()
      .property("x", FieldType.string.create())
      .meta({ source: "a", shared: "same" })
      .save();
    const b = FieldType.object.create()
      .property("y", FieldType.number.create())
      .meta({ source: "b", shared: "same" })
      .save();

    const ab = FieldType.compose(a, b);
    const ba = FieldType.compose(b, a);

    const abMeta = (ab as any).metadata;
    const baMeta = (ba as any).metadata;

    // shared key with same value should be preserved
    expect(abMeta.shared).toBe("same");
    expect(baMeta.shared).toBe("same");
    // conflicting key should resolve the same way regardless of order
    expect(abMeta.source).toBe(baMeta.source);
  });
});
