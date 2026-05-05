import z from "zod";
import { FieldTypeBuilder, types, validate } from "../builders.js";
import {
  ConstraintTypes,
  NumberConstraint,
  ObjectConstraint,
  StringConstraint,
} from "../constraint.js";
import { FieldType } from "../type.js";

const isLengthConstraint = (c: unknown): c is StringConstraint =>
  ConstraintTypes.string.length.describes(c);
const isRangeConstraint = (c: unknown): c is NumberConstraint =>
  ConstraintTypes.number.range.describes(c);
const isPropConstraint = (c: unknown): c is ObjectConstraint =>
  ConstraintTypes.object.property.describes(c);

describe("FieldTypeBuilder", () => {
  /* ------------------------------------------------------------------ *
   *  BASIC CONSTRUCTORS                                                 *
   * ------------------------------------------------------------------ */

  it("string() with no opts yields a bare StringType with empty metadata", () => {
    const node = FieldTypeBuilder.string().build();

    expect(node.fieldtype).toBe("string");
    expect(node.attributes).toHaveLength(0);
    expect(node.metadata).toEqual({});
  });

  it("number() passes initial attributes via opts", () => {
    const minRange = ConstraintTypes.number.range.create({ min: 1 });
    const node = FieldTypeBuilder.number({ attributes: [minRange] }).build();

    expect(node.fieldtype).toBe("number");
    expect(node.attributes[0]).toBe(minRange);
  });

  it("any() creates a node whose metadata defaults to empty object", () => {
    const node = FieldTypeBuilder.any().build();
    expect(node.fieldtype).toBe("any");
    expect(node.metadata).toEqual({});
  });

  /* ------------------------------------------------------------------ *
   *  ATTRIBUTE HELPERS                                                  *
   * ------------------------------------------------------------------ */

  it("attr.length() adds a StringLengthConstraint in-place", () => {
    const node = FieldTypeBuilder.string()
      .attr.length({ min: 2, max: 5 })
      .build();

    expect(node.attributes).toHaveLength(1);
    const c = node.attributes[0];
    expect(isLengthConstraint(c)).toBe(true);
    if (isLengthConstraint(c)) {
      expect(c["min"]).toBe(2);
      expect(c["max"]).toBe(5);
    }
  });

  it("attr.range() adds a NumberRangeConstraint", () => {
    const node = FieldTypeBuilder.number()
      .attr.range({ min: 0, max: 10 })
      .build();

    const c = node.attributes[0];
    expect(isRangeConstraint(c)).toBe(true);
    if (isRangeConstraint(c)) {
      expect(c["min"]).toBe(0);
      expect(c["max"]).toBe(10);
    }
  });

  it("attr.property() adds an ObjectPropertyConstraint", () => {
    const objNode = FieldTypeBuilder.object()
      .attr.property("foo", FieldTypeBuilder.string().build())
      .build();

    const c = objNode.attributes[0];
    expect(isPropConstraint(c)).toBe(true);
    if (isPropConstraint(c)) {
      expect(c["key"]).toBe("foo");
      expect((c as any).value.fieldtype).toBe("string");
    }
  });

  /* ------------------------------------------------------------------ *
   *  COMBINATORS                                                        *
   * ------------------------------------------------------------------ */

  it("or() combines builder nodes into an OrType", () => {
    const str = FieldTypeBuilder.string();
    const num = FieldTypeBuilder.number();

    const orNode = str.or(num).build();
    expect(orNode.fieldtype).toBe("or");

    const childTypes = orNode.attributes.map((a) => (a as FieldType).fieldtype);
    expect(childTypes).toEqual(["string", "number"]);
  });

  it("and() combines into an AndType", () => {
    const andNode = FieldTypeBuilder.string()
      .and(FieldTypeBuilder.number())
      .build();

    expect(andNode.fieldtype).toBe("and");
    expect(andNode.attributes).toHaveLength(2);
  });

  it("not() wraps into a NotType", () => {
    const notNode = FieldTypeBuilder.string().not().build();
    expect(notNode.fieldtype).toBe("not");
    // first (and only) child should be the original StringType
    const child = notNode.attributes[0] as unknown as FieldType;
    expect(child.fieldtype).toBe("string");
  });

  /* ------------------------------------------------------------------ *
   *  fromZod()                                                          *
   * ------------------------------------------------------------------ */

  it("fromZod() converts a ZodString.min(2) into StringType with length ≥ 2", () => {
    const zodSchema = z.string().min(2);
    const node = FieldTypeBuilder.fromZod(zodSchema).build();

    expect(node.fieldtype).toBe("string");
    const len = node.attributes.find(isLengthConstraint);
    expect(len).toBeDefined();
    if (len) {
      expect(len["min"]).toBe(2);
    }
  });

  it("meta() merges custom metadata", () => {
    const node = FieldTypeBuilder.string()
      .meta({ ui: "label" })
      .meta({ doc: "Username" })
      .build();

    expect(node.metadata).toEqual({ ui: "label", doc: "Username" });
  });
});

