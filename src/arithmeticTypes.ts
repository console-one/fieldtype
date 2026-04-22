/**
 * arithmeticTypes.ts — Function FieldTypes for arithmetic operations.
 *
 * Defines add/mul as well-typed function FieldTypes carrying projection
 * constraints. These are language-level primitives — the projection tells
 * patchResolve how to invert the function when narrowing input constraints
 * from an output constraint.
 *
 * Each function type has:
 *   - param: number (accepts numeric args)
 *   - returns: number (produces numeric result)
 *   - projection: { inverse, combiner, identity } — how to derive input
 *     constraints from output constraints
 *
 * v1 scope: Only commutative operations (add, mul).
 * Sub is expressible as add-with-negate. Non-commutative projection deferred.
 */

import { FieldType } from './type.js';
import { ConstraintTypes } from './constraint.js';
import type { Expression } from './statement.js';

// ─────────────────────────────────────────────────────────────────────────────
// Projection inverse expressions (type-level)
// ─────────────────────────────────────────────────────────────────────────────
//
// add: unknown = sub(output, known_sum)
// If output ≤ 20 and known_sum = 10, then unknown ≤ 10.
const addInverse: Expression = {
  type: 'call',
  fn: 'numericSub',
  args: [
    { type: 'name', id: 'output' },
    { type: 'name', id: 'known' },
  ]
};

// mul: unknown = div(output, known_product)
// If output ≤ 35 and known_product = 5, then unknown ≤ 7.
const mulInverse: Expression = {
  type: 'call',
  fn: 'numericDiv',
  args: [
    { type: 'name', id: 'output' },
    { type: 'name', id: 'known' },
  ]
};

// ─────────────────────────────────────────────────────────────────────────────
// Function type definitions
// ─────────────────────────────────────────────────────────────────────────────

const numberType = FieldType.number.create({});

/** add(a, b, ...) → sum. Commutative. Variadic.
 *  Projection: unknown = numericSub(output, knownSum). Identity: 0. */
export const addType: FieldType = FieldType.function.create({
  attributes: [
    ConstraintTypes.function.param.create(numberType),
    ConstraintTypes.function.returns.create(numberType),
    ConstraintTypes.function.projection.create(addInverse, 'numericAdd', 0),
  ]
});

/** mul(a, b, ...) → product. Commutative. Variadic.
 *  Projection: unknown = numericDiv(output, knownProduct). Identity: 1. */
export const mulType: FieldType = FieldType.function.create({
  attributes: [
    ConstraintTypes.function.param.create(numberType),
    ConstraintTypes.function.returns.create(numberType),
    ConstraintTypes.function.projection.create(mulInverse, 'numericMul', 1),
  ]
});

// ─────────────────────────────────────────────────────────────────────────────
// Registry
// ─────────────────────────────────────────────────────────────────────────────

/** Registry: fn name → function FieldType with projection rules.
 *  Used by patchResolve Phase A.4 to look up projection constraints
 *  for call expressions in concrete bindings. */
export const ARITHMETIC_FN_TYPES: ReadonlyMap<string, FieldType> = new Map([
  ['add', addType],
  ['mul', mulType],
]);
