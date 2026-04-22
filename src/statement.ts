/**
 * statement.ts — Statement primitive for the FieldType language.
 *
 * A Statement is one of six block types (the canonical grammar):
 * - BindStatement:     named expression with a level (concrete/type) and optional constraint
 * - ImportStatement:   load names from a package
 * - ExportStatement:   expose names from current scope
 * - AnnotateStatement: attach metadata
 * - ScopeStatement:    constraint region demarcation
 * - DeleteStatement:   remove a binding from scope (tombstone)
 *
 * Statements compose into Chains (see chain.ts). A Chain of Statements reduces
 * to a Scope, which maps names to gated or forced bindings.
 *
 * Grammar reform (Feb 2026):
 *   bind splits into concrete/type keywords.
 *   ref simplifies to a single source field.
 *   Bindings get a `: constraint` annotation.
 *   Two new inspectable expression types: intersect, object.
 *
 * This is the SINGLE representation — graph.ts Block types are aliases to these.
 */

import type { FieldType } from './type.js';
import { snapshotFT } from './normalize.js';
import { ConstraintTypes } from './constraint.js';

// ─────────────────────────────────────────────────────────────────────────────
// Statement Level (replaces StatementMode)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Statement level:
 * - 'concrete': a value-level binding — blocked when expr is a ref (needs resolution)
 * - 'type': a type-level binding — always resolved (declares type structure)
 */
export type StatementLevel = 'concrete' | 'type';

// ─────────────────────────────────────────────────────────────────────────────
// Expression = FT
//
// The canonical expression is a snapshotted FieldType. Every value, ref,
// composition, and call is a FieldType at some concreteness level:
//
//   Literal   → FT with literal constraint (carries the runtime value)
//   Ref/Name  → FT with ref constraint (gate = unresolved constraint)
//   Call      → Function FT with params; auto-reduces when concrete.
//               Effectful functions carry a `deferred` constraint.
//   Intersect → compose() of two FTs
//   Object    → Object FT with property constraints
//   Union     → Union FT
//
// Stored as minimum non-redundant information for the type in context.
// An inner chain can unpack the full derivation if needed.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The canonical expression form. A snapshotted FieldType carrying its
 * constraints AND its concrete value (as a literal constraint in attributes).
 */
export type FieldTypeExpr = {
  type: 'fieldtype';
  fieldtype: string;
  attributes: any[];
  metadata?: Record<string, any>;
};

// ── Legacy expression shapes (normalized into FT at reduce time) ────────────
// These exist for backward compatibility. New code should use typed().

export type RefExpr = {
  type: 'ref';
  source: string | FieldType | Expression;
  constraint?: FieldType;
};

export type CallExpr = {
  type: 'call';
  fn: string | Expression;
  args: Expression[];
};

export type NameExpr = {
  type: 'name';
  id: string;
};

export type LiteralExpr = {
  type: 'literal';
  value: any;
};

export type IntersectExpr = {
  type: 'intersect';
  left: Expression;
  right: Expression;
};

export type ObjectExpr = {
  type: 'object';
  properties: Record<string, Expression>;
};

export type UnionExpr = {
  type: 'union';
  members: Expression[];
};

/** Expression = FT. Legacy shapes normalized at reduce time. */
export type Expression =
  | FieldTypeExpr
  | RefExpr | CallExpr | NameExpr | LiteralExpr
  | IntersectExpr | ObjectExpr | UnionExpr;

// ─────────────────────────────────────────────────────────────────────────────
// Annotation Types
// ─────────────────────────────────────────────────────────────────────────────

export type TextAnnotation = { kind: 'text'; content: string };
/** Legacy ref: artifact DAO pointer. HEAD-native ref: source path in HEAD scope. */
export type RefAnnotation =
  | { kind: 'ref'; artifactType: string; artifactID: string }
  | { kind: 'ref'; source: string; display?: string };
export type FileAnnotation = { kind: 'file'; filename: string; content: string };

export type AnnotationNode = TextAnnotation | RefAnnotation | FileAnnotation;

// ─────────────────────────────────────────────────────────────────────────────
// Statement Types (6 variants)
// ─────────────────────────────────────────────────────────────────────────────

