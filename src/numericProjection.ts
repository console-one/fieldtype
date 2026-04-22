/**
 * numericProjection.ts — Type-level arithmetic on numeric FieldType constraints.
 *
 * Pure functions that compute arithmetic on numeric FieldTypes by extracting
 * bounds from constraint attributes, performing the operation on the bounds,
 * and producing a new FieldType with the resulting constraints.
 *
 * Used by the projection-based constraint propagation in patchResolve:
 * when a concrete binding has a call expression (e.g., add(10, ref('y'))),
 * the function type's projection evaluates these operations to derive
 * narrowed constraints for unresolved refs.
 *
 * Design principle: ConstraintRef values widen to null (conservative — never
 * over-narrow). Unbounded dimensions stay unbounded through operations.
 */

import { FieldType } from './type.js';
import { ConstraintTypes, isConstraintRef } from './constraint.js';

// ─────────────────────────────────────────────────────────────────────────────
// NumericBounds — intermediate representation for arithmetic
// ─────────────────────────────────────────────────────────────────────────────

export type NumericBounds = {
  min: number | null;           // null = -∞
  max: number | null;           // null = +∞
  exclusiveMin: number | null;
  exclusiveMax: number | null;
  literal: number | null;       // non-null when the FT carries a literal constraint
};

// ─────────────────────────────────────────────────────────────────────────────
// Extract / Build
// ─────────────────────────────────────────────────────────────────────────────

/** Extract numeric bounds from a FieldType's constraint attributes.
 *  ConstraintRef values → null (conservative: widen, never over-narrow). */
export function extractBounds(ft: FieldType): NumericBounds {
  const bounds: NumericBounds = {
    min: null, max: null,
    exclusiveMin: null, exclusiveMax: null,
    literal: null,
  };

  if (!ft.attributes) return bounds;

  for (const attr of ft.attributes) {
    if (!attr || typeof attr !== 'object') continue;

    // Literal constraint — carries a concrete numeric value
    if (ConstraintTypes.any.literal.describes(attr)) {
      const v = attr.value;
      if (typeof v === 'number' && !isConstraintRef(v)) {
        bounds.literal = v;
        // A literal is simultaneously min and max
        bounds.min = bounds.min !== null ? Math.max(bounds.min, v) : v;
        bounds.max = bounds.max !== null ? Math.min(bounds.max, v) : v;
      }
      continue;
    }

    // Number constraints — skip ConstraintRef values (widen to null)
    if (ConstraintTypes.number.min.describes(attr)) {
      if (!isConstraintRef(attr.value) && typeof attr.value === 'number') {
        bounds.min = bounds.min !== null ? Math.max(bounds.min, attr.value) : attr.value;
      }
    } else if (ConstraintTypes.number.max.describes(attr)) {
      if (!isConstraintRef(attr.value) && typeof attr.value === 'number') {
        bounds.max = bounds.max !== null ? Math.min(bounds.max, attr.value) : attr.value;
      }
    } else if (ConstraintTypes.number.range.describes(attr)) {
      if (!isConstraintRef(attr.min) && typeof attr.min === 'number') {
        bounds.min = bounds.min !== null ? Math.max(bounds.min, attr.min) : attr.min;
      }
      if (!isConstraintRef(attr.max) && typeof attr.max === 'number') {
        bounds.max = bounds.max !== null ? Math.min(bounds.max, attr.max) : attr.max;
      }
    } else if (ConstraintTypes.number.exclusiveMin.describes(attr)) {
      if (!isConstraintRef(attr.value) && typeof attr.value === 'number') {
        bounds.exclusiveMin = bounds.exclusiveMin !== null
          ? Math.max(bounds.exclusiveMin, attr.value)
          : attr.value;
      }
    } else if (ConstraintTypes.number.exclusiveMax.describes(attr)) {
      if (!isConstraintRef(attr.value) && typeof attr.value === 'number') {
        bounds.exclusiveMax = bounds.exclusiveMax !== null
          ? Math.min(bounds.exclusiveMax, attr.value)
          : attr.value;
      }
    }
  }

  return bounds;
}

