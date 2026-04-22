import {
  ConstraintTypes,
  AnyConstraint,
  StringConstraint,
  NumberConstraint,
  ObjectConstraint,
  ArrayConstraint,
  NumberRangeConstraint,
  BehavioralConstraint,
  isBehavioralConstraint,
  constraintRef,
} from "../constraint.js";

describe("ConstraintTypes – basic implementations", () => {
  /* ------------------------------------------------------------------ *
   *  ANY constraints                                                    *
   * ------------------------------------------------------------------ */

  describe("Any → literal", () => {
    it("creates a LiteralConstraint and is recognised by describes()", () => {
      const c: AnyConstraint = ConstraintTypes.any.literal.create("foo");

      expect(c.type).toEqual("typeconstraint");
      expect(c.basetype).toEqual("any");
      expect(c.constrainttype).toEqual("literal");
      expect(c.value).toEqual("foo");

      expect(ConstraintTypes.any.literal.describes(c)).toBe(true);
      expect(ConstraintTypes.any.literal.describes({})).toBe(false);
    });
  });

  describe("Any → returnedBy", () => {
    it("creates a ReturnTypeConstraint and is recognised by describes()", () => {
      const fn = () => 42;
      const c: AnyConstraint = ConstraintTypes.any.returnedBy.create(fn);

      expect(c.basetype).toEqual("any");
      expect(c.constrainttype).toEqual("returnedBy");
      expect(c.value).toBe(fn);

      expect(ConstraintTypes.any.returnedBy.describes(c)).toBe(true);
      expect(ConstraintTypes.any.returnedBy.describes({})).toBe(false);
    });
  });

  /* ------------------------------------------------------------------ *
   *  STRING constraints                                                 *
   * ------------------------------------------------------------------ */

  describe("String → matches", () => {
    it("creates a StringRegexConstraint", () => {
      const regex = /abc/i;
      const c: StringConstraint = ConstraintTypes.string.matches.create(regex);

      expect(c.basetype).toBe("string");
      expect(c.constrainttype).toBe("matches");
      expect(c.pattern).toBe(regex);

      expect(ConstraintTypes.string.matches.describes(c)).toBe(true);
      expect(ConstraintTypes.string.matches.describes({})).toBe(false);
    });
  });

  describe("String → includes", () => {
    it("creates a StringIncludesConstraint", () => {
      const c: StringConstraint = ConstraintTypes.string.includes.create("foo");

      expect(c.constrainttype).toBe("includes");
      expect(c.value).toBe("foo");

      expect(ConstraintTypes.string.includes.describes(c)).toBe(true);
    });
  });

  describe("String → length", () => {
    it("creates a StringLengthConstraint", () => {
      const c: StringConstraint = ConstraintTypes.string.length.create({
        min: 2,
        max: 5,
      });

      expect(c.constrainttype).toBe("length");
      expect(c.min).toBe(2);
      expect(c.max).toBe(5);

      expect(ConstraintTypes.string.length.describes(c)).toBe(true);
    });
  });

  /* ------------------------------------------------------------------ *
   *  NUMBER constraints                                                 *
   * ------------------------------------------------------------------ */

  describe("Number → min / max / integer / range", () => {
    it("min", () => {
      const c: NumberConstraint = ConstraintTypes.number.min.create(10);
      expect(c.constrainttype).toBe("min");
      expect(c.value).toBe(10);
      expect(ConstraintTypes.number.min.describes(c)).toBe(true);
    });

    it("max", () => {
      const c: NumberConstraint = ConstraintTypes.number.max.create(99);
      expect(c.constrainttype).toBe("max");
      expect(c.value).toBe(99);
      expect(ConstraintTypes.number.max.describes(c)).toBe(true);
    });

    it("integer", () => {
      const c: NumberConstraint = ConstraintTypes.number.integer.create();

      expect(c.constrainttype).toBe("integer");
      expect(ConstraintTypes.number.integer.describes(c)).toBe(true);
    });

    it("range", () => {
      const c: NumberConstraint = ConstraintTypes.number.range.create({
        min: 1,
        max: 5,
      });
      expect(c.constrainttype).toBe("range");
      expect(c.min).toBe(1);
      expect(c.max).toBe(5);
      expect(ConstraintTypes.number.range.describes(c)).toBe(true);
    });
  });

  /* ------------------------------------------------------------------ *
   *  OBJECT constraints                                                 *
   * ------------------------------------------------------------------ */

  describe("Object → property / properties", () => {
    const dummyType = ConstraintTypes.string.includes.create("x"); // any FieldType substitute

    it("property", () => {
      const c: ObjectConstraint = ConstraintTypes.object.property.create(
        "foo",
        dummyType as any,
      );
      expect(c.basetype).toBe("object");
      expect(c.constrainttype).toBe("property");
      expect(c.key).toBe("foo");

      expect(ConstraintTypes.object.property.describes(c)).toBe(true);
    });

    it("properties", () => {
      const c: ObjectConstraint = ConstraintTypes.object.properties.create(
        /^foo/,
        dummyType as any,
      );
      expect(c.constrainttype).toBe("properties");
      expect(c.key).toEqual(/^foo/);
      expect(ConstraintTypes.object.properties.describes(c)).toBe(true);
    });
  });

  describe("Array‑level constraints", () => {
    /* ------------------------------------------------------------------ *
     *  VALUES constraint                                                  *
     * ------------------------------------------------------------------ */
    it("array.values.create() generates IndexConstraint", () => {
      const child = ConstraintTypes.string.includes.create("x") as any;
      const rng: NumberRangeConstraint[] = [
        ConstraintTypes.number.range.create({ min: 0, max: 3 }),
      ];

      const c: ArrayConstraint = ConstraintTypes.array.values.create(
        child,
        rng,
      );

      expect(c.type).toBe("typeconstraint");
      expect(c.basetype).toBe("array");
      expect(c.constrainttype).toBe("values");
      expect(c.range).toEqual(rng);
      expect(c.value).toBe(child);

      expect(ConstraintTypes.array.values.describes(c)).toBe(true);
      expect(ConstraintTypes.array.values.describes({})).toBe(false);
    });

    /* ------------------------------------------------------------------ *
     *  ACCUMULATE constraint                                              *
     * ------------------------------------------------------------------ */
    it("array.accumulate.create() generates AccumulatedConstraint", () => {
      const lenRange = ConstraintTypes.number.range.create({ min: 1, max: 5 });
      const child = ConstraintTypes.string.includes.create("x") as any;

      const c: ArrayConstraint = ConstraintTypes.array.accumulate.create(
        lenRange,
        child,
      );

      expect(c.constrainttype).toBe("accumulate");
      expect(c.items).toBe(lenRange);
      expect(c.value).toBe(child);

      expect(ConstraintTypes.array.accumulate.describes(c)).toBe(true);
    });
  });

  /* ------------------------------------------------------------------ *
   *  BEHAVIORAL constraints (pairing demands)                           *
   * ------------------------------------------------------------------ */

  describe("Behavioral → merge", () => {
    it("creates a MergeConstraint and is recognised by describes()", () => {
      const c = ConstraintTypes.any.merge.create("source-wins");

      expect(c.type).toBe("typeconstraint");
      expect(c.basetype).toBe("any");
      expect(c.constrainttype).toBe("merge");
      expect(c.value).toBe("source-wins");

      expect(ConstraintTypes.any.merge.describes(c)).toBe(true);
      expect(ConstraintTypes.any.merge.describes({})).toBe(false);
    });

    it("accepts override and reason options", () => {
      const c = ConstraintTypes.any.merge.create("last-write", {
        override: "final",
        reason: "immutable after set",
      });
      expect(c.override).toBe("final");
      expect(c.reason).toBe("immutable after set");
    });
  });

  describe("Behavioral → persist", () => {
    it("creates a PersistConstraint with sink", () => {
      const c = ConstraintTypes.any.persist.create("encrypted", {
        target: "constants",
        transform: "encrypt",
      });

      expect(c.constrainttype).toBe("persist");
      expect(c.sink).toBe("encrypted");
      expect(c.target).toBe("constants");
      expect(c.transform).toBe("encrypt");

      expect(ConstraintTypes.any.persist.describes(c)).toBe(true);
      expect(ConstraintTypes.any.persist.describes({})).toBe(false);
    });
  });

  describe("Behavioral → compact", () => {
    it("creates a CompactConstraint", () => {
      const c = ConstraintTypes.any.compact.create({ retain: 3, strategy: "snapshot" });

      expect(c.constrainttype).toBe("compact");
      expect(c.retain).toBe(3);
      expect(c.strategy).toBe("snapshot");

      expect(ConstraintTypes.any.compact.describes(c)).toBe(true);
    });

    it("works with no args", () => {
      const c = ConstraintTypes.any.compact.create();
      expect(c.constrainttype).toBe("compact");
      expect(ConstraintTypes.any.compact.describes(c)).toBe(true);
    });
  });

  describe("Behavioral → subscribe", () => {
    it("creates a SubscribeConstraint", () => {
      const c = ConstraintTypes.any.subscribe.create("events.topic");

      expect(c.constrainttype).toBe("subscribe");
      expect(c.target).toBe("events.topic");

      expect(ConstraintTypes.any.subscribe.describes(c)).toBe(true);
    });
  });

  describe("Behavioral → fork", () => {
    it("creates a ForkConstraint", () => {
      const c = ConstraintTypes.any.fork.create("copy");

      expect(c.constrainttype).toBe("fork");
      expect(c.value).toBe("copy");

      expect(ConstraintTypes.any.fork.describes(c)).toBe(true);
    });
  });

  describe("Behavioral → visibility", () => {
    it("creates a VisibilityConstraint", () => {
      const c = ConstraintTypes.any.visibility.create("owner");

      expect(c.constrainttype).toBe("visibility");
      expect(c.scope).toBe("owner");

      expect(ConstraintTypes.any.visibility.describes(c)).toBe(true);
    });
  });

  describe("Behavioral → decorator", () => {
    it("creates a DecoratorConstraint", () => {
      const c = ConstraintTypes.any.decorator.create("decrypt");

      expect(c.constrainttype).toBe("decorator");
      expect(c.transform).toBe("decrypt");

      expect(ConstraintTypes.any.decorator.describes(c)).toBe(true);
      expect(ConstraintTypes.any.decorator.describes({})).toBe(false);
    });
  });

  describe("Behavioral → ConstraintRef support", () => {
    it("accepts ConstraintRef values in behavioral constraints", () => {
      const ref = constraintRef("config.mergeStrategy");
      const c = ConstraintTypes.any.merge.create(ref);

      expect(c.value).toEqual({ __ref: true, path: "config.mergeStrategy" });
      expect(ConstraintTypes.any.merge.describes(c)).toBe(true);
    });
  });

  describe("Behavioral → label", () => {
    it("creates a LabelConstraint with value and match", () => {
      const matchType = ConstraintTypes.object.property.create("packageID", { type: 'baseType', fieldtype: 'string', extensions: [], attributes: [] } as any);
      const c = ConstraintTypes.any.label.create("toolpackage", matchType as any);

      expect(c.type).toBe("typeconstraint");
      expect(c.basetype).toBe("any");
      expect(c.constrainttype).toBe("label");
      expect(c.value).toBe("toolpackage");
      expect(c.match).toBe(matchType);

      expect(ConstraintTypes.any.label.describes(c)).toBe(true);
      expect(ConstraintTypes.any.label.describes({})).toBe(false);
    });

    it("accepts reason option", () => {
      const matchType = { type: 'baseType', fieldtype: 'any', extensions: [], attributes: [] } as any;
      const c = ConstraintTypes.any.label.create("blueprint", matchType, { reason: "classify blueprints" });
      expect(c.reason).toBe("classify blueprints");
    });
  });

  describe("isBehavioralConstraint", () => {
    it("returns true for all behavioral constraint types", () => {
      expect(isBehavioralConstraint(ConstraintTypes.any.merge.create("last-write"))).toBe(true);
      expect(isBehavioralConstraint(ConstraintTypes.any.persist.create("fs"))).toBe(true);
      expect(isBehavioralConstraint(ConstraintTypes.any.compact.create())).toBe(true);
      expect(isBehavioralConstraint(ConstraintTypes.any.subscribe.create("x"))).toBe(true);
      expect(isBehavioralConstraint(ConstraintTypes.any.fork.create("copy"))).toBe(true);
      expect(isBehavioralConstraint(ConstraintTypes.any.visibility.create("owner"))).toBe(true);
      expect(isBehavioralConstraint(ConstraintTypes.any.decorator.create("decrypt"))).toBe(true);
      expect(isBehavioralConstraint(ConstraintTypes.any.label.create("pkg", { type: 'baseType', fieldtype: 'any', extensions: [], attributes: [] } as any))).toBe(true);
    });

    it("returns false for non-behavioral constraints", () => {
      expect(isBehavioralConstraint(ConstraintTypes.any.literal.create("foo"))).toBe(false);
      expect(isBehavioralConstraint(ConstraintTypes.string.matches.create(/x/))).toBe(false);
      expect(isBehavioralConstraint({})).toBe(false);
      expect(isBehavioralConstraint(null)).toBe(false);
    });
  });
});
