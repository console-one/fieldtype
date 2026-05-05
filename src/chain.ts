/**
 * chain.ts — Chain layer for the FieldType language.
 *
 * A Chain is a sequence of Statements that reduces to a Scope. Chains are
 * the operational primitive: they compose, fork, diff, and merge. A FieldType
 * can be viewed as the snapshot of a fully-reduced Chain.
 *
 * Core operations:
 *   createChain → push → fork → reduce → snapshot
 *   diff → patch → rebase → cherry
 *   compact → toJSON / fromJSON
 *
 * Lenses control how bindings are interpreted during reduction.
 *
 * Grammar reform (Feb 2026):
 *   GatedBinding uses level/constraint instead of mode/valueType.
 *   BindingLens returns boolean (should treat as resolved?).
 *   reduce() uses isBlocked/isResolved instead of inferMode.
 */

import { FieldType, literalFromAttributes } from './type.js';
import { ConstraintTypes, isBehavioralConstraint } from './constraint.js';
import { snapshotFT } from './normalize.js';
import type { FieldTypeCreationEvent } from './event.js';
import type { Statement, StatementLevel, Expression, BindStatement, ScopeStatement, ConstraintBlock } from './statement.js';
import { hasRefConstraint, getRefSource, getLiteralValue, isStatementArray } from './statement.js';

/**
 * Check whether a scope has any declared exports.
 * When exports are declared, HEAD should filter by them.
 * When no exports are declared, all bindings are visible (backward compat).
 */
export function hasExports(scope: Scope): boolean {
  return scope.exports.size > 0;
}

/**
 * Check whether a binding name is exported from a scope.
 * Returns true if: (a) no exports declared (everything visible), or (b) name is in exports.
 * Behavioral bindings (e.g., 'x:merge') are visible if their parent name is exported.
 */
export function isExported(scope: Scope, name: string): boolean {
  if (scope.exports.size === 0 && !scope.wildcardExport) return true; // no exports declared → everything visible
  // Wildcard export: everything is exported except explicitly excluded names
  if (scope.wildcardExport) return !scope.wildcardExcept.has(name);
  if (scope.exports.has(name)) return true;
  // Behavioral bindings: 'x:merge' is exported if 'x' is exported
  const colonIdx = name.indexOf(':');
  if (colonIdx > 0) return scope.exports.has(name.slice(0, colonIdx));
  return false;
}

// ─────────────────────────────────────────────────────────────────────────────
// Core Types
// ─────────────────────────────────────────────────────────────────────────────

/**
 * A chain segment is either inline statements or a reference to another
 * chain's history. Segments compose to form the full statement sequence.
 *
 * Ref segments include the referenced chain's full flattened history up to
 * position `at` (index into the chain's OWN statements, same as chain.head).
 */
export type ChainSegment =
  | { readonly kind: 'inline'; readonly statements: readonly Statement[] }
  | { readonly kind: 'ref'; readonly chain: Chain; readonly at: number };

/**
 * A Chain is an append-only sequence of Statements with a constructor label.
 * Internally composed of segments (inline or ref). Backward-compat fields
 * `statements` (own inline) and `parent` (first ref segment) are derived.
 */
export type Chain = {
  readonly id: string;
  readonly constructor: string;
  readonly segments: readonly ChainSegment[];
  readonly head: number;
  /** The FieldType schema this chain builds. Determines exports and typing. */
  readonly rootType?: FieldType;
  /** Nested chains for tree-structured state (child event logs). */
  readonly children: ReadonlyMap<string, Chain>;
  /** @compat Own inline statements (last inline segment). Derived from segments. */
  readonly statements: readonly Statement[];
  /** @compat Parent pointer (first ref segment). Derived from segments. */
  readonly parent?: { chain: Chain; at: number };
};

/**
 * A binding in a reduced Scope. Blocked bindings are holes; resolved bindings
 * have values.
 */
export type GatedBinding = {
  level: StatementLevel;
  constraint?: Expression;
  /** Value concreteness: binding has a concrete literal value. */
  resolved: boolean;
  /** Type concreteness: ref resolved to a known FieldType (but may lack a literal value). */
  typeResolved: boolean;
  /** The resolved FieldType when typeResolved=true (the type is known, value may not be). */
  resolvedType?: FieldType;
  value?: unknown;
  schema?: FieldTypeCreationEvent;
  /** The source expression, preserved for downstream inspection (e.g., call dispatch). */
  expr?: Expression;
  /** Optionality scope from the original bind statement (e.g., 'optional'). */
  scope?: string;
  /** Default expression from the original bind statement (pre-fills form). */
  default?: Expression;
  /** True when this binding was created from an import statement, not a bind. */
  isImport?: boolean;
  /** ID of the innermost enclosing scope annotation (if any). */
  scopeId?: string;
  /** Tombstone: this binding was explicitly deleted. Blocks parent fallthrough in drafts. */
  deleted?: boolean;
};

/**
 * A scope region tracked during reduce(). Represents an open scope statement
 * that hasn't been terminated yet. Scope regions form a stack (innermost last).
 *
 * The `constraints` map holds the reduced constraint body — constraint name
 * to constraint value. These are synthesized into per-binding behavioral
 * constraint bindings (e.g., `x:visibility`) for every binding created
 * within this scope's range.
 */
export type ScopeRegion = {
  readonly scopeId: string;
  readonly constraints: Map<string, unknown>;
  readonly metadata?: Record<string, unknown>;
  readonly openIndex: number;
};

/**
 * The result of reducing a Chain: a map of named bindings, a set of exports,
 * and optional metadata.
 *
 * Scope tracking:
 * - `scopes`: active scope stack (innermost last)
 * - `scopeBindings`: scopeId → set of binding names declared within that scope
 * - `closedScopes`: scopeId → reduced constraints for scopes that have been terminated
 */
