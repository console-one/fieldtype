import { FieldTypeBuilder } from "./builders.js";
import { ConstraintTypes, NumberConstraint, StringConstraint } from "./constraint.js";
import { FieldTypeError } from "./error.js";
import { FieldTypeEvent } from "./event.js";
import { FieldType } from "./type.js";

export type JsonSchema = {
    type?: string | string[];
    properties?: Record<string, JsonSchema>;
    patternProperties?: Record<string, JsonSchema>;
    additionalProperties?: boolean | JsonSchema;
    required?: string[];
    items?: JsonSchema | JsonSchema[];
    prefixItems?: JsonSchema[];              // 2020-12 tuple form
    contains?: JsonSchema;                   // 2019-09 / 2020-12
    minContains?: number;                    // 2019-09 / 2020-12
    maxContains?: number;                    // 2019-09 / 2020-12
    minItems?: number;
    maxItems?: number;
    uniqueItems?: boolean;
    enum?: any[];
    const?: any;
    anyOf?: JsonSchema[];
    oneOf?: JsonSchema[];
    allOf?: JsonSchema[];
    not?: JsonSchema;
    minimum?: number;
    maximum?: number;
    exclusiveMinimum?: number;
    exclusiveMaximum?: number;
    multipleOf?: number;
    minLength?: number;
    maxLength?: number;
    pattern?: string;
    format?: string;
    $ref?: string;
  
    // common “bundled” homes for defs
    $defs?: Record<string, JsonSchema>;
    definitions?: Record<string, JsonSchema>;
    components?: { schemas?: Record<string, JsonSchema> };
  
    [k: string]: any;
  };
  
  export type JsonSchemaOpts = {
    /** Root schema used for local $ref like "#/$defs/Foo" or "#/components/schemas/Foo" */
    root?: JsonSchema;
    /** Additional named definitions (external bundle or merged) */
    defs?: Record<string, JsonSchema>;
    /** Custom resolver for non-local refs (optional) */
    resolveRef?: (ref: string) => JsonSchema | undefined;
  };
  
  const LocalCheckWeakmap: WeakMap<any, any> = new WeakMap();
  
  export function analyze(x: any, map: WeakMap<any, any>) {
    if (typeof x === "object" && x) {
      if (FieldType.describes(x)) return true;
      if (x instanceof FieldTypeBuilder) return true;
      if (FieldTypeEvent.describes(x)) return true;
      if (ConstraintTypes.describes(x)) return true;
      for (const value of Object.values(x)) {
        if (typeof value === "object" && recursiveLocalCheck(value, map)) return true;
      }
    }
    return false;
  }

  export function recursiveLocalCheck(x: any, map = LocalCheckWeakmap) {
    if (!map.has(x)) {
      map.set(x, analyze(x, map));
    }
    return map.get(x) as boolean;
  }
  
  const JSON_SCHEMA_KEYWORDS = new Set([
    'type', '$ref', 'properties', 'items', 'prefixItems', 'anyOf', 'oneOf',
    'allOf', 'not', 'enum', 'const', '$defs', 'definitions', 'components',
    'additionalProperties', 'patternProperties', 'required', 'minimum',
    'maximum', 'exclusiveMinimum', 'exclusiveMaximum', 'minLength', 'maxLength',
    'pattern', 'format', 'minItems', 'maxItems', 'uniqueItems', 'multipleOf',
    'contains', 'minContains', 'maxContains', '$schema', '$id',
  ]);

  export function isJsonSchemaLike(x: any): x is JsonSchema {
    if (!x || typeof x !== "object" || Array.isArray(x)) return false;
    if (recursiveLocalCheck(x)) return false;
    const keys = Object.keys(x);
    if (keys.length === 0) return false;
    // Must have at least one JSON Schema keyword to distinguish from shorthand objects
    return keys.some(k => JSON_SCHEMA_KEYWORDS.has(k));
  }
  
  export function makeRefResolver(opts: JsonSchemaOpts = {}) {
    const root = opts.root;
    const defs = {
      ...(root?.$defs ?? {}),
      ...(root?.definitions ?? {}),
      ...(root?.components?.schemas ?? {}),
      ...(opts.defs ?? {}),
    } as Record<string, JsonSchema>;
  
    const byPointer = (ptr: string): JsonSchema | undefined => {
      if (!root || !ptr.startsWith("#/")) return undefined;
      const parts = ptr
        .slice(2)
        .split("/")
        .map(s => s.replace(/~1/g, "/").replace(/~0/g, "~"));
      let cur: any = root;
      for (const p of parts) {
        cur = cur?.[p];
        if (cur === undefined) return undefined;
      }
      return cur as JsonSchema;
    };
  
    return (ref: string): JsonSchema | undefined => {
      if (!ref) return undefined;
  
      // JSON Pointer inside the same document
      const local = byPointer(ref);
      if (local) return local;
  
      // Common short forms: "#/$defs/Name", "#/definitions/Name", "#/components/schemas/Name"
      const key = ref.replace(/^#\/(\$defs|definitions|components\/schemas)\//, "");
      if (defs[key]) return defs[key];
  
      return opts.resolveRef?.(ref);
    };
  }
  
export function jsonStringTypeToFT(s: JsonSchema): FieldType {
    const attrs: StringConstraint[] = [];
    if (s.minLength != null || s.maxLength != null) {
      attrs.push(ConstraintTypes.string.length.create({ min: s.minLength, max: s.maxLength }));
    }
    if (typeof s.pattern === "string") {
      try { attrs.push(ConstraintTypes.string.matches.create(new RegExp(s.pattern))); } catch {}
    }
    const ft = FieldType.string.create({ attributes: attrs });
    if (s.format) ft.meta({ format: s.format });
    return ft.save();
  }
  
export function jsonNumberTypeToFT(s: JsonSchema): FieldType {
    const attrs: NumberConstraint[] = [];
    if (s.type === "integer") attrs.push(ConstraintTypes.number.integer.create());
    if (s.minimum != null) attrs.push(ConstraintTypes.number.min.create(s.minimum));
    if (s.maximum != null) attrs.push(ConstraintTypes.number.max.create(s.maximum));
    if (s.exclusiveMinimum != null) attrs.push(ConstraintTypes.number.exclusiveMin.create(s.exclusiveMinimum));
    if (s.exclusiveMaximum != null) attrs.push(ConstraintTypes.number.exclusiveMax.create(s.exclusiveMaximum));
    if (s.multipleOf != null) attrs.push(ConstraintTypes.number.multipleOf.create(s.multipleOf));
    return FieldType.number.create({ attributes: attrs }).save();
  }
  
export function jsonObjectTypeToFT(s: JsonSchema, opts: JsonSchemaOpts, convert: (j: JsonSchema) => FieldType): FieldType {
    let ft = FieldType.object.create();
    const req = new Set<string>(s.required ?? []);
    for (const [k, v] of Object.entries(s.properties ?? {})) {
      ft = ft.property(k, convert(v), { optional: !req.has(k) });
    }
    for (const [k, v] of Object.entries(s.patternProperties ?? {})) {
      ft = ft.properties(new RegExp(k), convert(v));
    }
    if (s.additionalProperties === false) ft = ft.additional(false);
    else if (s.additionalProperties && typeof s.additionalProperties === "object")
      ft = ft.additional(convert(s.additionalProperties));
    return ft.save();
}
  
export function jsonArrayTypeToFT(s: JsonSchema, opts: JsonSchemaOpts, convert: (j: JsonSchema) => FieldType): FieldType {
    let ft = FieldType.array.create();
    const ix = (i: number) => [ConstraintTypes.number.range.create({ min: i, max: i })];
  
    const prefix = (s as any).prefixItems as JsonSchema[] | undefined;
    if (Array.isArray(prefix)) prefix.forEach((sch, i) => { ft = ft.index(convert(sch), ix(i)); });
  
    const items = s.items as JsonSchema | JsonSchema[] | undefined;
    if (Array.isArray(items)) items.forEach((sch, i) => { ft = ft.index(convert(sch), ix(i)); });
    else if (items && typeof items === "object") ft = ft.values(convert(items));
  
    if (s.minItems != null || s.maxItems != null) {
      ft = ft.accumulate(ConstraintTypes.number.range.create({ min: s.minItems, max: s.maxItems }), FieldType.any.create());
    }
    if (s.uniqueItems) {
      const ev: any = FieldTypeEvent.patch.create({ target: ft.toEvent(), attributes: ConstraintTypes.array.unique.create(true) });
      ft = FieldType.extend(ft, ev);
    }
    if (s.contains) {
      const ev: any = FieldTypeEvent.patch.create({
        target: ft.toEvent(),
        attributes: ConstraintTypes.array.contains.create(convert(s.contains), { min: s.minContains, max: s.maxContains }),
      });
      ft = FieldType.extend(ft, ev);
    }
    return ft.save();
}
  
/** JSON Schema → FieldType (handles local $ref + $defs/definitions/components.schemas) */
export function jsonSchemaToFieldType(schema: JsonSchema, opts: JsonSchemaOpts = {}): FieldType {
    const resolveRef = makeRefResolver({ root: opts.root ?? schema, defs: opts.defs, resolveRef: opts.resolveRef });
  
    const convert = (s: JsonSchema): FieldType => {
      if (s.$ref) {
        const target = resolveRef(s.$ref);
        if (!target) throw new FieldTypeError('UNRESOLVED_REF', `jsonSchemaToFieldType: cannot resolve $ref: ${s.$ref}`, undefined, { ref: s.$ref });
        return convert(target);
      }
  
      if (Object.prototype.hasOwnProperty.call(s, "const")) {
        return FieldType.any.create().literal((s as any).const).save();
      }
      if (Array.isArray(s.enum) && s.enum.length) {
        return FieldType.or.create(s.enum.map(v => FieldType.any.create().literal(v).save()));
      }
  
      if (Array.isArray(s.anyOf) && s.anyOf.length) return FieldType.or.create(s.anyOf.map(convert));
      if (Array.isArray(s.oneOf) && s.oneOf.length) return FieldType.or.create(s.oneOf.map(convert));
      if (Array.isArray(s.allOf) && s.allOf.length) return FieldType.and.create(s.allOf.map(convert));
      if (s.not) return FieldType.not.create(convert(s.not));
  
      if (!s.type) {
        if (s.properties || s.patternProperties || s.additionalProperties !== undefined) return jsonObjectTypeToFT(s, opts, convert);
        if (s.items || (s as any).prefixItems) return jsonArrayTypeToFT(s, opts, convert);
        return FieldType.any.create();
      }
  
      if (Array.isArray(s.type)) {
        // If 'type' is a list, treat it as a union of primitive base types.
        return FieldType.or.create(s.type.map(t => convert({ type: t })));
      }
  
      switch (s.type) {
        case "string":  return jsonStringTypeToFT(s);
        case "number":
        case "integer": return jsonNumberTypeToFT(s);
        case "boolean": return FieldType.boolean.create();
        case "null":    return FieldType.null.create();
        case "object":  return jsonObjectTypeToFT(s, opts, convert);
        case "array":   return jsonArrayTypeToFT(s, opts, convert);
        default:        return FieldType.any.create();
      }
    };
  
    return convert(schema);
}
  