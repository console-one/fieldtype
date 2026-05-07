/* ------------------------------------------------------------------ *
 *  fieldtype.ts  — minimal version, no NodeRef / Requirement         *
 * ------------------------------------------------------------------ */

import { FieldTypeError } from './error.js';
import {
  AnyConstraint,
  ObjectConstraint,
  ArrayConstraint,
  StringConstraint,
  NumberConstraint,
  FunctionConstraint,
  ConstraintTypes,
  type ConstraintRef,
  type ConstraintRefValue,
} from "./constraint.js";

import {
  FieldTypeCreationEvent,
  FieldTypeEvent,
  FieldTypePatchEvent,
} from "./event.js";
import type { ObjectPatch } from "@console-one/patchkit";

/* ---------- 1. Core node shapes ---------------------------------- */



import format from './format.js'

export function literalFromAttributes(attrs: any[] | undefined) {
  if (!attrs) return undefined;
  for (const a of attrs) {
    if (ConstraintTypes.any.literal.describes(a)) {
      return a.value;
    }
  }
  return undefined;
}


export function cloneType(t: FieldType): FieldType {
  // Rebuild from the creation event for a clean, detached copy
  return FieldType.fromEvent(t.toEvent());
}


export function isNever(n: FieldType) {
  return n.fieldtype === "never";
}




export type BaseFieldTypeProps<
  T extends string = string,
  Attributes = never,
> = {
  type: "baseType";
  fieldtype: T;
  extensions: BaseFieldTypeProps[]; // self‑references only
  attributes: (Attributes extends never
    ? AnyConstraint
    : AnyConstraint | Attributes)[];
  prev?: BaseFieldTypeProps;
  update?:
    | FieldTypeCreationEvent<
        T,
        Attributes extends never ? AnyConstraint : AnyConstraint | Attributes
      >
    | FieldTypePatchEvent<Attributes>;
};

export type ObjWithout<T extends string> = Omit<Record<any, any>, T>;


export type BaseFieldType<
  FT extends string = string,
  Attributes extends any = never,
  Extra extends ObjWithout<keyof BaseFieldTypeProps<FT>> = ObjWithout<
    keyof BaseFieldTypeProps<FT>
  >,
> = BaseFieldTypeProps<FT, Attributes> & Extra;

/* ---------- Fluent helper typing (types only) -------------------- */

type BaseFT = BaseFieldType<any, any>;

/** Compute the fully-augmented fluent type for a given base type T */
type Augment<T extends BaseFT> = T["fieldtype"] extends "string"
  ? T & FluentCommon<T> & FluentString<T>
  : T["fieldtype"] extends "number"
    ? T & FluentCommon<T> & FluentNumber<T>
    : T["fieldtype"] extends "object"
      ? T & FluentCommon<T> & FluentObject<T>
      : T["fieldtype"] extends "array"
        ? T & FluentCommon<T> & FluentArray<T>
        : T["fieldtype"] extends "or"
          ? T & FluentCommon<T> & FluentOr<T>
          : T["fieldtype"] extends "and"
            ? T & FluentCommon<T> & FluentAnd<T>
            : T["fieldtype"] extends "not"
              ? T & FluentCommon<T> & FluentNot<T>
              : T["fieldtype"] extends "function"
                ? T & FluentCommon<T> & FluentFunction<T>
                : T["fieldtype"] extends "var"
                  ? T & FluentCommon<T>
                  : T & FluentCommon<T>;

/** All common helpers must return the fully-augmented type */
export type FluentCommon<T extends BaseFT> = {
  literal(value: any, equals?: string): Augment<T>;
  returnedBy(value: any): Augment<T>;
  meta(metadata: any): Augment<T>;
  toEvent(opts?: { withDraft?: boolean }): FieldTypeEvent;
  toEvents(opts?: { withDraft?: boolean }): FieldTypeEvent[];
  save(): Augment<T>;
  extractLiterals(): unknown;
  missingLiteralRequirements(): { path: (string | number)[]; reason: string }[];
  composeWith(other: FieldType): Augment<T>;   // ← new
  // behavioral pairing demands — available on all FieldType kinds
  merge(value: ConstraintRefValue<string>, opts?: { override?: 'open' | 'sealed' | 'final'; reason?: string }): Augment<T>;
  persist(sink: ConstraintRefValue<string>, opts?: { target?: ConstraintRefValue<string>; transform?: ConstraintRefValue<string>; reason?: string }): Augment<T>;
  compact(opts?: { retain?: ConstraintRefValue<number>; strategy?: ConstraintRefValue<string>; reason?: string }): Augment<T>;
  subscribe(target: ConstraintRefValue<string>, opts?: { reason?: string }): Augment<T>;
  fork(value: ConstraintRefValue<string>, opts?: { reason?: string }): Augment<T>;
  visibility(scope: ConstraintRefValue<string>, opts?: { reason?: string }): Augment<T>;
  decorator(transform: ConstraintRefValue<string>, opts?: { reason?: string }): Augment<T>;
  autoMerge(opts?: { reason?: string }): Augment<T>;
  solve(opts?: { objective?: string | ((constraint: any) => unknown); reason?: string }): Augment<T>;
  label(value: ConstraintRefValue<string>, match: FieldType, opts?: { path?: string; reason?: string }): Augment<T>;
  callable(opts?: { reason?: string }): Augment<T>;
  claim(claimtype: string, opts?: {
    lhs?: string;
    rhs?: string;
    args?: readonly unknown[];
    scope?: string;
    temporal?: unknown;
    confidence?: number;
    reason?: string;
  }): Augment<T>;
};

export type FluentString<T extends BaseFT> = {
  matches(re: RegExp, reason?: string): Augment<T>;
  includes(value: string, reason?: string): Augment<T>;
  length(
    p: { min?: ConstraintRefValue<number>; max?: ConstraintRefValue<number>; reason?: string } | ConstraintRefValue<number>,
    max?: ConstraintRefValue<number>,
    reason?: string,
  ): Augment<T>;
};