export type Scope = {
  bindings: Map<string, GatedBinding>;
  exports: Set<string>;
  /** True if `export *` was used — all bindings are exported (except those in except list). */
  wildcardExport: boolean;
  /** Names excluded from wildcard export (from `export * except [...]`). */
  wildcardExcept: Set<string>;
  meta: Record<string, unknown>;
  /** Active scope stack — innermost scope is the last element. */
  scopes: ScopeRegion[];
  /** Map from scopeId to the set of binding names declared within that scope. */
  scopeBindings: Map<string, Set<string>>;
  /** Reduced constraints of terminated scopes, preserved for downstream queries. */
  closedScopes: Map<string, Map<string, unknown>>;
};

/**
 * A Changeset is the delta between two Chains from a common ancestor.
 */
export type Changeset = {
  readonly statements: readonly Statement[];
  readonly fromHead: number;
  readonly toHead: number;
};

/**
 * Result of evaluating an expression against a scope.
 * When a call returns a Promise, concrete is false and pending carries the Promise
 * for the environment to settle externally.
 */
export type EvalResult = {
  concrete: boolean;
  value: unknown;
  pending?: Promise<unknown>;
  /** Set when a call expression returned Statement[] — triggers overlay expansion in HEAD.write(). */
  overlay?: true;
};

/**
 * Result of a reduce operation.
 */
export type ReduceResult = {
  scope: Scope;
  unresolved: string[];
  resolved: string[];
};

/**
 * A lens controls how bindings are interpreted during reduction.
 * Given a name, its declared level, whether it's blocked, and the current
 * scope state, it returns whether to treat the binding as resolved.
 */
export type BindingLens = (name: string, level: StatementLevel, blocked: boolean, scope: Scope) => boolean;

/**
 * Detect whether a binding is an import ref gate. Uses the explicit isImport
 * flag set by reduce() on import statements, avoiding false positives from
 * ref gates where name happens to equal source (e.g., bind steps = ref('steps')).
 */
export function isImportBinding(_name: string, binding: GatedBinding): boolean {
  return binding.isImport === true;
}

// ─────────────────────────────────────────────────────────────────────────────
// Chain Operations
// ─────────────────────────────────────────────────────────────────────────────

let chainCounter = 0;

/** Create a new empty Chain. */
export function createChain(constructor: string, parent?: Chain, rootType?: FieldType): Chain {
  const segments: ChainSegment[] = [];
  if (parent) {
    segments.push({ kind: 'ref', chain: parent, at: parent.head });
  }
  segments.push({ kind: 'inline', statements: [] });

  return {
    id: `chain:${++chainCounter}:${constructor}`,
    constructor,
    segments,
    head: -1,
    rootType: rootType ?? parent?.rootType,
    children: parent?.children ?? new Map(),
    // Backward compat — derived from segments
    statements: [],
    parent: parent ? { chain: parent, at: parent.head } : undefined,
  };
}

/** Append a Statement to a Chain, returning a new Chain (immutable). */
export function push(chain: Chain, stmt: Statement): Chain {
  const statements = [...chain.statements, stmt];

  // Update last inline segment
  const lastSeg = chain.segments[chain.segments.length - 1];
  let segments: readonly ChainSegment[];
  if (lastSeg && lastSeg.kind === 'inline') {
    segments = [
      ...chain.segments.slice(0, -1),
      { kind: 'inline', statements },
    ];
  } else {
    // Last segment is ref — append new inline segment
    segments = [...chain.segments, { kind: 'inline', statements: [stmt] }];
  }

  return {
    ...chain,
    segments,
    statements,
    head: statements.length - 1,
    rootType: chain.rootType,
    children: chain.children,
  };
}

/**
 * Fork a Chain: create a new Chain that shares the parent's history.
 * The fork starts empty but has access to the parent's scope via a
 * ref segment pointing to the source chain.
 */
export function fork(chain: Chain): Chain {
  return createChain(chain.constructor, chain);
}

// ─────────────────────────────────────────────────────────────────────────────
// Reduction
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Collect all statements in order by iterating segments.
 * Ref segments recurse into the referenced chain; inline segments
 * contribute their statements directly.
 */
export function collectStatements(chain: Chain): Statement[] {
  const result: Statement[] = [];
  for (const seg of chain.segments) {
    if (seg.kind === 'inline') {
      result.push(...seg.statements);
    } else {
      // Ref segment: collect referenced chain's full history, then take up to `at`.
      // `at` is an index into the ref chain's OWN statements — translate to
      // the flattened position by adding the ancestor prefix length.
      const refStmts = collectStatements(seg.chain);
      const ancestorCount = refStmts.length - seg.chain.statements.length;
      const limit = ancestorCount + seg.at;
      for (let i = 0; i <= limit && i < refStmts.length; i++) {
        result.push(refStmts[i]);
      }
    }
  }
  return result;
}

/**
 * Resolve a patch composition function for a binding name from scope.
 *
 * Patch composition dispatches through a merge function when `patch: true`
 * on a bind statement. This allows typed merge strategies (e.g., string
 * diff/apply) instead of only shallow object spread.
 *
 * Resolution order:
 *   1. Type-level binding `name:merge` → value or value.value → resolve string as binding name
 *   2. Active scope constraint 'merge' (innermost scope wins) → same resolution
 *
 * Returns the merge function or undefined (caller falls back to object spread).
 */
function resolvePatchComposer(scope: Scope, name: string): Function | undefined {
  // 1. Property-specific: type-level bind `name:merge`
  const mergeBinding = scope.bindings.get(`${name}:merge`);
  if (mergeBinding?.resolved && mergeBinding.value != null) {
    const raw = mergeBinding.value;
    if (typeof raw === 'function') return raw as Function;
    // Constraint-shaped object: extract .value (e.g., { value: 'text-patch', override: ... })
    const policy = (typeof raw === 'object' && (raw as any).value) ?? raw;
    if (typeof policy === 'string') {
      const fn = scope.bindings.get(policy);
      if (fn?.resolved && typeof fn.value === 'function') return fn.value as Function;
    }
  }
  // 2. Active scope constraint 'merge' (innermost wins)
  for (let i = scope.scopes.length - 1; i >= 0; i--) {
    const mc = scope.scopes[i].constraints.get('merge');
    if (mc === undefined) continue;
    if (typeof mc === 'function') return mc as Function;
    if (typeof mc === 'string') {
      const fn = scope.bindings.get(mc);
      if (fn?.resolved && typeof fn.value === 'function') return fn.value as Function;
    }
  }
  return undefined;
}