/* ------------------------------------------------------------------ *
 *  NEW: tuple() sugar + optional()/many()
 * ------------------------------------------------------------------ */

describe("types.tuple() sugar", () => {
  const isArrayValues = (a: any) =>
    a?.basetype === "array" && a?.constrainttype === "values";
  const isArrayAcc = (a: any) =>
    a?.basetype === "array" && a?.constrainttype === "accumulate";

  const hasExactIndex = (attr: any, idx: number) => {
    const rg = attr.range;
    if (!rg) return false;
    const groups = Array.isArray(rg[0]) ? rg : [rg];
    return groups.some((g: any[]) => {
      const r = g.find((x: any) => x.constrainttype === "range");
      return r && r.min === idx && r.max === idx;
    });
  };

  it("tuple(A,B,C) emits per-index values + length min==max==3", () => {
    const A = types.string();
    const B = types.number().integer().save();
    const C = types.string();

    const t = types.tuple(A, B, C);

    expect(t.fieldtype).toBe("array");
    const attrs = t.attributes as any[];

    const vals = attrs.filter(isArrayValues);
    expect(vals).toHaveLength(3);
    const v0 = vals.find((v) => hasExactIndex(v, 0));
    const v1 = vals.find((v) => hasExactIndex(v, 1));
    const v2 = vals.find((v) => hasExactIndex(v, 2));
    expect(v0?.value.fieldtype).toBe("string");
    expect(v1?.value.fieldtype).toBe("number");
    expect(v2?.value.fieldtype).toBe("string");

    const acc = attrs.find(isArrayAcc);
    expect(acc.items.min).toBe(3);
    expect(acc.items.max).toBe(3);

    // validation sanity
    expect(validate(t, ["a", 1, "c"]).ok).toBe(true);
    expect(validate(t, ["a", "b", "c"]).ok).toBe(false);
    expect(validate(t, ["a", 1]).ok).toBe(false);
  });

  it("tuple(A,B,optional(C)) keeps index typing; min=2, max=3", () => {
    const A = types.string();
    const B = types.number();
    const C = types.string();

    const t = types.tuple(A, B, types.toptional(C));
    const attrs = t.attributes as any[];

    const vals = attrs.filter(isArrayValues);
    expect(vals).toHaveLength(3); // index 2 is typed but optional by length
    const acc = attrs.find(isArrayAcc);
    expect(acc.items.min).toBe(2);
    expect(acc.items.max).toBe(3);

    expect(validate(t, ["x", 2]).ok).toBe(true);
    expect(validate(t, ["x", 2, "z"]).ok).toBe(true);
    expect(validate(t, ["x"]).ok).toBe(false);
    expect(validate(t, ["x", 2, 999]).ok).toBe(false);
  });

  it("tuple(A,B,many(C)) adds a rest tail with min=2 and no max", () => {
    const A = types.string();
    const B = types.number();
    const C = types.string();

    const t = types.tuple(A, B, types.tmany(C));
    const attrs = t.attributes as any[];

    const acc = attrs.find(isArrayAcc);
    expect(acc.items.min).toBe(2);
    expect(acc.items.max).toBeUndefined();

    const rest = attrs.filter(isArrayValues).find((v) => {
      const rg = v.range;
      if (!rg) return false;
      const groups = Array.isArray(rg[0]) ? rg : [rg];
      return groups.some((g: any[]) => {
        const r = g.find((x: any) => x.constrainttype === "range");
        return r && r.min === 2 && r.max == null;
      });
    });
    expect(rest).toBeTruthy();

    expect(validate(t, ["a", 1]).ok).toBe(true);
    expect(validate(t, ["a", 1, "c", "d"]).ok).toBe(true);
    expect(validate(t, ["a", 1, 2]).ok).toBe(false); // rest must be C
  });

  it("tuple() layout rules: optional must be trailing; many must be last", () => {
    const A = types.string();
    const B = types.number();

    expect(() => types.tuple(types.toptional(A), B)).toThrow();
    expect(() => types.tuple(A, types.tmany(B), A)).toThrow();
  });
});