export type FluentNumber<T extends BaseFT> = {
  min(value: ConstraintRefValue<number>, reason?: string): Augment<T>;
  max(value: ConstraintRefValue<number>, reason?: string): Augment<T>;
  integer(reason?: string): Augment<T>;
  range(
    p: { min?: ConstraintRefValue<number>; max?: ConstraintRefValue<number>; reason?: string } | ConstraintRefValue<number>,
    max?: ConstraintRefValue<number>,
    reason?: string,
  ): Augment<T>;
};

export type FluentObject<T extends BaseFT> = {
  property(
    key: string,
    value: FieldType,
    opts?: { optional?: boolean; default?: unknown; reason?: string },
  ): Augment<T>;
  properties(
    key: string | RegExp,
    value: FieldType,
    reason?: string,
  ): Augment<T>;
  additional(value: FieldType | false, reason?: string): Augment<T>;
  indexBy(by: string, value: FieldType, opts?: { key?: string | RegExp; when?: FieldType; reason?: string }): Augment<T>;
};

export type FluentArray<T extends BaseFT> = {
  index(value: FieldType, range?: any[], reason?: string): Augment<T>;
  values(value: FieldType, range?: any[], reason?: string): Augment<T>;
  accumulate(items: any, value: FieldType, reason?: string): Augment<T>;
};

export type FluentOr<T extends BaseFT> = { add(...children: FieldType[]): Augment<T> };
export type FluentAnd<T extends BaseFT> = {
  add(...children: FieldType[]): Augment<T>;
};
export type FluentNot<T extends BaseFT> = { of(child: FieldType): Augment<T> };
export type FluentFunction<T extends BaseFT> = {
  param(value: FieldType, reason?: string): Augment<T>;
  returns(value: FieldType, reason?: string): Augment<T>;
  impl(id: string, reason?: string): Augment<T>;
  identity(outputPath: string, inputPath: string, reason?: string): Augment<T>;
  preserves(inputPath: string, outputPath?: string, reason?: string): Augment<T>;
  temporal(dir: "gt" | "lt", lhs: string, bound: unknown, reason?: string): Augment<T>;
};

/** Public alias used elsewhere */
export type Fluentize<T extends BaseFT> = Augment<T>;

// And keep these as they were, but now they’re fluent:
export type AnyType = Fluentize<BaseFieldType<"any", AnyConstraint>>;
export type NeverType = Fluentize<BaseFieldType<"never", AnyConstraint>>;
export type ObjectType = Fluentize<BaseFieldType<"object", ObjectConstraint>>;
export type ArrayType = Fluentize<BaseFieldType<"array", ArrayConstraint>>;
export type StringType = Fluentize<BaseFieldType<"string", StringConstraint>>;
export type NumberType = Fluentize<BaseFieldType<"number", NumberConstraint>>;
export type OrType = Fluentize<BaseFieldType<"or", BaseFieldType>>;
export type AndType = Fluentize<BaseFieldType<"and", BaseFieldType>>;
export type NotType = Fluentize<BaseFieldType<"not", BaseFieldType>>;
export type BooleanType = Fluentize<BaseFieldType<"boolean", AnyConstraint>>;
export type NullType = Fluentize<BaseFieldType<"null", AnyConstraint>>;
export type FunctionType = Fluentize<BaseFieldType<"function", FunctionConstraint>>;
export type VarType = Fluentize<
  BaseFieldType<"var", AnyConstraint, { name: string; varId: string; bound?: FieldType; [key: string]: any }>
>;

export type FieldType =
  | AnyType
  | NeverType
  | ObjectType
  | ArrayType
  | StringType
  | NumberType
  | OrType
  | AndType
  | NotType
  | BooleanType
  | NullType
  | FunctionType
  | VarType;

/* helper for `.create()` optional extras */
type Cfg = { extensions?: BaseFieldTypeProps[]; metadata?: any };

export type BaseReferenceContext<
  ReferenceContextType extends string = string,
  Ctx extends any = any,
> = {
  type: "referencecontext";
  refcontexttype: ReferenceContextType;
  context: Ctx;
};

export type ObjectReferenceContext = BaseReferenceContext<
  "object",
  { [key: string]: FieldTypeEvent }
>;
export type FunctionReferenceContext = BaseReferenceContext<
  "function",
  (name: string) => Promise<FieldTypeEvent>
>;
export type ReferenceContextInput =
  | ObjectReferenceContext
  | FunctionReferenceContext;

export const DRAFT_SYM = Symbol("fieldtype_draft");
const NODE_INSPECT_SYM: any =
  typeof Symbol !== "undefined" && (Symbol as any).for
    ? (Symbol as any).for("nodejs.util.inspect.custom")
    : undefined;


export type DraftPatch<Attributes extends any, Extensions extends any> = {
  type: "draftpatch";
  metadata?: ObjectPatch;
  attributes?: Attributes[];
  extensions?: Extensions[];
};

export type FieldTypeInnerModifier<
  Arguments extends any[] = any[],
  T extends string = string,
  Attributes extends any = any,
  Extensions extends any = any,
> = (
  draft: Draft<T, Attributes, Extensions>,
  ...args: Arguments
) => Draft<T, Attributes, Extensions>;

export type FieldTypeInnerModifiers<
  Arguments extends any[] = any[],
  T extends string = string,
  Attributes extends any = any,
  Extensions extends any = any,
> = {
  [key: string]: FieldTypeInnerModifier<Arguments, T, Attributes, Extensions>;
};

export type Draft<
  T extends string = string,
  Attributes extends any = any,
  Extensions extends any = any,
> = {
  type: "draft";
  state: {
    readonly base: BaseFieldType<T, Attributes>;
    readonly patches: DraftPatch<Attributes, Extensions>[];
  };
  update(
    add: DraftPatch<Attributes, Extensions>,
  ): Draft<T, Attributes, Extensions>;
  build(): FieldType;
};

