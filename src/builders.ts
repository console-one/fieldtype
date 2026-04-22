import z, { ZodSchema } from "zod";
import {
  ArrayConstraint,
  ArrayContainsConstraint,
  ArrayIndexRange,
  ArrayNamedConstraint,
  ConstraintTypes,
  FieldConstraintType,
  LiteralConstraint,
  NumberConstraint,
  ObjectConstraint,
  StringConstraint,
  type ConstraintRefValue,
  isConstraintRef,
} from "./constraint.js";
import {
  ArrayType,
  BooleanType,
  cloneType,
  FieldType,
  FunctionType,
  NullType,
  NumberType,
  ObjectType,
  StringType,
} from "./type.js";
import type { Shaped, Elemented, Varianted, Composed, Functioned } from "./infer.js";


import { FieldTypePatchEvent } from "./event.js";
import { FieldTypeError } from "./error.js";

/** @deprecated Use `types.*` builders instead (e.g. `types.string()`, `types.object({...})`). */
export class FieldTypeBuilder<T extends FieldType = FieldType> {
  private constructor(readonly _node?: FieldType) {}

  get node() {
    if (this._node === undefined) throw new FieldTypeError('INTERNAL', 'FieldTypeBuilder: node is undefined — builder was not initialized with a FieldType')
    return this._node; 
  }

  static string(opts: { attributes?: StringConstraint[] } = {}) {
    return new FieldTypeBuilder(FieldType.string.create(opts));
  }

  static number(opts: { attributes?: NumberConstraint[] } = {}) {
    return new FieldTypeBuilder(FieldType.number.create(opts));
  }

  static object(opts: { attributes?: ObjectConstraint[] } = {}) {
    return new FieldTypeBuilder(FieldType.object.create(opts));
  }

  static any() {
    return new FieldTypeBuilder(FieldType.any.create());
  }

  static fromZod(schema: z.ZodTypeAny) {
    return new FieldTypeBuilder(zodToFieldType(schema));
  }

  static array(opts: { attributes?: ArrayConstraint[] } = {}) {
    return new FieldTypeBuilder(FieldType.array.create(opts));
  }

  static function() {
    return new FieldTypeBuilder(FieldType.function.create());
  }

  static fromJSONSchema(schema: JsonSchema, opts?: JsonSchemaOpts) {
    return new FieldTypeBuilder(jsonSchemaToFieldType(schema, opts));
  }

  /** Auto‑detect Zod / JSON Schema / shorthand */
  static from(input: unknown, opts?: JsonSchemaOpts) {
    return new FieldTypeBuilder(toFieldType(input, opts));
  }


  /* ---- combinators --------------------------------------------- */
  or(...others: (FieldType | FieldTypeBuilder)[]) {
    return new FieldTypeBuilder(
      FieldType.or.create([this.node, ...others.map(extractNode)]),
    );
  }

  and(...others: (FieldType | FieldTypeBuilder)[]) {
    return new FieldTypeBuilder(
      FieldType.and.create([this.node, ...others.map(extractNode)]),
    );
  }

  not() {
    return new FieldTypeBuilder(FieldType.not.create(this.node));
  }

  meta(meta: Record<string, any>) {
    // the node’s `metadata` lives on its creation/update record
    const upd = (this.node as any).update;
    upd.metadata = { ...(upd.metadata ?? {}), ...meta };
    return this as unknown as FieldTypeBuilder<T>;
  }

  /* ---- attribute helpers --------------------------------------- */
  readonly attr = {
    length: (p: Parameters<typeof ConstraintTypes.string.length.create>[0]) => {
      ensureAttr(this.node, ConstraintTypes.string.length.create(p));
      return this as FieldTypeBuilder<T>;
    },
    range: (p: Parameters<typeof ConstraintTypes.number.range.create>[0]) => {
      ensureAttr(this.node, ConstraintTypes.number.range.create(p));
      return this as FieldTypeBuilder<T>;
    },
    property: (
      k: string,
      t: FieldType,
      opts: { optional?: boolean; default?: unknown; reason?: string } = {},
    ) => {
      ensureAttr(this.node, ConstraintTypes.object.property.create(k, t, opts));
      return this as FieldTypeBuilder<T>;
    },
    properties: (t: FieldType, k: RegExp = /^.*/, reason?: string) => {
      ensureAttr(
        this.node,
        reason === undefined
          ? ConstraintTypes.object.properties.create(k, t)
          : ConstraintTypes.object.properties.create(k, t, reason),
      );
      return this as FieldTypeBuilder<T>;
    },
    index: (value: FieldType, range?: ArrayIndexRange[], reason?: string) => {
      ensureAttr(
        this.node,
        ConstraintTypes.array.values.create(value, range, reason),
      );
      return this as FieldTypeBuilder<T>;
    },
    additional: (value: FieldType | false, reason?: string) => {
      ensureAttr(this.node, ConstraintTypes.object.additional.create(value as any, reason));
      return this as FieldTypeBuilder<T>;
    },
    indexBy: (
      by: string,
      value: FieldType,
      opts: { key?: string | RegExp; when?: FieldType; reason?: string } = {},
    ) => {
      ensureAttr(this.node, ConstraintTypes.object.index.create(by, value, opts));
      return this as FieldTypeBuilder<T>;
    }
  };