/**
 * Reduce a Chain to a Scope by replaying all statements in order.
 * Later statements override earlier ones at the same name.
 * A lens can transform resolution decisions during reduction.
 *
 * Dispatches on stmt.type:
 * - 'bind'     → create GatedBinding (lens applies, blocked determined by level+expr)
 * - 'import'   → create ref gate binding (name === expr.source; patchResolve resolves)
 * - 'export'   → populate scope.exports (handles `except`)
 * - 'annotate' → store in scope.meta; when named, also promote to binding
 */
export function reduce(chain: Chain, lens?: BindingLens): ReduceResult {
  const scope: Scope = {
    bindings: new Map(),
    exports: new Set(),
    wildcardExport: false,
    wildcardExcept: new Set(),
    meta: {},
    scopes: [],
    scopeBindings: new Map(),
    closedScopes: new Map(),
  };

  const allStatements = collectStatements(chain);

  for (let stmtIndex = 0; stmtIndex < allStatements.length; stmtIndex++) {
    const stmt = allStatements[stmtIndex];
    switch (stmt.type) {
      case 'bind': {
        // Nameless binds are bare expressions (splices / annotations).
        // They live in the chain but don't occupy binding slots in scope.
        if (!stmt.name) break;

        // Determine level — default to 'concrete' for inline statements missing level
        const level: StatementLevel = (stmt as BindStatement).level ?? 'concrete';
        // blocked decision stays with hasRefConstraint — unchanged protocol.
        // evaluateExpr provides better values but doesn't widen the gap set.
        const blocked = level === 'concrete' && hasRefConstraint(stmt.expr);
        const effectiveResolved = lens ? lens(stmt.name, level, blocked, scope) : !blocked;

        // Try expression evaluation when resolved and no ref constraint blocks
        const evaluated = (effectiveResolved && !blocked)
          ? evaluateExpr(stmt.expr, scope)
          : null;

        let value = effectiveResolved
          ? (evaluated?.concrete ? evaluated.value : extractValue(stmt.expr))
          : undefined;

        // Patch composition: dispatch through merge function OR shallow-merge objects.
        // The merge function is resolved from scope (type-level `name:merge` binding
        // or active scope constraint). This enables typed merge strategies — e.g.,
        // string diff/apply for text content, custom reducers for arrays, etc.
        if ((stmt as BindStatement).patch && effectiveResolved && value !== undefined) {
          const existing = scope.bindings.get(stmt.name);
          if (existing?.resolved && existing.value != null) {
            const composer = resolvePatchComposer(scope, stmt.name!);
            if (typeof composer === 'function') {
              value = composer(existing.value, value);
            } else if (typeof existing.value === 'object' && typeof value === 'object' && value !== null) {
              value = { ...(existing.value as any), ...(value as any) };
            }
            // No composer + non-object types: value replaces existing (last-write)
          }
        }

        // Two-level concreteness:
        // typeResolved = the ref has resolved to a known FieldType (type concreteness)
        // resolved = the binding has a concrete literal value (value concreteness)
        // Type-level bindings are always type-resolved. Concrete bindings with refs are neither.
        const isTypeLevel = level === 'type';
        const binding: GatedBinding = {
          level,
          resolved: effectiveResolved,
          typeResolved: isTypeLevel || effectiveResolved,
          value,
          schema: extractSchema(stmt),
          constraint: (stmt as BindStatement).constraint,
          expr: stmt.expr,
          scope: (stmt as BindStatement).scope,
          default: (stmt as BindStatement).default,
        };

        // Track scope membership and synthesize constraint bindings
        if (stmt.name && scope.scopes.length > 0) {
          const innermostScope = scope.scopes[scope.scopes.length - 1];
          binding.scopeId = innermostScope.scopeId;

          // Reduce the scope stack into an effective constraint set.
          // Scope constraints are patches: outer → inner, inner overwrites outer.
          const effectiveConstraints = new Map<string, unknown>();
          for (const region of scope.scopes) {
            scope.scopeBindings.get(region.scopeId)?.add(stmt.name);
            for (const [k, v] of region.constraints) {
              effectiveConstraints.set(k, v); // inner patches outer
            }
          }

          // Synthesize behavioral bindings from effective constraints.
          // Per-binding constraint (explicit type_ statement) wins over scope.
          for (const [constraintName, constraintValue] of effectiveConstraints) {
            const synthKey = `${stmt.name}:${constraintName}`;
            if (!scope.bindings.has(synthKey)) {
              scope.bindings.set(synthKey, {
                level: 'type',
                resolved: true,
                typeResolved: true,
                value: constraintValue,
              });
            }
          }
        }

        scope.bindings.set(stmt.name, binding);
        break;
      }

      case 'import': {
        // Import produces an unresolved ref gate flagged as an import.
        // The isImport flag distinguishes true imports from ref gates where
        // name happens to equal source (e.g., bind steps = ref('steps')).
        const binding: GatedBinding = {
          level: 'concrete',
          resolved: false,
          typeResolved: false,
          expr: { type: 'ref', source: stmt.source },
          isImport: true,
        };
        scope.bindings.set(stmt.source, binding);
        break;
      }

      case 'export': {
        if (stmt.names === '*') {
          scope.wildcardExport = true;
          if (stmt.except) {
            for (const ex of stmt.except) scope.wildcardExcept.add(ex);
          }
          for (const name of scope.bindings.keys()) {
            if (!stmt.except?.includes(name)) {
              scope.exports.add(name);
            }
          }
        } else {
          for (const n of stmt.names) scope.exports.add(n);
          // Record named export list so evaluateCallBindings can enforce it
          // after import resolution (imports add to exports unconditionally).
          if (!scope.meta._namedExports) scope.meta._namedExports = [];
          (scope.meta._namedExports as string[]).push(...stmt.names);
        }
        break;
      }

      case 'annotate': {
        // Named annotation → promote to binding with decomposed body.
        // Each body segment gets a keyed slot: text → string, ref → object, file → object.
        // _segments preserves ordering. Navigable via at() on the parent HEAD.
        if (stmt.name) {
          const segments: string[] = [];
          const bodyObj: Record<string, unknown> = {};
          for (let i = 0; i < stmt.body.length; i++) {
            const segKey = `seg:${i}`;
            segments.push(segKey);
            const node = stmt.body[i];
            switch (node.kind) {
              case 'text':  bodyObj[segKey] = node.content; break;
              case 'ref':   bodyObj[segKey] = node; break;
              case 'file':  bodyObj[segKey] = { kind: 'file', filename: node.filename, content: node.content }; break;
            }
          }
          bodyObj._segments = segments;
          scope.bindings.set(stmt.name, {
            level: 'concrete',
            resolved: true,
            typeResolved: true,
            value: bodyObj,
          });
        }
        // Always store in meta (backward compat for unnamed + named)
        const key = `annotate:${Object.keys(scope.meta).length}`;
        scope.meta[key] = stmt.body;
        break;
      }

      case 'delete': {
        // Tombstone: mark binding as deleted. Blocks parent fallthrough in drafts.
        // A subsequent bind for the same name resurrects it (last-write-wins).
        scope.bindings.set(stmt.name, {
          level: 'concrete',
          resolved: false,
          typeResolved: false,
          deleted: true,
        });
        break;
      }

      case 'scope': {
        if ('terminate' in stmt && stmt.terminate) {
          // Scope terminate — pop matching scope from stack
          const idx = scope.scopes.findIndex(s => s.scopeId === stmt.scopeId);
          if (idx >= 0) {
            const closed = scope.scopes[idx];
            scope.closedScopes.set(closed.scopeId, closed.constraints);
            scope.scopes.splice(idx, 1);
          }
        } else if ('body' in stmt) {
          // Scope open — reduce constraint body and push onto stack
          const constraints = new Map<string, unknown>();
          for (const bodyStmt of stmt.body) {
            if (bodyStmt.type === 'bind' && bodyStmt.name) {
              const value = extractValue(bodyStmt.expr);
              constraints.set(bodyStmt.name, value);
            }
          }
          scope.scopes.push({
            scopeId: stmt.scopeId,
            constraints,
            metadata: (stmt as any).metadata,
            openIndex: stmtIndex,
          });
          scope.scopeBindings.set(stmt.scopeId, new Set());
        }
        break;
      }
    }
  }

  const unresolved: string[] = [];
  const resolved: string[] = [];
  for (const [name, binding] of scope.bindings) {
    if (binding.deleted) continue; // tombstones don't count as unresolved
    if (binding.resolved) resolved.push(name);
    else unresolved.push(name);
  }

  return { scope, unresolved, resolved };
}