const Draft = {
  create<T extends string, A, E = never>(
    base: BaseFieldType<T, A>,
  ): Draft<T, A, E> {
    const state = { base, patches: [] as DraftPatch<A, E>[] };
    return {
      type: "draft",
      state,
      update(add: DraftPatch<A, E>) {
        state.patches.push(add);
        return this;
      },
      build(): FieldType {
        // replay patches as real events chained on top of the current base
        let cur: FieldType = state.base as any;
        for (const p of state.patches) {
          const attrs = p.attributes ?? [];
          const exts = p.extensions ?? [];
          const meta = p.metadata;

          if (attrs.length > 0 || meta !== undefined) {
            const evt: any = FieldTypeEvent.patch.create({
              target: (cur as any).update!,
              attributes: (attrs.length === 1
                ? (attrs[0] as any)
                : (attrs as any)) as any,
              metadata: meta,
            });
            cur = FieldType.extend(cur as any, evt);
          }

          for (const ext of exts) {
            const evt = FieldTypeEvent.patch.create({
              target: (cur as any).update!,
              extension: ext as any,
            });
            cur = FieldType.extend(cur as any, evt);
          }
        }
        // clear patches once built (caller keeps returned node)
      //  state.patches.length = 0;
        return cur;
      },
    };
  },
};

