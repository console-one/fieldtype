/**
 * history.ts — Chain history reconstruction + snapshot diffing.
 *
 * Pure functions for computing FieldType-level diffs between chain positions.
 *
 * snapshotAt(chain, position): Reconstructs the snapshot (object FieldType) at any
 *   position in a chain's flattened history.
 *
 * diffSnapshot(prev, next): Compares two snapshot FieldTypes and returns property-level
 *   patches (added, removed, changed).
 *
 * chainHistory(chain, range?): Walks chain positions and returns the sequence of non-empty
 *   snapshot diffs — the full delta history of a chain.
 */

import type { Chain } from './chain.js';
import { collectStatements, createChain, push, snapshot } from './chain.js';
import { FieldType, literalFromAttributes } from './type.js';

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

/** A single property-level change between two snapshots. */
export type SnapshotPatch = {
  readonly name: string;
  readonly kind: 'added' | 'removed' | 'changed';
  readonly prev?: unknown;
  readonly next?: unknown;
};

/** A diff between two snapshot positions. */
export type SnapshotDiff = {
  readonly patches: readonly SnapshotPatch[];
  readonly fromPosition: number;
  readonly toPosition: number;
};

// ─────────────────────────────────────────────────────────────────────────────
// Core Functions
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Reconstruct the snapshot FieldType at a given position in a chain's
 * flattened history.
 *
 * Position is an index into collectStatements() — 0 means "after the first
 * statement." Omit position (or pass undefined) for the current head.
 *
 * Returns an object FieldType with properties = resolved bindings at that
 * position, matching the structure produced by snapshot() in chain.ts.
 */
export function snapshotAt(chain: Chain, position?: number): FieldType {
  const allStmts = collectStatements(chain);

  // No position → snapshot the whole chain
  if (position === undefined || position < 0) {
    return snapshot(chain);
  }

  const limit = Math.min(position + 1, allStmts.length);

  let tempChain = createChain(chain.constructor);
  for (let i = 0; i < limit; i++) {
    tempChain = push(tempChain, allStmts[i]);
  }
  return snapshot(tempChain);
}

/**
 * Diff two snapshot FieldTypes, producing property-level patches.
 *
 * Both snapshots should be object FieldTypes (as produced by snapshot()).
 * Patches report: added (in next but not prev), removed (in prev but not next),
 * changed (in both but different literal value).
 */
export function diffSnapshot(
  prev: FieldType,
  next: FieldType,
  fromPosition: number,
  toPosition: number,
): SnapshotDiff {
  const prevProps = extractProperties(prev);
  const nextProps = extractProperties(next);
  const patches: SnapshotPatch[] = [];

  // Detect added and changed
  for (const [name, nextValue] of nextProps) {
    if (!prevProps.has(name)) {
      patches.push({ name, kind: 'added', next: nextValue });
    } else {
      const prevValue = prevProps.get(name);
      if (!valuesEqual(prevValue, nextValue)) {
        patches.push({ name, kind: 'changed', prev: prevValue, next: nextValue });
      }
    }
  }

  // Detect removed
  for (const [name, prevValue] of prevProps) {
    if (!nextProps.has(name)) {
      patches.push({ name, kind: 'removed', prev: prevValue });
    }
  }

  return { patches, fromPosition, toPosition };
}

/**
 * Compute the delta history of a chain: walk positions and collect
 * non-empty snapshot diffs.
 *
 * Options:
 * - `from`, `to`: restrict to a range (both inclusive, indices into
 *   the flattened statement list)
 * - `path`: restrict to patches affecting a specific binding name or
 *   dot-path prefix (e.g., 'x' matches 'x', 'config' matches
 *   'config.host' and 'config.port')
 */
export function chainHistory(
  chain: Chain,
  opts?: { from?: number; to?: number; path?: string },
): SnapshotDiff[] {
  const allStmts = collectStatements(chain);
  if (allStmts.length === 0) return [];

  const from = opts?.from ?? 0;
  const to = Math.min(opts?.to ?? allStmts.length - 1, allStmts.length - 1);
  const path = opts?.path;
  if (from > to) return [];

  const diffs: SnapshotDiff[] = [];

  // Initial snapshot: before `from`, or empty if from === 0
  let prevSnapshot: FieldType;
  if (from === 0) {
    prevSnapshot = snapshot(createChain(chain.constructor));
  } else {
    prevSnapshot = snapshotAt(chain, from - 1);
  }

  for (let i = from; i <= to; i++) {
    const nextSnapshot = snapshotAt(chain, i);
    let diff = diffSnapshot(prevSnapshot, nextSnapshot, i > 0 ? i - 1 : -1, i);

    // Filter patches by path if specified
    if (path && diff.patches.length > 0) {
      const filtered = diff.patches.filter(
        p => p.name === path || p.name.startsWith(path + '.'),
      );
      if (filtered.length > 0) {
        diff = { ...diff, patches: filtered };
      } else {
        prevSnapshot = nextSnapshot;
        continue;
      }
    }

    if (diff.patches.length > 0) {
      diffs.push(diff);
    }
    prevSnapshot = nextSnapshot;
  }

  return diffs;
}

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Extract property name → literal value from an object FieldType snapshot.
 *
 * Reads object property constraints from ft.attributes. For each property,
 * materializes any unsaved Draft (via .save()) then extracts the literal value
 * via literalFromAttributes(). Properties without literal values map to undefined.
 *
 * The .save() call is necessary because valueToFieldType() (chain.ts) creates
 * FieldTypes like `FT.string.create().literal(v)` where .literal() stores
 * the constraint in a deferred Draft — not in base.attributes directly.
 */
function extractProperties(ft: FieldType): Map<string, unknown> {
  const props = new Map<string, unknown>();
  if (!ft || (ft as any).fieldtype !== 'object') return props;

  for (const attr of ((ft as any).attributes ?? []) as any[]) {
    // Object property constraints have basetype 'object', constrainttype 'property'
    if (attr.basetype === 'object' && attr.constrainttype === 'property' && attr.key) {
      const valueFT = attr.value;
      // Materialize Draft patches (if any) so literal constraint appears in attributes
      const savedFT = valueFT?.save ? valueFT.save() : valueFT;
      const literal = savedFT ? literalFromAttributes(savedFT.attributes) : undefined;
      props.set(attr.key, literal);
    }
  }

  return props;
}

/** Shallow equality for diff comparison (covers primitives + undefined). */
function valuesEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  // Both objects: compare by JSON (sufficient for snapshot literal values)
  if (a && b && typeof a === 'object' && typeof b === 'object') {
    try { return JSON.stringify(a) === JSON.stringify(b); } catch { return false; }
  }
  return false;
}
