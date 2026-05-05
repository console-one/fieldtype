import { FieldTypeEvent } from "../event.js";
import { ConstraintTypes } from "../constraint.js";
import {
  FieldTypeEventSchema,
  PatchFieldTypeEventSchema,
  CreateFieldTypeEventSchema,
} from "../schema.js";
import { validate } from "../builders.js";
import { FieldType } from "../type.js";

describe("FieldTypeEvent schema", () => {
  describe("patch events", () => {
    it("accepts a valid patch event with single attribute", () => {
      const ev = FieldTypeEvent.patch.create({
        target: "prev-evt-id",
        attributes: ConstraintTypes.number.min.create(10),
        metadata: { note: "raise min" },
        extension: FieldType.number.create(), // shape signal only
      });

      const res = validate(PatchFieldTypeEventSchema, ev);
      expect(res.ok).toBe(true);
    });

    it("accepts a valid patch event with attributes as an array", () => {
      const ev = FieldTypeEvent.patch.create({
        target: "prev-evt-id",
        attributes: [
          ConstraintTypes.string.length.create({ min: 2 }),
          ConstraintTypes.string.includes.create("x"),
        ],
        metadata: { doc: "combine constraints" },
      });

      const res = validate(PatchFieldTypeEventSchema, ev);
      expect(res.ok).toBe(true);
    });

    it("rejects patch event with wrong type literal", () => {
      const bad: any = {
        type: "WRONG",
        eventtype: "patch",
        id: "x",
        target: "prev",
      };
      const res = validate(PatchFieldTypeEventSchema, bad);
      expect(res.ok).toBe(false);
    });

    it("rejects patch event missing id", () => {
      const bad = FieldTypeEvent.patch.create({
        target: "prev",
      }) as any;
      // delete id to simulate malformed input
      delete bad.id;

      const res = validate(PatchFieldTypeEventSchema, bad);
      expect(res.ok).toBe(false);
    });
  });

  describe("state (create) events", () => {
    it("accepts a valid create event", () => {
      const ev = FieldTypeEvent.state.create({
        fieldtype: "string",
        attributes: [ConstraintTypes.string.length.create({ min: 1 })],
        metadata: { ok: true },
        extensions: [],
      });
      const res = validate(CreateFieldTypeEventSchema, ev);
      expect(res.ok).toBe(true);
    });

    it("rejects create event with unsupported fieldtype", () => {
      const ev = FieldTypeEvent.state.create({
        fieldtype: "funky",
        attributes: [],
      }) as any;

      const res = validate(CreateFieldTypeEventSchema, ev);
      expect(res.ok).toBe(false);
    });

    it("rejects create event when id is missing", () => {
      const ev = FieldTypeEvent.state.create({
        fieldtype: "number",
        attributes: [],
      }) as any;
      delete ev.id;

      const res = validate(CreateFieldTypeEventSchema, ev);
      expect(res.ok).toBe(false);
    });
  });

  describe("union schema", () => {
    it("validates either state or patch", () => {
      const state = FieldTypeEvent.state.create({ fieldtype: "any" });
      const patch = FieldTypeEvent.patch.create({ target: "id-1" });

      expect(validate(FieldTypeEventSchema, state).ok).toBe(true);
      expect(validate(FieldTypeEventSchema, patch).ok).toBe(true);
    });
  });
});