export type BindStatement = {
  type: 'bind';
  name?: string;                  // absent → bare expression (splice / annotation)
  expr: Expression;
  level: StatementLevel;          // 'concrete' or 'type' — required, no default
  constraint?: Expression;        // `: Type` annotation
  scope?: string;
  default?: Expression;           // literal default value — pre-fills form, overridable
  patch?: boolean;                // true → compose with existing binding (shallow merge), not replace
};

export type ImportStatement = {
  type: 'import';
  source: string;
  names?: string[];
  as?: string;
  scope?: string;
};

export type ExportStatement = {
  type: 'export';
  names: string[] | '*';
  from?: string;
  except?: string[];
  scope?: string;
};

export type AnnotateStatement = {
  type: 'annotate';
  name?: string;     // when present, body is promoted to a named binding (navigable via at())
  body: AnnotationNode[];
  renderTerms?: { relationship?: string; condition?: string };
};

/**
 * Constraint block: bind + annotate only. The scope body is a block of
 * constraint assignments — same primitive as any block of value assignments.
 *
 *   scope('my-scope', [
 *     concrete('visibility', { type: 'literal', value: 'private' }),
 *     concrete('merge', { type: 'literal', value: 'source-wins' }),
 *   ])
 *
 * Constraints are bind statements in the body. They reduce the same way
 * any block does (key uniqueness, last-write-wins). Constraint values
 * can be refs that resolve from the enclosing chain scope.
 */
export type ConstraintBlock = (BindStatement | AnnotateStatement)[];

/**
 * Scope statement — the 5th statement type. Demarcates a constraint region
 * in the chain. All statements between a scope open and its terminate inherit
 * the reduction behaviors defined by the scope's constraint body.
 *
 * A scope IS a chain-level representation of constraints addressed by position
 * range, not by key. The same constraints that exist as per-binding type-level
 * binds (`type_('x:visibility', ...)`) can be applied to a range of bindings
 * via a scope statement.
 *
 * Open form: carries a constraint body (block of bind/annotate statements).
 * Terminate form: marks the end of the scope's range.
 */
export type ScopeStatement = {
  type: 'scope';
  scopeId: string;
  body: ConstraintBlock;
  metadata?: Record<string, unknown>;  // provenance: install, role, etc. (not constraints)
} | {
  type: 'scope';
  scopeId: string;
  terminate: true;
};

/**
 * Delete statement — removes a binding from scope (tombstone).
 *
 * Meaningful in sub-chains (drafts, interpreter children): the draft writes
 * delete_('x') to shadow the parent's binding with absence. On save(), the
 * delete merges into the parent chain, removing the binding from parent scope.
 *
 * In reduce(): sets a tombstone in scope.bindings — `{ deleted: true }`.
 * In value(): tombstone blocks parent fallthrough (draft doesn't inherit deleted name).
 * In entries(): tombstone bindings are excluded.
 */
export type DeleteStatement = {
  type: 'delete';
  name: string;
};

export type Statement = BindStatement | ImportStatement | ExportStatement | AnnotateStatement | ScopeStatement | DeleteStatement;

// ─────────────────────────────────────────────────────────────────────────────
// Import Clauses (used by import_ constructor)
// ─────────────────────────────────────────────────────────────────────────────

export type ImportClauses = {
  names?: string[];
  except?: string[];
  since?: string;
};

// ─────────────────────────────────────────────────────────────────────────────
// Resolution predicates
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Is this bind statement blocked (needs resolution)?
 * Only concrete-level bindings with ref expressions are blocked.
 * Works with both legacy RefExpr and FieldTypeExpr with ref constraint.
 */
export function isBlocked(stmt: BindStatement): boolean {
  return stmt.level === 'concrete' && hasRefConstraint(stmt.expr);
}

/**
 * Is this bind statement resolved?
 * Type-level bindings are always resolved.
 * Concrete-level bindings are resolved when the expr has no ref constraint.
 * Works with both legacy RefExpr and FieldTypeExpr with ref constraint.
 */
export function isResolved(stmt: BindStatement): boolean {
  return stmt.level === 'type' || !hasRefConstraint(stmt.expr);
}

// ─────────────────────────────────────────────────────────────────────────────
// Expression helpers (work with both legacy and FieldTypeExpr forms)
// ─────────────────────────────────────────────────────────────────────────────

