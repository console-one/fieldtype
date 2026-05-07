import { ConstraintTypes, isBehavioralConstraint } from "../constraint.js";
import { types } from "../builders.js";
import { FieldType } from "../type.js";

describe("function semantic constraints", () => {
  it("builds fn input/output with impl, identity, preserves, and temporal constraints", () => {
    const input = types.object({
      sourceTopic: types.string().meta({ ref: "topic:claude-jsonl" }),
      prompt: types.string(),
    });
    const output = types.object({
      narrativeTopic: types.string(),
      config: types.object({
        sourceTopic: types.string(),
        directive: types.string(),
      }),
      attachTo: types.string(),
    });

    const fn = types.fn({
      input,
      output,
      impl: "kit:summarizer",
      identity: [
        ["config.sourceTopic", "sourceTopic"],
        ["output.attachTo", "output.narrativeTopic"],
        ["config.directive", "prompt"],
      ],
      preserves: [["sourceTopic.tenant", "narrativeTopic.tenant"]],
      temporal: [["gt", "_rt.output", ["add", "_rt.input", 1000]]],
      description: "Summarize transcript events.",
    });

    expect(fn.fieldtype).toBe("function");
    expect(fn.metadata.description).toBe("Summarize transcript events.");
    expect(fn.attributes.find(ConstraintTypes.function.param.describes)?.value).toBe(input);
    expect(fn.attributes.find(ConstraintTypes.function.returns.describes)?.value).toBe(output);
    expect(fn.attributes.find(ConstraintTypes.function.impl.describes)?.id).toBe("kit:summarizer");
    expect(fn.attributes.filter(ConstraintTypes.function.identity.describes)).toEqual([
      expect.objectContaining({ outputPath: "config.sourceTopic", inputPath: "sourceTopic" }),
      expect.objectContaining({ outputPath: "output.attachTo", inputPath: "output.narrativeTopic" }),
      expect.objectContaining({ outputPath: "config.directive", inputPath: "prompt" }),
    ]);
    expect(fn.attributes.find(ConstraintTypes.function.preserves.describes)).toEqual(
      expect.objectContaining({
        inputPath: "sourceTopic.tenant",
        outputPath: "narrativeTopic.tenant",
      }),
    );
    expect(fn.attributes.find(ConstraintTypes.function.temporal.describes)).toEqual(
      expect.objectContaining({
        dir: "gt",
        lhs: "_rt.output",
        bound: ["add", "_rt.input", 1000],
      }),
    );
  });

  it("supports fluent function constraints", () => {
    const fn = FieldType.function
      .create()
      .param(types.object({ x: types.number() }))
      .returns(types.object({ y: types.number() }))
      .impl("tool.double")
      .identity("y", "x")
      .preserves("*")
      .save();

    expect(fn.attributes.find(ConstraintTypes.function.impl.describes)?.id).toBe("tool.double");
    expect(fn.attributes.find(ConstraintTypes.function.identity.describes)).toEqual(
      expect.objectContaining({ outputPath: "y", inputPath: "x" }),
    );
    expect(fn.attributes.find(ConstraintTypes.function.preserves.describes)).toEqual(
      expect.objectContaining({ inputPath: "*" }),
    );
  });
});

describe("generic semantic claims", () => {
  it("stores cross-tool claims as serializable type data without runtime commitment state", () => {
    const service = types.object({
      setReport: types.fn(types.object({ body: types.string() }), types.object({ id: types.string() })),
      getReport: types.fn(types.object({ id: types.string() }), types.object({ body: types.string() })),
    }).claim("identity", {
      lhs: "getReport.output.body",
      rhs: "setReport.input.body",
      scope: "object",
      temporal: { until: ["add", "setReport.output._rt", 86_400_000] },
      confidence: 0.99,
    }).save();

    const claim = service.attributes.find(ConstraintTypes.any.claim.describes);
    expect(claim).toEqual(expect.objectContaining({
      basetype: "any",
      constrainttype: "claim",
      claimtype: "identity",
      lhs: "getReport.output.body",
      rhs: "setReport.input.body",
      confidence: 0.99,
    }));
    expect(isBehavioralConstraint(claim)).toBe(true);
    expect(JSON.parse(JSON.stringify(claim))).toEqual(claim);
  });
});
