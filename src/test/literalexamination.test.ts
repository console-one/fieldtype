import { FieldType } from "../type.js";
import { ConstraintTypes } from "../constraint.js";




describe("Literals: extraction + requirement cues", () => {


  it("object with required vs proptional properties", () => {
    // required name without literal, optional age without literal
    const user = FieldType.object
      .create()
      .property("name", FieldType.string.create()) // required, missing literal
      .property("age", FieldType.number.create(), { optional: true })
      .save();

    const missing = user.missingLiteralRequirements();

    console.log("Missing Literal requirements: ", missing);
    
    // must include "name", NOT "age"
    expect(missing.some((m) => m.path.join(".") === "name")).toBe(true);
    expect(missing.some((m) => m.path.join(".") === "age")).toBe(false);
  });

  it("array element literal is required when min > 0", () => {
    const arr = FieldType.array
      .create()
      .values(FieldType.number.create()) // element literal missing
      .accumulate(
        ConstraintTypes.number.range.create({ min: 2 }),
        FieldType.number.create(),
      )
      .save();

    const missing = arr.missingLiteralRequirements();
    expect(missing.length).toBeGreaterThan(0);
    // representative index 0 is used in the cue path
    expect(missing[0].path).toEqual([0]);
  });

  it("OR: if every branch needs literals, returns the smallest branch set", () => {
    const a = FieldType.object
      .create()
      .property("x", FieldType.number.create())
      .save();
    const b = FieldType.string.create(); // needs literal

    const ft = FieldType.or.create([a, b]);
    const reqs = ft.missingLiteralRequirements();
    expect(Array.isArray(reqs)).toBe(true);
    expect(reqs.length).toBeGreaterThan(0);
  });
});
