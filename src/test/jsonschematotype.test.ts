
// Adjust these imports to your project layout if needed:
import {
  types,
} from "../builders.js";
import { jsonSchemaToFieldType } from "../jsonschema.js";
import { canonFT } from "../normalize.js";



describe("jsonSchemaToFieldType – core shapes", () => {
  it("primitive: string", () => {
    const schema = { type: "string" } as const;
    const actual = jsonSchemaToFieldType(schema);
    const expected = types.from("string");

    expect(canonFT(actual)).toEqual(canonFT(expected));
  });

  it("object with required/optional", () => {
    const schema = {
      type: "object",
      properties: {
        name: { type: "string" },
        age: { type: "integer" },
      },
      required: ["name"],
      // note: we skip additionalProperties:false here because shorthand
      // does not carry that knob (we test pure shape equivalence)
    } ;

    const actual = jsonSchemaToFieldType(schema);
    const expected = types.from({
      name: "string",
      "age?": "integer",
    });
    
    expect(canonFT(actual)).toEqual(canonFT(expected));
  });

  it("array of strings", () => {
    const schema = { type: "array", items: { type: "string" } } as const;

    const actual = jsonSchemaToFieldType(schema);
    const expected = types.from("string[]");

    expect(canonFT(actual)).toEqual(canonFT(expected));
  });

  it("tuple (draft-07 items array)", () => {
    const schema = {
      type: "array",
      items: [{ type: "string" }, { type: "number" }],
      minItems: 2,
      maxItems: 2,
    } as const;

    const actual = jsonSchemaToFieldType(schema);

    console.log("Actual: ", actual);
    console.log("Canon Actual: ", canonFT(actual))

    const expected = types.from(["string", "number"]);

    console.log("Expected: ", expected);
    console.log("Canon Expected: ", canonFT(expected))
    

    expect(canonFT(actual)).toEqual(canonFT(expected));
  });

  it("tuple (2020-12 prefixItems)", () => {
    const schema = {
      type: "array",
      prefixItems: [{ type: "string" }, { type: "integer" }],
      minItems: 2,
      maxItems: 2,
    };

    const actual = jsonSchemaToFieldType(schema);
    const expected = types.from(["string", "integer"]);

    expect(canonFT(actual)).toEqual(canonFT(expected));
  });

  it("union via anyOf", () => {
    const schema = {
      anyOf: [{ type: "string" }, { type: "integer" }],
    } ;

    const actual = jsonSchemaToFieldType(schema);
    const expected = types.from("string|integer");

    expect(canonFT(actual)).toEqual(canonFT(expected));
  });

  it('union via "type": ["string","null"]', () => {
    const schema = {
      type: ["string", "null"],
    } ;

    const actual = jsonSchemaToFieldType(schema);
    const expected = types.from("string|null");

    expect(canonFT(actual)).toEqual(canonFT(expected));
  });
});

describe("jsonSchemaToFieldType – $ref resolution", () => {
  it("resolves local $ref in $defs", () => {
    const root = {
      $defs: {
        Id: { type: "string" },
      },
      type: "object",
      properties: {
        id: { $ref: "#/$defs/Id" },
      },
      required: ["id"],
    };

    const actual = jsonSchemaToFieldType(root, { root });
    const expected = types.from({ id: "string" });

    expect(canonFT(actual)).toEqual(canonFT(expected));
  });

  it("resolves OpenAPI-style $ref in components.schemas", () => {
    const root = {
      components: {
        schemas: {
          Id: { type: "integer" },
        },
      },
      type: "object",
      properties: {
        id: { $ref: "#/components/schemas/Id" },
      },
      required: ["id"],
    };

    const actual = jsonSchemaToFieldType(root, { root });
    const expected = types.from({ id: "integer" });



    expect(canonFT(actual)).toEqual(canonFT(expected));
  });

  it("throws for unresolved $ref", () => {
    const root = {
      type: "object",
      properties: {
        id: { $ref: "#/$defs/Id" }, // no $defs present
      },
      required: ["id"],
    };

    expect(() => jsonSchemaToFieldType(root, { root })).toThrow(
      /cannot resolve \$ref/i
    );
  });
});
