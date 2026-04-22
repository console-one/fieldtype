


import { DRAFT_SYM, FieldType, isNever, literalFromAttributes } from './type.js'
import { ConstraintTypes, isConstraintRef } from './constraint.js'

/**
 * Symmetric metadata merge for commutative compose().
 * - Identical values: kept as-is
 * - Disjoint keys: both included
 * - Conflicting keys: deterministic winner via lexicographic sort of JSON-stringified values
 *
 * Guarantees: symmetricMeta(a, b) === symmetricMeta(b, a) for all a, b.
 */
function symmetricMeta(a: Record<string, any> | undefined, b: Record<string, any> | undefined): Record<string, any> | undefined {
  if (!a && !b) return undefined;
  if (!a) return b;
  if (!b) return a;
  const result: Record<string, any> = {};
  const allKeys = new Set([...Object.keys(a), ...Object.keys(b)]);
  for (const key of allKeys) {
    const inA = key in a;
    const inB = key in b;
    if (inA && inB) {
      // Both have this key — use deterministic winner on conflict
      const va = a[key];
      const vb = b[key];
      if (Object.is(va, vb)) {
        result[key] = va;
      } else {
        // Deterministic: sort stringified values, pick first
        const sa = JSON.stringify(va) ?? '';
        const sb = JSON.stringify(vb) ?? '';
        result[key] = sa <= sb ? va : vb;
      }
    } else {
      result[key] = inA ? a[key] : b[key];
    }
  }
  return result;
}
  

export function literalsOrNever(a: FieldType, b: FieldType): FieldType | null {
    const la = literalFromAttributes((a as any).attributes);
    const lb = literalFromAttributes((b as any).attributes);
    if (la !== undefined && lb !== undefined) {
      if (Object.is(la, lb)) return a; // consistent
      return FieldType.never.create({ reason: "literal mismatch" });
    }
    return null;
}
  

import * as find from './find.js'

export function objects(a: FieldType, b: FieldType): FieldType {
    const A = find.objectProperty(a);
    const B = find.objectProperty(b);
  
    const byKey = new Map<string, any>();
    for (const p of A) byKey.set(p.key, { a: p });
    for (const p of B) byKey.set(p.key, { ...(byKey.get(p.key) || {}), b: p });
  
    const out = FieldType.object.create();
    for (const [key, pair] of byKey) {
      if (pair.a && pair.b) {
        const ca = pair.a.value as FieldType;
        const cb = pair.b.value as FieldType;
        const composed = FieldType.compose(ca, cb);
        if (isNever(composed)) return composed;

        const optional =
          (!!pair.a.optional) && (!!pair.b.optional); // intersection semantics
        out.property(key, composed, { optional });
      } else {
        const only = (pair.a || pair.b)!;
        out.property(key, only.value as FieldType, {
          optional: !!only.optional,
          default: only.default,
          reason: only.reason,
        });
      }
    }
  
    // Pass-through other object-level constraints (e.g., properties) unmodified
    const passthrough = (x: any) =>
      ConstraintTypes.object.describes(x) &&
    x.constrainttype !== "property";
    for (const aAttr of (a.attributes ?? [])) if (passthrough(aAttr)) (out as any)[DRAFT_SYM]?.state?.patches?.push({
      type: "draftpatch",
      attributes: [aAttr],
    });
    for (const bAttr of (b.attributes ?? [])) if (passthrough(bAttr)) (out as any)[DRAFT_SYM]?.state?.patches?.push({
      type: "draftpatch",
      attributes: [bAttr],
    });

    // Symmetric metadata merge — commutative compose
    const aMeta = (a as any).metadata;
    const bMeta = (b as any).metadata;
    const mergedMeta = symmetricMeta(aMeta, bMeta);
    if (mergedMeta) {
      (out as any)[DRAFT_SYM]?.state?.patches?.push({
        type: "draftpatch",
        metadata: mergedMeta,
      });
    }

    return out.save();
}

export function arrays(a: FieldType, b: FieldType): FieldType {
    const av = find.arrayValues(a);
    const bv = find.arrayValues(b);

    const aMeta = (a as any).metadata;
    const bMeta = (b as any).metadata;

    const out = FieldType.array.create();
  
    // compose element type when both present
    if (av?.value && bv?.value) {
      const el = FieldType.compose(av.value as FieldType, bv.value as FieldType);
      if (isNever(el)) return el;
      out.values(el);
    } else if (av?.value) {
      out.values(av.value as FieldType);
    } else if (bv?.value) {
      out.values(bv.value as FieldType);
    }
  
    // intersect accumulate ranges if both have them
    const aa = find.arrayAccumulate(a);
    const ba = find.arrayAccumulate(b);
    if (aa?.items || ba?.items) {
      const aMin = aa?.items?.min;
      const aMax = aa?.items?.max;
      const bMin = ba?.items?.min;
      const bMax = ba?.items?.max;
      const hasRef = isConstraintRef(aMin) || isConstraintRef(aMax)
                  || isConstraintRef(bMin) || isConstraintRef(bMax);

      if (hasRef) {
        // Cannot statically merge when any bound is a scope ref —
        // carry both constraints through; runtime resolves and enforces both.
        const elemType = (av?.value || bv?.value) as FieldType ?? FieldType.any.create();
        if (aa?.items) out.accumulate(aa.items, elemType);
        if (ba?.items) out.accumulate(ba.items, elemType);
      } else {
        const mi = Math.max((aMin as number) ?? 0, (bMin as number) ?? 0);
        const ma = [
          (aMax as number) ?? Number.POSITIVE_INFINITY,
          (bMax as number) ?? Number.POSITIVE_INFINITY,
        ].reduce((m, v) => Math.min(m, v), Number.POSITIVE_INFINITY);

        if (ma < mi) return FieldType.never.create({ reason: "array length conflict" });

        // prefer finite max if any, else leave undefined
        const max = Number.isFinite(ma) ? ma : undefined;
        out.accumulate(
          ConstraintTypes.number.range.create({ min: mi, max }),
          (av?.value || bv?.value) as FieldType ?? FieldType.any.create(),
        );
      }
    }

    const mergedArrayMeta = symmetricMeta(aMeta, bMeta);
    if (mergedArrayMeta) {
      (out as any)[DRAFT_SYM]?.state?.patches?.push({
        type: "draftpatch",
        metadata: mergedArrayMeta,
      });
    }

    return out.save();
}
  