/**
 * headInterpreter.ts — HeadInterpreter<T> type + interpret() expression constructor.
 *
 * A HeadInterpreter classifies domain values and compiles them.
 * Registration: createHead({ interpreters: [...] })
 * Dispatch:     write(concrete('name', interpret(value)))
 *
 * impl(value, stem, ctx) returns a HEAD: the interpreter IS a HEAD.
 *   HEAD.value()  = exported state (callables, services, bindings)
 *   HEAD.gaps     = input requirements (unresolved refs with rich type constraints)
 *
 * The dispatch function in createHead() calls impl(), tags the result,
 * and write() links the interpreter HEAD via an 'interpreter' edge.
 * The parent reads exports and propagates unresolved gaps.
 *
 * During migration, Statement[] returns are also accepted (legacy overlay path).
 *
 * Behavioral constraint utilities:
 *   parseBehavioralBindName() — parse namespaced bind names (e.g. 'host:merge')
 *   findBehavioralConstraint() — find a behavioral constraint on a property in a FieldType
 *   getMergePolicy() — extract merge policy for a binding name
 */

import { FieldType } from './type.js';
import type { CallExpr, Statement } from './statement.js';
import type { Scope } from './chain.js';
import type { HEAD } from './head.js';
import {
  type BehavioralConstraint,
  BEHAVIORAL_CONSTRAINT_TYPES,
  isBehavioralConstraint,
} from './constraint.js';

// ─────────────────────────────────────────────────────────────────────────────
// Overlay Context — lazy reads for self-assembly
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Context passed to interpreters so they can read bindings from the parent
 * HEAD scope at impl() time (lazy dep reads for self-assembly).
 *
 * Created by the dispatch function inside createHead() — closes over the HEAD
 * instance so interpreters don't need a direct HEAD reference.
 */
export type OverlayContext = {
  /** Read a binding value from the parent HEAD scope. */
  value(name: string): unknown;
  /** All callable bindings from the parent HEAD scope. */
  callables(): Map<string, unknown>;
  /** All resolved entries from the parent HEAD scope. */
  entries(): Map<string, unknown>;
  /** The parent HEAD that hosts this interpreter. */
  host(): HEAD;
};

// ─────────────────────────────────────────────────────────────────────────────
// HeadInterpreter — classifier + compiler
// ─────────────────────────────────────────────────────────────────────────────

/**
 * A HeadInterpreter classifies domain values and compiles them into a HEAD.
 *
 * type:   FieldType classifier — structural match for values this handles.
 * impl:   takes (value, stem, ctx) and returns a HEAD.
 *
 *   The returned HEAD's value() = exported state (callable, service, binding).
 *   The returned HEAD's gaps = input requirements (unresolved refs).
 *
 *   The parent links the interpreter HEAD via an 'interpreter' edge,
 *   reads its exports, and propagates unresolved gaps.
 *
 * During migration, Statement[] returns are also accepted (legacy overlay path).
 */
export type HeadInterpreter<T = unknown> = {
  readonly type: FieldType;
  impl(value: T, stem?: string[], ctx?: OverlayContext): HEAD | Statement[];
};

/**
 * Create a call('interpret', [literal(value)]) expression.
 *
 * Usage: concrete('github', interpret(proto))
 *   → bind 'github' to call('interpret', [proto])
 *   → the HEAD processor dispatches the call expression to registered interpreters
 */
export function interpret(value: unknown): CallExpr {
  return { type: 'call', fn: 'interpret', args: [{ type: 'literal', value }] };
}

/**
 * Classify a value against a FieldType.
 *
 * Simple structural check: if the interpreter's type is an object type,
 * verify that the value is an object with at least the required property keys.
 * For non-object types, returns true (wildcard match — last-registered wins).
 */
export function classifyValue(interpreterType: FieldType, value: unknown): boolean {
  if (value === null || value === undefined) return false;

  if (interpreterType.fieldtype === 'object') {
    if (typeof value !== 'object') return false;
    // Check that the value has the required property keys from the type
    // Only required properties gate classification — optional ones are permitted missing.
    const props = (interpreterType.attributes ?? [])
      .filter((a: any) => a.constrainttype === 'property' && !a.optional)
      .map((a: any) => a.key as string);
    if (props.length === 0) return true; // empty object type matches any object
    return props.every(key => key in (value as Record<string, unknown>));
  }

  // Non-object types: match by typeof
  if (interpreterType.fieldtype === 'string') return typeof value === 'string';
  if (interpreterType.fieldtype === 'number') return typeof value === 'number';
  if (interpreterType.fieldtype === 'boolean') return typeof value === 'boolean';

  // any type matches everything
  return true;
}

// ─────────────────────────────────────────────────────────────────────────────
// Behavioral Constraint Utilities
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Parse a namespaced bind name like 'host:merge' into { key, constrainttype }.
 * Returns null if the name doesn't contain a recognized behavioral constraint namespace.
 *
 * chainFromFieldType emits type-level binds with names like 'host:merge',
 * 'apiKey:persist', etc. This parser recognizes those names.
 */
export function parseBehavioralBindName(
  name: string,
): { key: string; constrainttype: string } | null {
  const idx = name.indexOf(':');
  if (idx < 0) return null;
  const constrainttype = name.slice(idx + 1);
  if (!(BEHAVIORAL_CONSTRAINT_TYPES as readonly string[]).includes(constrainttype)) return null;
  return { key: name.slice(0, idx), constrainttype };
}

