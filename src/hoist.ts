import { HoistHandler, TryCompile, djb2 } from "@console-one/wire";
import { FieldType, ObjWithout, literalFromAttributes } from "./type.js";
import { ConstraintTypes } from "./constraint.js";
import { ftDeps } from "./wire.js";

/* ------------------------------------------------------------------------------------------------
 * Aggregation helpers (optional, opt-in)
 * ------------------------------------------------------------------------------------------------ */

export type FTCollectConfig = {
  /** Which metadata keys to collect (e.g., ['notes','permissions']) */
  metaKeys?: string[];
  /** Only visit nodes that pass this filter (defaults to all FieldTypes) */
  filter?: (ft: FieldType) => boolean;
  /**
   * Merge strategy for collected values:
   *  - 'last': last value wins
   *  - 'array': coalesce into arrays (dedup by JSON)
   *  - 'object': shallow-merge objects (last key wins)
   */
  merge?: "last" | "array" | "object";
};

export type FTCollector = {
  /** Call on each visited FieldType (root + children, incl. inlined) */
  visit(ft: FieldType): void;
  /** Final aggregated result */
  result(): Record<string, unknown>;
};

export function createFTCollector(cfg: FTCollectConfig = {}): FTCollector {
  const keys = cfg.metaKeys ?? [];
  const filter = cfg.filter ?? (() => true);
  const mode = cfg.merge ?? "last";

  const acc: Record<string, unknown> = {};
  const seenArrays = new Map<string, Set<string>>(); // for 'array' mode dedup

  const mergeLast = (k: string, v: unknown) => { acc[k] = v; };
  const mergeArray = (k: string, v: unknown) => {
    if (v === undefined) return;
    const set = seenArrays.get(k) ?? (seenArrays.set(k, new Set()), seenArrays.get(k)!);
    const arr = (acc[k] as unknown[]) ?? [];
    const push = (x: unknown) => {
      const s = JSON.stringify(x);
      if (!set.has(s)) { set.add(s); arr.push(x); }
    };
    if (Array.isArray(v)) v.forEach(push);
    else push(v);
    acc[k] = arr;
  };
  const mergeObject = (k: string, v: unknown) => {
    if (v && typeof v === "object" && !Array.isArray(v)) {
      acc[k] = Object.assign({}, (acc[k] as object) ?? {}, v as object);
    } else {
      acc[k] = v;
    }
  };

  const merge = (k: string, v: unknown) => {
    if (v === undefined) return;
    if (mode === "last") mergeLast(k, v);
    else if (mode === "array") mergeArray(k, v);
    else mergeObject(k, v);
  };

  return {
    visit(ft) {
      if (!filter(ft)) return;
      const meta = (ft as any).metadata;
      if (!meta || typeof meta !== "object") return;
      for (const k of keys) {
        if (Object.prototype.hasOwnProperty.call(meta, k)) merge(k, (meta as any)[k]);
      }
    },
    result() { return { ...acc }; },
  };
}

/* ------------------------------------------------------------------------------------------------
 * Structural helpers (parallels used in FT wire adapter)
 * ------------------------------------------------------------------------------------------------ */

const isFT = FieldType.describes;

/* ---------- formatting helpers that use tryCompile(child) ---------- */

const objectPropertyConstraints = (n: FieldType) =>
  (n.attributes ?? []).filter(ConstraintTypes.object.property.describes) as any[];

const arrayValuesConstraint = (n: FieldType) =>
  (n.attributes ?? []).find(
    (a: any) => ConstraintTypes.array.describes(a) && a.constrainttype === "values",
  ) as unknown as | { constrainttype: "values"; value: FieldType; range?: any } | undefined;

const arrayAccumulateConstraint = (n: FieldType) =>
  (n.attributes ?? []).find(
    (a: any) => ConstraintTypes.array.describes(a) && a.constrainttype === "accumulate",
  ) as | { constrainttype: "accumulate"; items?: { min?: number; max?: number } } | undefined;

const fmtString = (n: FieldType): string => {
  const attrs = (n.attributes ?? []).filter(ConstraintTypes.string.describes);
  const parts: string[] = [];
  for (const a of attrs) {
    if ((a as any).constrainttype === "length") {
      const { min, max } = a as any;
      if (min != null && max != null) {
        parts.push(`len(${min}..${max})`);
      } else if (min != null) {
        parts.push(`len(>=${min})`);
      } else if (max != null) {
        parts.push(`len(<=${max})`);
      }
    }
    if ((a as any).constrainttype === "matches") {
      const pat = (a as any).pattern;
      const src = pat instanceof RegExp ? pat.source : String(pat);
      parts.push(`=~"${src}"`);
    }
    if ((a as any).constrainttype === "includes")
      parts.push(`has(${JSON.stringify((a as any).value)})`);
  }
  return parts.length ? "string & " + parts.join(" & ") : "string";
};