/** Build a number FieldType from computed bounds.
 *  Skips null (unbounded) dimensions. Returns types.number() if all null. */
export function boundsToFieldType(bounds: NumericBounds): FieldType {
  const attrs: any[] = [];

  // If it's a pure literal, emit a literal constraint
  if (bounds.literal !== null &&
      bounds.min === bounds.literal &&
      bounds.max === bounds.literal) {
    attrs.push(ConstraintTypes.any.literal.create(bounds.literal));
    return FieldType.number.create({ attributes: attrs });
  }

  if (bounds.min !== null) {
    attrs.push(ConstraintTypes.number.min.create(bounds.min));
  }
  if (bounds.max !== null) {
    attrs.push(ConstraintTypes.number.max.create(bounds.max));
  }
  if (bounds.exclusiveMin !== null) {
    attrs.push(ConstraintTypes.number.exclusiveMin.create(bounds.exclusiveMin));
  }
  if (bounds.exclusiveMax !== null) {
    attrs.push(ConstraintTypes.number.exclusiveMax.create(bounds.exclusiveMax));
  }

  return FieldType.number.create(attrs.length > 0 ? { attributes: attrs } : {});
}

// ─────────────────────────────────────────────────────────────────────────────
// Solve — value selection from constraint bounds
// ─────────────────────────────────────────────────────────────────────────────

export type SolveObjective = 'midpoint' | 'minimize' | 'maximize' | ((constraint: FieldType) => unknown);

/**
 * Select a concrete numeric value from a FieldType's constraint bounds.
 * Used by the solve behavioral constraint to pick values for projected refs.
 *
 * Strategies:
 *   'midpoint'  — average of [min, max], unbounded sides → 0
 *   'minimize'  — lower bound (or 0 if -∞)
 *   'maximize'  — upper bound (or 0 if +∞)
 *   function    — custom selection from FieldType
 *
 * Returns undefined if bounds are contradictory (min > max).
 */
