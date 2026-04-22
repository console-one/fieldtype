/* ------------------------------------------------------------------ *
 *  fieldtype‑constraint.ts (refactored – no NodeRef / Requirement)   *
 * ------------------------------------------------------------------ */

import type { BaseFieldType, FieldType, ObjWithout } from "./type.js";

/* ---------- ref‑valued constraints ------------------------------- */

/**
 * A constraint value slot that references a scope binding instead of a literal.
 * Resolved at type-evaluation time — same namespace as chain `ref` expressions.
 */
export type ConstraintRef = {
  readonly __ref: true;
  readonly path: string;
};

/** Factory for ConstraintRef */
export function constraintRef(path: string): ConstraintRef {
  return { __ref: true, path };
}

/** Type guard for ConstraintRef */
export function isConstraintRef(v: unknown): v is ConstraintRef {
  return v != null && typeof v === 'object' && (v as any).__ref === true;
}

/** A constraint value slot that accepts either a literal T or a scope ref */
export type ConstraintRefValue<T> = T | ConstraintRef;

/* ---------- generic node‑shape ----------------------------------- */

export type BaseFieldTypeConstraint<
  ConstraintType extends string = string,
  BaseType extends string = string,
> = {
  type: "typeconstraint";
  basetype: BaseType;
  constrainttype: ConstraintType;
};

/**
 * Concrete constraint object.
 * `Params` are the constraint‑specific properties, e.g.
 *   { min: number; max?: number }
 */
export type FieldTypeConstraint<
  ConstraintType extends string = string,
  BaseType extends string = string,
  Params extends ObjWithout<
    keyof BaseFieldTypeConstraint<ConstraintType, BaseType>
  > = ObjWithout<keyof BaseFieldTypeConstraint<ConstraintType, BaseType>>,
> = BaseFieldTypeConstraint<ConstraintType, BaseType> & Params;

/* ---------- ANY constraints ------------------------------------- */

export type AnyTypeConstraint<
  Name extends string = string,
  Props extends Record<string, any> = Record<string, any>,
> = FieldTypeConstraint<Name, "any", Props>;

export type LiteralConstraint<T = any> = AnyTypeConstraint<
  "literal",
  { value: ConstraintRefValue<T>; equals?: string }
>;

export type ReturnTypeConstraint<T = any> = AnyTypeConstraint<
  "returnedBy",
  { value: T }
>;

export type RefConstraint = AnyTypeConstraint<
  "ref",
  { source: string }
>;

/* ---------- BEHAVIORAL constraints (pairing demands) ------------ *
 *  These declare interpreter/procedure requirements when this       *
 *  subspace is REF'd in a given context. Not metadata — demands on  *
 *  the consumer: "pair me with interpreter X, configured with Y."   *
 * ---------------------------------------------------------------- */

export type MergeConstraint = AnyTypeConstraint<
  "merge",
  {
    value: ConstraintRefValue<string>;
    override?: 'open' | 'sealed' | 'final';
    reason?: string;
  }
>;

export type PersistConstraint = AnyTypeConstraint<
  "persist",
  {
    sink: ConstraintRefValue<string>;
    target?: ConstraintRefValue<string>;
    transform?: ConstraintRefValue<string>;
    reason?: string;
  }
>;

export type CompactConstraint = AnyTypeConstraint<
  "compact",
  {
    retain?: ConstraintRefValue<number>;
    strategy?: ConstraintRefValue<string>;
    reason?: string;
  }
>;

export type SubscribeConstraint = AnyTypeConstraint<
  "subscribe",
  {
    target: ConstraintRefValue<string>;
    reason?: string;
  }
>;

export type ForkConstraint = AnyTypeConstraint<
  "fork",
  {
    value: ConstraintRefValue<string>;
    reason?: string;
  }
>;

export type VisibilityConstraint = AnyTypeConstraint<
  "visibility",
  {
    scope: ConstraintRefValue<string>;
    reason?: string;
  }
>;

export type DecoratorConstraint = AnyTypeConstraint<
  "decorator",
  {
    transform: ConstraintRefValue<string>;
    reason?: string;
  }
>;

export type AutoMergeConstraint = AnyTypeConstraint<
  "autoMerge",
  {
    reason?: string;
  }
>;

export type SolveConstraint = AnyTypeConstraint<
  "solve",
  {
    objective?: string | ((constraint: any) => unknown);
    reason?: string;
  }
>;

export type LabelConstraint = AnyTypeConstraint<
  "label",
  {
    value: ConstraintRefValue<string>;   // label name (e.g., 'toolpackage')
    match: BaseFieldType;                // FieldType predicate — tested against concrete value
    path?: string;                       // path alias — at('path') resolves to this label's child HEAD
    reason?: string;
  }