  /* ---- terminal ------------------------------------------------ */
  build(): T {
    return this.node as T;
  }
}

export class FieldTypePatchBuilder<
  B extends FieldType = FieldType,
  A extends FieldConstraintType = FieldConstraintType,
> {
  private readonly evt: FieldTypePatchEvent<A, B["fieldtype"], B>;

  constructor(target: B) {
    this.evt = {
      type: "fieldtypeevent",
      id: crypto.randomUUID(),
      target: (target as any).update.id,
    } as any;
  }

  attrs(attrs: A) {
    (this.evt.attributes as any) = attrs;
    return this;
  }

  meta(m: Record<string, any>) {
    this.evt.metadata = { ...(this.evt.metadata ?? {}), ...m };
    return this;
  }

  extension(ext: B) {
    (this.evt.extension as any) = ext;
    return this;
  }
  
  build() {
    return this.evt;
  }
}


// export const patchWhere = (override: Tree<TypeFromInput>) => {
//   let initialOptsState = override.metadata.state;
//   let transitions = Tree.create(override.metadata.transitions);

//   walk(initialOptsState,

// }

/* ---------- 5. Zod ⇢ FieldType (unchanged except Reqs removed) --- */

export function zodToFieldType(schema: z.ZodTypeAny): FieldType {
  // and add array in here

  if (schema instanceof z.ZodString) {
    const out: StringConstraint[] = [];
    for (const c of (schema as any)._def.checks) {
      if (c.kind === "min" || c.kind === "max")
        out.push(
          ConstraintTypes.string.length.create(
            c.kind === "min" ? { min: c.value } : { max: c.value },
          ),
        );
      if (c.kind === "regex")
        out.push(ConstraintTypes.string.matches.create(c.regex));
    }
    return FieldType.string.create({ attributes: out });
  }

  if (schema instanceof z.ZodArray) {
    const inner = zodToFieldType(schema.element as any);
    const attrs: ArrayConstraint[] = [];
  
    const { minLength, maxLength, exactLength } = (schema as any)._def;
  
    if (minLength) {
      const numRange = ConstraintTypes.number.range.create({ min: minLength.value });
      attrs.push(ConstraintTypes.array.accumulate.create(numRange, inner));
    }
    if (maxLength) {
      const numRange = ConstraintTypes.number.range.create({ max: maxLength.value });
      attrs.push(ConstraintTypes.array.accumulate.create(numRange, inner));
    }
    if (exactLength) {
      const numRange = ConstraintTypes.number.range.create({
        min: exactLength.value,
        max: exactLength.value,
      });
      attrs.push(ConstraintTypes.array.accumulate.create(numRange, inner));
    }
  
    // Always store the element-type constraint
    attrs.unshift(ConstraintTypes.array.values.create(inner));
    return FieldType.array.create({ attributes: attrs });
  }

  if (schema instanceof z.ZodBoolean) {
    return FieldType.boolean.create();
  }
  
  if (schema instanceof z.ZodNull) {
    return FieldType.null.create();
  }
  
  if (schema instanceof z.ZodNumber) {
    const out: NumberConstraint[] = [];
    for (const c of (schema as any)._def.checks) {
      if (c.kind === "min") out.push(ConstraintTypes.number.min.create(c.value));
      if (c.kind === "max") out.push(ConstraintTypes.number.max.create(c.value));
      if (c.kind === "int") out.push(ConstraintTypes.number.integer.create());
      if (c.kind === "gt") out.push(ConstraintTypes.number.exclusiveMin.create(c.value));
      if (c.kind === "lt") out.push(ConstraintTypes.number.exclusiveMax.create(c.value));
      if (c.kind === "multipleOf") out.push(ConstraintTypes.number.multipleOf.create(c.value));
    }
    return FieldType.number.create({ attributes: out });
  }

  if (schema instanceof z.ZodObject) {
    const shape = schema.shape;
    const attrs: ObjectConstraint[] = [];
    for (const [k, s] of Object.entries(shape))
      attrs.push(
        ConstraintTypes.object.property.create(
          k,
          zodToFieldType(s as any) as any,
        ),
      );
    return FieldType.object.create({ attributes: attrs });
  }

  if (schema instanceof z.ZodUnion) {
    const opts = (schema as any)._def.options;
    return FieldType.or.create(opts.map(zodToFieldType));
  }

  return FieldType.any.create(); // fallback
}


