import * as find from './find.js';
import { ConstraintTypes } from './constraint.js';
import { cloneType, FieldType, literalFromAttributes } from './type.js';

export function extractLiterals(ft: FieldType): unknown {
    const r = concreteness(ft);
    if (r.concrete) return r.literal;
    // For objects, return partial literal (only provable properties)
    if (r.literal !== undefined) return r.literal;
    return undefined;
}

export function missingLiteralReqs(
        n: FieldType,
        path: (string | number)[] = [],
    ): { path: (string | number)[]; reason: string }[] {
    const r = concreteness(n, path);
    return r.missing.map(m => ({ path: m.path, reason: m.message }));
}

/* ---------- Concreteness analysis (CUE-like) --------------------- */

export type MissingKind =
  | "literal"           // this leaf must be a concrete literal
  | "arrayElement"      // a concrete element at an index is required
  | "arrayLength"       // array length must be decided
  | "chooseOneOf"       // a disjunction must be resolved
  | "discriminant"      // set a discriminant field to decide a disjunction
  | "never";            // unsatisfiable

export type MissingReq = {
  path: (string | number)[];
  kind: MissingKind;
  message: string;
  expected?: FieldType;     // minimal expected type at this hole
  details?: any;            // e.g., {min, max}, discriminants, branch notes, etc.
};

export type ConcretenessResult = {
  concrete: boolean;
  literal?: unknown;
  witness?: FieldType;      // minimal type describing non-literal parts
  missing: MissingReq[];
};

export type ReadyInput = ConcretenessResult & { concrete: true, missing: [] }
export type AwaitingInput = ConcretenessResult & { concrete: false, missing: [MissingReq, ...MissingReq[]] }


// NOTE - Potential alternative but effective modelling formulation:
//
// We provide the summary of the template status (how 
// close is it to completeness) by evaluating the bindings from dependencies to 
// paths in the input field type. If the template schema is an OR type, then we may
// have multiple requirements, where a mis in one of them, invalidates all the others (and) 
// or satisfication satisfies all the others (or). These are provided as constraints.
// export type Satisfier = { onSatisfied: { item: any, index: string, action: 'satisfy' | 'cancel' }[] }
// export type Requirement = Satisfier & { 
//   type: 'concretenessRequirement'
//   path: string, 
//   schema: FieldType, 
//   id: string 
// } 
// export type Constraint = Satisfier & { 
//   type: 'concretenessConstraint'
//   group: Satisfier[]
//   compose: 'and' | 'or'
// } 
// export type CompletenessExpression = Requirement | Constraint
// export interface BindingValidator {
//   evaluate(fieldType: FieldType, bindings?: SourceBinding[]): CompletenessExpression[]
// }


export const isReady = (item: ConcretenessResult): item is ReadyInput => {
    return item.concrete && item.missing.length < 1
}

export const isAwaiting = (item: ConcretenessResult): item is AwaitingInput => {
    return !item.concrete && item.missing.length > 0
}


export const isValidConcretenessResult = (item: ConcretenessResult) => isReady(item) || isAwaiting(item)


/* ----- Wire into the existing helpers (drop-in replacements) ----- */


function _hole(expected: FieldType, info: Omit<MissingReq,"path"|"message"> & { message?: string }) {
    // Annotate a copy with metadata so downstream tooling can see why it’s a hole
    const w = cloneType(expected);
    w.meta({ missing: { kind: info.kind, details: info.details } });
    return w.save();
}
  
/* Try to extract discriminant hints from a list of alternative object types */
function _discriminantsForOr(children: FieldType[]) {
    type Disc = { key: string; values: unknown[] };
    const out: Disc[] = [];
    const propLitFor = (node: FieldType, key: string) => {
      if (node.fieldtype !== "object") return undefined;
      const prop = find.objectProperty(node).find(p => p.key === key);
      if (!prop) return undefined;
      return literalFromAttributes((prop.value as any).attributes);
    };
  
    // collect candidate keys that appear in all children
    const keyCounts = new Map<string, number>();
    for (const ch of children) {
      if (ch.fieldtype !== "object") continue;
      for (const p of find.objectProperty(ch)) {
        keyCounts.set(p.key, (keyCounts.get(p.key) ?? 0) + 1);
      }
    }
    const keysInAll = [...keyCounts.entries()].filter(([,n]) => n === children.length).map(([k]) => k);
    for (const key of keysInAll) {
      const lits = children.map(ch => propLitFor(ch, key));
      if (lits.every(v => v !== undefined)) {
        const uniq = Array.from(new Set(lits.map(v => JSON.stringify(v)))).map(s => JSON.parse(s));
        if (uniq.length === children.length) { // clean partition
          out.push({ key, values: uniq });
        }
      }
    }
    return out;
}