const fmtNumber = (n: FieldType): string => {
  const attrs = (n.attributes ?? []).filter(ConstraintTypes.number.describes);
  let isInt = false;
  const parts: string[] = [];
  for (const a of attrs) {
    const t = (a as any).constrainttype;
    if (t === "integer") { isInt = true; continue; }
    if (t === "min") parts.push(`>=${(a as any).value}`);
    if (t === "max") parts.push(`<=${(a as any).value}`);
    if (t === "exclusiveMin") parts.push(`>${(a as any).value}`);
    if (t === "exclusiveMax") parts.push(`<${(a as any).value}`);
    if (t === "multipleOf") parts.push(`%(${(a as any).value})`);
    if (t === "range") {
      const { min, max } = a as any;
      if (min != null && max != null) parts.push(`>=${min} & <=${max}`);
      else if (min != null) parts.push(`>=${min}`);
      else if (max != null) parts.push(`<=${max}`);
    }
  }
  const base = isInt ? "int" : "number";
  return parts.length ? base + " & " + parts.join(" & ") : base;
};

const detectTuple = (n: FieldType) => {
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
};

// helper to indent nested multi-line values in property position
const IND = "  ";
const indentNested = (s: string, level = 1) =>
  s.includes("\n")
    ? s.split("\n").map((ln, i) => (i === 0 ? ln : IND.repeat(level) + ln)).join("\n")
    : s;

// replace your current fmtObject with this pretty version
const fmtObject = (n: FieldType, tryCompile: TryCompile): string => {
  const props: string[] = [];

  // properties
  const propC = objectPropertyConstraints(n);
  propC.forEach((p: any) => {
    const opt = p.optional ? "?" : "";
    const d = p.default !== undefined ? ` = ${JSON.stringify(p.default)}` : "";
    const v = indentNested(tryCompile(p.value as FieldType), 1);
    const desc = (p.value as any)?.metadata?.description;
    const comment = desc ? `  // ${desc}` : "";
    props.push(`${p.key}${opt}: ${v}${d}${comment}`);
  });

  // properties(pattern)
  const patts = (n.attributes ?? []).filter(
    ConstraintTypes.object.properties.describes,
  ) as any[];
  patts.forEach((pp: any) => {
    const key = typeof pp.key === "string" ? JSON.stringify(pp.key) : String(pp.key);
    const v = indentNested(tryCompile(pp.value as FieldType), 1);
    props.push(`[key~${key}]: ${v}`);
  });

  // additional
  const addl = (n.attributes ?? []).find(
    ConstraintTypes.object.additional.describes as any,
  ) as any;
  if (addl) {
    if (addl.value === false) props.push(`[noAdditional]`);
    else {
      const v = indentNested(tryCompile(addl.value as FieldType), 1);
      props.push(`[additional]: ${v}`);
    }
  }

  // index
  const indexC = (n.attributes ?? []).filter(
    ConstraintTypes.object.index.describes,
  ) as any[];
  indexC.forEach((ix: any) => {
    const key = ix.key ? (typeof ix.key === "string" ? JSON.stringify(ix.key) : String(ix.key)) : "*";
    const when = ix.when ? `, when: ${indentNested(tryCompile(ix.when as FieldType), 1)}` : "";
    const v = indentNested(tryCompile(ix.value as FieldType), 1);
    props.push(`[index by:${ix.by} key:${key}${when}]: ${v}`);
  });

  // CUE-style struct with newline-separated fields
  return "{\n" + props.map(l => IND + l).join("\n") + "\n}";
};