/* ------------------------------------------------------------------ *
 *  BEHAVIORAL FLUENT METHODS (pairing demands on FieldType)           *
 * ------------------------------------------------------------------ */

describe("Behavioral fluent methods", () => {
  it(".merge() adds a merge constraint to string type", () => {
    const ft = types.string().merge("source-wins").save();
    const mergeAttr = ft.attributes.find(
      (a: any) => a.constrainttype === "merge",
    );
    expect(mergeAttr).toBeDefined();
    expect((mergeAttr as any).value).toBe("source-wins");
  });

  it(".persist() adds a persist constraint to string type", () => {
    const ft = types.string()
      .persist("encrypted", { target: "constants", transform: "encrypt" })
      .save();
    const attr = ft.attributes.find(
      (a: any) => a.constrainttype === "persist",
    );
    expect(attr).toBeDefined();
    expect((attr as any).sink).toBe("encrypted");
    expect((attr as any).target).toBe("constants");
  });

  it(".compact() adds a compact constraint", () => {
    const ft = types.number().compact({ retain: 3 }).save();
    const attr = ft.attributes.find(
      (a: any) => a.constrainttype === "compact",
    );
    expect(attr).toBeDefined();
    expect((attr as any).retain).toBe(3);
  });

  it(".subscribe() adds a subscribe constraint", () => {
    const ft = types.string().subscribe("events.topic").save();
    const attr = ft.attributes.find(
      (a: any) => a.constrainttype === "subscribe",
    );
    expect(attr).toBeDefined();
    expect((attr as any).target).toBe("events.topic");
  });

  it(".fork() adds a fork constraint", () => {
    const ft = types.string().fork("copy").save();
    const attr = ft.attributes.find(
      (a: any) => a.constrainttype === "fork",
    );
    expect(attr).toBeDefined();
    expect((attr as any).value).toBe("copy");
  });

  it(".visibility() adds a visibility constraint", () => {
    const ft = types.string().visibility("owner").save();
    const attr = ft.attributes.find(
      (a: any) => a.constrainttype === "visibility",
    );
    expect(attr).toBeDefined();
    expect((attr as any).scope).toBe("owner");
  });

  it(".decorator() adds a decorator constraint", () => {
    const ft = types.string().decorator("decrypt").save();
    const attr = ft.attributes.find(
      (a: any) => a.constrainttype === "decorator",
    );
    expect(attr).toBeDefined();
    expect((attr as any).transform).toBe("decrypt");
  });

  it("chains multiple behavioral constraints on one field", () => {
    const ft = types.string()
      .merge("source-wins")
      .persist("encrypted")
      .visibility("owner")
      .decorator("decrypt")
      .save();

    const behavioral = ft.attributes.filter(
      (a: any) => ["merge", "persist", "visibility", "decorator"].includes(a.constrainttype),
    );
    expect(behavioral.length).toBe(4);
  });

  it("behavioral constraints work on object types", () => {
    const ft = types.object({ name: types.string() })
      .merge("last-write")
      .save();
    const attr = ft.attributes.find(
      (a: any) => a.constrainttype === "merge",
    );
    expect(attr).toBeDefined();
  });

  it("behavioral constraints coexist with value constraints", () => {
    const ft = types.string()
      .literal("dark")
      .merge("last-write")
      .save();

    const litAttr = ft.attributes.find(
      (a: any) => a.constrainttype === "literal",
    );
    const mergeAttr = ft.attributes.find(
      (a: any) => a.constrainttype === "merge",
    );
    expect(litAttr).toBeDefined();
    expect(mergeAttr).toBeDefined();
    expect((litAttr as any).value).toBe("dark");
    expect((mergeAttr as any).value).toBe("last-write");
  });
});