// --- BEGIN: JSON Schema + shorthand converters ------------------------------------

import { FieldTypeEvent } from "./event.js"; // add to existing imports
import { JsonSchema, JsonSchemaOpts, isJsonSchemaLike, jsonSchemaToFieldType } from './jsonschema.js'

import { ref as artifactRef } from './artifactRef.js'

/** Very small shorthand → FieldType:
 *  - "string" | "number" | "integer" | "boolean" | "null" | "any" | "object"
 *  - "T[]" or "Array<T>"
 *  - unions via "A|B"
 *  - tuples via arrays: ["string","number",...]
 *  - objects via { key: Type, "optKey?": Type }
 *  - falls through to JSON Schema when it looks like one.
 */
export type TypeFromInput =
  | "string" | "number" | "integer" | "boolean" | "null" | "any" | "object"
  | `${string}[]`
  | { [k: string]: TypeFromInput | JsonSchema }
  | TypeFromInput[]
  | JsonSchema
  | FieldType 
  | ZodSchema 
  | FieldTypeEvent
  | any;
  

function isPlainObject(x: any) {
  return !!x && typeof x === "object" && !Array.isArray(x) && !isJsonSchemaLike(x);
}

function parseTypeToken(tok: string): FieldType {
  const arrMatch = tok.match(/^(Array<(.+)>|(.+)\[\])$/);
  if (arrMatch) {
    const inner = (arrMatch[2] ?? arrMatch[3]).trim();
    return FieldType.array.create().values(parseTypeToken(inner)).save();
  }
  switch (tok) {
    case "string":  return FieldType.string.create();
    case "number":  return FieldType.number.create();
    case "integer": return FieldType.number.create().integer().save();
    case "boolean": return FieldType.boolean.create();
    case "null":    return FieldType.null.create();
    case "object":  return FieldType.object.create();
    case "any":
    default:        return FieldType.any.create();
  }
}

export function isCustomTypeLike(x: any) {
  if (FieldType.describes(x)) return true;
  else if (x instanceof FieldTypeBuilder) return true;
  else if (FieldTypeEvent.describes(x)) return true;
  else if (ConstraintTypes.describes(x)) return true;
  return false;
}

export function toCustomType(x) {
  if (FieldType.describes(x)) return x;
  else if (x instanceof FieldTypeBuilder) return x.build();
  else if (FieldTypeEvent.describes(x)) return FieldType.fromEvent(x);
  return x;
}

/**
 * Convert an arbitrary input to a FieldType. Prefer `types.from()` over
 * importing this function directly by name.
 */
export function disambiguateFieldType(input: TypeFromInput, opts: { clone?: boolean } & any = {}): FieldType {

  if (FieldType.describes(input)) {
    return (opts.clone !== undefined && opts.clone) ? cloneType(input) : input;
  }

  if (FieldTypeEvent.describes(input)) {
    return FieldType.fromEvent(input);
  }

  if (input instanceof ZodSchema) {
    return zodToFieldType(input)
  }

  if ((input as any)?._def?.typeName?.startsWith?.("Zod")) return zodToFieldType(input as any);
  
  if (isJsonSchemaLike(input)) {
    return jsonSchemaToFieldType(input as any, opts);
  }


  if (typeof input === "string") {
    const parts = input.split("|").map(s => s.trim()).filter(Boolean);
    return parts.length > 1 ? FieldType.or.create(parts.map(parseTypeToken)) : parseTypeToken(parts[0]);
  }

  if (Array.isArray(input)) {
    // tuple
    let a = FieldType.array.create();
    input.forEach((entry, i) => {
      const ft = disambiguateFieldType(entry as any);
      const r = ConstraintTypes.number.range.create({ min: i, max: i });
      a = a.index(ft, [r]);
    });
    a = a.accumulate(ConstraintTypes.number.range.create({ min: input.length, max: input.length }), FieldType.any.create());
    return a.save();
  }

  if (isCustomTypeLike(input)) {
    return toCustomType(input);
  }

  if (isPlainObject(input)) {
    let o = FieldType.object.create();
    for (const [rawKey, v] of Object.entries(input as Record<string, any>)) {
      const optional = rawKey.endsWith("?");
      const key = optional ? rawKey.slice(0, -1) : rawKey;
      o = o.property(key, disambiguateFieldType(v), { optional });
    }
    return o.save();
  }

  return FieldType.any.create();
}

/** Auto‑detect among Zod, JSON Schema, and shorthand */
export function toFieldType(input: unknown, opts?: any): FieldType {
  // Zod (best‑effort detection without direct instanceof to avoid hard dep shape changes)

  return disambiguateFieldType(input as any);
}

// --- END: JSON Schema + shorthand converters --------------------------------------




/* ---------- 6. Basic validator (no pending refs) ---------------- */

export type ValidationError = { path: (string | number)[]; message: string };
export type ValidationOutcome =
  | { status: "valid" }
  | { status: "invalid"; errors: ValidationError[] };