/** Check if an expression carries a ref constraint (typed hole). Works with both legacy RefExpr and FieldTypeExpr. */
export function hasRefConstraint(expr: Expression): boolean {
  if (expr.type === 'ref') return true;
  if (expr.type === 'fieldtype') return expr.attributes.some((a: any) => ConstraintTypes.any.ref.describes(a));
  return false;
}

/** Get the ref source string from an expression, or undefined. Works with both legacy RefExpr and FieldTypeExpr. */
export function getRefSource(expr: Expression): string | undefined {
  if (expr.type === 'ref') return typeof expr.source === 'string' ? expr.source : undefined;
  if (expr.type !== 'fieldtype') return undefined;
  const rc = expr.attributes.find((a: any) => ConstraintTypes.any.ref.describes(a));
  return rc?.source;
}

/** Get the literal value from an expression, or undefined. Works with both legacy LiteralExpr and FieldTypeExpr. */
export function getLiteralValue(expr: Expression): unknown {
  if (expr.type === 'literal') return expr.value;
  if (expr.type !== 'fieldtype') return undefined;
  const lc = expr.attributes.find((a: any) => ConstraintTypes.any.literal.describes(a));
  return lc?.value;
}

// ─────────────────────────────────────────────────────────────────────────────
// Deep expression traversal (for nested refs inside call expressions)
// ─────────────────────────────────────────────────────────────────────────────

/** Recursively check if an expression tree contains any ref expressions.
 *  Unlike hasRefConstraint (which checks top-level only), this traverses
 *  into call args, intersect branches, and union members. */
export function hasDeepRefConstraint(expr: Expression): boolean {
  if (expr.type === 'ref') return true;
  if (expr.type === 'fieldtype') return expr.attributes.some((a: any) => ConstraintTypes.any.ref.describes(a));
  if (expr.type === 'call') return expr.args.some(hasDeepRefConstraint);
  if (expr.type === 'intersect') return hasDeepRefConstraint(expr.left) || hasDeepRefConstraint(expr.right);
  if (expr.type === 'union') return expr.members.some(hasDeepRefConstraint);
  return false;
}

/** Collect all ref source names from an expression tree (recursive).
 *  Returns string sources only — structural/dynamic sources are skipped. */
export function collectDeepRefs(expr: Expression): string[] {
  const refs: string[] = [];
  function walk(e: Expression) {
    if (e.type === 'ref' && typeof e.source === 'string') {
      refs.push(e.source);
    } else if (e.type === 'fieldtype') {
      for (const a of e.attributes) {
        if (ConstraintTypes.any.ref.describes(a) && a.source) refs.push(a.source);
      }
    } else if (e.type === 'call') {
      e.args.forEach(walk);
    } else if (e.type === 'intersect') {
      walk(e.left);
      walk(e.right);
    } else if (e.type === 'union') {
      e.members.forEach(walk);
    }
  }
  walk(expr);
  return refs;
}

// ─────────────────────────────────────────────────────────────────────────────
// Overlay detection
// ─────────────────────────────────────────────────────────────────────────────