/* ---------------- Modifiers -------------------------------------- */
export const Modifiers = {
  any: {
    literal<T extends string, A, E>(
      draft: Draft<T, A, E>,
      value: any,
      equals?: string,
    ) {
      return draft.update({
        type: "draftpatch",
        attributes: [ConstraintTypes.any.literal.create(value, equals) as any],
      });
    },
    returnedBy<T extends string, A, E>(draft: Draft<T, A, E>, value: any) {
      return draft.update({
        type: "draftpatch",
        attributes: [ConstraintTypes.any.returnedBy.create(value) as any],
      });
    },
    meta<T extends string, A, E>(draft: Draft<T, A, E>, metadata: any) {
      return draft.update({ type: "draftpatch", metadata });
    },
    metadata<T extends string, A, E>(draft: Draft<T, A, E>, metadata: any) {
      return Modifiers.any.meta(draft, metadata);
    },
    merge<T extends string, A, E>(draft: Draft<T, A, E>, value: ConstraintRefValue<string>, opts?: { override?: 'open' | 'sealed' | 'final'; reason?: string }) {
      return draft.update({ type: "draftpatch", attributes: [ConstraintTypes.any.merge.create(value, opts) as any] });
    },
    persist<T extends string, A, E>(draft: Draft<T, A, E>, sink: ConstraintRefValue<string>, opts?: { target?: ConstraintRefValue<string>; transform?: ConstraintRefValue<string>; reason?: string }) {
      return draft.update({ type: "draftpatch", attributes: [ConstraintTypes.any.persist.create(sink, opts) as any] });
    },
    compact<T extends string, A, E>(draft: Draft<T, A, E>, opts?: { retain?: ConstraintRefValue<number>; strategy?: ConstraintRefValue<string>; reason?: string }) {
      return draft.update({ type: "draftpatch", attributes: [ConstraintTypes.any.compact.create(opts) as any] });
    },
    subscribe<T extends string, A, E>(draft: Draft<T, A, E>, target: ConstraintRefValue<string>, opts?: { reason?: string }) {
      return draft.update({ type: "draftpatch", attributes: [ConstraintTypes.any.subscribe.create(target, opts) as any] });
    },
    fork<T extends string, A, E>(draft: Draft<T, A, E>, value: ConstraintRefValue<string>, opts?: { reason?: string }) {
      return draft.update({ type: "draftpatch", attributes: [ConstraintTypes.any.fork.create(value, opts) as any] });
    },
    visibility<T extends string, A, E>(draft: Draft<T, A, E>, scope: ConstraintRefValue<string>, opts?: { reason?: string }) {
      return draft.update({ type: "draftpatch", attributes: [ConstraintTypes.any.visibility.create(scope, opts) as any] });
    },
    decorator<T extends string, A, E>(draft: Draft<T, A, E>, transform: ConstraintRefValue<string>, opts?: { reason?: string }) {
      return draft.update({ type: "draftpatch", attributes: [ConstraintTypes.any.decorator.create(transform, opts) as any] });
    },
    autoMerge<T extends string, A, E>(draft: Draft<T, A, E>, opts?: { reason?: string }) {
      return draft.update({ type: "draftpatch", attributes: [ConstraintTypes.any.autoMerge.create(opts) as any] });
    },
    solve<T extends string, A, E>(draft: Draft<T, A, E>, opts?: { objective?: string | ((constraint: any) => unknown); reason?: string }) {
      return draft.update({ type: "draftpatch", attributes: [ConstraintTypes.any.solve.create(opts) as any] });
    },
    label<T extends string, A, E>(draft: Draft<T, A, E>, value: ConstraintRefValue<string>, match: BaseFieldType, opts?: { path?: string; reason?: string }) {
      return draft.update({ type: "draftpatch", attributes: [ConstraintTypes.any.label.create(value, match, opts) as any] });
    },
    callable<T extends string, A, E>(draft: Draft<T, A, E>, opts?: { reason?: string }) {
      return draft.update({ type: "draftpatch", attributes: [ConstraintTypes.any.callable.create(opts) as any] });
    },
    claim<T extends string, A, E>(
      draft: Draft<T, A, E>,
      claimtype: string,
      opts?: {
        lhs?: string;
        rhs?: string;
        args?: readonly unknown[];
        scope?: string;
        temporal?: unknown;
        confidence?: number;
        reason?: string;
      },
    ) {
      return draft.update({ type: "draftpatch", attributes: [ConstraintTypes.any.claim.create(claimtype, opts) as any] });
    },
  },

  string: {
    matches<T extends string, A, E>(
      d: Draft<T, A, E>,
      pattern: RegExp,
      reason?: string,
    ) {
      return d.update({
        type: "draftpatch",
        attributes: [
          ConstraintTypes.string.matches.create(pattern, reason) as any,
        ],
      });
    },
    includes<T extends string, A, E>(
      d: Draft<T, A, E>,
      value: string,
      reason?: string,
    ) {
      return d.update({
        type: "draftpatch",
        attributes: [
          ConstraintTypes.string.includes.create(value, reason) as any,
        ],
      });
    },
    length<T extends string, A, E>(
      d: Draft<T, A, E>,
      p: { min?: ConstraintRefValue<number>; max?: ConstraintRefValue<number>; reason?: string } | ConstraintRefValue<number>,
      max?: ConstraintRefValue<number>,
      reason?: string,
    ) {
      const cfg = typeof p === "number" || (p != null && typeof p === 'object' && '__ref' in p) ? { min: p, max, reason } : p;
      return d.update({
        type: "draftpatch",
        attributes: [ConstraintTypes.string.length.create(cfg as any) as any],
      });
    },
  },

  number: {
    min<T extends string, A, E>(
      d: Draft<T, A, E>,
      value: ConstraintRefValue<number>,
      reason?: string,
    ) {
      return d.update({
        type: "draftpatch",
        attributes: [ConstraintTypes.number.min.create(value, reason) as any],
      });
    },
    max<T extends string, A, E>(
      d: Draft<T, A, E>,
      value: ConstraintRefValue<number>,
      reason?: string,
    ) {
      return d.update({
        type: "draftpatch",
        attributes: [ConstraintTypes.number.max.create(value, reason) as any],
      });
    },
    integer<T extends string, A, E>(d: Draft<T, A, E>, reason?: string) {
      return d.update({
        type: "draftpatch",
        attributes: [ConstraintTypes.number.integer.create(reason) as any],
      });
    },
    range<T extends string, A, E>(
      d: Draft<T, A, E>,
      p: { min?: ConstraintRefValue<number>; max?: ConstraintRefValue<number>; reason?: string } | ConstraintRefValue<number>,
      max?: ConstraintRefValue<number>,
      reason?: string,
    ) {
      const cfg = typeof p === "number" || (p != null && typeof p === 'object' && '__ref' in p) ? { min: p, max, reason } : p;
      return d.update({
        type: "draftpatch",
        attributes: [ConstraintTypes.number.range.create(cfg as any) as any],
      });
    },
  },

  object: {
    property<T extends string, A, E>(
      d: Draft<T, A, E>,
      key: string,
      value: FieldType,
      opts: { optional?: boolean; default?: unknown; reason?: string } = {},
    ) {
      return d.update({
        type: "draftpatch",
        attributes: [
          ConstraintTypes.object.property.create(key, value.save(), opts) as any,
        ],
      });
    },
    properties<T extends string, A, E>(
      d: Draft<T, A, E>,
      key: string | RegExp,
      value: FieldType,
      reason?: string,
    ) {
      return d.update({
        type: "draftpatch",
        attributes: [
          ConstraintTypes.object.properties.create(key, value.save(), reason) as any,
        ],
      });
    },
    additional<T extends string, A, E>(
      d: Draft<T, A, E>,
      value: FieldType | false,
      reason?: string,
    ) {
      return d.update({
        type: "draftpatch",
        attributes: [ConstraintTypes.object.additional.create(typeof value === 'object' ? value.save() : value as any, reason) as any],
      });
    },
    indexBy<T extends string, A, E>(
      d: Draft<T, A, E>,
      by: string,
      value: FieldType,
      opts?: { key?: string | RegExp; when?: FieldType; reason?: string },
    ) {
      return d.update({
        type: "draftpatch",
        attributes: [ConstraintTypes.object.index.create(by, value.save(), opts as any) as any],
      });
    },
  },

  array: {
    index<T extends string, A, E>(
      d: Draft<T, A, E>,
      value: FieldType,
      range?: any[],
      reason?: string,
    ) {
      return d.update({
        type: "draftpatch",
        attributes: [
          ConstraintTypes.array.values.create(
            value.save(),
            range as any,
            reason,
          ) as any,
        ],
      });
    },
    values<T extends string, A, E>(
      d: Draft<T, A, E>,
      value: FieldType,
      range?: any[],
      reason?: string,
    ) {
      return Modifiers.array.index(d, value.save(), range, reason);
    },
    accumulate<T extends string, A, E>(
      d: Draft<T, A, E>,
      items: any,
      value: FieldType,
      reason?: string,
    ) {
      return d.update({
        type: "draftpatch",
        attributes: [
          ConstraintTypes.array.accumulate.create(items, value.save(), reason) as any,
        ],
      });
    },
  },

  or: {
    add<T extends string, A, E>(d: Draft<T, A, E>, ...children: FieldType[]) {
      return d.update({ type: "draftpatch", attributes: children as any });
    },
  },
  and: {
    add<T extends string, A, E>(d: Draft<T, A, E>, ...children: FieldType[]) {
      return d.update({ type: "draftpatch", attributes: children as any });
    },
  },
  not: {
    of<T extends string, A, E>(d: Draft<T, A, E>, child: FieldType) {
      return d.update({ type: "draftpatch", attributes: [child as any] });
    },
  },
  never: {
    of<T extends string, A, E>(d: Draft<T, A, E>, child: FieldType) {
      return d.update({ type: "draftpatch", attributes: [child as any] });
    },
  },

  function: {
    param<T extends string, A, E>(d: Draft<T, A, E>, value: FieldType, reason?: string) {
      return d.update({
        type: "draftpatch",
        attributes: [ConstraintTypes.function.param.create(value.save(), reason) as any],
      });
    },
    returns<T extends string, A, E>(d: Draft<T, A, E>, value: FieldType, reason?: string) {
      return d.update({
        type: "draftpatch",
        attributes: [ConstraintTypes.function.returns.create(value.save(), reason) as any],
      });
    },
    impl<T extends string, A, E>(d: Draft<T, A, E>, id: string, reason?: string) {
      return d.update({
        type: "draftpatch",
        attributes: [ConstraintTypes.function.impl.create(id, reason) as any],
      });
    },
    identity<T extends string, A, E>(d: Draft<T, A, E>, outputPath: string, inputPath: string, reason?: string) {
      return d.update({
        type: "draftpatch",
        attributes: [ConstraintTypes.function.identity.create(outputPath, inputPath, reason) as any],
      });
    },
    preserves<T extends string, A, E>(d: Draft<T, A, E>, inputPath: string, outputPath?: string, reason?: string) {
      return d.update({
        type: "draftpatch",
        attributes: [ConstraintTypes.function.preserves.create(inputPath, outputPath, reason) as any],
      });
    },
    temporal<T extends string, A, E>(d: Draft<T, A, E>, dir: "gt" | "lt", lhs: string, bound: unknown, reason?: string) {
      return d.update({
        type: "draftpatch",
        attributes: [ConstraintTypes.function.temporal.create(dir, lhs, bound, reason) as any],
      });
    },
  },
} as const;