/**
 * Look up the reduced constraints for a given scopeId.
 * Checks both active scopes (still open) and terminated scopes.
 * Returns null if the scopeId is not found.
 */
export function findScopeConstraints(scope: Scope, scopeId: string): Map<string, unknown> | null {
  // Check active scopes
  const active = scope.scopes.find(s => s.scopeId === scopeId);
  if (active) return active.constraints;
  // Check terminated scopes
  const closed = scope.closedScopes.get(scopeId);
  if (closed) return closed;
  return null;
}

/**
 * Collect reduced constraints from all enclosing scopes for a binding.
 * Returns an array of constraint maps (one per enclosing scope).
 * Useful for inherited constraints like labels.
 */
export function collectEnclosingScopeConstraints(scope: Scope, bindingName: string): Map<string, unknown>[] {
  const result: Map<string, unknown>[] = [];
  for (const [scopeId, names] of scope.scopeBindings) {
    if (names.has(bindingName)) {
      const constraints = findScopeConstraints(scope, scopeId);
      if (constraints) result.push(constraints);
    }
  }
  return result;
}

/** Extract a runtime value from a resolved expression. */
function extractValue(expr: Expression): unknown {
  switch (expr.type) {
    case 'literal': return expr.value;
    case 'fieldtype': return literalFromAttributes(expr.attributes);
    case 'name': return expr.id; // symbolic reference
    case 'ref': return undefined;
    case 'call': return undefined; // would need interpreter
    case 'intersect': return undefined; // type-level construct
    case 'object': return undefined; // type-level construct
    case 'union': return undefined; // type-level construct
  }
}

/**
 * Evaluate a `block` call: decode its contained `stmt:*` args into bindings
 * in a child scope (parent bindings remain visible by inheritance), then
 * project the block's value as an object containing either the explicitly
 * exported names or all bindings declared inside the block.
 *
 * The block's bindings are evaluated in order, with later statements seeing
 * earlier statements' values. This is the same semantic as a top-level
 * chain, just at expression position.
 */