export function validate(node: FieldType, data: unknown): ValidationOutcome {
  const errs: ValidationError[] = [];
  walk(node, data, [], errs);
  return errs.length
    ? { status: "invalid", errors: errs }
    : { status: "valid" };
}

/* --- recursive walker ------------------------------------------ */

function walk(
  n: FieldType,
  val: unknown,
  path: (string | number)[],
  out: ValidationError[],
) {
  switch (n.fieldtype) {
    case "any":
      runAttr(n.attributes, val, path, out);
      break;

    case "string":
      if (typeof val !== "string") {
        out.push({ path, message: "expected string" });
        return;
      }
      runAttr(n.attributes ?? [], val, path, out);
      break;

    case "number":
      if (typeof val !== "number") {
        out.push({ path, message: "expected number" });
        return;
      }
      runAttr(n.attributes ?? [], val, path, out);
      break;

    case "object":
      if (typeof val !== "object" || val === null || Array.isArray(val)) {
        out.push({ path, message: "expected object" });
        return;
      }
      // enforce ANY-level attrs (e.g., literal) on objects too
      runAttr(n.attributes ?? [], val, path, out);
      runObjAttr(
        n.attributes.filter(ConstraintTypes.object.describes),
        val as Record<string, unknown>,
        path,
        out,
      );
      break;

    case "array":
      if (!Array.isArray(val)) {
        out.push({ path, message: "expected array" });
        return;
      }
      // enforce ANY-level attrs (e.g., literal) on arrays too
      runAttr(n.attributes ?? [], val, path, out);
      runArrAttr(
        n.attributes.filter(ConstraintTypes.array.describes),
        val as unknown[],
        path,
        out,
      );
      break;

    case "or":
      let orTypeAttributes: FieldType[] = n.attributes.filter((attr) =>
        FieldType.describes(attr),
      ) as FieldType[];
      if (
        !orTypeAttributes.some(
          (child) => validate(child, val).status === "valid",
        )
      )
        out.push({ path, message: "no OR branch matched" });
      break;

    case "and":
      let andTypeAttributes: FieldType[] = n.attributes.filter((attr) =>
        FieldType.describes(attr),
      ) as FieldType[];
      andTypeAttributes.forEach((child) => walk(child, val, path, out));
      break;

    case "not":
      let notTypeAttributes: FieldType[] = n.attributes.filter((attr) =>
        FieldType.describes(attr),
      ) as FieldType[];
      if (validate(notTypeAttributes[0], val).status === "valid")
        out.push({ path, message: "negated type matched" });
      break;

    case "function":
      if (typeof val !== "function") {
        out.push({ path, message: "expected function" });
        return;
      }
      // Function signature validation happens at call site, not here
      runAttr(n.attributes ?? [], val, path, out);
      break;
  }
}

/* --- attribute evaluators -------------------------------------- */

function runAttr(
  attrs: FieldConstraintType[],
  v: any,
  path: (string | number)[],
  out: ValidationError[],
) {
  attrs.forEach((a) => {
    // ANY.literal applies to any base type (deep equality)
    if (ConstraintTypes.any.describes(a) && a.constrainttype === "literal") {
      const expected = (a as any).value;
      if (!deepEqual(v, expected)) {
        out.push({ path, message: `must equal ${JSON.stringify(expected)}` });
      }
      return; // literal check is definitive for this attr
    }

    if (ConstraintTypes.string.describes(a) && typeof v === "string") {
      if (a.constrainttype === "matches" && !a.pattern.test(v))
        out.push({ path, message: `does not match ${a.pattern}` });
      if (a.constrainttype === "includes" && !v.includes(a.value))
        out.push({ path, message: `must include ${a.value}` });
      if (a.constrainttype === "length") {
        // Skip ref-valued bounds — deferred until scope resolution
        const lmin = a.min, lmax = a.max;
        if (typeof lmin === 'number' && v.length < lmin)
          out.push({ path, message: `length < ${lmin}` });
        if (typeof lmax === 'number' && v.length > lmax)
          out.push({ path, message: `length > ${lmax}` });
      }
    }

    if (ConstraintTypes.number.describes(a) && typeof v === "number") {
      // Skip ref-valued bounds — deferred until scope resolution
      const av = (a as any).value;
      if (a.constrainttype === "min" && typeof av === 'number' && v < av)
        out.push({ path, message: `must be ≥ ${av}` });
      if (a.constrainttype === "max" && typeof av === 'number' && v > av)
        out.push({ path, message: `must be ≤ ${av}` });
      if (a.constrainttype === "exclusiveMin" && typeof av === 'number' && v <= av)
        out.push({ path, message: `must be > ${av}` });
      if (a.constrainttype === "exclusiveMax" && typeof av === 'number' && v >= av)
        out.push({ path, message: `must be < ${av}` });
      if (a.constrainttype === "integer" && !Number.isInteger(v))
        out.push({ path, message: "must be integer" });
      if (a.constrainttype === "range") {
        const rmin = (a as any).min, rmax = (a as any).max;
        if (typeof rmin === 'number' && v < rmin) out.push({ path, message: `must be ≥ ${rmin}` });
        if (typeof rmax === 'number' && v > rmax) out.push({ path, message: `must be ≤ ${rmax}` });
      }
      if (a.constrainttype === "multipleOf" && typeof av === 'number') {
        if (av === 0 || !isFinite(av)) out.push({ path, message: `invalid multipleOf` });
        else {
          const ratio = v / av;
          const nearInt = Math.round(ratio);
          if (Math.abs(ratio - nearInt) > 1e-12)
            out.push({ path, message: `must be a multiple of ${av}` });
        }
      }
    }
  });
}