import { extractLiterals, missingLiteralReqs } from './concreteness.js'

/* Utility to attach fluent helpers + event methods to a FieldType instance */
function attachHelpers<T extends FieldType>(node: T): T {
  const base = node as any;
  const ensureDraft = () => (base[DRAFT_SYM] ??= Draft.create(base));

  // common helpers
  base.literal = (v: any, equals?: string) => (
    Modifiers.any.literal(ensureDraft(), v, equals),
    base
  );
  base.returnedBy = (v: any) => (
    Modifiers.any.returnedBy(ensureDraft(), v),
    base
  );
  // behavioral pairing demands
  base.merge = (v: any, opts?: any) => (Modifiers.any.merge(ensureDraft(), v, opts), base);
  base.persist = (sink: any, opts?: any) => (Modifiers.any.persist(ensureDraft(), sink, opts), base);
  base.compact = (opts?: any) => (Modifiers.any.compact(ensureDraft(), opts), base);
  base.subscribe = (target: any, opts?: any) => (Modifiers.any.subscribe(ensureDraft(), target, opts), base);
  base.fork = (v: any, opts?: any) => (Modifiers.any.fork(ensureDraft(), v, opts), base);
  base.visibility = (scope: any, opts?: any) => (Modifiers.any.visibility(ensureDraft(), scope, opts), base);
  base.decorator = (transform: any, opts?: any) => (Modifiers.any.decorator(ensureDraft(), transform, opts), base);
  base.autoMerge = (opts?: any) => (Modifiers.any.autoMerge(ensureDraft(), opts), base);
  base.solve = (opts?: any) => (Modifiers.any.solve(ensureDraft(), opts), base);
  base.label = (v: any, match: any, opts?: any) => (Modifiers.any.label(ensureDraft(), v, match, opts), base);
  base.callable = (opts?: any) => (Modifiers.any.callable(ensureDraft(), opts), base);
  base.claim = (claimtype: string, opts?: any) => (Modifiers.any.claim(ensureDraft(), claimtype, opts), base);

  base.meta = (m: any) => {
    Modifiers.any.meta(ensureDraft(), m);
    return base.save();
  };
  // NEW: extraction and requirements
  base.extractLiterals = () => extractLiterals(base);
  base.missingLiteralRequirements = () => missingLiteralReqs(base);
  base.composeWith = (other: FieldType) => FieldType.compose(base, other);

  // per-type helpers
  switch (base.fieldtype) {
    case "string":
      base.matches = (re: RegExp, r?: string) => (
        Modifiers.string.matches(ensureDraft(), re, r),
        base
      );
      base.includes = (s: string, r?: string) => (
        Modifiers.string.includes(ensureDraft(), s, r),
        base
      );
      base.length = (p: any, max?: number, r?: string) => (
        Modifiers.string.length(ensureDraft(), p, max, r),
        base
      );
      break;
    case "number":
      base.min = (v: number, r?: string) => (
        Modifiers.number.min(ensureDraft(), v, r),
        base
      );
      base.max = (v: number, r?: string) => (
        Modifiers.number.max(ensureDraft(), v, r),
        base
      );
      base.integer = (r?: string) => (
        Modifiers.number.integer(ensureDraft(), r),
        base
      );
      base.range = (p: any, max?: number, r?: string) => (
        Modifiers.number.range(ensureDraft(), p, max, r),
        base
      );
      break;
    case "object":
      base.property = (k: string, v: FieldType, opts?: any) => (Modifiers.object.property(ensureDraft(), k, v, opts), base);
      base.properties = (k: string | RegExp, v: FieldType, r?: string) => (Modifiers.object.properties(ensureDraft(), k, v, r), base);
      base.additional = (val: FieldType | false, r?: string) => (Modifiers.object.additional(ensureDraft(), val, r), base);
      base.indexBy = (by: string, v: FieldType, opts?: any) => (Modifiers.object.indexBy(ensureDraft(), by, v, opts), base);
      break;
    case "array":
      base.index = (v: FieldType, range?: any[], r?: string) => (
        Modifiers.array.index(ensureDraft(), v, range, r),
        base
      );
      base.values = (v: FieldType, range?: any[], r?: string) => (
        Modifiers.array.values(ensureDraft(), v, range, r),
        base
      );
      base.accumulate = (items: any, v: FieldType, r?: string) => (
        Modifiers.array.accumulate(ensureDraft(), items, v, r),
        base
      );
      break;
    case "or":
      base.add = (...children: FieldType[]) => (
        Modifiers.or.add(ensureDraft(), ...children),
        base
      );
      break;
    case "and":
      base.add = (...children: FieldType[]) => (
        Modifiers.and.add(ensureDraft(), ...children),
        base
      );
      break;
    case "not":
      base.of = (child: FieldType) => (
        Modifiers.not.of(ensureDraft(), child),
        base
      );
      break;
    case "never":
      base.of = (child: FieldType) => (
        Modifiers.never.of(ensureDraft(), child),
        base
      );
      break;
    case "function":
      base.param = (v: FieldType, r?: string) => (
        Modifiers.function.param(ensureDraft(), v, r),
        base
      );
      base.returns = (v: FieldType, r?: string) => (
        Modifiers.function.returns(ensureDraft(), v, r),
        base
      );
      base.impl = (id: string, r?: string) => (
        Modifiers.function.impl(ensureDraft(), id, r),
        base
      );
      base.identity = (outPath: string, inPath: string, r?: string) => (
        Modifiers.function.identity(ensureDraft(), outPath, inPath, r),
        base
      );
      base.preserves = (inputPath: string, outputPath?: string, r?: string) => (
        Modifiers.function.preserves(ensureDraft(), inputPath, outputPath, r),
        base
      );
      base.temporal = (dir: "gt" | "lt", lhs: string, bound: unknown, r?: string) => (
        Modifiers.function.temporal(ensureDraft(), dir, lhs, bound, r),
        base
      );
      break;
  }

  // event utilities
  base.toEvent = (opts?: { withDraft?: boolean }) => {
    // When withDraft=true: return the *current* event (patch if there is a draft)
    if (opts?.withDraft) {
      const before = listEvents(base).at(-1) ?? (base.update as FieldTypeEvent);
      const draft: Draft<any, any, any> | undefined = base[DRAFT_SYM];
      if (!draft || draft.state.patches.length === 0) return before;
      const built = draft.build();
      return (built as any).update as FieldTypeEvent; // this is the draft patch
    }

    // Default: return the **creation** (state) event for stability
    const events = listEvents(base);
    return (events[0] ?? (base.update as FieldTypeEvent)) as FieldTypeEvent;
  };

  base.toEvents = (opts?: { withDraft?: boolean }) => {
    const events = listEvents(base); // [state, ...patches]
    if (opts?.withDraft) {
      const draft: Draft<any, any, any> | undefined = base[DRAFT_SYM];
      if (draft && draft.state.patches.length > 0) {
        const built = draft.build();
        return listEvents(built as any); // [state, ...patches, draftPatch]
      }
    }
    return events;
  };

  base.save = () => {
    const draft: Draft<any, any, any> | undefined = base[DRAFT_SYM];
    if (!draft || draft.state.patches.length === 0) return base as T;
    return draft.build() as T;
  };

  // human-readable output
  try {
    Object.defineProperty(base, "toString", {
      enumerable: false,
      value: () => format(base),
    });
    Object.defineProperty(base, "toJSON", {
      enumerable: false,
      value: () => ({ __ft: format(base) }),
    });
    if (NODE_INSPECT_SYM) {
      Object.defineProperty(base, NODE_INSPECT_SYM, {
        enumerable: false,
        value: () => format(base),
      });
    }
  } catch {}

  return base as T;
}