const fmtArray = (n: FieldType, tryCompile: TryCompile): string => {
  const maybeTuple = detectTuple(n);
  if (maybeTuple) {
    const { pos, rest, minLen } = maybeTuple;
    const lastFixed = rest
      ? Math.max(-1, ...(pos.size ? [...pos.keys(), rest.start - 1] : [rest.start - 1]))
      : (pos.size ? Math.max(...pos.keys()) : -1);
    const parts: string[] = [];
    for (let i = 0; i <= lastFixed; i++) {
      const t = pos.get(i) ?? FieldType.any.create();
      const optional = typeof minLen === "number" ? i >= minLen : false;
      parts.push(optional ? `${tryCompile(t)}?` : tryCompile(t));
    }
    if (rest) parts.push(`...${tryCompile(rest.t)}`);
    return `[${parts.join(", ")}]`;
  }

  const values = (n.attributes ?? []).filter(
    (a: any) => ConstraintTypes.array.describes(a) && a.constrainttype === "values",
  ) as any[];
  const generic = values.find((v) => !v.range);
  const inner = generic ? tryCompile(generic.value as FieldType) : "any";
  const acc = (n.attributes ?? []).find(
    (a: any) => a.constrainttype === "accumulate",
  ) as any;
  const constraints: string[] = [];
  if (acc?.items?.min != null) constraints.push(`list.MinItems(${acc.items.min})`);
  if (acc?.items?.max != null) constraints.push(`list.MaxItems(${acc.items.max})`);
  const base = `[...${inner}]`;
  return constraints.length ? `${base} & ${constraints.join(" & ")}` : base;
};

const fmtFT = (n: FieldType, tryCompile: TryCompile): string => {
  const lit = literalFromAttributes((n as any).attributes);
  if (lit !== undefined) return JSON.stringify(lit);

  switch (n.fieldtype) {
    case "any": return "any";
    case "never": return "never";
    case "boolean": return "boolean";
    case "null": return "null";
    case "string": return fmtString(n);
    case "number": return fmtNumber(n);
    case "object": return fmtObject(n, tryCompile);
    case "array": return fmtArray(n, tryCompile);
    case "or": {
      const kids = (n.attributes as any[]).filter(FieldType.describes) as FieldType[];
      return "(" + kids.map(tryCompile).join(" | ") + ")";
    }
    case "and": {
      const kids = (n.attributes as any[]).filter(FieldType.describes) as FieldType[];
      return "(" + kids.map(tryCompile).join(" & ") + ")";
    }
    case "not": {
      const kids = (n.attributes as any[]).filter(FieldType.describes) as FieldType[];
      return "not " + (kids[0] ? tryCompile(kids[0]) : "<?>");
    }
    case "var": {
      const name = (n as any).name ?? "?";
      const bound = (n as any).bound as FieldType | undefined;
      return bound ? `${name} extends ${tryCompile(bound)}` : name;
    }
    case "function": {
      const param = (n.attributes as any[]).find((a: any) => a.constrainttype === "param");
      const returns = (n.attributes as any[]).find((a: any) => a.constrainttype === "returns");
      const paramStr = param?.value ? tryCompile(param.value as FieldType) : "any";
      const retStr = returns?.value ? tryCompile(returns.value as FieldType) : "any";
      return `(${paramStr}) => ${retStr}`;
    }
    default:
      // best-effort fallback: stringified structural snapshot
      return JSON.stringify({ fieldtype: (n as any).fieldtype });
  }
};

/* ------------------------------------------------------------------------------------------------
 * isSimple heuristic (overrideable)
 * ------------------------------------------------------------------------------------------------ */

const baseIsSimple = (ft: FieldType): boolean => {
  const attrCount = (ft.attributes ?? []).length;
  switch (ft.fieldtype) {
    case "any":
    case "boolean":
    case "null":
      return true;
    case "string":
    case "number":
      return attrCount <= 1;
    case "array":
    case "object":
      return false; // prefer hoisting; these compose rapidly
    case "or":
    case "and": {
      const kids = (ft.attributes as any[]).filter(FieldType.describes) as FieldType[];
      return kids.length <= 2 && kids.every(defaultIsSimple);
    }
    case "not": {
      const kid = (ft.attributes as any[]).find(FieldType.describes) as FieldType | undefined;
      return !!kid && defaultIsSimple(kid);
    }
    case "var":
      return true; // just a name (possibly with bound)
    case "function":
      return false; // always hoist — contains param/return types
    case "never":
    default:
      return true;
  }
};


const defaultIsSimple = baseIsSimple;


/* ------------------------------------------------------------------------------------------------
 * Hoist handler factory
 * ------------------------------------------------------------------------------------------------ */

