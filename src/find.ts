import { ConstraintTypes } from "./constraint.js";
import { FieldType } from "./type.js";
import type { FieldTypeCreationEvent } from "./event.js";

export function tuple(n: FieldType) {
    const arrAttrs = (n.attributes ?? []).filter(ConstraintTypes.array.describes) as any[];
    const values = arrAttrs.filter((a) => a.constrainttype === "values") as any[];
    const acc = arrAttrs.find((a) => a.constrainttype === "accumulate") as any | undefined;
  
    const pos = new Map<number, FieldType>();
    let rest: { start: number; t: FieldType } | undefined;
  
    for (const v of values) {
      const rg: any = v.range;
      if (!rg) return null;
      const groups = Array.isArray(rg[0]) ? (rg as any[]) : [rg];
      for (const g of groups) {
        const r = g.find((x: any) => x.constrainttype === "range");
        if (!r) continue;
        if (typeof r.min === "number" && typeof r.max === "number" && r.min === r.max) {
          pos.set(r.min, v.value as FieldType);
        } else if (typeof r.min === "number" && r.max == null) {
          rest = { start: r.min, t: v.value as FieldType };
        } else {
          return null;
        }
      }
    }
    if (pos.size === 0 && !rest) return null;
    const minLen = acc?.items?.min;
    const maxLen = acc?.items?.max;
    return { pos, rest, minLen, maxLen };
}

export function arrayValues(n: FieldType) {
    return (n.attributes ?? []).find(
      (a: any) =>
        ConstraintTypes.array.describes(a) && a.constrainttype === "values",
    ) as unknown as
      | { constrainttype: "values"; value: FieldType; range?: any }
      | undefined;
}
  
export function arrayAccumulate(n: FieldType) {
    return (n.attributes ?? []).find(
      (a: any) =>
        ConstraintTypes.array.describes(a) && a.constrainttype === "accumulate",
    ) as
      | { constrainttype: "accumulate"; items?: { min?: number; max?: number } }
      | undefined;
}

export function arrayNamed(n: FieldType) {
    return (n.attributes ?? []).filter(
      (a: any) => ConstraintTypes.array.describes(a) && a.constrainttype === "named",
    ) as unknown as Array<{
      constrainttype: "named"; key: string; by?: string;
      value: FieldType; min?: number; max?: number; reason?: string;
      default?: unknown;
    }>;
}

export function arrayContains(n: FieldType) {
    return (n.attributes ?? []).filter(
      (a: any) => ConstraintTypes.array.describes(a) && a.constrainttype === "contains",
    ) as unknown as Array<{
      constrainttype: "contains"; value: FieldType; min?: number; max?: number; reason?: string;
    }>;
}

export function objectProperty(n: FieldType) {
    return (n.attributes ?? []).filter(ConstraintTypes.object.property.describes) as any[];
  }

export function functionParam(n: FieldType): FieldType | undefined {
    const c = (n.attributes ?? []).find(ConstraintTypes.function.param.describes) as any;
    return c?.value as FieldType | undefined;
}

export function functionReturns(n: FieldType): FieldType | undefined {
    const c = (n.attributes ?? []).find(ConstraintTypes.function.returns.describes) as any;
    return c?.value as FieldType | undefined;
}

/**
 * Extract the minimum constraint value from a number FieldType.
 * Returns the numeric min value, or null if no min constraint exists.
 *
 * Used by TemporalSchedule to extract deadline values from
 * `types.number().min(deadline).meta({ domain: 'REAL_TIME' })` gates.
 */
export function extractMinConstraint(n: FieldType): number | null {
    if (n.fieldtype !== 'number') return null;
    const minAttr = (n.attributes ?? []).find(
      (a: any) => ConstraintTypes.number.min.describes(a)
    ) as { value: number } | undefined;
    return minAttr?.value ?? null;
}

// ── Block schema decomposition ────────────────────────────────────────

/** A single entry from a block schema, ready for UI form rendering. */
export type BlockSchemaEntry = {
    key: string;
    type: FieldType;
    typeSerialized: FieldTypeCreationEvent;
    required: boolean;
    reason?: string;
    min?: number;
    max?: number;
    default?: unknown;
};

/**
 * Extract a UI-friendly array from a block FieldType.
 *
 * Each named constraint in the block becomes a BlockSchemaEntry with its key,
 * typed schema (both live and serialized), cardinality, and reason string.
 * This is the canonical decomposition for rendering block-typed kit forms.
 */
export function blockEntries(block: FieldType): BlockSchemaEntry[] {
    const named = arrayNamed(block);
    return named.map(n => ({
        key: n.key,
        type: n.value as FieldType,
        typeSerialized: (n.value as FieldType).toEvent() as FieldTypeCreationEvent,
        required: (n.min ?? 1) > 0,
        reason: n.reason,
        min: n.min as number | undefined,
        max: n.max as number | undefined,
        default: n.default,
    }));
}