/**
 * Infer<> bridge: derive TypeScript types from phantom-branded FieldType builders.
 *
 * Phantom brands on builder return types carry shape information that Infer<>
 * walks at compile time. Zero runtime cost — brands exist only in the type system.
 *
 * Usage:
 *   const t = types.object({ name: types.string(), 'age?': types.number() });
 *   type T = Infer<typeof t>;  // { name: string; age?: number }
 *
 *   const c = extensionof(SessionContext, { chatID: chatIDType });
 *   type C = Infer<typeof c>;  // { identity: string; organization: string; chatID: string }
 */
import type {
  FieldType,
  ObjectType,
  ArrayType,
  StringType,
  NumberType,
  BooleanType,
  NullType,
  FunctionType,
} from './type.js';

// ── Phantom brand symbols (zero runtime cost) ───────────────────────────

declare const __shape: unique symbol;
declare const __element: unique symbol;
declare const __variants: unique symbol;
declare const __compose: unique symbol;
declare const __param: unique symbol;
declare const __returns: unique symbol;

// ── Branded wrappers ────────────────────────────────────────────────────

/** Object type carrying its property shape for inference */
export type Shaped<S> = ObjectType & { readonly [__shape]: S };

/** Array type carrying its element type for inference */
export type Elemented<E> = ArrayType & { readonly [__element]: E };

/** Union type carrying its variant list for inference */
export type Varianted<V extends FieldType[]> = FieldType & { readonly [__variants]: V };

/** Composed type (extensionof) carrying both halves for inference */
export type Composed<A, B> = FieldType & { readonly [__compose]: [A, B] };

/** Function type carrying param and return types for inference */
export type Functioned<I, O> = FunctionType & { readonly [__param]: I; readonly [__returns]: O };

// ── Core inference engine ───────────────────────────────────────────────

/**
 * Infer a TypeScript type from a phantom-branded FieldType.
 *
 * Resolution order:
 *   1. Branded types (Composed → Shaped → Varianted → Elemented)
 *   2. Primitive types (String → Number → Boolean → Null)
 *   3. Structural types (Object → Array)
 *   4. Catch-all → any
 */
export type Infer<T> =
  // Branded types (checked first — more specific)
  T extends { readonly [__param]: infer I; readonly [__returns]: infer O }
    ? (input: Infer<I>) => Infer<O>
    : T extends { readonly [__compose]: [infer A, infer B] }
      ? Pretty<Infer<A> & InferPlain<B>>
      : T extends { readonly [__shape]: infer S }
        ? Pretty<InferObject<S>>
        : T extends { readonly [__variants]: infer V }
          ? V extends FieldType[] ? Infer<V[number]> : never
          : T extends { readonly [__element]: infer E }
            ? Infer<E>[]
            // Primitive types
            : T extends StringType ? string
            : T extends NumberType ? number
            : T extends BooleanType ? boolean
            : T extends NullType ? null
            // Structural types (unbranded)
            : T extends FunctionType ? (...args: any[]) => any
            : T extends ObjectType ? Record<string, any>
            : T extends ArrayType ? any[]
            // Catch-all (includes AnyType, OrType without brand, etc.)
            : any;

// ── Object shape inference ──────────────────────────────────────────────

/** Split object shape into required (no ? suffix) and optional (? suffix) */
type InferObject<S> = {
  [K in keyof S as K extends `${string}?` ? never : K & string]: InferField<S[K]>;
} & {
  [K in keyof S as K extends `${infer B}?` ? B : never]?: InferField<S[K]>;
};

/** Infer a single field: unwrap PropSpec ({ ft, optional }) or recurse */
type InferField<F> =
  F extends { ft: infer FT } ? Infer<FT> :  // PropSpec form
  F extends FieldType ? Infer<F> :
  any;

// ── Extension inference (for extensionof RHS) ───────────────────────────

/** Infer from a plain object shape (the second argument to extensionof) */
type InferPlain<T> =
  T extends Record<string, any> ? {
    [K in keyof T as K extends `${string}?` ? never : K & string]:
      T[K] extends FieldType ? Infer<T[K]> : T[K];
  } & {
    [K in keyof T as K extends `${infer B}?` ? B : never]?:
      T[K] extends FieldType ? Infer<T[K]> : T[K];
  } : T;

// ── Utility ─────────────────────────────────────────────────────────────

/** Flatten intersection for readable IDE tooltips */
type Pretty<T> = { [K in keyof T]: T[K] } & {};
