import {
  ArrayConstraint,
  ArrayIndexRange,
  ConstraintTypes,
  FieldConstraintType,
  ObjectConstraint,
} from "./constraint.js";
import { FieldType } from "./type.js";

// ─────────────────────────────────────────────────────────────────────────────
// Result vocabulary
//
// Aligned with head.ts (PreflightResult / MergeResult) and patchResolve.ts
// (FieldTypeMissing / MergeConflict): faults carry path / typeName /
// constraint / provided, and OR-branch ambiguity is surfaced as `candidates`
// — the same idiom used by FieldTypeMissing.candidates.
// ─────────────────────────────────────────────────────────────────────────────

export type ValidationFault = {
  readonly path: readonly (string | number)[];
  readonly typeName: string;
  readonly constraint?: FieldConstraintType;
  readonly provided?: unknown;
  /** True for missing-required-field faults. Mirrors FieldTypeMissing semantics. */
  readonly missing?: boolean;
  /** Per-branch failures for OR-style ambiguity. Mirrors FieldTypeMissing.candidates. */
  readonly candidates?: readonly { typeName: string; faults: readonly ValidationFault[] }[];
};

export type ValidationResult =
  | { ok: true }
  | { ok: false; faults: readonly ValidationFault[] };

export function validate(node: FieldType, data: unknown): ValidationResult {
  const faults: ValidationFault[] = [];
  walk(node, data, [], faults);
  return faults.length ? { ok: false, faults } : { ok: true };
}

function walk(
  n: FieldType,
  val: unknown,
  path: (string | number)[],
  out: ValidationFault[],
) {
  switch (n.fieldtype) {
    case "any":
      runAttr(n.attributes, val, path, out, n.fieldtype);
      break;

    case "string":
      if (typeof val !== "string") {
        out.push({ path, typeName: "string", provided: val });
        return;
      }
      runAttr(n.attributes ?? [], val, path, out, "string");
      break;

    case "number":
      if (typeof val !== "number") {
        out.push({ path, typeName: "number", provided: val });
        return;
      }
      runAttr(n.attributes ?? [], val, path, out, "number");
      break;

    case "object":
      if (typeof val !== "object" || val === null || Array.isArray(val)) {
        out.push({ path, typeName: "object", provided: val });
        return;
      }
      runAttr(n.attributes ?? [], val, path, out, "object");
      runObjAttr(
        n.attributes.filter(ConstraintTypes.object.describes),
        val as Record<string, unknown>,
        path,
        out,
      );
      break;

    case "array":
      if (!Array.isArray(val)) {
        out.push({ path, typeName: "array", provided: val });
        return;
      }
      runAttr(n.attributes ?? [], val, path, out, "array");
      runArrAttr(
        n.attributes.filter(ConstraintTypes.array.describes),
        val as unknown[],
        path,
        out,
      );
      break;

    case "or": {
      const branches = n.attributes.filter((a) =>
        FieldType.describes(a),
      ) as FieldType[];
      const candidates: { typeName: string; faults: ValidationFault[] }[] = [];
      let matched = false;
      for (const child of branches) {
        const tmp: ValidationFault[] = [];
        walk(child, val, path, tmp);
        if (tmp.length === 0) {
          matched = true;
          break;
        }
        candidates.push({ typeName: child.fieldtype, faults: tmp });
      }
      if (!matched) {
        out.push({ path, typeName: "or", provided: val, candidates });
      }
      break;
    }

    case "and": {
      const branches = n.attributes.filter((a) =>
        FieldType.describes(a),
      ) as FieldType[];
      branches.forEach((child) => walk(child, val, path, out));
      break;
    }

    case "not": {
      const branches = n.attributes.filter((a) =>
        FieldType.describes(a),
      ) as FieldType[];
      const tmp: ValidationFault[] = [];
      walk(branches[0], val, path, tmp);
      if (tmp.length === 0) {
        out.push({ path, typeName: "not", provided: val });
      }
      break;
    }

    case "function":
      if (typeof val !== "function") {
        out.push({ path, typeName: "function", provided: val });
        return;
      }
      runAttr(n.attributes ?? [], val, path, out, "function");
      break;
  }
}