>;

export type CallableConstraint = AnyTypeConstraint<
  "callable",
  {
    reason?: string;
  }
>;

export type MountConstraint = AnyTypeConstraint<
  "mount",
  {
    allow?: readonly string[];   // statement types: ['bind', 'annotate']
    levels?: readonly string[];  // bind levels: ['concrete']
    pattern?: string;            // regex for allowed binding names
    reason?: string;             // rejection message
  }
>;

/**
 * CallConstraint — computed constraint.
 * "My value = f(args) where f and args are refs."
 * Resolved when fn and all args are concrete in the workspace.
 * CCP equivalent: computed tell via agent evaluation.
 */
export type CallConstraint = AnyTypeConstraint<
  "call",
  {
    fn: ConstraintRefValue<string>;     // ref to a callable (function path in workspace)
    args: ConstraintRefValue<any>[];    // refs or literals for arguments
    reason?: string;
  }
>;

/**
 * TemporalConstraint — timed tell.
 * "This constraint holds when REAL_TIME >= after."
 * Append-only — never deletes the base value. When active, shadows with `value`.
 * CCP equivalent: timed constraint in TCCP (de Boer et al. 1997).
 */
export type TemporalConstraint = AnyTypeConstraint<
  "temporal",
  {
    after: number;     // REAL_TIME threshold
    value: any;        // the value that becomes active after the threshold
    reason?: string;
  }
>;

/* ---------- OBJECT constraints ---------------------------------- */

export type ObjectTypeConstraint<
  Name extends string = string,
  Props extends Record<string, any> = Record<string, any>,
> = FieldTypeConstraint<Name, "object", Props>;

export type ObjectPropertyConstraint = ObjectTypeConstraint<
  "property",
  {
    key: string;
    value: BaseFieldType;
    optional?: boolean;
    default?: unknown;
    reason?: string;
  }
>;

export type ObjectPropertiesConstraint = ObjectTypeConstraint<
  "properties",
  { key: string | RegExp; value: BaseFieldType; reason?: string }
>;

export type ObjectAdditionalConstraint = ObjectTypeConstraint<
  "additional",
  { value: false | BaseFieldType; reason?: string }
>;

export type ObjectIndexConstraint = ObjectTypeConstraint<
  "index",
  {
    // apply to all keys or only those matching 'key'
    key?: string | RegExp;
    value: BaseFieldType;          // schema of each entry
    by: string;                    // dot-path inside value that must equal the object key
    when?: BaseFieldType;          // optional guard: only enforce when(value) is satisfiable
    reason?: string;
  }
>;


export type ArrayTypeConstraint<
  Name extends string = string,
  Props extends Record<string, any> = Record<string, any>,
> = FieldTypeConstraint<Name, "array", Props>;

export type ArrayIndexRange = NumberConstraint;

export type IndexConstraint = ArrayTypeConstraint<
  "values",
  { range?: ArrayIndexRange[]; value: BaseFieldType; reason?: string }
>;
export type AccumulatedConstraint = ArrayTypeConstraint<
  "accumulate",
  { items?: NumberRangeConstraint; value: BaseFieldType; reason?: string }
>;

export type ArrayUniqueConstraint = ArrayTypeConstraint<
  "unique",
  { value: boolean; reason?: string }
>;
export type ArrayContainsConstraint = ArrayTypeConstraint<
  "contains",
  { value: BaseFieldType; min?: ConstraintRefValue<number>; max?: ConstraintRefValue<number>; reason?: string }
>;
export type ArrayNamedConstraint = ArrayTypeConstraint<
  "named",
  {
    key: string;                       // element key value (e.g., 'model')
    by?: string;                       // dot-path to key field (default 'name')
    value: BaseFieldType;              // type constraint on matched element
    min?: ConstraintRefValue<number>;  // min occurrences (default 1 = required)
    max?: ConstraintRefValue<number>;  // max occurrences (default 1 = unique)
    reason?: string;
    description?: string;              // help text below label
    placeholder?: string;              // input placeholder
    inputType?: string;                // 'secret' → password field, 'url' → url field, etc.
    default?: unknown;                 // pre-fill value — shown in form, overridable
  }
>;

/* ---------- STRING constraints ---------------------------------- */

export type StringTypeConstraint<
  Name extends string = string,
  Props extends Record<string, any> = Record<string, any>,
> = FieldTypeConstraint<Name, "string", Props>;

export type StringRegexConstraint = StringTypeConstraint<
  "matches",
  { pattern: RegExp; reason?: string }