function deepEqual(a: any, b: any): boolean {
  if (Object.is(a, b)) return true;
  if (
    typeof a !== "object" ||
    typeof b !== "object" ||
    a === null ||
    b === null
  )
    return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a)) {
    if (a.length !== (b as any).length) return false;
    for (let i = 0; i < a.length; i++)
      if (!deepEqual(a[i], (b as any)[i])) return false;
    return true;
  }
  const ak = Object.keys(a),
    bk = Object.keys(b);
  if (ak.length !== bk.length) return false;
  for (const k of ak) if (!deepEqual(a[k], (b as any)[k])) return false;
  return true;
}


function getByPath(o: any, p: string): any {
  const parts = p.split('.').filter(Boolean);
  let cur = o;
  for (const seg of parts) {
    if (cur == null || typeof cur !== 'object') return undefined;
    cur = cur[seg];
  }
  return cur;
}

function runArrAttr(
  attrs: ArrayConstraint[],
  arr: unknown[],
  path: (string | number)[],
  out: ValidationError[],
) {
  const normalizeRanges = (r?: ArrayIndexRange[] | ArrayIndexRange[][]): ArrayIndexRange[][] => {
    if (!r) return [[ConstraintTypes.number.range.create({})]];
    if (Array.isArray(r) && r.length > 0 && Array.isArray((r as any)[0])) return r as any;
    return [r as ArrayIndexRange[]];
  };

  attrs.forEach((a) => {
    if (a.constrainttype === "values") {
      const ranges = normalizeRanges(a.range);
      const indicies: number[] = [];
      ranges.forEach((rg) =>
        arr.forEach((_, idx) => {
          const ok = rg.every((rc) =>
            rc.constrainttype === "range"
              ? (rc.min == null || typeof rc.min !== 'number' || idx >= rc.min) && (rc.max == null || typeof rc.max !== 'number' || idx <= rc.max)
              : true,
          );
          if (ok) indicies.push(idx);
        }),
      );
      indicies.forEach((i) => walk(a.value as any, arr[i], [...path, i], out));
    }

    if (a.constrainttype === "accumulate") {
      const { items } = a;
      if (items) {
        if ((typeof items.min === 'number' && arr.length < items.min) ||
            (typeof items.max === 'number' && arr.length > items.max)) {
          out.push({ path, message: `array length out of range` });
        }
      }
      arr.forEach((v, i) => walk(a.value as any, v, [...path, i], out));
    }

    if (a.constrainttype === "unique" && a.value) {
      for (let i = 0; i < arr.length; i++) {
        for (let j = i + 1; j < arr.length; j++) {
          if (deepEqual(arr[i], arr[j])) {
            out.push({ path: [...path, j], message: `duplicate array item` });
            i = arr.length; break;
          }
        }
      }
    }

    if (a.constrainttype === "contains") {
      let count = 0;
      for (let i = 0; i < arr.length; i++) {
        const tmp: ValidationError[] = [];
        walk(a.value as any, arr[i], [...path, i], tmp);
        if (tmp.length === 0) count++;
      }
      // Skip ref-valued bounds — deferred until scope resolution
      const cmin = a.min ?? 1;
      const cmax = a.max;
      if (typeof cmin === 'number' && count < cmin) out.push({ path, message: `must contain at least ${cmin} matching items` });
      if (typeof cmax === 'number' && count > cmax) out.push({ path, message: `must contain at most ${cmax} matching items` });
    }

    if (a.constrainttype === "named") {
      const by = a.by ?? 'name';
      const key = a.key;
      const matches: number[] = [];
      for (let i = 0; i < arr.length; i++) {
        const el = arr[i];
        if (el != null && typeof el === 'object') {
          if (getByPath(el, by) === key) matches.push(i);
        }
      }
      for (const idx of matches) {
        walk(a.value as any, arr[idx], [...path, idx], out);
      }
      // Skip ref-valued bounds — deferred until scope resolution
      const nmin = a.min ?? 1;
      const nmax = a.max ?? 1;
      if (typeof nmin === 'number' && matches.length < nmin)
        out.push({ path, message: `block requires at least ${nmin} element(s) with ${by}="${key}", found ${matches.length}` });
      if (typeof nmax === 'number' && matches.length > nmax)
        out.push({ path, message: `block allows at most ${nmax} element(s) with ${by}="${key}", found ${matches.length}` });
    }
  });
}

