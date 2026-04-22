// test/utils/canonFT.ts
import { FieldType } from "./type.js";
import { FieldTypeEvent } from "./event.js";
import { ConstraintTypes } from "./constraint.js";

/** Create a single state-snapshot event for a FieldType (no history). */
export function snapshotFT(ft: FieldType): any {
  const attrs = (ft.attributes ?? []).map(snapshotAttr);
  return {
    type: "fieldtypeevent",
    eventtype: "state",
    fieldtype: ft.fieldtype,
    attributes: attrs,
    metadata: (ft as any).metadata ?? {},
    extensions: [], // normalized
  };
}

/** Canonicalize constraint payloads, recursively snapshotting child FieldTypes. */
function snapshotAttr(a: any): any {
  // Child FieldTypes inside unions or constraints
  if (FieldType.describes(a)) return snapshotFT(a);

  // Object.property / properties: value is a FieldType
  if (ConstraintTypes.object.property.describes(a)) {
    return { ...a, value: snapshotFT(a.value as any) };
  }
  if (ConstraintTypes.object.properties.describes(a)) {
    return { ...a, value: snapshotFT(a.value as any) };
  }
  if (ConstraintTypes.object.additional.describes(a) && a.value !== undefined && a.value !== false) {
    return { ...a, value: snapshotFT(a.value as any) };
  }
  if (ConstraintTypes.object.index.describes?.(a)) {
    const out: any = { ...a };
    if (FieldType.describes(a.value)) out.value = snapshotFT(a.value as FieldType);
    if (a.when && FieldType.describes(a.when)) out.when = snapshotFT(a.when as FieldType);
    if (a.key && typeof a.key !== "string") out.key = String(a.key); // normalize RegExp
    return out;
  }

  // Array.values / accumulate / contains: value is a FieldType
  if (ConstraintTypes.array.values.describes?.(a) && FieldType.describes(a.value)) {
    return { ...a, value: snapshotFT(a.value as FieldType) };
  }
  if (ConstraintTypes.array.accumulate.describes?.(a) && FieldType.describes(a.value)) {
    return { ...a, value: snapshotFT(a.value as FieldType) };
  }
  if (ConstraintTypes.array.contains?.describes?.(a) && FieldType.describes(a.value)) {
    return { ...a, value: snapshotFT(a.value as FieldType) };
  }

  // Generic fallback: any constraint with a FieldType value that wasn't
  // caught by the specific checks above (e.g., named, function.param/returns).
  if (a.value && FieldType.describes(a.value)) {
    return { ...a, value: snapshotFT(a.value as FieldType) };
  }

  // Plain constraint or scalar → leave as-is
  return a;
}

/** Test-only canonicalizer:
 *  - coerce FieldType (and any nested FTs) to a single state-snapshot
 *  - strip volatile keys: id + update
 */
export function canonFT(x: FieldType | FieldTypeEvent): any {
  const snap =
    FieldType.describes(x as any)
      ? snapshotFT((x as FieldType).save())
      : snapshotFT(FieldType.fromEvent(x as FieldTypeEvent));

  return JSON.parse(
    JSON.stringify(snap, (k, v) => (k === "id" || k === "update" ? undefined : v)),
  );
}