>;

export type StringIncludesConstraint = StringTypeConstraint<
  "includes",
  { value: string; reason?: string }
>;

export type StringLengthConstraint = StringTypeConstraint<
  "length",
  { min?: ConstraintRefValue<number>; max?: ConstraintRefValue<number>; reason?: string }
>;

/* ---------- NUMBER constraints ---------------------------------- */

export type NumberTypeConstraint<
  Name extends string = string,
  Props extends Record<string, any> = Record<string, any>,
> = FieldTypeConstraint<Name, "number", Props>;

export type NumberMinConstraint = NumberTypeConstraint<
  "min",
  { value: ConstraintRefValue<number>; reason?: string }
>;

export type NumberMaxConstraint = NumberTypeConstraint<
  "max",
  { value: ConstraintRefValue<number>; reason?: string }
>;

export type NumberIntegerConstraint = NumberTypeConstraint<
  "integer",
  { reason?: string }
>;

export type NumberRangeConstraint = NumberTypeConstraint<
  "range",
  { min?: ConstraintRefValue<number>; max?: ConstraintRefValue<number>; reason?: string }
>;

export type NumberExclusiveMinConstraint = NumberTypeConstraint<
  "exclusiveMin",
  { value: ConstraintRefValue<number>; reason?: string }
>;
export type NumberExclusiveMaxConstraint = NumberTypeConstraint<
  "exclusiveMax",
  { value: ConstraintRefValue<number>; reason?: string }
>;
export type NumberMultipleOfConstraint = NumberTypeConstraint<
  "multipleOf",
  { value: ConstraintRefValue<number>; reason?: string }
>;

/* ---------- FUNCTION constraints -------------------------------- */

export type FunctionTypeConstraint<
  Name extends string = string,
  Props extends Record<string, any> = Record<string, any>,
> = FieldTypeConstraint<Name, "function", Props>;

export type FunctionParamConstraint = FunctionTypeConstraint<
  "param",
  { value: BaseFieldType; reason?: string }
>;

export type FunctionReturnsConstraint = FunctionTypeConstraint<
  "returns",
  { value: BaseFieldType; reason?: string }
>;

/**
 * FunctionProjectionConstraint — declares how a function's output constraint
 * can be projected backwards through an inverse to derive input constraints.
 *
 * Used by patchResolve Phase A.4 to narrow unresolved refs inside call expressions.
 * The `inverse` expression is evaluated with 'output' and 'known' in scope:
 *   - output: the output constraint FieldType (from binding or rootType)
 *   - known: forward-combined known args via `combiner` (identity if none)
 */
export type FunctionProjectionConstraint = FunctionTypeConstraint<
  "projection",
  {
    inverse: any;       // Expression — evaluated by evaluateTypeExpr
    combiner: string;   // fn name to forward-combine known args ('numericAdd', 'numericMul')
    identity: number;   // identity element for the combiner (0 for add, 1 for mul)
  }
>;

/* ---------- unions for convenience ------------------------------- */

export type BehavioralConstraint =
  | MergeConstraint
  | PersistConstraint
  | CompactConstraint
  | SubscribeConstraint
  | ForkConstraint
  | VisibilityConstraint
  | DecoratorConstraint
  | AutoMergeConstraint
  | SolveConstraint
  | LabelConstraint
  | CallableConstraint
  | MountConstraint
  | CallConstraint
  | TemporalConstraint;

export type AnyConstraint = LiteralConstraint | ReturnTypeConstraint | RefConstraint | CallConstraint | TemporalConstraint;

export type ObjectConstraint =
  | ObjectPropertyConstraint
  | ObjectPropertiesConstraint
  | ObjectAdditionalConstraint
  | ObjectIndexConstraint
  | AnyConstraint;

export type NumberConstraint =
  | NumberMinConstraint
  | NumberMaxConstraint
  | NumberIntegerConstraint
  | NumberRangeConstraint
  | NumberExclusiveMinConstraint
  | NumberExclusiveMaxConstraint
  | NumberMultipleOfConstraint
  | AnyConstraint;

export type ArrayConstraint =
  | ArrayTypeConstraint
  | ArrayUniqueConstraint
  | ArrayContainsConstraint
  | ArrayNamedConstraint
  | AnyConstraint;

export type StringConstraint =
  | StringRegexConstraint
  | StringIncludesConstraint
  | StringLengthConstraint
  | AnyConstraint;

export type FunctionConstraint =
  | FunctionParamConstraint
  | FunctionReturnsConstraint
  | FunctionProjectionConstraint
  | AnyConstraint;