function runObjAttr(
  attrs: ObjectConstraint[],
  obj: Record<string, unknown>,
  path: (string | number)[],
  out: ValidationError[],
) {
  const propC = attrs.filter(ConstraintTypes.object.property.describes);
  const propsC = attrs.filter(ConstraintTypes.object.properties.describes);
  const addlC = attrs.find(ConstraintTypes.object.additional.describes);
  const indexC = attrs.filter(ConstraintTypes.object.index.describes);

  const visited = new Set<string>();

  // explicit properties
  propC.forEach((a) => {
    if (!(a.key in obj)) {
      if (!(a as any).optional) {
        out.push({ path, message: `missing property ${a.key}` });
      }
    } else {
      visited.add(a.key);
      walk(a.value as any, obj[a.key], [...path, a.key], out);
    }
  });

  // pattern properties
  const ensureRegExp = (item: string | RegExp) => (typeof item === "string" ? new RegExp(item) : item);
  propsC.forEach((a) => {
    const pred =
      typeof a.key === "string"
        ? (k: string) => k === a.key
        : (k: string) => ensureRegExp(a.key).test(k);
    Object.entries(obj)
      .filter(([k]) => pred(k))
      .forEach(([k, v]) => {
        visited.add(k);
        walk(a.value as any, v, [...path, k], out);
      });
  });

  // index / keyed-by: validate map entries and key==value[by]
  indexC.forEach((a) => {
    const pred = !a.key
      ? (_: string) => true
      : typeof a.key === "string"
        ? (k: string) => k === a.key
        : (k: string) => ensureRegExp(a.key!).test(k);

    Object.entries(obj)
      .filter(([k]) => pred(k))
      .forEach(([k, v]) => {
        // guard
        if (a.when) {
          const tmp: ValidationError[] = [];
          walk(a.when as any, v, [...path, k], tmp);
          if (tmp.length > 0) return; // skip when guard fails
        }

        // validate value shape
        walk(a.value as any, v, [...path, k], out);
        visited.add(k);

        // check key equality
        const got = getByPath(v, a.by);
        if (got !== k) {
          out.push({
            path: [...path, k, a.by],
            message: `index key "${k}" must equal value at "${a.by}"`,
          });
        }
      });
  });

  // additional properties
  if (addlC) {
    const extraKeys = Object.keys(obj).filter((k) => !visited.has(k));
    if (addlC.value === false) {
      extraKeys.forEach((k) =>
        out.push({ path: [...path, k], message: `additional properties not allowed` }),
      );
    } else {
      extraKeys.forEach((k) =>
        walk(addlC.value as any, obj[k], [...path, k], out),
      );
    }
  }
}


/* ---------- helpers -------------------------------------------- */

function ensureAttr(node: FieldType, attr: FieldConstraintType) {
  if (
    node.fieldtype === "string" ||
    node.fieldtype === "number" ||
    node.fieldtype === "object" ||
    node.fieldtype === "array" ||
    node.fieldtype === "any"
  ) {
    (node.attributes ??= []).push(attr as any);
  } else {
    throw new FieldTypeError('INVALID_CONSTRAINT', `'${node.fieldtype}' cannot accept attributes`, undefined, { fieldtype: node.fieldtype });
  }
}

const extractNode = (x: FieldType | FieldTypeBuilder) =>
  x instanceof FieldTypeBuilder ? (x as any).node : x;

const string = (
  opts: Parameters<typeof FieldTypeBuilder.string>[0] = {},
): StringType => FieldTypeBuilder.string(opts).build() as StringType;

const number = (
  opts: Parameters<typeof FieldTypeBuilder.number>[0] = {},
): NumberType => FieldTypeBuilder.number(opts).build() as NumberType;
const any = (): FieldType => FieldTypeBuilder.any().build();
function array<E extends FieldType>(el: E): Elemented<E>;
function array(el?: FieldType): ArrayType;
function array(el?: FieldType): any {
  return FieldTypeBuilder.array().attr.index(el ?? any()).build() as ArrayType;
}

type TuplePart = FieldType | TupleOptional | TupleMany;

function toptional(ft: FieldType): TupleOptional {
  return  { __tuple: "optional", ft: ft }
}
function tmany(ft: FieldType): TupleMany {
  return  { __tuple: "many", ft: ft }
}