function evaluateBlock(expr: Expression, scope: Scope): EvalResult {
  if (expr.type !== 'call' || expr.fn !== 'block') {
    return { concrete: false, value: undefined };
  }

  // Child scope inheriting parent bindings; child writes don't leak upward.
  const childBindings = new Map(scope.bindings);
  const childScope: Scope = { ...scope, bindings: childBindings };

  let exportFilter: Set<string> | undefined;
  const declaredInBlock = new Set<string>();

  for (const stmtCall of expr.args) {
    if (stmtCall.type !== 'call') continue;
    const stmtFn = (stmtCall as any).fn;
    const stmtArgs = ((stmtCall as any).args ?? []) as Expression[];

    if (stmtFn === 'stmt:concrete' || stmtFn === 'stmt:type') {
      const nameExpr = stmtArgs[0];
      const valExpr = stmtArgs[1];
      if (!nameExpr || nameExpr.type !== 'literal') continue;
      const name = (nameExpr as any).value;
      if (typeof name !== 'string' || !valExpr) continue;

      const valResult = evaluateExpr(valExpr, childScope);
      childBindings.set(name, {
        level: stmtFn === 'stmt:concrete' ? 'concrete' : 'type',
        resolved: valResult.concrete,
        typeResolved: true,
        value: valResult.value,
        expr: valExpr,
      });
      declaredInBlock.add(name);
    } else if (stmtFn === 'stmt:export') {
      const namesExpr = stmtArgs[0];
      if (namesExpr?.type === 'literal') {
        const v = (namesExpr as any).value;
        if (Array.isArray(v)) {
          if (!exportFilter) exportFilter = new Set();
          for (const n of v) exportFilter.add(String(n));
        }
        // '*' or non-array: leave exportFilter undefined → export all
      }
    }
    // stmt:import / stmt:annotate are no-ops at this evaluation layer
  }

  // Project the block's value: { name → value } for every binding declared
  // inside the block (filtered by exportFilter when present). Bindings with
  // unresolved values fall through (consumer can re-evaluate later).
  const result: Record<string, unknown> = {};
  for (const name of declaredInBlock) {
    if (exportFilter && !exportFilter.has(name)) continue;
    const b = childBindings.get(name);
    if (!b || !b.resolved) continue;
    result[name] = b.value;
  }
  return { concrete: true, value: result };
}

/**
 * Evaluate an expression against a Scope, resolving names, calls, and
 * compositions. Returns { concrete, value } — concrete is false when any
 * sub-expression cannot be resolved (ref, unbound name, unresolved arg).
 *
 * This is the core of "reduce() as sole execution engine": expressions that
 * extractValue() returned undefined for (call, name, object, intersect) now
 * evaluate using scope bindings.
 */
export function evaluateExpr(
  expr: Expression,
  scope: Scope,
): EvalResult {
  switch (expr.type) {
    case 'literal':
      return { concrete: true, value: expr.value };

    case 'fieldtype':
      return { concrete: true, value: literalFromAttributes(expr.attributes) };

    case 'name': {
      const binding = scope.bindings.get(expr.id);
      if (!binding || !binding.resolved)
        return { concrete: false, value: undefined };
      return { concrete: true, value: binding.value };
    }

    case 'call': {
      // ── Function definition: `fn` produces a closure capturing the outer
      //    scope. When invoked, the closure binds positional args to the
      //    param names declared in `paramsExpr` (an object expression whose
      //    keys are the param names), then evaluates the body in a child
      //    scope. Body is typically a `block` call.
      if (expr.fn === 'fn') {
        const paramsExpr = expr.args[0];
        const bodyExpr = expr.args[1];
        const paramNames = paramsExpr && paramsExpr.type === 'object'
          ? Object.keys((paramsExpr as any).properties)
          : [];
        const captured = scope;
        const closure = (...args: unknown[]) => {
          const childBindings = new Map(captured.bindings);
          for (let i = 0; i < paramNames.length; i++) {
            childBindings.set(paramNames[i], {
              level: 'concrete',
              resolved: true,
              typeResolved: true,
              value: args[i],
              expr: { type: 'literal', value: args[i] },
            });
          }
          const childScope: Scope = { ...captured, bindings: childBindings };
          const r = evaluateExpr(bodyExpr, childScope);
          return r.concrete ? r.value : undefined;
        };
        return { concrete: true, value: closure };
      }

      // ── Block expression: walk the contained `stmt:*` args, build an
      //    object of {name → value} for each bind statement, return either
      //    the explicit `export {...}` filter or all bindings declared in
      //    the block.
      if (expr.fn === 'block') {
        return evaluateBlock(expr, scope);
      }

      // ── Transclusion (`<<`): modify LHS's structure by incorporating RHS.
      //    Array LHS   → push RHS at the tail
      //    Object LHS  → shallow-merge RHS into LHS
      //    Number LHS  → sum (lattice meet of two number values is their
      //                  sum; for accumulators this IS += and is the
      //                  reason indexSpec bodies use `<<` as the
      //                  accumulator op without a special-case op kind)
      //    String LHS  → concat (string monoid; mirrors number's sum)
      //    Boolean LHS → OR (truth monoid; AND would be the dual; OR is
      //                  the common case for "any of these accumulated")
      //    Other       → RHS wins (no defined meet)
      //    No reducer fires. The result is the LHS's kind, transformed.
      if (expr.fn === '<<') {
        const lhsResult = evaluateExpr(expr.args[0], scope);
        const rhsResult = evaluateExpr(expr.args[1], scope);
        if (!lhsResult.concrete || !rhsResult.concrete)
          return { concrete: false, value: undefined };
        const lhs = lhsResult.value;
        const rhs = rhsResult.value;
        if (Array.isArray(lhs)) {
          return { concrete: true, value: [...lhs, rhs] };
        }
        if (lhs && typeof lhs === 'object' && rhs && typeof rhs === 'object') {
          return { concrete: true, value: { ...lhs as any, ...rhs as any } };
        }
        if (typeof lhs === 'number' && typeof rhs === 'number') {
          return { concrete: true, value: lhs + rhs };
        }
        if (typeof lhs === 'string' && typeof rhs === 'string') {
          return { concrete: true, value: lhs + rhs };
        }
        if (typeof lhs === 'boolean' && typeof rhs === 'boolean') {
          return { concrete: true, value: lhs || rhs };
        }
        return { concrete: true, value: rhs };
      }

      // ── stmt:* calls only appear inside `block` bodies and are decoded
      //    there. Standalone evaluation isn't meaningful — fall through to
      //    non-concrete.
      if (typeof expr.fn === 'string' && expr.fn.startsWith('stmt:')) {
        return { concrete: false, value: undefined };
      }

      // ── Existing dispatch: resolve fn from scope, apply args. ──────────────
      const fnResult = typeof expr.fn === 'string'
        ? evaluateExpr({ type: 'name', id: expr.fn }, scope)
        : evaluateExpr(expr.fn, scope);
      if (!fnResult.concrete || typeof fnResult.value !== 'function')
        return { concrete: false, value: undefined };

      const resolvedArgs: unknown[] = [];
      for (const arg of expr.args) {
        const r = evaluateExpr(arg, scope);
        if (!r.concrete) return { concrete: false, value: undefined };
        resolvedArgs.push(r.value);
      }
      const rawResult = (fnResult.value as Function)(...resolvedArgs);
      // Async call: function returned a thenable — not concrete yet.
      // Carry the Promise for the environment to settle externally.
      if (rawResult != null && typeof rawResult === 'object' && typeof rawResult.then === 'function') {
        return { concrete: false, value: undefined, pending: rawResult as Promise<unknown> };
      }
      // Overlay call: function returned Statement[] — signal for HEAD.write() expansion.
      if (isStatementArray(rawResult)) {
        return { concrete: true, value: rawResult, overlay: true };
      }
      return { concrete: true, value: rawResult };
    }

    case 'ref':
      return { concrete: false, value: undefined };

    case 'intersect': {
      const left = evaluateExpr(expr.left, scope);
      const right = evaluateExpr(expr.right, scope);
      if (!left.concrete || !right.concrete)
        return { concrete: false, value: undefined };
      if (typeof left.value === 'object' && left.value &&
          typeof right.value === 'object' && right.value)
        return { concrete: true, value: { ...left.value as any, ...right.value as any } };
      return { concrete: true, value: right.value };
    }

    case 'object': {
      const result: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(expr.properties)) {
        const r = evaluateExpr(v, scope);
        if (!r.concrete) return { concrete: false, value: undefined };
        result[k] = r.value;
      }
      return { concrete: true, value: result };
    }

    case 'union':
      return { concrete: false, value: undefined };

    default:
      return { concrete: false, value: undefined };
  }
}