export type FieldConstraintType =
  | AnyConstraint
  | BehavioralConstraint
  | ObjectConstraint
  | StringConstraint
  | NumberConstraint
  | ArrayConstraint
  | FunctionConstraint;

/* ---------------------------------------------------------------- *
 *  Factory helpers + type‑guards (mirrors previous API)            *
 * ---------------------------------------------------------------- */

/** Helper: creates a `describes` type guard for behavioral constraints.
 *  Uses raw property checks to avoid TS discriminated-union narrowing issues. */
function behavioralDescribes<T extends BehavioralConstraint>(ct: string): (item: any) => item is T {
  return (item: any): item is T =>
    item != null && typeof item === 'object' && item.type === 'typeconstraint' && item.basetype === 'any' && item.constrainttype === ct;
}

export const ConstraintTypes = {
  /* ---------- ANY ----------------------------------------------- */
  any: {
    literal: {
      create<T>(value: T, equals?: string): LiteralConstraint<T> {
        return ConstraintTypes.create("literal", "any", {
          value,
          equals,
        }) as LiteralConstraint<T>;
      },
      describes(item: any): item is LiteralConstraint<any> {
        return (
          ConstraintTypes.any.describes(item) &&
          item.constrainttype === "literal"
        );
      },
    },
    returnedBy: {
      create<T = any>(value: T): ReturnTypeConstraint<T> {
        return ConstraintTypes.create("returnedBy", "any", {
          value,
        }) as ReturnTypeConstraint<T>;
      },
      describes(item: any): item is ReturnTypeConstraint<any> {
        return (
          ConstraintTypes.any.describes(item) &&
          item.constrainttype === "returnedBy"
        );
      },
    },
    ref: {
      create(source: string): RefConstraint {
        return ConstraintTypes.create("ref", "any", { source }) as RefConstraint;
      },
      describes(item: any): item is RefConstraint {
        return (
          ConstraintTypes.any.describes(item) &&
          item.constrainttype === "ref"
        );
      },
    },
    /* --- behavioral constraint factories (pairing demands) --- */
    merge: {
      create(value: ConstraintRefValue<string>, opts?: { override?: 'open' | 'sealed' | 'final'; reason?: string }): MergeConstraint {
        return ConstraintTypes.create("merge", "any", { value, override: opts?.override, reason: opts?.reason }) as MergeConstraint;
      },
      describes: behavioralDescribes<MergeConstraint>("merge"),
    },
    persist: {
      create(sink: ConstraintRefValue<string>, opts?: { target?: ConstraintRefValue<string>; transform?: ConstraintRefValue<string>; reason?: string }): PersistConstraint {
        return ConstraintTypes.create("persist", "any", { sink, target: opts?.target, transform: opts?.transform, reason: opts?.reason }) as PersistConstraint;
      },
      describes: behavioralDescribes<PersistConstraint>("persist"),
    },
    compact: {
      create(opts?: { retain?: ConstraintRefValue<number>; strategy?: ConstraintRefValue<string>; reason?: string }): CompactConstraint {
        return ConstraintTypes.create("compact", "any", { retain: opts?.retain, strategy: opts?.strategy, reason: opts?.reason }) as CompactConstraint;
      },
      describes: behavioralDescribes<CompactConstraint>("compact"),
    },
    subscribe: {
      create(target: ConstraintRefValue<string>, opts?: { reason?: string }): SubscribeConstraint {
        return ConstraintTypes.create("subscribe", "any", { target, reason: opts?.reason }) as SubscribeConstraint;
      },
      describes: behavioralDescribes<SubscribeConstraint>("subscribe"),
    },
    fork: {
      create(value: ConstraintRefValue<string>, opts?: { reason?: string }): ForkConstraint {
        return ConstraintTypes.create("fork", "any", { value, reason: opts?.reason }) as ForkConstraint;
      },
      describes: behavioralDescribes<ForkConstraint>("fork"),
    },
    visibility: {
      create(scope: ConstraintRefValue<string>, opts?: { reason?: string }): VisibilityConstraint {
        return ConstraintTypes.create("visibility", "any", { scope, reason: opts?.reason }) as VisibilityConstraint;
      },
      describes: behavioralDescribes<VisibilityConstraint>("visibility"),
    },
    decorator: {
      create(transform: ConstraintRefValue<string>, opts?: { reason?: string }): DecoratorConstraint {
        return ConstraintTypes.create("decorator", "any", { transform, reason: opts?.reason }) as DecoratorConstraint;
      },
      describes: behavioralDescribes<DecoratorConstraint>("decorator"),
    },
    autoMerge: {
      create(opts?: { reason?: string }): AutoMergeConstraint {
        return ConstraintTypes.create("autoMerge", "any", { reason: opts?.reason }) as AutoMergeConstraint;
      },
      describes: behavioralDescribes<AutoMergeConstraint>("autoMerge"),
    },
    solve: {
      create(opts?: { objective?: string | ((constraint: any) => unknown); reason?: string }): SolveConstraint {
        return ConstraintTypes.create("solve", "any", {
          objective: opts?.objective ?? 'midpoint',
          reason: opts?.reason,
        }) as SolveConstraint;
      },
      describes: behavioralDescribes<SolveConstraint>("solve"),
    },
    label: {
      create(value: ConstraintRefValue<string>, match: BaseFieldType, opts?: { path?: string; reason?: string }): LabelConstraint {
        return ConstraintTypes.create("label", "any", { value, match, path: opts?.path, reason: opts?.reason }) as LabelConstraint;
      },
      describes: behavioralDescribes<LabelConstraint>("label"),
    },
    callable: {
      create(opts?: { reason?: string }): CallableConstraint {
        return ConstraintTypes.create("callable", "any", { reason: opts?.reason }) as CallableConstraint;
      },
      describes: behavioralDescribes<CallableConstraint>("callable"),
    },
    mount: {
      create(opts?: { allow?: readonly string[]; levels?: readonly string[]; pattern?: string; reason?: string }): MountConstraint {
        return ConstraintTypes.create("mount", "any", {
          allow: opts?.allow,
          levels: opts?.levels,
          pattern: opts?.pattern,
          reason: opts?.reason,
        }) as MountConstraint;
      },
      describes: behavioralDescribes<MountConstraint>("mount"),
    },
    call: {
      create(fn: ConstraintRefValue<string>, args: ConstraintRefValue<any>[], opts?: { reason?: string }): CallConstraint {
        return ConstraintTypes.create("call", "any", { fn, args, reason: opts?.reason }) as CallConstraint;
      },
      describes: behavioralDescribes<CallConstraint>("call"),
    },
    temporal: {
      create(after: number, value: any, opts?: { reason?: string }): TemporalConstraint {
        return ConstraintTypes.create("temporal", "any", { after, value, reason: opts?.reason }) as TemporalConstraint;
      },
      describes: behavioralDescribes<TemporalConstraint>("temporal"),
    },
    /* category‑wide helpers */
    create<
      N extends
        AnyConstraint["constrainttype"] = AnyConstraint["constrainttype"],
      P extends Record<string, any> = Record<string, any>,
    >(constrainttype: N, props: P): AnyConstraint {
      return ConstraintTypes.create(
        constrainttype,
        "any",
        props,
      ) as AnyConstraint;
    },
    describes(item: any): item is AnyConstraint {
      return ConstraintTypes.describes(item) && item.basetype === "any";
    },
  },

  /* ---------- STRING -------------------------------------------- */
  string: {
    matches: {
      create(pattern: RegExp, reason?: string): StringRegexConstraint {
        return ConstraintTypes.create("matches", "string", {
          pattern,
          reason,
        }) as StringRegexConstraint;
      },
      describes(item: any): item is StringRegexConstraint {
        return (
          ConstraintTypes.string.describes(item) &&
          item.constrainttype === "matches"
        );
      },
    },
    includes: {
      create(value: string, reason?: string): StringIncludesConstraint {
        return ConstraintTypes.create("includes", "string", {
          value,
          reason,
        }) as StringIncludesConstraint;
      },
      describes(item: any): item is StringIncludesConstraint {
        return (
          ConstraintTypes.string.describes(item) &&
          item.constrainttype === "includes"
        );
      },
    },
    length: {
      create(opts: {
        min?: ConstraintRefValue<number>;
        max?: ConstraintRefValue<number>;
        reason?: string;
      }): StringLengthConstraint {
        return ConstraintTypes.create(
          "length",
          "string",
          opts,
        ) as StringLengthConstraint;
      },
      describes(item: any): item is StringLengthConstraint {
        return (
          ConstraintTypes.string.describes(item) &&
          item.constrainttype === "length"
        );
      },
    },
    create<
      N extends
        StringConstraint["constrainttype"] = StringConstraint["constrainttype"],
      P extends Record<string, any> = Record<string, any>,
    >(constrainttype: N, props: P): StringConstraint {
      return ConstraintTypes.create(
        constrainttype,
        "string",
        props,
      ) as StringConstraint;
    },
    describes(item: any): item is StringConstraint {
      return ConstraintTypes.describes(item) && item.basetype === "string";
    },
  },

  /* ---------- NUMBER -------------------------------------------- */
  number: {
    min: {
      create(value: ConstraintRefValue<number>, reason?: string): NumberMinConstraint {
        return ConstraintTypes.create("min", "number", {
          value,
          reason,
        }) as NumberMinConstraint;
      },
      describes(item: any): item is NumberMinConstraint {
        return (
          ConstraintTypes.number.describes(item) &&
          item.constrainttype === "min"
        );
      },
    },
    max: {
      create(value: ConstraintRefValue<number>, reason?: string): NumberMaxConstraint {
        return ConstraintTypes.create("max", "number", {
          value,
          reason,
        }) as NumberMaxConstraint;
      },
      describes(item: any): item is NumberMaxConstraint {
        return (
          ConstraintTypes.number.describes(item) &&
          item.constrainttype === "max"
        );
      },
    },
    integer: {
      create(reason?: string): NumberIntegerConstraint {
        return ConstraintTypes.create("integer", "number", {
          reason,
        }) as NumberIntegerConstraint;
      },
      describes(item: any): item is NumberIntegerConstraint {
        return (
          ConstraintTypes.number.describes(item) &&
          item.constrainttype === "integer"
        );
      },
    },
    range: {
      create(opts: {
        min?: ConstraintRefValue<number>;
        max?: ConstraintRefValue<number>;
        reason?: string;
      }): NumberRangeConstraint {
        return ConstraintTypes.create(
          "range",
          "number",
          opts,
        ) as NumberRangeConstraint;
      },
      describes(item: any): item is NumberRangeConstraint {
        return (
          ConstraintTypes.number.describes(item) &&
          item.constrainttype === "range"
        );
      },
    },

    exclusiveMin: {
      create(value: ConstraintRefValue<number>, reason?: string): NumberExclusiveMinConstraint {
        return ConstraintTypes.create("exclusiveMin", "number", { value, reason }) as NumberExclusiveMinConstraint;
      },
      describes(i: any): i is NumberExclusiveMinConstraint {
        return ConstraintTypes.number.describes(i) && i.constrainttype === "exclusiveMin";
      },
    },
    exclusiveMax: {
      create(value: ConstraintRefValue<number>, reason?: string): NumberExclusiveMaxConstraint {
        return ConstraintTypes.create("exclusiveMax", "number", { value, reason }) as NumberExclusiveMaxConstraint;
      },
      describes(i: any): i is NumberExclusiveMaxConstraint {
        return ConstraintTypes.number.describes(i) && i.constrainttype === "exclusiveMax";
      },
    },
    multipleOf: {
      create(value: ConstraintRefValue<number>, reason?: string): NumberMultipleOfConstraint {
        return ConstraintTypes.create("multipleOf", "number", { value, reason }) as NumberMultipleOfConstraint;
      },
      describes(i: any): i is NumberMultipleOfConstraint {
        return ConstraintTypes.number.describes(i) && i.constrainttype === "multipleOf";
      },
    },


    create<
      N extends
        NumberConstraint["constrainttype"] = NumberConstraint["constrainttype"],
      P extends Record<string, any> = Record<string, any>,
    >(constrainttype: N, props: P): NumberConstraint {
      return ConstraintTypes.create(
        constrainttype,
        "number",
        props,
      ) as NumberConstraint;
    },

    describes(item: any): item is NumberConstraint {
      return ConstraintTypes.describes(item) && item.basetype === "number";
    },
  },

  object: {
    property: {
      create(
        key: string,
        value: FieldType,
        opts: { optional?: boolean; default?: unknown; reason?: string } = {},
      ): ObjectPropertyConstraint {
        const { optional, default: def, reason } = opts;
        return ConstraintTypes.create("property", "object", {
          key,
          value,
          optional,
          default: def,
          reason,
        }) as ObjectPropertyConstraint;
      },
      describes(i: any): i is ObjectPropertyConstraint {
        return (
          ConstraintTypes.object.describes(i) && i.constrainttype === "property"
        );
      },
    },
    properties: {
      create(
        key: string | RegExp,
        value: FieldType,
        reason?: string,
      ): ObjectPropertiesConstraint {
        return ConstraintTypes.create("properties", "object", {
          key,
          value,
          reason,
        }) as ObjectPropertiesConstraint;
      },
      describes(item: any): item is ObjectPropertiesConstraint {
        return (
          ConstraintTypes.object.describes(item) &&
          item.constrainttype === "properties"
        );
      },
    },
    additional: {
      create(value: false | FieldType, reason?: string): ObjectAdditionalConstraint {
        return ConstraintTypes.create("additional", "object", { value, reason }) as ObjectAdditionalConstraint;
      },
      describes(i: any): i is ObjectAdditionalConstraint {
        return ConstraintTypes.object.describes(i) && i.constrainttype === "additional";
      },
    },
    index: {
      create(
        by: string,
        value: FieldType,
        opts: { key?: string | RegExp; when?: FieldType; reason?: string } = {},
      ): ObjectIndexConstraint {
        return ConstraintTypes.create("index", "object", {
          by,
          value,
          key: opts.key,
          when: opts.when,
          reason: opts.reason,
        }) as ObjectIndexConstraint;
      },
      describes(i: any): i is ObjectIndexConstraint {
        return ConstraintTypes.object.describes(i) && i.constrainttype === "index";
      },
    },

    create<
      N extends
        ObjectConstraint["constrainttype"] = ObjectConstraint["constrainttype"],
    >(constrainttype: N, props: any): ObjectConstraint {
      return ConstraintTypes.create(
        constrainttype,
        "object",
        props,
      ) as ObjectConstraint;
    },

    describes(item: any): item is ObjectConstraint {
      return ConstraintTypes.describes(item) && item.basetype === "object";
    },
  },

  /* please add array constaint here */
  array: {
    unique: {
      create(value: boolean = true, reason?: string): ArrayUniqueConstraint {
        return ConstraintTypes.create("unique", "array", { value, reason }) as ArrayUniqueConstraint;
      },
      describes(i: any): i is ArrayUniqueConstraint {
        return ConstraintTypes.array.describes(i) && i.constrainttype === "unique";
      },
    },
    contains: {
      create(
        value: FieldType,
        opts: { min?: ConstraintRefValue<number>; max?: ConstraintRefValue<number>; reason?: string } = {},
      ): ArrayContainsConstraint {
        return ConstraintTypes.create("contains", "array", {
          value,
          min: opts.min,
          max: opts.max,
          reason: opts.reason,
        }) as ArrayContainsConstraint;
      },
      describes(i: any): i is ArrayContainsConstraint {
        return ConstraintTypes.array.describes(i) && i.constrainttype === "contains";
      },
    },
    named: {
      create(
        key: string,
        value: FieldType,
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
        return ConstraintTypes.create("named", "array", {
          key,
          value,
          by: opts.by,
          min: opts.min,
          max: opts.max,
          reason: opts.reason,
          description: opts.description,
          placeholder: opts.placeholder,
          inputType: opts.inputType,
          default: opts.default,
        }) as ArrayNamedConstraint;
      },
      describes(i: any): i is ArrayNamedConstraint {
        return ConstraintTypes.array.describes(i) && i.constrainttype === "named";
      },
    },

    values: {
      create(
        value: FieldType,
        range?: ArrayIndexRange[],
        reason?: string,
      ): IndexConstraint {
        return ConstraintTypes.create("values", "array", {
          value,
          range,
          reason,
        }) as IndexConstraint;
      },
      describes(i: any): i is IndexConstraint {
        return (
          ConstraintTypes.array.describes(i) && i.constrainttype === "values"
        );
      },
    },
    accumulate: {
      create(
        items: NumberRangeConstraint,
        value: FieldType,
        reason?: string,
      ): AccumulatedConstraint {
        return ConstraintTypes.create("accumulate", "array", {
          items,
          value,
          reason,
        }) as AccumulatedConstraint;
      },
      describes(i: any): i is AccumulatedConstraint {
        return (
          ConstraintTypes.array.describes(i) &&
          i.constrainttype === "accumulate"
        );
      },
    },
    /* category‑wide helpers */
    create<
      N extends
        ArrayConstraint["constrainttype"] = ArrayConstraint["constrainttype"],
      P extends Record<string, any> = Record<string, any>,
    >(constrainttype: N, props: P): ArrayConstraint {
      return ConstraintTypes.create(
        constrainttype,
        "array",
        props,
      ) as ArrayConstraint;
    },
    describes(i: any): i is ArrayConstraint {
      return ConstraintTypes.describes(i) && i.basetype === "array";
    },
  },

  /* ---------- FUNCTION ------------------------------------------ */
  function: {
    param: {
      create(value: FieldType, reason?: string): FunctionParamConstraint {
        return ConstraintTypes.create("param", "function", { value, reason }) as FunctionParamConstraint;
      },
      describes(i: any): i is FunctionParamConstraint {
        return ConstraintTypes.function.describes(i) && i.constrainttype === "param";
      },
    },
    returns: {
      create(value: FieldType, reason?: string): FunctionReturnsConstraint {
        return ConstraintTypes.create("returns", "function", { value, reason }) as FunctionReturnsConstraint;
      },
      describes(i: any): i is FunctionReturnsConstraint {
        return ConstraintTypes.function.describes(i) && i.constrainttype === "returns";
      },
    },
    projection: {
      create(inverse: any, combiner: string, identity: number): FunctionProjectionConstraint {
        return ConstraintTypes.create("projection", "function", { inverse, combiner, identity }) as FunctionProjectionConstraint;
      },
      describes(i: any): i is FunctionProjectionConstraint {
        return ConstraintTypes.function.describes(i) && i.constrainttype === "projection";
      },
    },
    create<
      N extends FunctionConstraint["constrainttype"] = FunctionConstraint["constrainttype"],
      P extends Record<string, any> = Record<string, any>,
    >(constrainttype: N, props: P): FunctionConstraint {
      return ConstraintTypes.create(constrainttype, "function", props) as FunctionConstraint;
    },
    describes(item: any): item is FunctionConstraint {
      return ConstraintTypes.describes(item) && item.basetype === "function";
    },
  },

  /* ---------- low‑level factory & guard ------------------------- */
  create(
    constrainttype: string,
    basetype: string,
    props: Record<string, any>,
  ): FieldTypeConstraint {
    return {
      type: "typeconstraint",
      basetype,
      constrainttype,
      ...props,
    } as FieldTypeConstraint;
  },

  describes(item: any): item is FieldConstraintType {
    return typeof item === "object" && item?.type === "typeconstraint";
  },
} as const;

