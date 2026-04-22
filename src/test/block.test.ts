import { types, validate } from "../builders.js";
import { ConstraintTypes, constraintRef } from "../constraint.js";
import * as find from "../find.js";

describe("Block constraints", () => {
  /* ------------------------------------------------------------------ *
   *  CONSTRAINT CREATION                                                *
   * ------------------------------------------------------------------ */

  describe("ConstraintTypes.array.named", () => {
    it("create() produces valid constraint shape", () => {
      const c = ConstraintTypes.array.named.create("model", types.object({}));

      expect(c.type).toBe("typeconstraint");
      expect(c.basetype).toBe("array");
      expect(c.constrainttype).toBe("named");
      expect(c.key).toBe("model");
      expect(c.value).toBeDefined();
      // defaults: min=undefined, max=undefined, by=undefined (resolved at validation time)
    });

    it("describes() type guard identifies named constraints", () => {
      const named = ConstraintTypes.array.named.create("x", types.any());
      const contains = ConstraintTypes.array.contains.create(types.any());
      const unique = ConstraintTypes.array.unique.create();

      expect(ConstraintTypes.array.named.describes(named)).toBe(true);
      expect(ConstraintTypes.array.named.describes(contains)).toBe(false);
      expect(ConstraintTypes.array.named.describes(unique)).toBe(false);
      expect(ConstraintTypes.array.named.describes(null)).toBe(false);
      expect(ConstraintTypes.array.named.describes(42)).toBe(false);
    });

    it("create() with all options", () => {
      const c = ConstraintTypes.array.named.create("provider", types.string(), {
        by: "kind",
        min: 0,
        max: 3,
        reason: "optional provider entries",
      });

      expect(c.key).toBe("provider");
      expect(c.by).toBe("kind");
      expect(c.min).toBe(0);
      expect(c.max).toBe(3);
      expect(c.reason).toBe("optional provider entries");
    });
  });

  /* ------------------------------------------------------------------ *
   *  BUILDER FUNCTIONS                                                  *
   * ------------------------------------------------------------------ */

  describe("types.assignment()", () => {
    it("creates a named constraint with default required+unique (min=unset, max=unset → defaults 1,1 at validation)", () => {
      const c = types.assignment("model", types.object({}));

      expect(ConstraintTypes.array.named.describes(c)).toBe(true);
      expect(c.key).toBe("model");
      // min/max undefined → validation defaults to 1
    });

    it("with min:0 makes it optional", () => {
      const c = types.assignment("description", types.string(), { min: 0 });

      expect(c.min).toBe(0);
    });

    it("with custom by path", () => {
      const c = types.assignment("model", types.any(), { by: "kind.name" });

      expect(c.by).toBe("kind.name");
    });
  });

  describe("types.block()", () => {
    it("creates array FieldType with named constraints", () => {
      const schema = types.block([
        types.assignment("model", types.object({})),
        types.assignment("prompt", types.string()),
      ]);

      expect(schema.fieldtype).toBe("array");
      const named = find.arrayNamed(schema);
      expect(named).toHaveLength(2);
      expect(named[0].key).toBe("model");
      expect(named[1].key).toBe("prompt");
    });

    it("accepts mixed named + contains constraints", () => {
      const schema = types.block([
        types.assignment("model", types.object({})),
        types.zeroToMany(types.string()),
      ]);

      expect(schema.fieldtype).toBe("array");
      const named = find.arrayNamed(schema);
      const contains = find.arrayContains(schema);
      expect(named).toHaveLength(1);
      expect(contains).toHaveLength(1);
    });
  });

  describe("cardinality sugar", () => {
    it("zeroToMany produces contains with min:0, no max", () => {
      const c = types.zeroToMany(types.string());
      expect(ConstraintTypes.array.contains.describes(c)).toBe(true);
      expect(c.min).toBe(0);
      expect(c.max).toBeUndefined();
    });

    it("zeroToOne produces contains with min:0, max:1", () => {
      const c = types.zeroToOne(types.string());
      expect(c.min).toBe(0);
      expect(c.max).toBe(1);
    });

    it("oneToMany produces contains with min:1, no max", () => {
      const c = types.oneToMany(types.string());
      expect(c.min).toBe(1);
      expect(c.max).toBeUndefined();
    });

    it("exactly(n) produces contains with min:n, max:n", () => {
      const c = types.exactly(3, types.number());
      expect(c.min).toBe(3);
      expect(c.max).toBe(3);
    });
  });

  /* ------------------------------------------------------------------ *
   *  FIND HELPERS                                                       *
   * ------------------------------------------------------------------ */

  describe("find.arrayNamed / find.arrayContains", () => {
    it("arrayNamed extracts only named constraints", () => {
      const schema = types.block([
        types.assignment("a", types.any()),
        types.zeroToMany(types.any()),
        types.assignment("b", types.any()),
      ]);

      const named = find.arrayNamed(schema);
      expect(named).toHaveLength(2);
      expect(named[0].key).toBe("a");
      expect(named[1].key).toBe("b");
    });

    it("arrayContains extracts only contains constraints", () => {
      const schema = types.block([
        types.assignment("a", types.any()),
        types.zeroToMany(types.string()),
        types.oneToMany(types.number()),
      ]);

      const contains = find.arrayContains(schema);
      expect(contains).toHaveLength(2);
    });

    it("returns empty arrays on non-array types", () => {
      expect(find.arrayNamed(types.string())).toHaveLength(0);
      expect(find.arrayContains(types.object({}))).toHaveLength(0);
    });
  });

  /* ------------------------------------------------------------------ *
   *  VALIDATION                                                         *
   * ------------------------------------------------------------------ */

  describe("validation: named constraint", () => {
    // Schema: block with required "model" element (exactly 1, keyed by "name")
    const modelType = types.object({ name: types.string(), value: types.any() });
    const schema = types.block([
      types.assignment("model", modelType),
    ]);

    it("valid: required element present", () => {
      const result = validate(schema, [
        { name: "model", value: "gpt-4" },
      ]);
      expect(result.status).toBe("valid");
    });

    it("invalid: required element missing", () => {
      const result = validate(schema, [
        { name: "prompt", value: "hello" },
      ]);
      expect(result.status).toBe("invalid");
      if (result.status === "invalid") {
        expect(result.errors.some(e => e.message.includes('at least 1') && e.message.includes('model'))).toBe(true);
      }
    });

    it("invalid: duplicate unique element", () => {
      const result = validate(schema, [
        { name: "model", value: "gpt-4" },
        { name: "model", value: "gpt-3.5" },
      ]);
      expect(result.status).toBe("invalid");
      if (result.status === "invalid") {
        expect(result.errors.some(e => e.message.includes('at most 1') && e.message.includes('model'))).toBe(true);
      }
    });

    it("invalid: named element fails value type constraint", () => {
      const strictSchema = types.block([
        types.assignment("model", types.object({
          name: types.string(),
          value: types.number(),
        })),
      ]);

      const result = validate(strictSchema, [
        { name: "model", value: "not-a-number" },
      ]);
      expect(result.status).toBe("invalid");
      if (result.status === "invalid") {
        // Should report that 'value' is not a number
        expect(result.errors.some(e => e.message.includes("expected number"))).toBe(true);
      }
    });

    it("valid: optional element missing is OK", () => {
      const optSchema = types.block([
        types.assignment("model", types.any()),
        types.assignment("description", types.any(), { min: 0 }),
      ]);

      const result = validate(optSchema, [
        { name: "model", value: "gpt-4" },
      ]);
      expect(result.status).toBe("valid");
    });

    it("valid: optional element present is OK", () => {
      const optSchema = types.block([
        types.assignment("model", types.any()),
        types.assignment("description", types.any(), { min: 0 }),
      ]);

      const result = validate(optSchema, [
        { name: "model", value: "gpt-4" },
        { name: "description", value: "A helpful model" },
      ]);
      expect(result.status).toBe("valid");
    });
  });

  describe("validation: custom by path", () => {
    it("matches elements by nested dot-path", () => {
      const schema = types.block([
        types.assignment("llm", types.any(), { by: "kind.type" }),
      ]);

      const valid = validate(schema, [
        { kind: { type: "llm" }, data: 42 },
      ]);
      expect(valid.status).toBe("valid");

      const invalid = validate(schema, [
        { kind: { type: "rest" }, data: 42 },
      ]);
      expect(invalid.status).toBe("invalid");
    });
  });

  describe("validation: ref-valued bounds are skipped", () => {
    it("constraint ref min/max do not cause validation failure", () => {
      const refMin = constraintRef("scope.minCount");
      const c = ConstraintTypes.array.named.create("x", types.any(), { min: refMin });

      // Build schema manually with the ref-valued constraint
      const schema = types.block([c as any]);

      // Even though there are 0 elements matching "x", the ref-valued min
      // should be skipped (deferred to scope resolution)
      const result = validate(schema, [
        { name: "y", value: 1 },
      ]);
      // The ref is not a number, so the cardinality check is skipped
      expect(result.status).toBe("valid");
    });
  });

  describe("validation: mixed named + contains", () => {
    it("both constraint types enforced together", () => {
      const annotationType = types.object({ type: types.string() });
      const schema = types.block([
        types.assignment("model", types.any()),
        types.zeroToMany(annotationType),
      ]);

      // Valid: model present, annotations match type
      const r1 = validate(schema, [
        { name: "model", value: "gpt-4" },
        { type: "annotation" },
        { type: "metadata" },
      ]);
      expect(r1.status).toBe("valid");

      // Invalid: model missing (named constraint fails)
      const r2 = validate(schema, [
        { type: "annotation" },
      ]);
      expect(r2.status).toBe("invalid");
    });

    it("exactly(2) enforces precise count", () => {
      const schema = types.block([
        types.exactly(2, types.string()),
      ]);

      expect(validate(schema, ["a", "b"]).status).toBe("valid");
      expect(validate(schema, ["a"]).status).toBe("invalid");
      expect(validate(schema, ["a", "b", "c"]).status).toBe("invalid");
    });
  });

  describe("validation: empty block", () => {
    it("empty array validates against schema with only optional/zeroToMany constraints", () => {
      const schema = types.block([
        types.assignment("x", types.any(), { min: 0 }),
        types.zeroToMany(types.any()),
      ]);

      expect(validate(schema, []).status).toBe("valid");
    });

    it("empty array fails against schema with required named element", () => {
      const schema = types.block([
        types.assignment("model", types.any()),
      ]);

      const result = validate(schema, []);
      expect(result.status).toBe("invalid");
    });
  });
});