/** Check if an expression is concrete (fully evaluable) in the given scope. */
export function isConcrete(expr: Expression, scope: Scope): boolean {
  return evaluateExpr(expr, scope).concrete;
}

/** Extract the schema from a bind statement's constraint, or fall back to the expr. */
function extractSchema(stmt: BindStatement): FieldTypeCreationEvent | undefined {
  // Schema from constraint literal (chainFromFieldType puts it here)
  if (stmt.constraint?.type === 'literal') {
    const val = stmt.constraint.value;
    if (val && typeof val === 'object' && val.eventtype) return val;
  }
  // Schema from FieldTypeExpr constraint (typed() produces this form)
  if (stmt.constraint?.type === 'fieldtype') {
    const val = getLiteralValue(stmt.constraint);
    if (val && typeof val === 'object' && (val as any).eventtype) return val as FieldTypeCreationEvent;
    // The FieldTypeExpr itself can serve as a schema when it describes a type
    if (stmt.constraint.fieldtype && stmt.constraint.fieldtype !== 'any') {
      return {
        type: 'fieldtypeevent',
        eventtype: 'state',
        id: '',
        fieldtype: stmt.constraint.fieldtype,
        attributes: stmt.constraint.attributes.filter((a: any) => !ConstraintTypes.any.literal.describes(a)),
        extensions: [],
        ...(stmt.constraint.metadata ? { metadata: stmt.constraint.metadata } : {}),
      } as FieldTypeCreationEvent;
    }
  }
  // Derive schema from expr when no constraint provides one.
  // typed() produces FieldTypeExpr with full type info — no separate constraint needed.
  if (stmt.expr?.type === 'fieldtype' && stmt.expr.fieldtype && stmt.expr.fieldtype !== 'any') {
    return {
      type: 'fieldtypeevent',
      eventtype: 'state',
      id: '',
      fieldtype: stmt.expr.fieldtype,
      attributes: stmt.expr.attributes.filter((a: any) => !ConstraintTypes.any.literal.describes(a)),
      extensions: [],
      ...(stmt.expr.metadata ? { metadata: stmt.expr.metadata } : {}),
    } as FieldTypeCreationEvent;
  }
  return undefined;
}

/**
 * Take a snapshot: reduce the Chain and convert the Scope to a FieldType.
 * Returns an object type where each resolved binding is a property.
 */
export function snapshot(chain: Chain, lens?: BindingLens): FieldType {
  const FT = FieldType;
  const CT = ConstraintTypes;

  const { scope } = reduce(chain, lens);
  let ft = FT.object.create();

  for (const [name, binding] of scope.bindings) {
    if (binding.resolved && binding.value !== undefined) {
      // Create a literal property
      const valueFT = valueToFieldType(FT, binding.value);
      const prop = CT.object.property.create(name, valueFT);
      (ft.attributes ??= []).push(prop);
    } else if (binding.schema) {
      // Create a typed hole (gate)
      const schemaFT = FT.fromCreationEvent(binding.schema);
      const prop = CT.object.property.create(name, schemaFT, { optional: true });
      (ft.attributes ??= []).push(prop);
    }
  }

  return ft.save();
}

/** Convert a JS value to a FieldType literal. */
function valueToFieldType(FT: typeof FieldType, value: unknown): any {
  if (typeof value === 'string') return FT.string.create().literal(value);
  if (typeof value === 'number') return FT.number.create().literal(value);
  if (typeof value === 'boolean') return FT.boolean.create().literal(value);
  return FT.any.create();
}

// ─────────────────────────────────────────────────────────────────────────────
// Standard Lenses
// ─────────────────────────────────────────────────────────────────────────────

/** Compilation lens: respects natural blocked/resolved (default behavior). */
export const compilationLens: BindingLens = (_name, _level, blocked, _scope) => !blocked;