/* ---------- behavioral constraint helpers ------------------------- */

/** The constrainttype values that identify behavioral (pairing demand) constraints. */
export const BEHAVIORAL_CONSTRAINT_TYPES = [
  'merge', 'persist', 'compact', 'subscribe', 'fork', 'visibility', 'decorator', 'autoMerge', 'solve', 'label', 'callable', 'mount', 'call', 'temporal',
] as const;

export type BehavioralConstraintType = typeof BEHAVIORAL_CONSTRAINT_TYPES[number];

/** Type guard for behavioral constraints (pairing demands on interpreters). */
export function isBehavioralConstraint(item: any): item is BehavioralConstraint {
  return ConstraintTypes.describes(item) &&
    item.basetype === 'any' &&
    (BEHAVIORAL_CONSTRAINT_TYPES as readonly string[]).includes(item.constrainttype);
}

/* ---------- constraint ref collection ----------------------------- */

/**
 * Walk an attributes array and collect all ConstraintRef paths.
 * Used by the compilation manifest to record scope binding dependencies.
 */
export function collectConstraintRefs(attributes: any[] | undefined): string[] {
  if (!attributes) return [];
  const paths: string[] = [];
  for (const attr of attributes) {
    if (!attr || typeof attr !== 'object') continue;
    // Walk all own properties looking for ConstraintRef values
    for (const key of Object.keys(attr)) {
      const v = attr[key];
      if (isConstraintRef(v)) {
        paths.push(v.path);
      }
    }
  }
  return paths;
}