function listEvents(n: FieldType): FieldTypeEvent[] {
  const out: FieldTypeEvent[] = [];
  let cur: any = n;
  while (cur) {
    if (cur.update) out.push(cur.update);
    cur = cur.prev;
  }
  return out.reverse();
}




import * as compose from './compose.js'
import * as find from './find.js'


// todo - patchlike

export const FieldTypeSpec = {

  extend<T extends FieldType = FieldType, K extends FieldType = FieldType>(
    item: T,
    patch: FieldTypePatchEvent<T["attributes"], K["fieldtype"], K>,
    passedDraft?: any,
  ) {
  // Prepare a stable history that *must* contain the previous node
  const history = Array.isArray((item as any).extensions)
    ? (item as any).extensions.concat([item as any])
    : [item as any];

  
  const obj: any = {
    type: "baseType",
    get fieldtype() {
      return (patch as any).extensions?.fieldtype ?? (item as any).fieldtype;
    },
    get extensions() {
      // stable, deterministic
      return history;
    },
    extend<K2 extends FieldType = FieldType>(
      attributeUpdate: FieldTypePatchEvent<
        K["attributes"],
        K2["fieldtype"],
        K2
      >,
    ) {
      return FieldType.extend(this as any, attributeUpdate) as unknown as K2;
    },
    get attributes() {
      const prev = (item as any).attributes ?? [];
      const a = (patch as any).attributes;
      if (a === undefined) return prev;
      const add = Array.isArray(a) ? a : [a];
      return normalizeObjectProperties(prev.concat(add) as any);
    },
    get prev() {
      return item;
    },
    get metadata() {
      const prevMeta = (item as any).metadata ?? {};
      const thisMeta = (patch as any).metadata;
      return thisMeta === undefined ? prevMeta : { ...prevMeta, ...thisMeta };
    },
    update: patch,
  } as unknown as K;

  if (passedDraft) (obj as any)[DRAFT_SYM] = passedDraft;
  return attachHelpers(obj);
  },

  fromCreationEvent<T extends string = string, Attributes = any>(
    update: FieldTypeCreationEvent,
  ) {
    const base = {
      type: "baseType",
      fieldtype: update.fieldtype,
      extend<
        T2 extends FieldType = FieldType,
        K2 extends FieldType = FieldType,
      >(patch: FieldTypePatchEvent<T2["attributes"], K2["fieldtype"], K2>) {
        return FieldType.extend(this as any, patch) as K2;
      },
      get attributes() {
        return (update.attributes as any) ?? [];
      },
      get metadata() {
        return update.metadata ?? {};    // ← ensure object
      },
      get extensions() {
        return update.extensions;
      },
      update: update,
    } as any;

    // Hydrate var-specific props from creation event metadata + extensions
    if (update.fieldtype === "var" && update.metadata) {
      base.name = update.metadata.name;
      base.varId = update.metadata.varId;
      if (update.extensions?.[0] && FieldType.describes(update.extensions[0])) {
        base.bound = update.extensions[0];
      }
    }

    return attachHelpers(base);
  },

  fromEvent(
    typeEvent: FieldTypeEvent,
    ctx: { [key: string]: FieldTypeEvent } = {},
  ) {
    let node: any = typeEvent;
    const stack: FieldTypeEvent[] = [];

    while (node.eventtype === "patch") {
      let next: any;
      if (
        node.update !== undefined &&
        typeof node.update === "string" &&
        ctx[node.update] !== undefined
      )
        next = ctx[node.update];
      else if (node.update !== undefined && typeof node.update === "object")
        next = node.update;
      else
        throw new FieldTypeError(
          'CHAIN_ERROR',
          'Patch type node provided with no valid update reference',
          undefined,
          { nodeId: (node as any).id, update: node.update },
        );
      stack.push(node);
      node = next;
    }
    const base: FieldTypeCreationEvent = node;
    let ftype = FieldType.fromCreationEvent(base);
    while (stack.length > 0) ftype = ftype.extend(stack.pop()!);
    return ftype;
  },

  create<T extends string, K extends any = any>(
    kind: T,
    attributes: K[],
    extensions: any[] = [],
    cfg: Cfg = {},
  ): BaseFieldType<T, K> {
    const update: FieldTypeCreationEvent<T, any> = {
      type: "fieldtypeevent",
      eventtype: "state",
      fieldtype: kind,
      id: crypto.randomUUID(),
      attributes: attributes,
      metadata: cfg['metadata'] ?? {},   // ← FIXED
      extensions: extensions,
    };
    return this.fromCreationEvent(update) as any;
  },

  describes(x: any): x is FieldType {
    return x && (x.type === "baseType" || x.type === "extendedType");
  },

  compose(a: FieldType, b: FieldType): FieldType {
    if (isNever(a)) return a;
    if (isNever(b)) return b;
  
    // literal fast-path (unchanged)
    const litCheck = compose.literalsOrNever(a, b);
    if (litCheck) return litCheck;
  
    // --- NEW: extension short‑circuit (subtyping by history)
    if (isExtensionOf(b, a)) return b;
    if (isExtensionOf(a, b)) return a;
  
    // --- NEW: distribute intersection over union
    if (a.fieldtype === "or" || b.fieldtype === "or") {
      const as = flattenOr(a);
      const bs = flattenOr(b);
      const out: FieldType[] = [];
  
      for (const ai of as) {
        for (const bj of bs) {
          const c = FieldType.compose(ai, bj); // recursion on simpler pairs
          if (!isNever(c)) out.push(c);
        }
      }
      const uniq = dedupeTypes(out);
      if (uniq.length === 0) return FieldType.never.create({ reason: "no common subtype" });
      if (uniq.length === 1) return uniq[0];
      return FieldType.or.create(uniq);
    }
  
    // var: same varId → return either; one var + one concrete → use bound
    if (a.fieldtype === "var" || b.fieldtype === "var") {
      if (a.fieldtype === "var" && b.fieldtype === "var" &&
          (a as any).varId === (b as any).varId) {
        return a;
      }
      // Both vars with different varIds → intersection
      if (a.fieldtype === "var" && b.fieldtype === "var") {
        return FieldType.and.create([a, b]);
      }
      // One VarType + one concrete: compose using the bound.
      // If the concrete satisfies the bound, the var is instantiated to the concrete.
      const [varSide, concreteSide] = a.fieldtype === "var" ? [a, b] : [b, a];
      const bound = (varSide as any).bound as FieldType | undefined;
      if (bound) {
        // Categorical fieldtype check: if the bound and concrete have different
        // base fieldtypes (e.g., object vs string), they're incompatible.
        // Skip for composite types (and/or/not/any/var) which compose structurally.
        const boundBase = bound.fieldtype;
        const concreteBase = concreteSide.fieldtype;
        const compositeKinds = new Set(["any", "and", "or", "not", "var", "never"]);
        if (!compositeKinds.has(boundBase) && !compositeKinds.has(concreteBase) &&
            boundBase !== concreteBase) {
          return FieldType.never.create({ reason: `${(varSide as any).name} bound incompatible` });
        }
        const check = FieldType.compose(bound, concreteSide);
        if (!isNever(check)) return concreteSide; // var instantiated
        return FieldType.never.create({ reason: `${(varSide as any).name} bound incompatible` });
      }
      // Unbounded var accepts anything
      return concreteSide;
    }

    // objects/arrays compose structurally (your logic)
    if (a.fieldtype === "object" && b.fieldtype === "object")
      return compose.objects(a, b);
  
    if (a.fieldtype === "array" && b.fieldtype === "array")
      return compose.arrays(a, b);
  
    // Otherwise, keep safe intersection. Validator will enforce both.
    return FieldType.and.create([a, b]);
  },

  /** Concreteness convenience */
  checkConcrete(node: FieldType) {
    const missing = missingLiteralReqs(node);
    return { isConcrete: missing.length === 0, reasons: missing };
  },

  typeAtPath(item: FieldType, path: string): FieldType {
    // Simple navigator for object.property() paths separated by '.'
    // (best-effort; wildcard/array index patterns intentionally omitted here)
    const parts = path.split(".").filter(Boolean);
    let cur: FieldType = item;

    for (const p of parts) {
      if (cur.fieldtype !== "object") {
        throw new FieldTypeError('TYPE_MISMATCH', `typeAtPath: non-object segment encountered at "${p}"`, undefined, { segment: p, fieldtype: cur.fieldtype });
      }
      const prop = find.objectProperty(cur).find((c) => c.key === p);
      if (!prop) throw new FieldTypeError('TYPE_MISMATCH', `typeAtPath: missing property "${p}"`, undefined, { property: p, available: find.objectProperty(cur).map(c => c.key) });
      cur = prop.value as FieldType;
    }
    return cur;
  },

  any: {
    get nonce() {
      return this.create({});
    },
    create(opts: { attributes?: AnyConstraint[] } = {}): AnyType {
      return FieldType.create("any", opts.attributes ?? []) as AnyType;
    },
    describes(x: any): x is AnyType {
      return FieldType.describes(x) && x.fieldtype === "any";
    },
  },

  string: {
    get nonce() {
      return this.create({});
    },
    create(
      opts: { attributes?: (StringConstraint | AnyConstraint)[] } = {},
    ): StringType {
      return FieldType.create("string", opts.attributes ?? []) as StringType;
    },
    describes(x: any): x is StringType {
      return FieldType.describes(x) && x.fieldtype === "string";
    },
  },

  number: {
    get nonce() {
      return this.create({});
    },
    create(
      opts: { attributes?: (NumberConstraint | AnyConstraint)[] } = {},
    ): NumberType {
      return FieldType.create("number", opts.attributes ?? []) as NumberType;
    },
    describes(x: any): x is NumberType {
      return FieldType.describes(x) && x.fieldtype === "number";
    },
  },

  object: {
    get nonce() {
      return this.create({});
    },
    create(
      opts: { attributes?: (ObjectConstraint | AnyConstraint)[] } = {},
    ): ObjectType {
      return FieldType.create("object", opts.attributes ?? []) as ObjectType;
    },
    describes(x: any): x is ObjectType {
      return FieldType.describes(x) && x.fieldtype === "object";
    },
  },

  array: {
    get nonce() {
      return this.create({});
    },
    create(
      opts: { attributes?: (ArrayConstraint | AnyConstraint)[] } = {},
    ): ArrayType {
      return FieldType.create("array", opts.attributes ?? []) as ArrayType;
    },
    describes(x: any): x is ArrayType {
      return FieldType.describes(x) && x.fieldtype === "array";
    },
  },

  or: {
    create(attributes: FieldType[], cfg?: Cfg): OrType {
      return FieldType.create("or", attributes, [], cfg) as OrType;
    },
    describes(x: any): x is OrType {
      return FieldType.describes(x) && x.fieldtype === "or";
    },
  },

  and: {
    create(attributes: FieldType[], cfg?: Cfg): AndType {
      return FieldType.create("and", attributes, [], cfg) as AndType;
    },
    describes(x: any): x is AndType {
      return FieldType.describes(x) && x.fieldtype === "and";
    },
  },

  not: {
    create(of: FieldType, cfg?: Cfg): NotType {
      return FieldType.create("not", [of], [], cfg) as NotType;
    },
    describes(x: any): x is NotType {
      return FieldType.describes(x) && x.fieldtype === "not";
    },
  },

  never: {
    create(reason: any, cfg?: Cfg): NeverType {
      return FieldType.create("never", [reason], [], cfg) as NeverType;
    },
    describes(x: any): x is NeverType {
      return FieldType.describes(x) && x.fieldtype === "never";
    }
  },

  boolean: {
    get nonce() { return this.create({}); },
    create(opts: { attributes?: AnyConstraint[] } = {}): BooleanType {
      return FieldType.create("boolean", opts.attributes ?? []) as BooleanType;
    },
    describes(x: any): x is BooleanType {
      return FieldType.describes(x) && x.fieldtype === "boolean";
    },
  },
  
  null: {
    get nonce() { return this.create({}); },
    create(opts: { attributes?: AnyConstraint[] } = {}): NullType {
      return FieldType.create("null", opts.attributes ?? []) as NullType;
    },
    describes(x: any): x is NullType {
      return FieldType.describes(x) && x.fieldtype === "null";
    },
  },

  function: {
    get nonce() { return this.create({}); },
    create(opts: { attributes?: FunctionConstraint[] } = {}): FunctionType {
      return FieldType.create("function", opts.attributes ?? []) as FunctionType;
    },
    describes(x: any): x is FunctionType {
      return FieldType.describes(x) && x.fieldtype === "function";
    },
  },

  var: {
    create(opts: { name: string; varId?: string; bound?: FieldType }): VarType {
      const varId = opts.varId ?? crypto.randomUUID();
      const extensions = opts.bound ? [opts.bound] : [];
      const node = FieldType.create("var", [], extensions, {
        metadata: { name: opts.name, varId },
      }) as any;
      // Hydrate var props directly on the node
      node.name = opts.name;
      node.varId = varId;
      if (opts.bound) node.bound = opts.bound;
      return node as VarType;
    },
    describes(x: any): x is VarType {
      return FieldType.describes(x) && x.fieldtype === "var";
    },
  },
};