/** Schema lens: everything resolved (type-level view — all bindings have types). */
export const schemaLens: BindingLens = (_name, _level, _blocked, _scope) => true;

/** Validity lens: required blocked bindings stay blocked, optional ones resolve. */
export const validityLens: BindingLens = (name, _level, blocked, scope) => {
  if (blocked) {
    const existing = scope.bindings.get(name);
    if (existing?.schema) return false; // truly required — stay blocked
    return true; // optional — treat as resolved
  }
  return true;
};

/** Projection lens: overlay blocked resolved, base blocked stays open. */
export const projectionLens: BindingLens = (name, _level, blocked, scope) => {
  if (blocked && scope.bindings.has(name)) return true;
  return !blocked;
};

// ─────────────────────────────────────────────────────────────────────────────
// Diff / Patch / Rebase / Cherry
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Compute the changeset between two Chains from a common ancestor.
 * Returns the statements in `to` that are not in `from`.
 */
export function diff(from: Chain, to: Chain): Changeset {
  const fromStmts = collectStatements(from);
  const toStmts = collectStatements(to);

  // Find common prefix length
  const minLen = Math.min(fromStmts.length, toStmts.length);
  let commonPrefix = 0;
  for (let i = 0; i < minLen; i++) {
    if (fromStmts[i] === toStmts[i]) commonPrefix = i + 1;
    else break;
  }

  // Statements in `to` after the common prefix
  const delta = toStmts.slice(commonPrefix);
  return {
    statements: delta,
    fromHead: fromStmts.length - 1,
    toHead: toStmts.length - 1,
  };
}

/**
 * Apply a Changeset to a Chain, returning a new Chain with the delta applied.
 */
export function patch(chain: Chain, changeset: Changeset): Chain {
  let result = chain;
  for (const stmt of changeset.statements) {
    result = push(result, stmt);
  }
  return result;
}

/**
 * Rebase: replay the own statements of `branch` onto a new `base`.
 * Returns a new Chain with base's statements + branch's unique statements.
 */
export function rebase(branch: Chain, base: Chain): Chain {
  // Get branch's own statements (not from parent)
  const ownStatements = branch.statements;

  // Fork from new base and replay
  let result = fork(base);
  for (const stmt of ownStatements) {
    result = push(result, stmt);
  }
  return result;
}

/**
 * Cherry-pick: apply selected statements from a changeset.
 */
export function cherry(
  chain: Chain,
  changeset: Changeset,
  selector: (stmt: Statement) => boolean,
): Chain {
  let result = chain;
  for (const stmt of changeset.statements) {
    if (selector(stmt)) {
      result = push(result, stmt);
    }
  }
  return result;
}

// ─────────────────────────────────────────────────────────────────────────────
// Segment Operations
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Create a ref segment pointing to a range of a chain's flattened history.
 * `at` is the inclusive upper bound (index into chain's own statements).
 * Defaults to chain.head (full history).
 */
export function chainRange(chain: Chain, at?: number): ChainSegment {
  return { kind: 'ref', chain, at: at ?? chain.head };
}

/**
 * Splice segments into a chain at a logical position.
 * Inserts the given segments between the existing content, returning a new
 * chain. The splice point is specified as a statement index in the flattened
 * chain.
 *
 * If `at` is omitted, segments are appended (inserted before the last inline
 * segment's contents, preserving any trailing own statements).
 *
 * This is the primitive for blueprint installation: splice a blueprint chain's
 * history into the target chain within a scope.
 */
export function splice(
  chain: Chain,
  newSegments: readonly ChainSegment[],
  at?: number,
): Chain {
  if (at === undefined) {
    // Append mode: insert new segments after all existing content,
    // followed by a fresh trailing inline for future push() calls.
    const segments: ChainSegment[] = [
      ...chain.segments,
      ...newSegments,
      { kind: 'inline', statements: [] },
    ];

    return {
      ...chain,
      segments,
      head: chain.head,
      statements: [], // trailing inline is empty
    };
  }

  // Positional splice: split existing segments at the given flattened index
  // and insert new segments between the halves.
  const { before, after } = splitSegmentsAt(chain.segments, at);
  const segments = [...before, ...newSegments, ...after];
  const lastInline = segments.filter(s => s.kind === 'inline').pop();

  return {
    ...chain,
    segments,
    head: chain.head, // own head semantics preserved
    statements: lastInline?.kind === 'inline' ? lastInline.statements : [],
  };
}


/**
 * Split a segment list at a flattened statement index.
 * Returns two segment lists: before (up to index) and after (from index).
 */
function splitSegmentsAt(
  segments: readonly ChainSegment[],
  at: number,
): { before: ChainSegment[]; after: ChainSegment[] } {
  let pos = 0;

  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i];
    let segLen: number;

    if (seg.kind === 'inline') {
      segLen = seg.statements.length;
    } else {
      segLen = collectStatements(seg.chain).length;
    }

    if (pos + segLen > at) {
      // Split point is within this segment
      if (seg.kind === 'inline') {
        const splitIdx = at - pos;
        return {
          before: [
            ...segments.slice(0, i),
            { kind: 'inline', statements: seg.statements.slice(0, splitIdx) },
          ],
          after: [
            { kind: 'inline', statements: seg.statements.slice(splitIdx) },
            ...segments.slice(i + 1),
          ],
        };
      } else {
        // Can't split a ref segment — include it whole in `before`
        return {
          before: [...segments.slice(0, i + 1)],
          after: [...segments.slice(i + 1)],
        };
      }
    }

    pos += segLen;
  }

  // at is beyond all segments — everything is "before"
  return { before: [...segments], after: [] };
}

// ─────────────────────────────────────────────────────────────────────────────
// Compaction
// ─────────────────────────────────────────────────────────────────────────────

export type CompactOptions = {
  /** Number of recent statements to keep (default: all). */
  keep?: number;
};