/**
 * Find a behavioral constraint of a given constrainttype on a named property
 * within an object-typed FieldType.
 *
 * Resolution order (most specific wins):
 *   1. Property-specific: rootType → property[bindingName] → value.attributes
 *   2. Scope-level: rootType → own attributes (container type carries constraint)
 *
 * Scope-level constraints cascade to all bindings within the container.
 * A property-specific constraint overrides the scope-level one.
 */
export function findBehavioralConstraint(
  rootType: FieldType,
  bindingName: string,
  constrainttype: string,
): BehavioralConstraint | null {
  if (rootType.fieldtype !== 'object') return null;
  const attrs = (rootType.attributes ?? []) as any[];

  // 1. Property-specific — most specific wins
  const prop = attrs.find(
    (a: any) => a.constrainttype === 'property' && a.key === bindingName,
  );
  if (prop?.value?.attributes) {
    const found = (prop.value.attributes as any[]).find(
      (a: any) => isBehavioralConstraint(a) && a.constrainttype === constrainttype,
    );
    if (found) return found;
  }

  // 2. Scope-level — constraint on the container type itself
  const scopeLevel = attrs.find(
    (a: any) => isBehavioralConstraint(a) && (a as any).constrainttype === constrainttype,
  );
  return scopeLevel ?? null;
}

/**
 * Find ALL behavioral constraints of a given type for a binding name.
 *
 * Unlike findBehavioralConstraint (which returns the first match),
 * this returns every matching constraint. Used for multi-instance
 * constraints like 'label' where a single scope can declare many.
 *
 * Resolution: property-specific constraints first, then scope-level.
 */
export function findAllBehavioralConstraints(
  rootType: FieldType,
  bindingName: string,
  constrainttype: string,
): BehavioralConstraint[] {
  if (rootType.fieldtype !== 'object') return [];
  const attrs = (rootType.attributes ?? []) as any[];
  const results: BehavioralConstraint[] = [];

  // 1. Property-specific
  const prop = attrs.find(
    (a: any) => a.constrainttype === 'property' && a.key === bindingName,
  );
  if (prop?.value?.attributes) {
    for (const a of prop.value.attributes as any[]) {
      if (isBehavioralConstraint(a) && a.constrainttype === constrainttype) {
        results.push(a);
      }
    }
  }

  // 2. Scope-level (all matching)
  for (const a of attrs) {
    if (isBehavioralConstraint(a) && (a as any).constrainttype === constrainttype) {
      results.push(a);
    }
  }

  return results;
}

/**
 * Get the merge policy for a binding name from a root object FieldType.
 *
 * Returns { value, override } from the MergeConstraint on the property's
 * value type, or null if no merge constraint exists.
 *
 * Merge policies:
 * - 'source-wins': source keeps its value, draft's concrete bind is rejected
 * - 'last-write': draft's value wins (default behavior when no constraint)
 */
export function getMergePolicy(
  rootType: FieldType,
  bindingName: string,
): { value: string; override?: string } | null {
  const c = findBehavioralConstraint(rootType, bindingName, 'merge');
  if (!c) return null;
  return { value: (c as any).value, override: (c as any).override };
}

/**
 * Get the persist policy for a binding name from a root object FieldType.
 * Returns the PersistConstraint params or null.
 */
export function getPersistPolicy(
  rootType: FieldType,
  bindingName: string,
): { sink: string; target?: string; transform?: string } | null {
  const c = findBehavioralConstraint(rootType, bindingName, 'persist');
  if (!c) return null;
  return {
    sink: (c as any).sink,
    target: (c as any).target,
    transform: (c as any).transform,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Constraint Resolution from Scope
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Resolve a behavioral constraint's param value from scope.
 *
 * Constraint params are binding names — e.g., persist({ sink: 'encrypted' })
 * means "resolve binding 'encrypted' from scope to get the adapter function."
 * Returns undefined if the binding doesn't exist or isn't resolved.
 */
export function resolveConstraintParam(
  scope: Scope,
  paramValue: string,
): unknown | undefined {
  const binding = scope.bindings.get(paramValue);
  return binding?.resolved ? binding.value : undefined;
}

/**
 * For a given binding name + constraint type, resolve all constraint params
 * from scope. Returns null if no constraint exists, or an object with
 * resolved param values.
 *
 * Looks up the constraint from two sources (first match wins):
 *   1. rootType behavioral constraint attributes (FieldType-based HEAD)
 *   2. Scope type-level bind `name:constrainttype` (chain-based HEAD)
 *
 * String param values are resolved as scope binding names — if a binding
 * named `paramValue` exists and is resolved, its value replaces the string.
 * Otherwise the literal string is kept (constraint is inert for that param).
 */
export function resolveConstraint(
  rootType: FieldType,
  scope: Scope,
  bindingName: string,
  constrainttype: string,
): Record<string, unknown> | null {
  // Source 1: rootType behavioral constraint (FieldType-based HEAD)
  const c = findBehavioralConstraint(rootType, bindingName, constrainttype);

  // Source 2: scope type-level bind (chain-based HEAD, or emitted by chainFromFieldType)
  const scopeKey = `${bindingName}:${constrainttype}`;
  const binding = scope.bindings.get(scopeKey);
  const scopeParams = (binding?.resolved && binding.value && typeof binding.value === 'object')
    ? binding.value as Record<string, unknown>
    : null;

  const raw = c ?? scopeParams;
  if (!raw) return null;

  // Resolve string param values from scope (adapter binding names)
  const result: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(raw)) {
    if (k === 'type' || k === 'basetype' || k === 'constrainttype') continue;
    result[k] = typeof v === 'string' ? resolveConstraintParam(scope, v) ?? v : v;
  }
  return result;
}