function normalizeObjectProperties(attrs: AnyConstraint[]): AnyConstraint[] {
  const props = attrs.filter(ConstraintTypes.object.property.describes) as any[];
  if (props.length === 0) return attrs;

  const rest = attrs.filter(a => !ConstraintTypes.object.property.describes(a)) as any[];
  const byKey = new Map<string, any[]>();
  for (const p of props) (byKey.get(p.key) ?? (byKey.set(p.key, []), byKey.get(p.key)!)).push(p);

  const merged: AnyConstraint[] = [];
  for (const [key, list] of byKey) {
    // compose values left-to-right
    let val: FieldType = list[0].value as FieldType;
    for (let i = 1; i < list.length; i++) {
      val = FieldType.compose(val, list[i].value as FieldType);
      if (isNever(val)) break;
    }

    // optional only if all were optional
    const optional = list.every(p => !!p.optional);

    // keep default only if all the same
    const allDefs = list.map(p => p.default);
    const defaultStable = allDefs.every(d => Object.is(d, allDefs[0]));
    const def = defaultStable ? allDefs[0] : undefined;

    merged.push(
      ConstraintTypes.object.property.create(
        key,
        val.save?.() ?? val,
        def === undefined ? { optional } : { optional, default: def }
      ) as any
    );
  }

  return [...rest, ...merged];
}



function isExtensionOf(sub: FieldType, base: FieldType): boolean {
  if (sub === base) return true;
  const baseId = (base as any).toEvent?.().id;
  if (!baseId) return false;
  const exts = ((sub as any).extensions ?? []) as any[];
  return exts.some((e: any) => {
    const ev = (e as any).update ?? (e as any);
    return (ev?.id ?? (e as any).toEvent?.().id) === baseId;
  });
}

function flattenOr(n: FieldType): FieldType[] {
  if (n.fieldtype !== "or") return [n];
  const kids = (n.attributes as any[]).filter(FieldType.describes) as FieldType[];
  return kids.flatMap(flattenOr);
}

function structuralKeyQuick(ft: FieldType): string {
  // good enough for de-dupe inside OR results
  try { return (ft as any).toString(); }
  catch { return `${ft.fieldtype}:${JSON.stringify((ft as any).attributes ?? [])}`; }
}

function dedupeTypes(ts: FieldType[]): FieldType[] {
  const seen = new Set<string>(); const out: FieldType[] = [];
  for (const t of ts) {
    const k = structuralKeyQuick(t);
    if (!seen.has(k)) { seen.add(k); out.push(t); }
  }
  return out;
}


export const FieldType = FieldTypeSpec;