function tuple(...parts: TuplePart[]): ArrayType {
  if (parts.length === 0) return FieldTypeBuilder.array().build() as ArrayType;

  // Validate layout: optional must be trailing; many must be last.
  let seenOptional = false;
  parts.forEach((p, i) => {
    if (isTupleMany(p) && i !== parts.length - 1) {
      throw new FieldTypeError('INVALID_INPUT', 'types.tuple(...): many(...) must be the final element', [i]);
    }
    if (isTupleOptional(p)) seenOptional = true;
    if (!isTupleOptional(p) && !isTupleMany(p) && seenOptional) {
      throw new FieldTypeError('INVALID_INPUT', 'types.tuple(...): optional(...) elements must be trailing', [i]);
    }
  });

  const b = FieldTypeBuilder.array();
  let requiredCount = 0;
  let hasRest = false;

  parts.forEach((part, idx) => {
    if (isTupleMany(part)) {
      hasRest = true;
      const r = ConstraintTypes.number.range.create({ min: idx });
      b.attr.index(part.ft, [r]);
      return;
    }
    const ft = isTupleOptional(part) ? part.ft : (part as FieldType);
    const r = ConstraintTypes.number.range.create({ min: idx, max: idx });
    b.attr.index(ft, [r]);
    if (!isTupleOptional(part)) requiredCount++;
  });

  // Enforce overall length via accumulate; use `any` so we don't over-constrain elements.
  const itemsRange = ConstraintTypes.number.range.create({
    min: requiredCount,
    max: hasRest ? undefined : parts.length,
  });
  ensureAttr((b as any).node, ConstraintTypes.array.accumulate.create(itemsRange, FieldType.any.create()));
  return b.build() as ArrayType;
}

/* ---------- block builders ------------------------------------- */

function block(parts: (ArrayNamedConstraint | ArrayContainsConstraint)[]): ArrayType {
  const b = FieldTypeBuilder.array();
  for (const part of parts) {
    ensureAttr((b as any).node, part);
  }
  return b.build() as ArrayType;
}

function assignment(
  key: string,
  type: FieldType,
  opts: {
    by?: string;
    min?: ConstraintRefValue<number>;
    max?: ConstraintRefValue<number>;
    reason?: string;
    description?: string;
    placeholder?: string;
    inputType?: string;
    default?: unknown;
  } = {},
): ArrayNamedConstraint {
  return ConstraintTypes.array.named.create(key, type, opts);
}

function zeroToMany(type: FieldType): ArrayContainsConstraint {
  return ConstraintTypes.array.contains.create(type, { min: 0 });
}

function zeroToOne(type: FieldType): ArrayContainsConstraint {
  return ConstraintTypes.array.contains.create(type, { min: 0, max: 1 });
}

function oneToMany(type: FieldType): ArrayContainsConstraint {
  return ConstraintTypes.array.contains.create(type, { min: 1 });
}

function exactly(n: number, type: FieldType): ArrayContainsConstraint {
  return ConstraintTypes.array.contains.create(type, { min: n, max: n });
}

/* ---------- property decorators -------------------------------- */

/** Required property (default if you pass a bare FieldType). */
const prop = (ft: FieldType, reason?: string) =>
  ({ ft, optional: false, reason }) satisfies PropSpec;

/** “proptional” ⇒ optional property (may also supply default). */
const proptional = (ft: FieldType, def?: unknown, reason?: string) =>
  ({ ft, optional: true, default: def, reason }) satisfies PropSpec;

type PropSpec = {
  ft: FieldType;
  optional: boolean;
  default?: unknown;
  reason?: string;
};

/* ---------- object helper -------------------------------------- */

function bool(...ops: any[]): BooleanType {
  return FieldType.boolean.create(ops.length > 0 ? { attributes: ops } : {});
}

function object<S extends Record<string, FieldType | PropSpec>>(shape: S): Shaped<S>;
function object(shape?: Record<string, FieldType | PropSpec>): ObjectType;
function object(shape?: Record<string, FieldType | PropSpec>): any {
  const b = FieldTypeBuilder.object();
  Object.entries(shape ?? {}).forEach(([rawKey, v]) => {
    const optionalSuffix = rawKey.endsWith("?");
    const k = optionalSuffix ? rawKey.slice(0, -1) : rawKey;
    if ("ft" in v) {
      // PropSpec form — save() commits any pending draft (e.g. .literal())
      const ft = (v as any).ft;
      b.attr.property(k, ft.save ? ft.save() : ft, {
        optional: v.optional || optionalSuffix,
        default: v.default,
        reason: v.reason,
      });
    } else {
      // plain FieldType — save() commits any pending draft (e.g. .literal())
      const ft = v as FieldType;
      b.attr.property(k, (ft as any).save ? (ft as any).save() : ft, { optional: optionalSuffix });
    }
  });
  return b.build() as ObjectType;
}