export type FieldTypeHoistOptions = {
  /** Bucket/section to file hoisted types under (default: "type") */
  bucket?: string;
  /** Extract a doc string for the definition (e.g., from metadata) */
  docFrom?: (ft: FieldType) => string | undefined;
  /** Inline vs hoist override (default: conservative heuristic) */
  isSimple?: (ft: FieldType) => boolean;
  /** Optional collector to aggregate metadata while traversing */
  collector?: FTCollector;
  /** Optional custom ref name transform; defaults to assignedName as-is */
  refName?: (ft: FieldType, assigned: string) => string;
};


export function makeFieldTypeHoistHandler(
  opts: FieldTypeHoistOptions = {},
): HoistHandler<FieldType> {
  const bucket = opts.bucket ?? "type";
  const isSimple = opts.isSimple ?? defaultIsSimple;
  const docFrom =
    opts.docFrom ??
    ((ft) => {
      const meta = (ft as any).metadata ?? {};
      return meta.doc ?? meta.description ?? meta?.ui?.label;
    });

  const collector = opts.collector;
  const refName = opts.refName;

  

  return {
    type: "fieldtype",
    matches: isFT,

    // Stable structural key (align with wire FT adapter to dedupe across systems)

    id(ft)  { return (ft as any).toEvent().id },
    key(ft) {
      const base = ftStructuralKey(ft);
      const name = (ft as any).metadata?.name;
      return name ? `${base}:named:${name}` : base;
    },
    // We explicitly visit the node here for aggregation, then return structural children.
    dependencies(ft) {
      collector?.visit(ft);
      return ftDeps(ft);
    },

    // Inline when trivial; otherwise hoist.
    isSimple,

    // Inline rendering must call tryCompile(child) whenever children appear,
    // else hoisted children wouldn't be referenced by name.
    renderInline(ft, tryCompile) {
      collector?.visit(ft); // also visit inlined nodes (those won't pass through deps())
      return fmtFT(ft, tryCompile);
    },

    // Hoisted rendering: produce the definition body + optional doc + bucket/name hints.
    renderHoisted(ft, tryCompile) {
      collector?.visit(ft);
      return {
        body: fmtFT(ft, tryCompile),
        doc: docFrom(ft),
        bucket,
        name: (ft as any).metadata?.name ??  (ft as any).metadata?.tsName
      };
    },

    // How references to the hoisted thing should appear
    refName(ft, assigned) {
      return refName ? refName(ft, assigned) : assigned;
    },
  };
}

/** A ready-to-use default handler (no aggregation) */
export const FieldTypeHoistHandler: HoistHandler<FieldType> =
  makeFieldTypeHoistHandler();


  // --- structural key for FieldType (cycle-safe, order-normalized) ----------------
