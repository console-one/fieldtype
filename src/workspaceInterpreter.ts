/**
 * workspaceInterpreter.ts — Interpreter as guarded compose (walk model).
 *
 * TCCP isomorphism:
 *   Interpreter  =  ask(guard) → tell(constraints)
 *   Walk         =  Agent (sequence of guarded composes)
 *   Partition    =  ∃x.P (scoped region in ONE store)
 *   Unmount      =  Agent termination (constraints remain, process gone)
 *   Suspension   =  Open refs (unsatisfied asks)
 *
 * An interpreter is a (guard, constraints) pair:
 *   guard:        FieldType classifier — the ask. "Does this value match?"
 *   constraints:  function returning FieldType — the tell. "These constraints hold."
 *
 * Dispatch = classify value against guard → compose constraints into scope.
 * That's the entire interpreter runtime: one conditional compose.
 *
 * A walk is a sequence of these composes. The walk IS the agent execution.
 * Each step adds constraints to the scope FieldType. Refs in the constraints
 * are asks — if unresolved, the walk suspends (partition stays mounted).
 * When all refs resolve, the walk is complete and the partition unmounts.
 */

import { FieldType } from './type.js';

// ─────────────────────────────────────────────────────────────────────────────
// Interpreter — guarded compose (ask → tell)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Store access for interpreter asks.
 * The interpreter can read from the store (ask) but cannot write (tell).
 * Tells are expressed by returning constraints from constraints().
 */
export type StoreAccess = {
  /** Read a value from the store. This is an ask — returns undefined if not entailed. */
  read(path: string): unknown;
  /** Entry keys at a path (or root). */
  entries(path?: string): string[];
};

/**
 * An interpreter classifies domain values (ask) and produces constraints (tell).
 *
 * guard:        FieldType — structural match for values this handles (the ask guard).
 * constraints:  (value, store, stem) → FieldType — the constraints to compose into scope.
 *               `store` provides read access (ask) to the current store state.
 *               Callables MAY close over `store.read` for lazy dep resolution at call time.
 *
 * The caller composes the result into the scope FieldType.
 * The interpreter does not create a HEAD, fork, or workspace.
 * It produces a FieldType. That's it.
 */
export type Interpreter<T = unknown> = {
  readonly guard: FieldType;
  constraints(value: T, store: StoreAccess, stem?: string[]): FieldType;
};

// ─────────────────────────────────────────────────────────────────────────────
// classifyValue — structural type match (the ask check)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Classify a value against a FieldType guard.
 * Simple structural check: object type → verify required property keys present.
 * This is the "ask" — does the store entail the guard's constraints?
 */
export function classifyValue(guard: FieldType, value: unknown): boolean {
  if (value === null || value === undefined) return false;

  if (guard.fieldtype === 'object') {
    if (typeof value !== 'object') return false;
    const props = (guard.attributes ?? [])
      .filter((a: any) => a.constrainttype === 'property' && !a.optional)
      .map((a: any) => a.key as string);
    if (props.length === 0) return true;
    return props.every(key => key in (value as Record<string, unknown>));
  }

  if (guard.fieldtype === 'string') return typeof value === 'string';
  if (guard.fieldtype === 'number') return typeof value === 'number';
  if (guard.fieldtype === 'boolean') return typeof value === 'boolean';

  return true; // 'any' matches everything
}

// ─────────────────────────────────────────────────────────────────────────────
// interpret — one guarded compose step
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Interpret a value: find matching guard → compose constraints into scope.
 * First match wins. Returns the new scope (with constraints composed in),
 * or the original scope if no interpreter matched.
 *
 * This is one step in a walk. The walk is a sequence of these.
 */
export function interpret(
  interpreters: readonly Interpreter[],
  value: unknown,
  scope: FieldType,
  store: StoreAccess,
  stem?: string[],
): FieldType {
  for (const interp of interpreters) {
    if (classifyValue(interp.guard, value)) {
      const constraints = interp.constraints(value, store, stem);
      return FieldType.compose(scope, constraints);
    }
  }
  return scope; // no match — scope unchanged
}

// ─────────────────────────────────────────────────────────────────────────────
// walk — full interpretation pass (agent execution)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Walk a set of named values through interpreters, composing each match into scope.
 * The walk IS the agent execution trace. Each step is a tell.
 * Returns the final scope with all matched constraints composed in.
 */
export function walk(
  interpreters: readonly Interpreter[],
  values: Iterable<[string, unknown]>,
  scope: FieldType,
  store: StoreAccess,
): FieldType {
  for (const [name, value] of values) {
    scope = interpret(interpreters, value, scope, store, [name]);
  }
  return scope;
}

// ─────────────────────────────────────────────────────────────────────────────
// Backward compat — prior types (deprecated, used by workspaceInterpreters.ts)
// ─────────────────────────────────────────────────────────────────────────────

import type { Workspace } from './workspace.js';

/** @deprecated Use Interpreter instead. */
export type WorkspaceContext = {
  read(name: string): unknown;
  entries(): string[];
  ws: Workspace;
};

/** @deprecated Use Interpreter instead. */
export type WorkspaceInterpreter<T = unknown> = {
  readonly type: FieldType;
  impl(value: T, fork: Workspace, stem?: string[], ctx?: WorkspaceContext): void;
};

/** @deprecated Use interpret() instead. */
export function dispatchInterpreters(
  interpreters: readonly WorkspaceInterpreter[],
  value: unknown,
  parentWs: Workspace,
  stem?: string[],
): Workspace | null {
  const ctx: WorkspaceContext = {
    read: (name: string) => parentWs.read(name),
    entries: () => parentWs.entries(),
    ws: parentWs,
  };

  for (const interp of interpreters) {
    if (classifyValue(interp.type, value)) {
      const fork = parentWs.fork();
      interp.impl(value, fork, stem, ctx);
      return fork;
    }
  }

  return null;
}
