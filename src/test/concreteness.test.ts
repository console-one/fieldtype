import { FieldType } from "../type.js";
import { ConstraintTypes } from "../constraint.js";

/* Small helpers */
const range = (min?: number, max?: number) =>
  ConstraintTypes.number.range.create({ min, max });

const hasConcreteness =
  typeof (FieldType.any.create() as any).concreteness === "function";
const itIfConcreteness = hasConcreteness ? it : it.skip;

function missingPaths(ft: any): string[] {
  const miss = ft.missingLiteralRequirements?.() ?? [];
  return miss.map((m: any) =>
    m.path.map((p: string | number) => String(p)).join("."),
  );
}

describe("Concreteness (broad scenarios)", () => {
  /* ------------------------------------------------------------------ *
   * Back‑compat block: asserts behavior that should work *today*
   *   using extractLiterals() and missingLiteralRequirements().
   * ------------------------------------------------------------------ */

  describe("Back‑compat: extraction + shallow requirement cues", () => {
    it("null is concrete (literal), scalars without literal are not", () => {
      const n = FieldType.null.create();
      expect(n.extractLiterals()).toBe(null);
      expect(missingPaths(n)).toEqual([]); // no obligations

      const s = FieldType.string.create();
      expect(s.extractLiterals()).toBeUndefined();
      expect(missingPaths(s)).toContain(""); // root requires a literal

      const num = FieldType.number.create();
      expect(num.extractLiterals()).toBeUndefined();
      expect(missingPaths(num)).toContain("");
    });

    it("object: required vs optional (optional does not create a missing cue)", () => {
      const user = FieldType.object
        .create()
        .property("name", FieldType.string.create()) // required
        .property("age", FieldType.number.create(), { optional: true }) // optional
        .save();

      const miss = missingPaths(user);
      expect(miss).toContain("name");
      expect(miss).not.toContain("age");
    });

    it("array: min > 0 produces an element requirement cue at a representative index", () => {
      const arr = FieldType.array
        .create()
        .values(FieldType.number.create())
        .accumulate(range(2), FieldType.number.create())
        .save();
      const m = arr.missingLiteralRequirements();
      expect(m.length).toBeGreaterThan(0);
      expect(m[0].path).toEqual([0]); // representative cue
    });

    it("array: fixed length & literal element → full array literal extracted", () => {
      const elem = FieldType.any.create().literal(5);
      const arr = FieldType.array
        .create()
        .values(elem)
        .accumulate(range(3, 3), elem)
        .save();

      expect(arr.extractLiterals()).toEqual([5, 5, 5]);
    });

    it("object: extractLiterals only includes provable literals", () => {
      const t = FieldType.object
        .create()
        .property("p", FieldType.any.create().literal(1))
        .property("q", FieldType.string.create())
        .save();

      expect(t.extractLiterals()).toEqual({ p: 1 });
    });

    it("compose conflict to never -> requirement should signal unsatisfiable", () => {
      const a = FieldType.array
        .create()
        .accumulate(range(5, 5), FieldType.any.create())
        .save();
      const b = FieldType.array
        .create()
        .accumulate(range(6, 6), FieldType.any.create())
        .save();

      const bad = FieldType.compose(a, b);
      // Either a direct never type, or a missing req that says 'never'
      if (bad.fieldtype === "never") {
        const miss = bad.missingLiteralRequirements();
        expect(miss.some((m) => /never/i.test(m.reason))).toBe(true);
      } else {
        const miss = bad.missingLiteralRequirements();
        expect(miss.some((m) => /never|unsatisfiable/i.test(m.reason))).toBe(
          true,
        );
      }
    });
  });

  /* ------------------------------------------------------------------ *
   * Rich concreteness block: runs only when your analyzer exists.
   * It asserts:
   *  - defaults satisfy required props
   *  - nested paths are reported
   *  - tuple/rest arrays generate precise index obligations
   *  - unions emit chooseOneOf + discriminant hints
   *  - intersections can produce a single literal when all agree
   * ------------------------------------------------------------------ */

  describeIfConcreteness();

  function describeIfConcreteness() {
    describe(
      hasConcreteness
        ? "Rich concreteness() (nested, discriminants, tuples, defaults)"
        : "Rich concreteness() — SKIPPED until implemented",
      () => {
        itIfConcreteness("objects: required, optional, and defaults", () => {
          const t = FieldType.object
            .create()
            .property("name", FieldType.string.create()) // required (no default)
            .property("age", FieldType.number.create(), { optional: true }) // optional
            .property("region", FieldType.string.create(), {
              default: "us-east-1",
            }) // default satisfies
            .save();

          const c = (t as any).concreteness();
          // Should NOT require 'age' or 'region'
          const paths = c.missing.map((m: any) => m.path.join("."));
          expect(paths).toContain("name");
          expect(paths).not.toContain("age");
          expect(paths).not.toContain("region");

          // Partial literal should reflect defaults when present
          // (OK if your implementation only treats defaults as "not missing"
          // and does not materialize them in literal until finalization.)
          // If you *do* materialize, this will pass:
          if (c.literal) {
            expect((c.literal as any).region).toBe("us-east-1");
          }
        });

        itIfConcreteness("nested object: deep obligation paths", () => {
          const t = FieldType.object
            .create()
            .property(
              "spec",
              FieldType.object
                .create()
                .property(
                  "credentials",
                  FieldType.object
                    .create()
                    .property(
                      "token",
                      FieldType.string.create().length({ min: 20 }),
                    )
                    .save(),
                )
                .save(),
            )
            .save();

          const c = (t as any).concreteness();
          const paths = c.missing.map((m: any) => m.path.join("."));
          // All deep segments should be reported (installation UX needs these)
          expect(paths).toContain("spec");
          expect(paths).toContain("spec.credentials");
          expect(paths).toContain("spec.credentials.token");
        });

        itIfConcreteness("tuple/rest arrays: index-specific obligations", () => {
          // Build a tuple: [string{len>=1}, integer, ...number]
          const tup = FieldType.array
            .create()
            .index(FieldType.string.create().length({ min: 1 }), [
              range(0, 0),
            ])
            .index(FieldType.number.create().integer(), [range(1, 1)])
            .index(FieldType.number.create(), [range(2)]) // rest from index 2
            .accumulate(range(2), FieldType.number.create()) // at least 2 elements required
            .save();

          const c = (tup as any).concreteness();
          const paths = c.missing.map((m: any) => m.path.join("."));
          expect(paths).toContain("0"); // first element needed (string)
          expect(paths).toContain("1"); // second element needed (integer)
          // No requirement for rest yet (min satisfied by first two)
          expect(paths.some((p: string) => /^2(\.|$)/.test(p))).toBe(false);
        });

        itIfConcreteness("unions: chooseOneOf + discriminant hints", () => {
          const Docker = FieldType.object
            .create()
            .property("kind", FieldType.any.create().literal("docker"))
            .property("image", FieldType.string.create())
            .save();
          const Binary = FieldType.object
            .create()
            .property("kind", FieldType.any.create().literal("binary"))
            .property("path", FieldType.string.create())
            .save();

          const ft = FieldType.or.create([Docker, Binary]).save();
          const c = (ft as any).concreteness();

          // We should see a union-choice requirement, and a discriminant hint on 'kind'
          expect(
            c.missing.some(
              (m: any) =>
                m.kind === "chooseOneOf" || /choose one of/i.test(m.message),
            ),
          ).toBe(true);

          const hasKindHint = c.missing.some((m: any) => {
            const p = m.path.join(".");
            return p === "kind" || /kind/.test(m.message);
          });
          expect(hasKindHint).toBe(true);

          // Narrow the union by composing a literal discriminant at the root
          const delta = FieldType.object
            .create()
            .property("kind", FieldType.any.create().literal("docker"))
            .save();
          const narrowed = FieldType.compose(ft, delta).save();

          const c2 = (narrowed as any).concreteness();
          const paths2 = c2.missing.map((m: any) => m.path.join("."));
          expect(paths2).toContain("image"); // only docker branch remains
          expect(paths2).not.toContain("path");
        });

        itIfConcreteness("AND intersections: literal emerges when all agree", () => {
          const both = FieldType.and
            .create([
              FieldType.any.create().literal(10),
              FieldType.number.create().integer(),
            ])
            .save();

          const c = (both as any).concreteness();
          expect(c.concrete).toBe(true);
          expect(c.literal).toBe(10);
        });

        itIfConcreteness("never is reported as unsatisfiable (explicit)", () => {
          const never = FieldType.never.create({ reason: "conflict" }).save();
          const c = (never as any).concreteness();
          expect(c.concrete).toBe(false);
          expect(
            c.missing.some(
              (m: any) => m.kind === "never" || /never/i.test(m.message),
            ),
          ).toBe(true);
        });

        itIfConcreteness("NOT: surfaces ‘does not match’ requirement", () => {
          const notFoo = FieldType.not.create(
            FieldType.any.create().literal("foo"),
          );
          const c = (notFoo as any).concreteness();
          expect(c.concrete).toBe(false);
          expect(c.missing.length).toBeGreaterThan(0);
          expect(
            c.missing.some((m: any) => /does not match/i.test(m.message)),
          ).toBe(true);
        });

        itIfConcreteness("array fixed length + concrete element → array literal", () => {
          const elem = FieldType.any.create().literal("X");
          const arr = FieldType.array
            .create()
            .values(elem)
            .accumulate(range(2, 2), elem)
            .save();
          const c = (arr as any).concreteness();
          expect(c.concrete).toBe(true);
          expect(c.literal).toEqual(["X", "X"]);
        });
      },
    );
  }
});