export function ftStructuralKey(ft: FieldType): string {
  const seen = new WeakMap<object, number>();
  let nextId = 1;

  const lit = (attrs?: any[]) => {
    if (!attrs) return undefined;
    for (const a of attrs) {
      if (ConstraintTypes.any.describes(a) && a.constrainttype === "literal") return a.value;
    }
  };

  // Normalize RegExp
  const reg = (r: RegExp) => ({ source: r.source, flags: r.flags });

  const ser = (n: FieldType): any => {
    if (seen.has(n as any)) return { $ref: seen.get(n as any) };
    seen.set(n as any, nextId++);

    // literal beats everything
    const L = lit((n as any).attributes);
    if (L !== undefined) return { t: "lit", v: L };

    switch (n.fieldtype) {
      case "any":      return { t: "any" };
      case "never":    return { t: "never" };
      case "boolean":  return { t: "boolean" };
      case "null":     return { t: "null" };

      case "string": {
        const attrs = (n.attributes ?? [])
          .filter(ConstraintTypes.string.describes)
          .map((a: any) => {
            switch (a.constrainttype) {
              case "length":  return { k: "length", min: a.min, max: a.max };
              case "matches": return { k: "matches", re: reg(a.pattern) };
              case "includes":return { k: "includes", v: a.value };
              default:        return null;
            }
          })
          .filter(Boolean)
          .sort((a: any, b: any) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
        return { t: "string", attrs };
      }

      case "number": {
        const attrs = (n.attributes ?? [])
          .filter(ConstraintTypes.number.describes)
          .map((a: any) => ({ k: a.constrainttype, ...a }))
          .map(({ k, value, min, max, reason, ...rest }) =>
            k === "range" ? { k, min, max } :
            k === "integer" ? { k: "integer" } :
            k === "multipleOf" ? { k, value } :
            k.startsWith("exclusive") ? { k, value } :
            k === "min" || k === "max" ? { k, value } : { k }
          )
          .sort((a: any, b: any) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
        return { t: "number", attrs };
      }

      case "array": {
        const vals = (n.attributes ?? [])
          .filter((a: any) => ConstraintTypes.array.describes(a) && a.constrainttype === "values") as any[];
        const acc  = (n.attributes ?? [])
          .find((a: any) => ConstraintTypes.array.describes(a) && a.constrainttype === "accumulate") as any;
        const contains = (n.attributes ?? [])
          .find(ConstraintTypes.array.contains.describes as any) as any;
        const unique = (n.attributes ?? [])
          .find(ConstraintTypes.array.unique.describes as any) as any;

        const valuesSig = vals.map(v => ({
          range: v.range
            ? (Array.isArray(v.range[0]) ? v.range : [v.range])
                .map((grp: any[]) =>
                  grp.map(r => r.constrainttype === "range" ? { min: r.min, max: r.max } : null)
                )
            : null,
          value: ser(v.value as FieldType),
        })).sort((a,b)=> JSON.stringify(a).localeCompare(JSON.stringify(b)));

        return {
          t: "array",
          values: valuesSig,
          acc: acc?.items ? { min: acc.items.min, max: acc.items.max, v: ser(acc.value as FieldType) } : null,
          contains: contains ? { v: ser(contains.value as FieldType), min: contains.min, max: contains.max } : null,
          unique: unique?.value ? true : false,
        };
      }

      case "object": {
        const props = (n.attributes ?? [])
          .filter(ConstraintTypes.object.property.describes) as any[];
        const propsByKey = new Map<string, FieldType[]>();
        for (const p of props) (propsByKey.get(p.key) ?? (propsByKey.set(p.key, []), propsByKey.get(p.key)!)).push(p.value);

        const propsSig = [...propsByKey.entries()]
          .map(([k, arr]) => ({ k, vs: arr.map(ser).sort((a,b)=>JSON.stringify(a).localeCompare(JSON.stringify(b))) }))
          .sort((a,b)=> a.k.localeCompare(b.k));

        const patts = (n.attributes ?? [])
          .filter(ConstraintTypes.object.properties.describes) as any[];
        const pattsSig = patts.map((pp: any) => ({
          key: typeof pp.key === "string" ? { s: pp.key } : { re: reg(pp.key) },
          v: ser(pp.value as FieldType),
        })).sort((a,b)=> JSON.stringify(a).localeCompare(JSON.stringify(b)));

        const addl = (n.attributes ?? []).find(ConstraintTypes.object.additional.describes as any) as any;

        const indexC = (n.attributes ?? []).filter(ConstraintTypes.object.index.describes) as any[];
        const indexSig = indexC.map((ix: any) => ({
          by: ix.by,
          key: ix.key ? (typeof ix.key === "string" ? { s: ix.key } : { re: reg(ix.key) }) : null,
          when: ix.when ? ser(ix.when as FieldType) : null,
          v: ser(ix.value as FieldType),
        })).sort((a,b)=> JSON.stringify(a).localeCompare(JSON.stringify(b)));

        return {
          t: "object",
          props: propsSig,
          patts: pattsSig,
          addl: addl ? (addl.value === false ? { t: "no" } : { t: "schema", v: ser(addl.value as FieldType) }) : null,
          index: indexSig,
        };
      }

      case "or":
      case "and": {
        const kids = (n.attributes as any[]).filter(FieldType.describes) as FieldType[];
        const set = kids.map(ser).sort((a,b)=> JSON.stringify(a).localeCompare(JSON.stringify(b)));
        return { t: n.fieldtype, set };
      }

      case "not": {
        const kid = (n.attributes as any[]).find(FieldType.describes) as FieldType | undefined;
        return { t: "not", v: kid ? ser(kid) : null };
      }

      case "var": {
        const varId = (n as any).varId;
        const bound = (n as any).bound as FieldType | undefined;
        return { t: "var", varId, bound: bound ? ser(bound) : null };
      }

      case "function": {
        const param = (n.attributes as any[]).find((a: any) => a.constrainttype === "param");
        const returns = (n.attributes as any[]).find((a: any) => a.constrainttype === "returns");
        return {
          t: "function",
          param: param?.value ? ser(param.value as FieldType) : null,
          returns: returns?.value ? ser(returns.value as FieldType) : null,
        };
      }

      default:
        return { t: (n as unknown as any).fieldtype };
    }
  };

  const sig = ser(ft);
  return "fts:" + djb2(JSON.stringify(sig));
}