/* Core: compute literal, witness, and missing obligations */
export function concreteness(n: FieldType, path: (string|number)[] = []): ConcretenessResult {
    // direct literal wins
    const lit = literalFromAttributes((n as any).attributes);
    if (lit !== undefined) return { concrete: true, literal: lit, missing: [] };
  
    switch (n.fieldtype) {
  
      case "null":
        return { concrete: true, literal: null, missing: [] };
      case "boolean":
      case "string":
      case "number": {
        // Scalar type without literal: missing a concrete value.
        const expected = cloneType(n);
        return {
          concrete: false,
          missing: [{
            path, kind: "literal",
            message: `${n.fieldtype} value required`,
            expected
          }],
          witness: expected
        };
      }
  
      case "object": {
        const props = find.objectProperty(n);
        const outObj: Record<string, unknown> = {};
        const missing: MissingReq[] = [];
        const witness = FieldType.object.create();
  
        for (const p of props) {
          const sub = p.value as FieldType;
  
          // Default satisfies concreteness for required props
          const defIsLiteral = p.default !== undefined;
          if (defIsLiteral) {
            outObj[p.key] = p.default;
            continue;
          }
  
          const a = concreteness(sub, [...path, p.key]);
          if (a.concrete && "literal" in a && a.literal !== undefined) {
            outObj[p.key] = a.literal;
          } else {
            if (!p.optional) {
              missing.push({
                path: [...path, p.key],
                kind: "literal",
                message: `property "${p.key}" requires a concrete value`,
                expected: a.witness ?? cloneType(sub)
              });
              witness.property(p.key, a.witness ?? cloneType(sub), { optional: false });
            }
            // If optional and not concrete, leave it out; not an obligation.
          }
        }
  
        if (missing.length === 0) {
          return {
            concrete: true,
            literal: outObj,
            missing: []
          };
        }
        // Include partial literal (provable properties) even when not fully concrete
        return {
          concrete: false,
          literal: Object.keys(outObj).length > 0 ? outObj : undefined,
          missing,
          witness: witness.save()
        };
      }
  
      case "array": {
        // Prefer tuple-ish obligations if detectable; otherwise use accumulate(min/max)
        const tuple = find.tuple(n);
        const vals = find.arrayValues(n);
        const elemType: FieldType | undefined = vals?.value as FieldType | undefined;
        const acc = find.arrayAccumulate(n);
        const min = acc?.items?.min;
        const max = acc?.items?.max;
  
        const missing: MissingReq[] = [];
  
        // If we have a single generic element type and a fully fixed length and that element is concrete:
        if (!tuple && elemType) {
          const elem = concreteness(elemType, [...path, 0]);
          if (typeof min === "number" && typeof max === "number" && min >= 0 && min === max && elem.concrete && elem.literal !== undefined) {
            return {
              concrete: true,
              literal: Array.from({ length: min }, () => elem.literal),
              missing: []
            };
          }
        }
  
        // Build a minimal witness: include required indices only
        const witness = FieldType.array.create();
  
        if (tuple) {
          const { pos, rest, minLen } = tuple;
          const lastFixed = rest ? Math.max(-1, ...(pos.size ? [...pos.keys(), rest.start - 1] : [rest.start - 1]))
                                 : (pos.size ? Math.max(...pos.keys()) : -1);
  
          for (let i = 0; i <= lastFixed; i++) {
            const t = (pos.get(i) ?? FieldType.any.create());
            const a = concreteness(t, [...path, i]);
            const isRequired = typeof minLen === "number" ? i < minLen : true;
            if (isRequired && !(a.concrete && a.literal !== undefined)) {
              missing.push({
                path: [...path, i],
                kind: "arrayElement",
                message: `tuple element #${i} requires a concrete value`,
                expected: a.witness ?? cloneType(t)
              });
              witness.index(a.witness ?? cloneType(t), [ConstraintTypes.number.range.create({ min: i, max: i })]);
            }
          }
          if (rest) {
            // If a rest tail exists and minLen exceeds fixed slots, demand at least one concrete for the rest start
            if (typeof minLen === "number" && minLen > lastFixed + 1) {
              const idx = lastFixed + 1;
              const a = concreteness(rest.t, [...path, idx]);
              if (!(a.concrete && a.literal !== undefined)) {
                missing.push({
                  path: [...path, idx],
                  kind: "arrayElement",
                  message: `array element #${idx}+ requires a concrete value`,
                  expected: a.witness ?? cloneType(rest.t)
                });
                witness.index(a.witness ?? cloneType(rest.t), [ConstraintTypes.number.range.create({ min: idx, max: idx })]);
              }
            }
          }
        } else {
          // Generic array
          if (typeof min === "number" && min > 0) {
            if (elemType) {
              const elemA = concreteness(elemType, [...path, 0]);
              if (!(elemA.concrete && elemA.literal !== undefined)) {
                missing.push({
                  path: [...path, 0],
                  kind: "arrayElement",
                  message: `array requires ${min} concrete element${min === 1 ? "" : "s"}`,
                  expected: elemA.witness ?? cloneType(elemType),
                  details: { min }
                });
                // Put a single representative required slot in the witness.
                witness.index(elemA.witness ?? cloneType(elemType), [ConstraintTypes.number.range.create({ min: 0, max: 0 })]);
              }
            } else {
              missing.push({
                path,
                kind: "arrayLength",
                message: `array length ≥ ${min} but element type is not concrete`
              });
            }
          }
        }
  
        return {
          concrete: false,
          missing,
          witness: witness.save()
        };
      }
  
      case "or": {
        const kids = (n.attributes as any[]).filter(FieldType.describes) as FieldType[];
        if (kids.length === 0) return { concrete: false, missing: [{ path, kind: "chooseOneOf", message: "empty union" }], witness: FieldType.or.create([]) };
  
        const analyses = kids.map((k, i) => ({ i, ...concreteness(k, path) }));
        const fullyConcrete = analyses.filter(a => a.concrete && a.literal !== undefined);
  
        // If exactly one branch is fully concrete, we can pick it
        if (fullyConcrete.length === 1) {
          return { concrete: true, literal: fullyConcrete[0].literal, missing: [] };
        }
  
        // Otherwise unresolved disjunction; surface choices and discriminants.
        const discr = _discriminantsForOr(kids);
        const witness = FieldType.or.create(
          analyses.map(a => a.witness ?? cloneType(kids[a.i]))
        );
  
        const msg = discr.length
          ? `choose one of ${kids.length} alternatives (discriminants: ` +
            discr.map(d => `${d.key}∈{${d.values.map(v => JSON.stringify(v)).join(", ")}}`).join(", ") + ")"
          : `choose one of ${kids.length} alternatives`;
  
        const missing: MissingReq[] = [{
          path, kind: "chooseOneOf", message: msg,
          details: {
            discriminants: discr,
            branches: analyses.map((a) => ({
              branch: a.i,
              concrete: a.concrete,
              missingCount: a.missing.length
            }))
          }
        }];
  
        // If we *do* have clear discriminants, add a targeted hint per discriminant key.
        for (const d of discr) {
          missing.push({
            path: [...path, d.key],
            kind: "discriminant",
            message: `set ${d.key} to one of ${d.values.map(v => JSON.stringify(v)).join(", ")}`,
            expected: FieldType.or.create(d.values.map(v => FieldType.any.create().literal(v)))
          });
        }
  
        return { concrete: false, missing, witness };
      }
  
      case "and": {
        const kids = (n.attributes as any[]).filter(FieldType.describes) as FieldType[];
        if (kids.length === 0) {
          return { concrete: false, missing: [{ path, kind: "literal", message: "value required" }], witness: FieldType.any.create() };
        }
        // Combine all obligations; if any kid is never -> unsatisfiable
        const parts = kids.map(k => concreteness(k, path));
        const never = parts.find(p => p.missing.some(m => m.kind === "never"));
        if (never) return never;
  
        const allMissing = parts.flatMap(p => p.missing);
        // Heuristic witness: AND of witnesses (or the original kid if none)
        const witness = FieldType.and.create(
          kids.map((k, idx) => parts[idx].witness ?? cloneType(k))
        );
        // If *every* leaf produced a literal and they are all equal, produce it
        const lits = parts.map(p => p.literal).filter(v => v !== undefined);
        if (lits.length === parts.length && lits.every(v => Object.is(v, lits[0]))) {
          return { concrete: true, literal: lits[0], missing: [] };
        }
        return { concrete: false, missing: allMissing, witness };
      }
  
      case "never":
        return {
          concrete: false,
          missing: [{ path, kind: "never", message: "type is never (unsatisfiable)" }]
        };
  
      case "not":
        // Cannot exhibit a single concrete witness in general; surface as non-concrete
        const kids = (n.attributes as any[]).filter(FieldType.describes) as FieldType[];
        return {
          concrete: false,
          missing: [{
            path, kind: "literal",
            message: `value required that does not match ${kids[0]?.toString?.() ?? "<type>"}`
          }],
          witness: n // keep as-is for diagnostic purposes
        };
  
      case "any":
      default:
        return {
          concrete: false,
          missing: [{ path, kind: "literal", message: "value required" }],
          witness: cloneType(n)
        };
    }
}




