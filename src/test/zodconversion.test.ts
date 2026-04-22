import z from "zod";
import { zodToFieldType } from "../builders.js";
import { FieldType } from "../type.js";

const isLen = (a: any) =>
  a?.basetype === "string" && a?.constrainttype === "length";
const isMin = (a: any) =>
  a?.basetype === "number" && a?.constrainttype === "min";
const isMax = (a: any) =>
  a?.basetype === "number" && a?.constrainttype === "max";
const isInt = (a: any) =>
  a?.basetype === "number" && a?.constrainttype === "integer";
const isArrValues = (a: any) =>
  a?.basetype === "array" && a?.constrainttype === "values";
const isArrAcc = (a: any) =>
  a?.basetype === "array" && a?.constrainttype === "accumulate";
const isObjProp = (a: any) =>
  a?.basetype === "object" && a?.constrainttype === "property";

describe("zodToFieldType()", () => {
  it("ZodString.min → string.length(min)", () => {
    const ft = zodToFieldType(z.string().min(2));
    expect(FieldType.string.describes(ft)).toBe(true);
    const len = (ft.attributes as any[]).find(isLen);
    expect(len.min).toBe(2);
  });

  it("ZodNumber: int + min + max", () => {
    const ft = zodToFieldType(z.number().int().min(1).max(5));
    expect(FieldType.number.describes(ft)).toBe(true);
    const attrs = ft.attributes as any[];
    expect(attrs.some(isInt)).toBe(true);
    expect(attrs.find(isMin)?.value).toBe(1);
    expect(attrs.find(isMax)?.value).toBe(5);
  });

  it('ZodObject({ a: z.number() }) → property "a" with number type', () => {
    const ft = zodToFieldType(z.object({ a: z.number() }));
    expect(FieldType.object.describes(ft)).toBe(true);
    const prop = (ft.attributes as any[]).find(isObjProp);
    expect(prop.key).toBe("a");
    expect(prop.value.fieldtype).toBe("number");
  });

  it("ZodArray(z.string()).min(2) → values(inner) + accumulate(min)", () => {
    const ft = zodToFieldType(z.array(z.string()).min(2));
    expect(FieldType.array.describes(ft)).toBe(true);
    const attrs = ft.attributes as any[];
    expect(attrs.some(isArrValues)).toBe(true);
    expect(attrs.some(isArrAcc)).toBe(true);
    const acc = attrs.find(isArrAcc);
    expect(acc.items.min).toBe(2);
  });

  it("ZodUnion → or type of all options", () => {
    const ft = zodToFieldType(z.union([z.string(), z.number()]));
    expect(FieldType.or.describes(ft)).toBe(true);
    const kids = (ft.attributes as any[]).filter(
      (a: any) => a?.type === "baseType",
    );
    expect(kids.map((k: any) => k.fieldtype)).toEqual(["string", "number"]);
  });
});