function runAttr(
  attrs: FieldConstraintType[],
  v: any,
  path: (string | number)[],
  out: ValidationFault[],
  typeName: string,
) {
  attrs.forEach((a) => {
    if (ConstraintTypes.any.describes(a) && a.constrainttype === "literal") {
      const expected = (a as any).value;
      if (!deepEqual(v, expected)) {
        out.push({ path, typeName, constraint: a, provided: v });
      }
      return;
    }

    if (ConstraintTypes.string.describes(a) && typeof v === "string") {
      if (a.constrainttype === "matches" && !a.pattern.test(v))
        out.push({ path, typeName, constraint: a, provided: v });
      if (a.constrainttype === "includes" && !v.includes(a.value))
        out.push({ path, typeName, constraint: a, provided: v });
      if (a.constrainttype === "length") {
        const lmin = a.min, lmax = a.max;
        if (typeof lmin === "number" && v.length < lmin)
          out.push({ path, typeName, constraint: a, provided: v });
        if (typeof lmax === "number" && v.length > lmax)
          out.push({ path, typeName, constraint: a, provided: v });
      }
    }

    if (ConstraintTypes.number.describes(a) && typeof v === "number") {
      const av = (a as any).value;
      if (a.constrainttype === "min" && typeof av === "number" && v < av)
        out.push({ path, typeName, constraint: a, provided: v });
      if (a.constrainttype === "max" && typeof av === "number" && v > av)
        out.push({ path, typeName, constraint: a, provided: v });
      if (a.constrainttype === "exclusiveMin" && typeof av === "number" && v <= av)
        out.push({ path, typeName, constraint: a, provided: v });
      if (a.constrainttype === "exclusiveMax" && typeof av === "number" && v >= av)
        out.push({ path, typeName, constraint: a, provided: v });
      if (a.constrainttype === "integer" && !Number.isInteger(v))
        out.push({ path, typeName, constraint: a, provided: v });
      if (a.constrainttype === "range") {
        const rmin = (a as any).min, rmax = (a as any).max;
        if (typeof rmin === "number" && v < rmin)
          out.push({ path, typeName, constraint: a, provided: v });
        if (typeof rmax === "number" && v > rmax)
          out.push({ path, typeName, constraint: a, provided: v });
      }
      if (a.constrainttype === "multipleOf" && typeof av === "number") {
        if (av === 0 || !isFinite(av)) {
          out.push({ path, typeName, constraint: a, provided: v });
        } else {
          const ratio = v / av;
          const nearInt = Math.round(ratio);
          if (Math.abs(ratio - nearInt) > 1e-12)
            out.push({ path, typeName, constraint: a, provided: v });
        }
      }
    }
  });
}