/** Detect whether a value is a Statement[] overlay (call-overlay expansion). */
export function isStatementArray(value: unknown): value is Statement[] {
  if (!Array.isArray(value) || value.length === 0) return false;
  return value.every(
    s => s && typeof s === 'object' && 'type' in s &&
      ['bind', 'import', 'export', 'annotate', 'scope', 'delete'].includes((s as any).type),
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Constructors
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Create a canonical FieldTypeExpr from a FieldType, optionally carrying a runtime value.
 *
 * This is the PREFERRED way to create expressions for functions and typed values.
 * Replaces the anti-pattern `{ type: 'literal', value: fn }` which erases type info.
 *
 * @param ft   - The FieldType to snapshot (fieldtype + constraints + metadata)
 * @param impl - Optional runtime value (stored as a literal constraint in attributes)
 */
export function typed(ft: FieldType, impl?: unknown): FieldTypeExpr {
  const snap = snapshotFT(ft);
  const attrs = [...snap.attributes];
  if (impl !== undefined) {
    attrs.push(ConstraintTypes.any.literal.create(impl));
  }
  return { type: 'fieldtype', fieldtype: snap.fieldtype, attributes: attrs, metadata: snap.metadata };
}

/**
 * Create a FieldTypeExpr for a simple literal value (string, number, boolean, object, array, null).
 * Infers the fieldtype from the runtime value.
 *
 * For functions, use typed(ft, fn) instead — literal() will throw to prevent
 * the bare-function anti-pattern.
 */
export function literal(value: unknown): FieldTypeExpr {
  if (typeof value === 'function') {
    throw new Error('literal() cannot wrap functions — use typed(ft, fn) to preserve type information');
  }
  const ft = value === null ? 'null'
    : Array.isArray(value) ? 'array'
    : typeof value; // 'string' | 'number' | 'boolean' | 'object' | 'undefined'
  return {
    type: 'fieldtype',
    fieldtype: ft,
    attributes: [ConstraintTypes.any.literal.create(value)],
  };
}

/** Create a ref expression (a typed hole). */
export function ref(source: string | FieldType | Expression, constraint?: FieldType): RefExpr {
  const expr: RefExpr = { type: 'ref', source };
  if (constraint) expr.constraint = constraint;
  return expr;
}

/** Create a union expression (A | B | C). */
export function union_(members: Expression[]): UnionExpr {
  return { type: 'union', members };
}

/** Create a concrete-level bind statement. */
export function concrete(name: string, expr: Expression, constraint?: Expression): BindStatement {
  return { type: 'bind', name, expr, level: 'concrete', constraint };
}

/** Create a type-level bind statement. */
export function type_(name: string, expr: Expression, constraint?: Expression): BindStatement {
  return { type: 'bind', name, expr, level: 'type', constraint };
}

/**
 * Create a concrete-level patch bind (composes delta with existing binding value).
 *
 * FieldTypes are already modeled as patch chains (creation event + patch events).
 * This extends that model to the chain layer: a patch bind shallow-merges its
 * value with the existing binding rather than replacing it.
 *
 * @param name  - The binding name to patch
 * @param delta - Expression carrying the partial update (typically literal({...}))
 */
export function patch(name: string, delta: Expression): BindStatement {
  return { type: 'bind', name, expr: delta, level: 'concrete', patch: true };
}

/** Create an import statement. */
export function import_(source: string, clauses?: ImportClauses): ImportStatement {
  return {
    type: 'import',
    source,
    names: clauses?.names,
    scope: source,
  };
}

/** Create an export statement (names or '*'). */
export function export_(names: string[] | '*', options?: { except?: string[] }): ExportStatement {
  return {
    type: 'export',
    names,
    except: options?.except,
  };
}

/** Create an unnamed annotation statement (stored in scope.meta). */
export function annotate(body: AnnotationNode[], renderTerms?: AnnotateStatement['renderTerms']): AnnotateStatement;
/** Create a named annotation statement (promoted to a binding with decomposed body). */
export function annotate(name: string, body: AnnotationNode[], renderTerms?: AnnotateStatement['renderTerms']): AnnotateStatement;
export function annotate(
  first: string | AnnotationNode[],
  second?: AnnotationNode[] | AnnotateStatement['renderTerms'],
  third?: AnnotateStatement['renderTerms'],
): AnnotateStatement {
  if (typeof first === 'string') {
    return { type: 'annotate', name: first, body: second as AnnotationNode[], renderTerms: third };
  }
  return { type: 'annotate', body: first, renderTerms: second as AnnotateStatement['renderTerms'] };
}

// ─────────────────────────────────────────────────────────────────────────────
// Scope Statement Constructors
// ─────────────────────────────────────────────────────────────────────────────

let scopeCounter = 0;

/**
 * Create a scope statement (open form) with a constraint body.
 * The body is a block of bind/annotate statements that define the constraint
 * rules for all statements within this scope's range.
 *
 * @param body     - Constraint block (bind + annotate statements)
 * @param scopeId  - Optional scope ID (generated if omitted)
 * @param metadata - Optional provenance metadata (install, role, etc.)
 */
export function scope(body: ConstraintBlock, scopeId?: string, metadata?: Record<string, unknown>): ScopeStatement {
  const id = scopeId ?? `scope:${++scopeCounter}`;
  const stmt: ScopeStatement = { type: 'scope', scopeId: id, body };
  if (metadata) (stmt as any).metadata = metadata;
  return stmt;
}

/** Create a scope terminate statement (marks end of scope range). */
export function scopeTerminate(scopeId: string): ScopeStatement {
  return { type: 'scope', scopeId, terminate: true as const };
}

/** Create a delete statement (remove a binding from scope). */
export function delete_(name: string): DeleteStatement {
  return { type: 'delete', name };
}
