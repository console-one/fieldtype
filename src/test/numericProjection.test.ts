/**
 * numericProjection.test.ts — Tests for type-level numeric arithmetic.
 *
 * Verifies extractBounds, boundsToFieldType, and the four arithmetic
 * operations (numericAdd, numericSub, numericMul, numericDiv) used by
 * the projection-based constraint propagation in patchResolve.
 */

import { FieldType } from '../type.js';
import { ConstraintTypes, constraintRef } from '../constraint.js';
import {
  extractBounds,
  boundsToFieldType,
  numericAdd,
  numericSub,
  numericMul,
  numericDiv,
  selectFromBounds,
  type NumericBounds,
} from '../numericProjection.js';

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

/** Build a number FieldType with a min constraint. */
function numMin(v: number): FieldType {
  return FieldType.number.create({ attributes: [ConstraintTypes.number.min.create(v)] });
}

/** Build a number FieldType with a max constraint. */
function numMax(v: number): FieldType {
  return FieldType.number.create({ attributes: [ConstraintTypes.number.max.create(v)] });
}

/** Build a number FieldType with both min and max constraints. */
function numRange(min: number, max: number): FieldType {
  return FieldType.number.create({ attributes: [
    ConstraintTypes.number.min.create(min),
    ConstraintTypes.number.max.create(max),
  ] });
}

/** Build a number FieldType with a literal constraint. */
function numLiteral(v: number): FieldType {
  return FieldType.number.create({ attributes: [ConstraintTypes.any.literal.create(v)] });
}

/** Plain number FT (no constraints). */
function numPlain(): FieldType {
  return FieldType.number.create({});
}

// ─────────────────────────────────────────────────────────────────────────────
// extractBounds
// ─────────────────────────────────────────────────────────────────────────────