function runArrAttr(
  attrs: ArrayConstraint[],
  arr: unknown[],
  path: (string | number)[],
  out: ValidationFault[],
) {
  const normalizeRanges = (
    r?: ArrayIndexRange[] | ArrayIndexRange[][],
  ): ArrayIndexRange[][] => {
    if (!r) return [[ConstraintTypes.number.range.create({})]];
    if (Array.isArray(r) && r.length > 0 && Array.isArray((r as any)[0]))
      return r as any;
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
              ? (rc.min == null || typeof rc.min !== "number" || idx >= rc.min) &&
                (rc.max == null || typeof rc.max !== "number" || idx <= rc.max)
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
        if (
          (typeof items.min === "number" && arr.length < items.min) ||
          (typeof items.max === "number" && arr.length > items.max)
        ) {
          out.push({ path, typeName: "array", constraint: a, provided: arr });
        }
      }
      arr.forEach((v, i) => walk(a.value as any, v, [...path, i], out));
    }

    if (a.constrainttype === "unique" && a.value) {
      for (let i = 0; i < arr.length; i++) {
        for (let j = i + 1; j < arr.length; j++) {
          if (deepEqual(arr[i], arr[j])) {
            out.push({
              path: [...path, j],
              typeName: "array",
              constraint: a,
              provided: arr[j],
            });
            i = arr.length;
            break;
          }
        }
      }
    }

    if (a.constrainttype === "contains") {
      let count = 0;
      for (let i = 0; i < arr.length; i++) {
        const tmp: ValidationFault[] = [];
        walk(a.value as any, arr[i], [...path, i], tmp);
        if (tmp.length === 0) count++;
      }
      const cmin = a.min ?? 1;
      const cmax = a.max;
      if (typeof cmin === "number" && count < cmin)
        out.push({ path, typeName: "array", constraint: a, provided: arr });
      if (typeof cmax === "number" && count > cmax)
        out.push({ path, typeName: "array", constraint: a, provided: arr });
    }

    if (a.constrainttype === "named") {
      const by = a.by ?? "name";
      const key = a.key;
      const matches: number[] = [];
      for (let i = 0; i < arr.length; i++) {
        const el = arr[i];
        if (el != null && typeof el === "object") {
          if (getByPath(el, by) === key) matches.push(i);
        }
      }
      for (const idx of matches) {
        walk(a.value as any, arr[idx], [...path, idx], out);
      }
      const nmin = a.min ?? 1;
      const nmax = a.max ?? 1;
      if (typeof nmin === "number" && matches.length < nmin)
        out.push({
          path,
          typeName: "array",
          constraint: a,
          provided: arr,
          missing: matches.length === 0,
        });
      if (typeof nmax === "number" && matches.length > nmax)
        out.push({ path, typeName: "array", constraint: a, provided: arr });
    }
  });
}

function runObjAttr(
  attrs: ObjectConstraint[],
  obj: Record<string, unknown>,
  path: (string | number)[],
  out: ValidationFault[],
) {
  const propC = attrs.filter(ConstraintTypes.object.property.describes);
  const propsC = attrs.filter(ConstraintTypes.object.properties.describes);
  const addlC = attrs.find(ConstraintTypes.object.additional.describes);
  const indexC = attrs.filter(ConstraintTypes.object.index.describes);

  const visited = new Set<string>();

  propC.forEach((a) => {
    if (!(a.key in obj)) {
      if (!(a as any).optional) {
        out.push({
          path: [...path, a.key],
          typeName: "object",
          constraint: a,
          missing: true,
        });
      }
    } else {
      visited.add(a.key);
      walk(a.value as any, obj[a.key], [...path, a.key], out);
    }
  });

  const ensureRegExp = (item: string | RegExp) =>
    typeof item === "string" ? new RegExp(item) : item;
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

  indexC.forEach((a) => {
    const pred = !a.key
      ? (_: string) => true
      : typeof a.key === "string"
        ? (k: string) => k === a.key
        : (k: string) => ensureRegExp(a.key!).test(k);

    Object.entries(obj)
      .filter(([k]) => pred(k))
      .forEach(([k, v]) => {
        if (a.when) {
          const tmp: ValidationFault[] = [];
          walk(a.when as any, v, [...path, k], tmp);
          if (tmp.length > 0) return;
        }

        walk(a.value as any, v, [...path, k], out);
        visited.add(k);

        const got = getByPath(v, a.by);
        if (got !== k) {
          out.push({
            path: [...path, k, a.by],
            typeName: "object",
            constraint: a,
            provided: got,
          });
        }
      });
  });

  if (addlC) {
    const extraKeys = Object.keys(obj).filter((k) => !visited.has(k));
    if (addlC.value === false) {
      extraKeys.forEach((k) =>
        out.push({
          path: [...path, k],
          typeName: "object",
          constraint: addlC,
          provided: obj[k],
        }),
      );
    } else {
      extraKeys.forEach((k) =>
        walk(addlC.value as any, obj[k], [...path, k], out),
      );
    }
  }
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
  const parts = p.split(".").filter(Boolean);
  let cur = o;
  for (const seg of parts) {
    if (cur == null || typeof cur !== "object") return undefined;
    cur = cur[seg];
  }
  return cur;
}