/* ---------- constraint ref substitution -------------------------- */

/**
 * Walk a FieldTypeCreationEvent's attributes, replace ConstraintRef values
 * with concrete scope values. Returns { substituted, unresolvedRefs }.
 *
 * If a ref path is not in the scope, it stays as a ConstraintRef (deferred).
 * Nested FieldType-valued attributes (e.g., `value` on property constraints)
 * are walked recursively.
 */
export function substituteConstraintRefs(
  schema: any,
  scope: Map<string, any>,
): { substituted: any; unresolvedRefs: string[] } {
  if (!schema?.attributes?.length) return { substituted: schema, unresolvedRefs: [] };

  const unresolvedRefs: string[] = [];
  const newAttributes = schema.attributes.map((attr: any) => {
    if (!attr || typeof attr !== 'object') return attr;
    const patched = { ...attr };
    for (const key of Object.keys(patched)) {
      const v = patched[key];
      if (isConstraintRef(v)) {
        if (scope.has(v.path)) {
          patched[key] = scope.get(v.path);
        } else {
          if (!unresolvedRefs.includes(v.path)) unresolvedRefs.push(v.path);
        }
      }
      // Recurse into nested FieldTypeCreationEvents (e.g., property value types)
      if (v && typeof v === 'object' && v.attributes && Array.isArray(v.attributes)) {
        const nested = substituteConstraintRefs(v, scope);
        patched[key] = nested.substituted;
        for (const r of nested.unresolvedRefs) {
          if (!unresolvedRefs.includes(r)) unresolvedRefs.push(r);
        }
      }
    }
    return patched;
  });

  return {
    substituted: { ...schema, attributes: newAttributes },
    unresolvedRefs,
  };
}