describe('extractBounds', () => {

  it('extracts min constraint', () => {
    const b = extractBounds(numMin(5));
    expect(b.min).toBe(5);
    expect(b.max).toBeNull();
  });

  it('extracts max constraint', () => {
    const b = extractBounds(numMax(20));
    expect(b.min).toBeNull();
    expect(b.max).toBe(20);
  });

  it('extracts range constraint', () => {
    const ft = FieldType.number.create({ attributes: [
      ConstraintTypes.number.range.create({ min: 3, max: 15 }),
    ] });
    const b = extractBounds(ft);
    expect(b.min).toBe(3);
    expect(b.max).toBe(15);
  });

  it('extracts exclusiveMin and exclusiveMax', () => {
    const ft = FieldType.number.create({ attributes: [
      ConstraintTypes.number.exclusiveMin.create(0),
      ConstraintTypes.number.exclusiveMax.create(100),
    ] });
    const b = extractBounds(ft);
    expect(b.exclusiveMin).toBe(0);
    expect(b.exclusiveMax).toBe(100);
  });

  it('extracts literal → min=max=literal', () => {
    const b = extractBounds(numLiteral(42));
    expect(b.literal).toBe(42);
    expect(b.min).toBe(42);
    expect(b.max).toBe(42);
  });

  it('treats ConstraintRef values as null (conservative widening)', () => {
    const ft = FieldType.number.create({ attributes: [
      ConstraintTypes.number.max.create(constraintRef('limit')),
    ] });
    const b = extractBounds(ft);
    expect(b.max).toBeNull();
  });

  it('returns all-null for unconstrained number', () => {
    const b = extractBounds(numPlain());
    expect(b.min).toBeNull();
    expect(b.max).toBeNull();
    expect(b.exclusiveMin).toBeNull();
    expect(b.exclusiveMax).toBeNull();
    expect(b.literal).toBeNull();
  });

  it('takes tightest of multiple min constraints', () => {
    const ft = FieldType.number.create({ attributes: [
      ConstraintTypes.number.min.create(3),
      ConstraintTypes.number.min.create(7),
    ] });
    const b = extractBounds(ft);
    expect(b.min).toBe(7);
  });

  it('takes tightest of multiple max constraints', () => {
    const ft = FieldType.number.create({ attributes: [
      ConstraintTypes.number.max.create(20),
      ConstraintTypes.number.max.create(10),
    ] });
    const b = extractBounds(ft);
    expect(b.max).toBe(10);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// boundsToFieldType — round-trip fidelity
// ─────────────────────────────────────────────────────────────────────────────

describe('boundsToFieldType', () => {

  it('round-trips min/max bounds', () => {
    const original = numRange(5, 20);
    const bounds = extractBounds(original);
    const rebuilt = boundsToFieldType(bounds);
    const reBounds = extractBounds(rebuilt);
    expect(reBounds.min).toBe(5);
    expect(reBounds.max).toBe(20);
  });

  it('round-trips literal', () => {
    const bounds: NumericBounds = { min: 10, max: 10, exclusiveMin: null, exclusiveMax: null, literal: 10 };
    const ft = boundsToFieldType(bounds);
    const rb = extractBounds(ft);
    expect(rb.literal).toBe(10);
  });

  it('produces unconstrained number for all-null bounds', () => {
    const ft = boundsToFieldType({ min: null, max: null, exclusiveMin: null, exclusiveMax: null, literal: null });
    expect(ft.fieldtype).toBe('number');
    const rb = extractBounds(ft);
    expect(rb.min).toBeNull();
    expect(rb.max).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// numericSub
// ─────────────────────────────────────────────────────────────────────────────

describe('numericSub', () => {

  it('max(20) - literal(10) → max(10)', () => {
    const result = numericSub(numMax(20), numLiteral(10));
    const b = extractBounds(result);
    expect(b.max).toBe(10);
  });

  it('min(5) - literal(3) → min(2)', () => {
    const result = numericSub(numMin(5), numLiteral(3));
    const b = extractBounds(result);
    expect(b.min).toBe(2);
  });

  it('range(5,20) - literal(3) → range(2,17)', () => {
    const result = numericSub(numRange(5, 20), numLiteral(3));
    const b = extractBounds(result);
    expect(b.min).toBe(2);
    expect(b.max).toBe(17);
  });

  it('literal(10) - literal(3) → literal(7)', () => {
    const result = numericSub(numLiteral(10), numLiteral(3));
    const b = extractBounds(result);
    expect(b.literal).toBe(7);
  });

  it('max(M) - min(c) → max(M - c) (conservative)', () => {
    // max(20) - min(5): result max = 20 - 5 = 15
    const result = numericSub(numMax(20), numMin(5));
    const b = extractBounds(result);
    expect(b.max).toBe(15);
  });

  it('unbounded - literal → unbounded', () => {
    const result = numericSub(numPlain(), numLiteral(5));
    const b = extractBounds(result);
    expect(b.min).toBeNull();
    expect(b.max).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// numericAdd
// ─────────────────────────────────────────────────────────────────────────────

describe('numericAdd', () => {

  it('max(10) + literal(5) → max(15)', () => {
    const result = numericAdd(numMax(10), numLiteral(5));
    const b = extractBounds(result);
    expect(b.max).toBe(15);
  });

  it('min(0) + literal(10) → min(10)', () => {
    const result = numericAdd(numMin(0), numLiteral(10));
    const b = extractBounds(result);
    expect(b.min).toBe(10);
  });

  it('literal(3) + literal(7) → literal(10)', () => {
    const result = numericAdd(numLiteral(3), numLiteral(7));
    const b = extractBounds(result);
    expect(b.literal).toBe(10);
  });

  it('min(0) + max(10) → min(0) only (conservative: max unbounded)', () => {
    // min(0) has no max → null. max(10) has no min → null.
    // result_min = 0 + null = null, result_max = null + 10 = null
    const result = numericAdd(numMin(0), numMax(10));
    const b = extractBounds(result);
    expect(b.min).toBeNull();
    expect(b.max).toBeNull();
  });

  it('range(2,5) + range(3,7) → range(5,12)', () => {
    const result = numericAdd(numRange(2, 5), numRange(3, 7));
    const b = extractBounds(result);
    expect(b.min).toBe(5);
    expect(b.max).toBe(12);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// numericMul
// ─────────────────────────────────────────────────────────────────────────────

describe('numericMul', () => {

  it('literal(5) * max(7) → max(35)', () => {
    const result = numericMul(numLiteral(5), numMax(7));
    const b = extractBounds(result);
    expect(b.max).toBe(35);
  });

  it('literal(3) * literal(4) → literal(12)', () => {
    const result = numericMul(numLiteral(3), numLiteral(4));
    const b = extractBounds(result);
    expect(b.literal).toBe(12);
  });

  it('range(2,5) * range(3,4) → range(6,20)', () => {
    const result = numericMul(numRange(2, 5), numRange(3, 4));
    const b = extractBounds(result);
    expect(b.min).toBe(6);
    expect(b.max).toBe(20);
  });

  it('zero-crossing range computes correct product range', () => {
    // range(-1, 5) * literal(3) = range(-3, 15)
    const result = numericMul(numRange(-1, 5), numLiteral(3));
    const b = extractBounds(result);
    expect(b.min).toBe(-3);
    expect(b.max).toBe(15);
  });

  it('unbounded * literal → unbounded', () => {
    const result = numericMul(numPlain(), numLiteral(5));
    const b = extractBounds(result);
    expect(b.min).toBeNull();
    expect(b.max).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// numericDiv
// ─────────────────────────────────────────────────────────────────────────────

describe('numericDiv', () => {

  it('max(35) / literal(5) → max(7)', () => {
    const result = numericDiv(numMax(35), numLiteral(5));
    const b = extractBounds(result);
    expect(b.max).toBe(7);
  });

  it('literal(20) / literal(4) → literal(5)', () => {
    const result = numericDiv(numLiteral(20), numLiteral(4));
    const b = extractBounds(result);
    expect(b.literal).toBe(5);
  });

  it('divisor range includes zero → unbounded (sound)', () => {
    const result = numericDiv(numMax(20), numRange(-1, 1));
    const b = extractBounds(result);
    expect(b.min).toBeNull();
    expect(b.max).toBeNull();
  });

  it('literal(0) / literal(0) → unbounded', () => {
    const result = numericDiv(numLiteral(0), numLiteral(0));
    const b = extractBounds(result);
    // Division by zero → unbounded
    expect(b.min).toBeNull();
  });

  it('range(10,20) / range(2,5) → range(2,10)', () => {
    const result = numericDiv(numRange(10, 20), numRange(2, 5));
    const b = extractBounds(result);
    expect(b.min).toBe(2);
    expect(b.max).toBe(10);
  });

  it('unbounded / literal → unbounded', () => {
    const result = numericDiv(numPlain(), numLiteral(5));
    const b = extractBounds(result);
    expect(b.min).toBeNull();
    expect(b.max).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// selectFromBounds
// ─────────────────────────────────────────────────────────────────────────────

describe('selectFromBounds', () => {

  it('midpoint of min(0) + max(10) → 5', () => {
    expect(selectFromBounds(numRange(0, 10), 'midpoint')).toBe(5);
  });

  it('minimize with min(3) → 3', () => {
    expect(selectFromBounds(numMin(3), 'minimize')).toBe(3);
  });

  it('maximize with max(20) → 20', () => {
    expect(selectFromBounds(numMax(20), 'maximize')).toBe(20);
  });

  it('midpoint unbounded below + max(10) → 10 (hi only)', () => {
    expect(selectFromBounds(numMax(10), 'midpoint')).toBe(10);
  });

  it('midpoint min(5) + unbounded above → 5 (lo only)', () => {
    expect(selectFromBounds(numMin(5), 'midpoint')).toBe(5);
  });

  it('fully unbounded → 0', () => {
    expect(selectFromBounds(numPlain(), 'midpoint')).toBe(0);
  });

  it('contradictory bounds (min > max) → undefined', () => {
    // Build a FT with min(20) + max(5) — contradictory
    const ft = FieldType.number.create({ attributes: [
      ConstraintTypes.number.min.create(20),
      ConstraintTypes.number.max.create(5),
    ] });
    expect(selectFromBounds(ft, 'midpoint')).toBeUndefined();
  });

  it('custom function objective', () => {
    expect(selectFromBounds(numRange(0, 10), (ft) => 7)).toBe(7);
  });

  it('custom function returning non-number → undefined', () => {
    expect(selectFromBounds(numRange(0, 10), (() => 'hello') as any)).toBeUndefined();
  });

  it('defaults to midpoint when no objective given', () => {
    expect(selectFromBounds(numRange(2, 8))).toBe(5);
  });

  it('minimize unbounded below → 0', () => {
    expect(selectFromBounds(numMax(10), 'minimize')).toBe(0);
  });

  it('maximize unbounded above → 0', () => {
    expect(selectFromBounds(numMin(5), 'maximize')).toBe(0);
  });
});