const len = (min?: ConstraintRefValue<number>, max?: ConstraintRefValue<number>) => ({ min, max });
const rng = (min?: ConstraintRefValue<number>, max?: ConstraintRefValue<number>) => ({ min, max });
const min = (value: ConstraintRefValue<number>) => ({ min: value });
const max = (value: ConstraintRefValue<number>) => ({ max: value });

/* ----------  B.  ready‑made constraint helpers ----------------- *
 *  If you’d rather have the full Constraint objects               *
 *  (so you can feed them via the `attributes` array when calling  *
 *   `types.string({ attributes: [...] })`) you can use these.     */

const str = {
  matches: (re: RegExp, reason?: string): StringConstraint =>
    ConstraintTypes.string.matches.create(re, reason),
  includes: (s: string, reason?: string): StringConstraint =>
    ConstraintTypes.string.includes.create(s, reason),
  length: (min?: ConstraintRefValue<number>, max?: ConstraintRefValue<number>, r?: string): StringConstraint =>
    ConstraintTypes.string.length.create({ min, max, reason: r }),
};

const num = {
  min: (v: ConstraintRefValue<number>, r?: string): NumberConstraint =>
    ConstraintTypes.number.min.create(v, r),
  max: (v: ConstraintRefValue<number>, r?: string): NumberConstraint =>
    ConstraintTypes.number.max.create(v, r),
  range: (min?: ConstraintRefValue<number>, max?: ConstraintRefValue<number>, r?: string): NumberConstraint =>
    ConstraintTypes.number.range.create({ min, max, reason: r }),
  integer: (r?: string): NumberConstraint =>
    ConstraintTypes.number.integer.create(r),
  exclusiveMin: (v: ConstraintRefValue<number>, r?: string): NumberConstraint => ConstraintTypes.number.exclusiveMin.create(v, r),
  exclusiveMax: (v: ConstraintRefValue<number>, r?: string): NumberConstraint => ConstraintTypes.number.exclusiveMax.create(v, r),
  multipleOf:  (v: ConstraintRefValue<number>, r?: string): NumberConstraint => ConstraintTypes.number.multipleOf.create(v, r)
};

const literal = <T>(value: T, equals?: string): LiteralConstraint =>
  ConstraintTypes.any.literal.create(value, equals) as LiteralConstraint;
function or<T extends FieldType[]>(...alts: T): Varianted<T>;
function or(...alts: FieldType[]): FieldType;
function or(...alts: FieldType[]): any {
  return FieldTypeBuilder.any() // dummy seed
    .or(...alts) // reuse builder's .or()
    .build();
}

/** `types.and(a, b, c)` → FieldType with fieldtype === 'and' */
function and(...all: FieldType[]): FieldType {
  return FieldTypeBuilder.any()
    .and(...all)
    .build();
}

/** `types.not(a)` → FieldType with fieldtype === 'not' */
function not(ft: FieldType): FieldType {
  return FieldTypeBuilder.any()
    .not.call({ node: ft }) // quick wrap
    .build();
}


type TupleOptional = { __tuple: "optional"; ft: FieldType };
type TupleMany = { __tuple: "many"; ft: FieldType };

const isTupleOptional = (x: any): x is TupleOptional => x && x.__tuple === "optional";
const isTupleMany = (x: any): x is TupleMany => x && x.__tuple === "many";


/* ---------- public surface ------------------------------------- */

export const attrs = (...item: any[]) => {
  return { attributes: [...item] };
};

function fn<I extends FieldType, O extends FieldType>(input: I, output: O): Functioned<I, O>;
function fn(input: FieldType, output: FieldType): FunctionType;
function fn(input: FieldType, output: FieldType): any {
  return FieldType.function.create().param(input).returns(output).save();
}

export const extensionof = ((other: FieldType, item: any, opts?: any) => {
  return FieldType.compose(other, types.from(item));
}) as {
  <A extends FieldType, B extends Record<string, any>>(other: A, item: B): Composed<A, B>;
  (other: FieldType, item: any): FieldType;
}





function nil(): NullType {
  return FieldType.null.nonce;
}

/**
 * Convenience: create a REAL_TIME temporal gate.
 * Returns `types.number().min(deadline).meta({ domain: 'REAL_TIME' })`.
 * No new type constructor — REAL_TIME uses existing number composition.
 */
function realtime(deadline: number) {
  return number().min(deadline).meta({ domain: 'REAL_TIME' });
}

export const types = {
  string,
  number,
  any,
  array,
  prop, // for explicit required props (rarely needed)
  proptional, // 😉 optional property
  object,
  len,
  rng,
  min,
  max,
  str,
  num,
  literal,
  or,
  and,
  not,
  attrs,
  tuple,
  toptional,
  tmany,
  block,
  assignment,
  zeroToMany,
  zeroToOne,
  oneToMany,
  exactly,
  bool,
  fn,
  null: nil,
  extensionof,
  ref: artifactRef,
  from: disambiguateFieldType,
  realtime,
};