export function selectFromBounds(ft: FieldType, objective: SolveObjective = 'midpoint'): number | undefined {
  if (typeof objective === 'function') {
    const result = objective(ft);
    return typeof result === 'number' ? result : undefined;
  }

  const bounds = extractBounds(ft);
  const lo = bounds.min ?? bounds.exclusiveMin ?? null;
  const hi = bounds.max ?? bounds.exclusiveMax ?? null;

  // Contradiction check
  if (lo !== null && hi !== null && lo > hi) return undefined;

  switch (objective) {
    case 'minimize': return lo ?? 0;
    case 'maximize': return hi ?? 0;
    case 'midpoint':
    default:
      if (lo !== null && hi !== null) return (lo + hi) / 2;
      if (lo !== null) return lo;
      if (hi !== null) return hi;
      return 0;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

/** Build unbounded number FT (number with no constraints). */
function unbounded(): FieldType {
  return FieldType.number.create({});
}

/** Safe add: null + anything = null (unbounded propagates). */
function safeAdd(a: number | null, b: number | null): number | null {
  if (a === null || b === null) return null;
  return a + b;
}

/** Safe sub: null - anything = null. */
function safeSub(a: number | null, b: number | null): number | null {
  if (a === null || b === null) return null;
  return a - b;
}

/** Safe mul: null * anything = null, except 0 * anything = 0. */
function safeMul(a: number | null, b: number | null): number | null {
  if (a === 0 || b === 0) return 0;
  if (a === null || b === null) return null;
  return a * b;
}

/** Safe div: null / anything = null. anything / 0 = null (unbounded). */
function safeDiv(a: number | null, b: number | null): number | null {
  if (b === null || b === 0) return null;
  if (a === null) return null;
  return a / b;
}

// ─────────────────────────────────────────────────────────────────────────────
// Arithmetic operations
// ─────────────────────────────────────────────────────────────────────────────

/**
 * numericSub(a, b) — subtract b's bounds from a's bounds.
 *
 * sub(max(M), literal(N)) → max(M − N)
 * sub(min(m), literal(N)) → min(m − N)
 * sub(max(M), min(c))     → max(M − c)   (conservative: subtract the smallest possible b)
 * sub(min(m), max(d))     → min(m − d)   (conservative: subtract the largest possible b)
 */
export function numericSub(a: FieldType, b: FieldType): FieldType {
  const ba = extractBounds(a);
  const bb = extractBounds(b);

  // Literal - literal = literal
  if (ba.literal !== null && bb.literal !== null) {
    const result = ba.literal - bb.literal;
    return boundsToFieldType({ min: result, max: result, exclusiveMin: null, exclusiveMax: null, literal: result });
  }

  // For subtraction: result_min = a.min - b.max, result_max = a.max - b.min
  // This is because subtracting a larger b makes the result smaller.
  const effectiveBMin = bb.min ?? bb.exclusiveMin;
  const effectiveBMax = bb.max ?? bb.exclusiveMax;
  const effectiveAMin = ba.min ?? ba.exclusiveMin;
  const effectiveAMax = ba.max ?? ba.exclusiveMax;

  const resultMin = safeSub(effectiveAMin, effectiveBMax);
  const resultMax = safeSub(effectiveAMax, effectiveBMin);

  return boundsToFieldType({
    min: resultMin,
    max: resultMax,
    exclusiveMin: null,
    exclusiveMax: null,
    literal: null,
  });
}

/**
 * numericAdd(a, b) — add b's bounds to a's bounds.
 *
 * add(max(M), literal(N)) → max(M + N)
 * add(min(m), literal(N)) → min(m + N)
 */
export function numericAdd(a: FieldType, b: FieldType): FieldType {
  const ba = extractBounds(a);
  const bb = extractBounds(b);

  // Literal + literal = literal
  if (ba.literal !== null && bb.literal !== null) {
    const result = ba.literal + bb.literal;
    return boundsToFieldType({ min: result, max: result, exclusiveMin: null, exclusiveMax: null, literal: result });
  }

  // result_min = a.min + b.min, result_max = a.max + b.max
  const effectiveAMin = ba.min ?? ba.exclusiveMin;
  const effectiveAMax = ba.max ?? ba.exclusiveMax;
  const effectiveBMin = bb.min ?? bb.exclusiveMin;
  const effectiveBMax = bb.max ?? bb.exclusiveMax;

  return boundsToFieldType({
    min: safeAdd(effectiveAMin, effectiveBMin),
    max: safeAdd(effectiveAMax, effectiveBMax),
    exclusiveMin: null,
    exclusiveMax: null,
    literal: null,
  });
}


/**
 * numericMul(a, b) — multiply bounds.
 *
 * Uses sign-aware bound propagation:
 * - Computes all four corner products (aMin*bMin, aMin*bMax, aMax*bMin, aMax*bMax)
 * - Known products contribute to result bounds directly
 * - Unknown products (involving null/unbounded) contribute ±∞ based on sign analysis:
 *   positive × (+∞) = +∞, positive × (-∞) = -∞, etc.
 * - When sign is ambiguous (range crosses zero AND unbounded on other side), that
 *   dimension stays null (sound: never over-narrows)
 */
export function numericMul(a: FieldType, b: FieldType): FieldType {
  const ba = extractBounds(a);
  const bb = extractBounds(b);

  // Literal * literal = literal
  if (ba.literal !== null && bb.literal !== null) {
    const result = ba.literal * bb.literal;
    return boundsToFieldType({ min: result, max: result, exclusiveMin: null, exclusiveMax: null, literal: result });
  }

  const aMin = ba.min ?? ba.exclusiveMin;
  const aMax = ba.max ?? ba.exclusiveMax;
  const bMin = bb.min ?? bb.exclusiveMin;
  const bMax = bb.max ?? bb.exclusiveMax;

  // Compute all four corner products
  const corners = [
    safeMul(aMin, bMin),
    safeMul(aMin, bMax),
    safeMul(aMax, bMin),
    safeMul(aMax, bMax),
  ];
  const known = corners.filter((v): v is number => v !== null);

  // For result_max: the max of known products, unless an unknown product could be +∞
  // An unknown product is +∞ when: positive × null(+∞ direction) or negative × null(-∞ direction)
  // We check: is there a null corner that could exceed all known products?
  let hasUnboundedHigh = false;
  let hasUnboundedLow = false;

  // Check which dimensions are null and what sign the other factor has
  if (aMin === null) {
    // a extends to -∞. Products aMin*bMin and aMin*bMax are null.
    // -∞ * positive → -∞ (unbounded low), -∞ * negative → +∞ (unbounded high)
    if (bMin !== null && bMin > 0 || bMax !== null && bMax > 0) hasUnboundedLow = true;
    if (bMin !== null && bMin < 0 || bMax !== null && bMax < 0) hasUnboundedHigh = true;
    if (bMin === null || bMax === null) { hasUnboundedLow = true; hasUnboundedHigh = true; }
  }
  if (aMax === null) {
    // a extends to +∞. Products aMax*bMin and aMax*bMax are null.
    if (bMin !== null && bMin > 0 || bMax !== null && bMax > 0) hasUnboundedHigh = true;
    if (bMin !== null && bMin < 0 || bMax !== null && bMax < 0) hasUnboundedLow = true;
    if (bMin === null || bMax === null) { hasUnboundedLow = true; hasUnboundedHigh = true; }
  }
  if (bMin === null) {
    if (aMin !== null && aMin > 0 || aMax !== null && aMax > 0) hasUnboundedLow = true;
    if (aMin !== null && aMin < 0 || aMax !== null && aMax < 0) hasUnboundedHigh = true;
  }
  if (bMax === null) {
    if (aMin !== null && aMin > 0 || aMax !== null && aMax > 0) hasUnboundedHigh = true;
    if (aMin !== null && aMin < 0 || aMax !== null && aMax < 0) hasUnboundedLow = true;
  }

  const resultMin = hasUnboundedLow ? null : (known.length > 0 ? Math.min(...known) : null);
  const resultMax = hasUnboundedHigh ? null : (known.length > 0 ? Math.max(...known) : null);

  return boundsToFieldType({
    min: resultMin,
    max: resultMax,
    exclusiveMin: null,
    exclusiveMax: null,
    literal: null,
  });
}

/**
 * numericDiv(a, b) — divide bounds.
 *
 * When b's range includes zero, return unbounded (sound — division by zero).
 */
export function numericDiv(a: FieldType, b: FieldType): FieldType {
  const ba = extractBounds(a);
  const bb = extractBounds(b);

  // Literal / literal = literal (if divisor nonzero)
  if (ba.literal !== null && bb.literal !== null) {
    if (bb.literal === 0) return unbounded();
    const result = ba.literal / bb.literal;
    return boundsToFieldType({ min: result, max: result, exclusiveMin: null, exclusiveMax: null, literal: result });
  }

  const bMin = bb.min ?? bb.exclusiveMin;
  const bMax = bb.max ?? bb.exclusiveMax;

  // If b's range includes zero, return unbounded
  if (bMin === null || bMax === null) return unbounded();
  if (bMin <= 0 && bMax >= 0) return unbounded();

  const aMin = ba.min ?? ba.exclusiveMin;
  const aMax = ba.max ?? ba.exclusiveMax;

  // Compute all four quotients and take min/max
  const quotients = [
    safeDiv(aMin, bMin),
    safeDiv(aMin, bMax),
    safeDiv(aMax, bMin),
    safeDiv(aMax, bMax),
  ].filter((v): v is number => v !== null);

  if (quotients.length === 0) return unbounded();

  return boundsToFieldType({
    min: Math.min(...quotients),
    max: Math.max(...quotients),
    exclusiveMin: null,
    exclusiveMax: null,
    literal: null,
  });
}