/**
 * Compact a Chain: reduce the prefix to a set of concrete statements
 * (the snapshot), then append the recent tail.
 */
export function compact(chain: Chain, options?: CompactOptions): Chain {
  const allStmts = collectStatements(chain);
  const keep = options?.keep ?? allStmts.length;

  if (keep >= allStmts.length) return chain; // nothing to compact

  // Reduce the prefix to produce snapshot bindings
  const prefixStmts = allStmts.slice(0, allStmts.length - keep);
  const tailStmts = allStmts.slice(allStmts.length - keep);

  // Build a temporary chain from the prefix and reduce it
  let prefixChain = createChain(chain.constructor, undefined, chain.rootType);
  for (const s of prefixStmts) {
    prefixChain = push(prefixChain, s);
  }
  const { scope } = reduce(prefixChain);

  // Emit concrete statements for each binding in the prefix
  let result = createChain(chain.constructor, undefined, chain.rootType);
  for (const [name, binding] of scope.bindings) {
    if (binding.resolved) {
      result = push(result, {
        type: 'bind',
        name,
        expr: { type: 'literal', value: binding.value },
        level: 'concrete',
      });
    } else {
      // Preserve blocked bindings
      const source = getRefSource(binding.expr!) ?? (binding.expr?.type === 'ref' ? binding.expr.source : 'any');
      result = push(result, {
        type: 'bind',
        name,
        expr: { type: 'ref', source },
        level: 'concrete',
        constraint: binding.schema
          ? { type: 'literal', value: binding.schema }
          : undefined,
      });
    }
  }

  // Append the tail
  for (const s of tailStmts) {
    result = push(result, s);
  }

  return result;
}

// ─────────────────────────────────────────────────────────────────────────────
// Serialization
// ─────────────────────────────────────────────────────────────────────────────

export type ChainJSON = {
  id: string;
  constructor: string;
  statements: Statement[];
  head: number;
  parent?: { chainId: string; at: number };
};

/** Serialize a Chain to JSON. Does NOT follow parent pointers (caller handles). */
export function chainToJSON(chain: Chain): ChainJSON {
  return {
    id: chain.id,
    constructor: chain.constructor,
    statements: [...chain.statements],
    head: chain.head,
    parent: chain.parent
      ? { chainId: chain.parent.chain.id, at: chain.parent.at }
      : undefined,
  };
}

/** Deserialize a Chain from JSON. Parent must be resolved by caller. */
export function chainFromJSON(data: ChainJSON, parent?: Chain): Chain {
  // Reconstruct segments from parent + statements
  const segments: ChainSegment[] = [];
  const parentRef = parent
    ? { chain: parent, at: data.parent?.at ?? parent.head }
    : undefined;
  if (parentRef) {
    segments.push({ kind: 'ref', chain: parentRef.chain, at: parentRef.at });
  }
  segments.push({ kind: 'inline', statements: data.statements });

  return {
    id: data.id,
    constructor: data.constructor,
    segments,
    statements: data.statements,
    head: data.head,
    parent: parentRef,
    children: parent?.children ?? new Map(),
    rootType: parent?.rootType,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Bridge Functions
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Create a Chain from a FieldType by converting its properties to statements.
 * Each property becomes a concrete ref (blocked gate) and its literal value
 * becomes a concrete literal (resolved).
 */
export function chainFromFieldType(ft: FieldType): Chain {
  const CT = ConstraintTypes;

  let chain = createChain(ft.fieldtype, undefined, ft);

  if (ft.fieldtype === 'object') {
    const props = (ft.attributes ?? []).filter((a: any) => CT.object.property.describes(a));
    for (const prop of props) {
      const key = (prop as any).key as string;
      const valueFT = (prop as any).value as FieldType;

      // Snapshot the full accumulated FieldType (attributes + metadata) into a
      // plain serializable event. snapshotFT reads through getters, recursively
      // snapshots nested FieldTypes, and produces IPC-safe output.
      const schemaEvent = snapshotFT(valueFT) as FieldTypeCreationEvent;
      const ftMeta = schemaEvent.metadata as any;

      const isOptional = (prop as any).optional === true;
      const source = ftMeta?.name ?? valueFT.fieldtype;

      // Declare the gate: concrete ref with constraint carrying the schema
      chain = push(chain, {
        type: 'bind',
        name: key,
        expr: { type: 'ref', source },
        level: 'concrete',
        constraint: schemaEvent ? { type: 'literal', value: schemaEvent } : undefined,
        scope: isOptional ? 'optional' : undefined,
      });

      // If the value has a literal, add a concrete literal (resolves the gate)
      const literal = literalFromAttributes(valueFT.attributes);
      if (literal !== undefined) {
        chain = push(chain, {
          type: 'bind',
          name: key,
          expr: { type: 'literal', value: literal },
          level: 'concrete',
        });
      }

      // Emit type-level binds for behavioral constraints (pairing demands).
      // These declare what interpreters/procedures must accompany this subspace
      // when it's ref'd in a specific context (merge, persist, etc.).
      // Type-level binds are always resolved — structural declarations, not gates.
      for (const attr of (valueFT.attributes ?? [])) {
        if (isBehavioralConstraint(attr)) {
          const constrainttype = (attr as any).constrainttype as string;
          // Extract constraint params (everything except type/basetype/constrainttype)
          const params: Record<string, unknown> = {};
          for (const k of Object.keys(attr)) {
            if (k !== 'type' && k !== 'basetype' && k !== 'constrainttype') {
              params[k] = (attr as any)[k];
            }
          }
          chain = push(chain, {
            type: 'bind',
            name: `${key}:${constrainttype}`,
            expr: { type: 'literal', value: params },
            level: 'type',
          });
        }
      }
    }
  }

  return chain;
}

/**
 * Convert a Chain to a FieldType snapshot via reduction.
 */
export function chainToFieldType(chain: Chain, lens?: BindingLens): FieldType {
  return snapshot(chain, lens);
}
