import { FieldTypeBuilder } from "../builders.js";
import { FieldType } from "../type.js";

describe("Metadata – creation + patch aggregation", () => {
  it("builder meta() sets creation metadata on the node", () => {
    const n = FieldTypeBuilder.string().meta({ ui: "label", doc: "Username" }).build();
    expect(n.metadata).toEqual({ ui: "label", doc: "Username" });
  });

  it("fluent .meta() creates a metadata-only patch and node.metadata merges last-write-wins", () => {
    let s = FieldType.string.create();                // creation: {}
    s = s.meta({ a: 1 }).save();                      // patch 1
    s = s.meta({ b: 2, a: 9 }).save();                // patch 2 overrides a
    expect(s.metadata).toEqual({ a: 9, b: 2 });
  });

  it("metadata remains an object (never undefined) on base nodes without explicit metadata", () => {
    const s = FieldType.string.create();
    expect(s.metadata).toEqual({});
  });

  it("metadata-only patches are included in toEvents()", () => {
    const s = FieldType.string.create().meta({ foo: "bar" }).save();
    const evs = s.toEvents();
    expect(evs.length).toBe(2);               // state + one patch
    expect(evs[1].eventtype).toBe("patch");
    expect((evs[1] as any).metadata).toEqual({ foo: "bar" });
  });
});