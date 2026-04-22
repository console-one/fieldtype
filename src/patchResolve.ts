/**
 * patchResolve — HEAD-based constraint resolution engine
 *
 * Resolves ref gates in a HEAD's chain against a resolution context:
 *   - For drafts: ctx = head.source (resolve against parent HEAD)
 *   - For non-drafts: ctx = head itself (resolve against own type surface)
 *
 * Phase A (resolution): match chain ref gates against ctx.rootType,
 *   accumulate resolved deps, produce missing list for unresolved.
 * Phase A.1 (constraint ref substitution): substitute constraint refs
 *   with resolved scope values; discover new missing deps from unresolved refs.
 * Phase A.2 (constraint-aware matching): use concrete constraints to
 *   disambiguate multiple matches.
 * Phase B (policy): missing → error (throw) or → pending (caller decides).
 *
 * Grammar reform (Feb 2026):
 *   Uses isBlocked() instead of inferMode(). RefExpr has source field.
 *   FieldTypeMissing carries source and optional constraint.
 *
 * Constraint ref reduction (Feb 2026):
 *   substituteConstraintRefs replaces ConstraintRef values in constraint
 *   schemas with concrete scope values. Unresolved refs join the missing
 *   list. On re-run, the cascade continues.
 */
import { objectProperty } from './find.js';
import type { Chain } from './chain.js';
import { collectStatements } from './chain.js';
import { isBlocked, getLiteralValue, hasDeepRefConstraint, collectDeepRefs } from './statement.js';
import type { BindStatement, Expression } from './statement.js';
import { types } from './builders.js';
import { FieldType, isNever } from './type.js';
import { substituteConstraintRefs, BEHAVIORAL_CONSTRAINT_TYPES, ConstraintTypes } from './constraint.js';
import { findBehavioralConstraint } from './headInterpreter.js';
import type { MissingRequirement } from './missingRequirement.js';
import type { HEAD } from './head.js';
import { numericAdd, numericSub, numericMul, numericDiv, extractBounds, boundsToFieldType } from './numericProjection.js';
import { ARITHMETIC_FN_TYPES } from './arithmeticTypes.js';

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

/** A missing field from Phase A resolution. */
export type FieldTypeMissing = {
  readonly key: string;
  readonly source: string;         // ref source path
  readonly constraint?: Expression; // the constraint expression if present
  readonly typeName: string;
  /** Legacy: the schema for downstream consumers that still expect it */
  readonly type: any;
  /** When multiple ctx entries match, these are the candidates (branching suspension). */
  readonly candidates?: readonly { key: string; displayName?: string; value?: unknown }[];
  /** Pre-fill value from statement default — shown in form, overridable */
  readonly defaultValue?: unknown;
  /** Whether this field is optional (min:0 or has a default). Optional fields
   *  appear in the form but don't block resolution in Phase B. */
  readonly optional?: boolean;
};

/** Options for patchResolve policy phase. */
export type PatchResolveOptions = {
  /** When true, unresolved required fields return pending instead of throwing. */
  allowDefer?: boolean;
};

/** A behavioral constraint action discovered during resolution. */
export type BehavioralAction = {
  readonly bindingName: string;
  readonly constrainttype: string;
  readonly params: Record<string, unknown>;
};

/**
 * SolveResult — unified result from patchResolve.
 *
 * Preserves the full constraint graph (scopeMap, varBindings, candidateDomains)
 * that was previously discarded. Both resolved and pending results share this
 * shape — narrowed by `status`.
 */
export type SolveResult = {
  readonly status: 'resolved' | 'pending';
  readonly key: string;
  readonly deps: Record<string, any>;
  readonly missing: FieldTypeMissing[];
  readonly chain: Chain;
  readonly constraintRefs: readonly string[];
  // Rich context (previously discarded)
  readonly scopeMap: ReadonlyMap<string, any>;
  readonly varBindings: VarBindings;
  readonly candidateDomains: ReadonlyMap<string, readonly { key: string; value?: unknown }[]>;
  // Behavioral constraints discovered during resolution
  readonly behavioralActions: readonly BehavioralAction[];
};

/** Narrowing helpers for SolveResult. */
export function isResolved(r: SolveResult): boolean { return r.status === 'resolved'; }
export function isPending(r: SolveResult): boolean { return r.status === 'pending'; }

/** @deprecated Use SolveResult directly. Kept for backward compat. */
export type ResolvedResult = SolveResult & { readonly status: 'resolved' };

/** @deprecated Use SolveResult directly. Kept for backward compat. */
export type PendingResult = SolveResult & { readonly status: 'pending' };

/** patchResolve return type. */
export type PatchResolveResult = SolveResult;

// ─────────────────────────────────────────────────────────────────────────────
// Core
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Resolve a HEAD's ref gates against its resolution context.
 *
 * Resolution context:
 *   - Drafts: head.source (resolve against parent HEAD's type surface + values)
 *   - Non-drafts: head itself (resolve against own type surface + values)
 *
 * Phase A: match ref gate schemas against ctx.rootType by metadata.name
 *   (domain types) or by source string (primitives).
 * Phase A.1: substitute constraint refs in all constraint schemas with
 *   resolved scope values. Unresolved refs become additional missing deps.
 * Phase A.2: for ambiguous matches (>1), use concrete constraints to filter
 *   by compose compatibility.
 * Phase B: if missing fields exist, apply policy (throw or return pending).
 *
 * When allowDefer is true:
 *   - Returns { status: 'pending', missing, deps, chain, constraintRefs }
 *   - The caller creates a Watcher and subscribes to EventBus
 *   - No deferred infrastructure, no TYPE_SURFACE indexing
 *
 * Does NOT construct anything — caller handles construction from deps.
 */
export function patchResolve(head: HEAD, options?: PatchResolveOptions): PatchResolveResult {
  // Resolution context: drafts resolve against source, non-drafts against self
  const ctx = head.source ?? head;
  const envType = ctx.rootType;
  const key = head.path || '(root)';
  const chain = head.chain;

  if (!envType || envType.fieldtype !== 'object') {
    throw new Error(`patchResolve(${key}): HEAD has no object type surface`);
  }

  const envProps = objectProperty(envType);

  // ── Phase A: Resolution ──
  // Walk chain statements to get blocked bindings with their schemas and optionality.
  const deps: Record<string, any> = {};
  const missing: FieldTypeMissing[] = [];
  const allStatements = collectStatements(chain);
  const allConstraintRefs: string[] = [];
  // VarType bindings: varId → concrete FieldType (accumulated across statements)
  const varBindings: VarBindings = new Map();
  // Rich context: candidate domains per ref gate (for multi-match introspection)
  const candidateDomains = new Map<string, readonly { key: string; value?: unknown }[]>();
  // Behavioral actions discovered during resolution
  const behavioralActions: BehavioralAction[] = [];

  // ── Phase A.1: Build scope map from ctx values for constraint ref substitution ──
  const scopeMap = new Map<string, any>();
  for (const ep of envProps) {
    if (ep.key && ctx.value(ep.key) !== undefined) {
      scopeMap.set(ep.key, ctx.value(ep.key));
    }
  }

  for (const stmt of allStatements) {
    if (stmt.type !== 'bind') continue;

    const bindStmt = stmt as BindStatement;

    // Only process concrete-level bindings with ref expressions (blocked)
    if (!isBlocked(bindStmt)) continue;
    if (bindStmt.expr.type !== 'ref') continue;

    const isOptional = bindStmt.scope === 'optional';

    // ── Resolve ref source: static string or dynamic from scope ──
    let refSourceStr: string | undefined;
    let resolvedSourceType: any = null;

    if (typeof bindStmt.expr.source === 'string') {
      refSourceStr = bindStmt.expr.source;
    } else if (bindStmt.expr.source.type === 'name') {
      const resolved = scopeMap.get(bindStmt.expr.source.id);
      if (resolved === undefined) {
        // Source binding not yet resolved — depends on it
        missing.push({
          key: bindStmt.name,
          source: bindStmt.expr.source.id,
          constraint: bindStmt.constraint,
          type: null,
          typeName: `(awaiting ${bindStmt.expr.source.id})`,
          optional: isOptional,
        });
        continue;
      }
      resolvedSourceType = resolved;
      refSourceStr = bindStmt.expr.source.id;
    } else {
      continue; // unsupported source expression type
    }

    // Extract schema from constraint (chainFromFieldType puts it there).
    // Constraints have two forms:
    //   1. Simple: literal(SomeType) — Phase A matching only
    //   2. Where:  intersect(literal(SomeType), whereExpr) — Phase A matching + Phase A.3 predicate
    //   3. Pure where: call/intersect without literal — Phase A.3 predicate only (no type matching)
    let constraintSchema: any = null;
    let whereExpr: Expression | null = null;

    if (bindStmt.constraint) {
      if (bindStmt.constraint.type === 'literal') {
        constraintSchema = bindStmt.constraint.value;
      } else if (bindStmt.constraint.type === 'fieldtype') {
        // FieldTypeExpr constraint — extract literal value if present, else use as schema
        const litVal = getLiteralValue(bindStmt.constraint);
        if (litVal && typeof litVal === 'object') {
          constraintSchema = litVal;
        } else if (bindStmt.constraint.fieldtype && bindStmt.constraint.fieldtype !== 'any') {
          // The FieldTypeExpr itself describes the constraint type
          constraintSchema = {
            type: 'fieldtypeevent', eventtype: 'state', id: '',
            fieldtype: bindStmt.constraint.fieldtype,
            attributes: bindStmt.constraint.attributes,
            extensions: [],
            ...(bindStmt.constraint.metadata ? { metadata: bindStmt.constraint.metadata } : {}),
          };
        }
      } else if (bindStmt.constraint.type === 'intersect') {
        // Intersect constraint: extract literal side for matching, rest for where-predicate
        const { left, right } = bindStmt.constraint;
        if (left.type === 'literal') {
          constraintSchema = left.value;
          whereExpr = right;
        } else if (right.type === 'literal') {
          constraintSchema = right.value;
          whereExpr = left;
        } else if (left.type === 'fieldtype') {
          constraintSchema = getLiteralValue(left) ?? null;
          whereExpr = right;
        } else if (right.type === 'fieldtype') {
          constraintSchema = getLiteralValue(right) ?? null;
          whereExpr = left;
        } else {
          // Both sides are non-literal — pure where-predicate
          whereExpr = bindStmt.constraint;
        }
      } else {
        // Pure where-predicate (call, name, etc.)
        whereExpr = bindStmt.constraint;
      }
    }

    // Substitute constraint refs in the schema with resolved scope values
    if (constraintSchema) {
      const { substituted, unresolvedRefs } = substituteConstraintRefs(constraintSchema, scopeMap);
      constraintSchema = substituted;
      for (const refPath of unresolvedRefs) {
        if (!allConstraintRefs.includes(refPath)) {
          allConstraintRefs.push(refPath);
        }
      }
    }

    // ── VarType detection in constraint ──
    // If the constraint contains VarType nodes, extract bounds for matching
    // and substitute any already-bound variables.
    let constraintVars: Array<{ varId: string; name: string; bound?: FieldType }> = [];
    if (constraintSchema && FieldType.describes(constraintSchema)) {
      // Substitute already-bound vars before matching
      if (varBindings.size > 0) {
        constraintSchema = substituteVarBindings(constraintSchema, varBindings);
      }
      constraintVars = collectVarTypes(constraintSchema);
    }

    // For matching: if the constraint IS a VarType (or contains one at top level),
    // use the bound for matching instead of the var itself.
    let matchingSchema = constraintSchema;
    if (constraintVars.length > 0 && FieldType.var.describes(constraintSchema)) {
      // Top-level VarType constraint: match using the bound
      matchingSchema = (constraintSchema as any).bound ?? null;
    }

    const gateTypeName = matchingSchema?.metadata?.name
      ?? constraintSchema?.metadata?.name;

    let matches = envProps.filter((ep: any) => {
      if (!ep.value) return false;

      // Dynamic source: compose-based matching against the resolved type.
      // The resolved value is a serialized FieldType (label definition / type predicate).
      if (resolvedSourceType) {
        try {
          const targetFT = resolvedSourceType.eventtype
            ? FieldType.fromCreationEvent(resolvedSourceType)
            : (resolvedSourceType.fieldtype ? resolvedSourceType : null);
          if (targetFT) {
            const composed = FieldType.compose(targetFT, ep.value);
            return !isNever(composed);
          }
        } catch { /* not a valid type — no match */ }
        return false;
      }

      // Static source: key match, metadata.name match, or fieldtype match
      if (ep.key === refSourceStr) return true;
      if (gateTypeName && ep.value.metadata?.name) {
        return ep.value.metadata.name === gateTypeName;
      }
      if (refSourceStr && ep.value.fieldtype === refSourceStr
          && refSourceStr !== 'any' && refSourceStr !== 'object') {
        return true;
      }
      return false;
    });

    // ── Compose fallback: no key/name match, try property-level structural check ──
    // When the initial key/name/fieldtype filter finds 0 matches, check if the
    // constraint's properties (e.g., [kind]: literal('model')) are present in ctx
    // entries. Only fires for object constraints with at least one discriminating
    // property — prevents false positives from disjoint object types.
    if (matches.length === 0 && (matchingSchema || constraintSchema)) {
      const schema = matchingSchema ?? constraintSchema;
      const constraintFT = schema?.eventtype
        ? FieldType.fromCreationEvent(schema)
        : (FieldType.describes(schema) ? schema : null);
      if (constraintFT && constraintFT.fieldtype === 'object') {
        const cProps = objectProperty(constraintFT);
        if (cProps.length > 0) {
          matches = envProps.filter((ep: any) => {
            if (!ep.value || ep.value.fieldtype !== 'object') return false;
            const ePropsArr = objectProperty(ep.value);
            const ePropMap = new Map(ePropsArr.map((p: any) => [p.key, p]));
            // Every constraint property must exist in the ctx entry with compatible value
            for (const cp of cProps) {
              const match = ePropMap.get(cp.key);
              if (!match) return false;
              // Compare literal constraint values directly
              const cLit = (cp.value?.attributes ?? []).find((a: any) => a.constrainttype === 'literal');
              const eLit = (match.value?.attributes ?? []).find((a: any) => a.constrainttype === 'literal');
              if (cLit && eLit && cLit.value !== eLit.value) return false;
              if (cLit && !eLit) return false;
            }
            return true;
          });
        }
      }
    }

    // ── Phase A.2: Constraint-aware matching ──
    // When multiple candidates match, use concrete constraint to disambiguate
    if (matches.length > 1 && (matchingSchema || constraintSchema)) {
      const schema = matchingSchema ?? constraintSchema;
      const constraintFT = schema?.eventtype
        ? FieldType.fromCreationEvent(schema)
        : (FieldType.describes(schema) ? schema : null);
      if (constraintFT) {
        try {
          const compatible = matches.filter((ep: any) => {
            const composed = FieldType.compose(constraintFT, ep.value);
            return !isNever(composed);
          });
          if (compatible.length >= 1 && compatible.length < matches.length) {
            matches = compatible;
          }
        } catch {
          // compose may fail on reconstructed (non-live) constraint types —
          // skip narrowing and let the matches proceed to candidate surfacing.
        }
      }
    }

    // ── Phase A.3: Where-predicate filtering ──
    // If the constraint is a non-literal expression (intersect, call),
    // evaluate it post-binding for each candidate and filter.
    if (whereExpr && matches.length >= 1) {
      const compatible = matches.filter((ep: any) => {
        // Temporarily bind the var to this candidate's type
        const tempBindings = new Map(varBindings);
        for (const cv of constraintVars) {
          tempBindings.set(cv.varId, ep.value);
        }
        // Also add the binding name → ctx value for name resolution
        const tempScope = new Map(scopeMap);
        tempScope.set(bindStmt.name, ctx.value(ep.key));

        const result = evaluateTypeExpr(whereExpr, tempBindings, tempScope, ctx);
        // Predicate succeeds if evaluation returns a non-never FieldType
        return result !== null && !isNever(result);
      });
      if (compatible.length >= 1) {
        matches = compatible;
      }
    }

    const stmtDefault = bindStmt.default;

    // Build candidate list with values for ALL multi-match and defaulted cases
    const candidateList = matches.map((m: any) => ({
      key: m.key,
      displayName: m.value?.metadata?.displayName ?? m.value?.metadata?.name ?? m.key,
      value: ctx.value(m.key),
    }));

    // Record candidate domain for this gate (preserves multi-match info)
    if (candidateList.length > 0) {
      candidateDomains.set(bindStmt.name, candidateList);
    }

    // Defaulted gates always surface in missing (even single-match) so the form shows them
    if (stmtDefault && matches.length >= 1) {
      const defaultVal = stmtDefault.type === 'literal' ? stmtDefault.value
        : stmtDefault.type === 'fieldtype' ? getLiteralValue(stmtDefault)
        : undefined;
      missing.push({
        key: bindStmt.name,
        source: refSourceStr ?? '(dynamic)',
        constraint: bindStmt.constraint,
        type: constraintSchema ?? null,
        typeName: gateTypeName ?? refSourceStr ?? '(unnamed)',
        candidates: candidateList,
        defaultValue: defaultVal,
        optional: true,  // has a default → always optional
      });
      // Still resolve the dep with the first match for downstream use
      deps[bindStmt.name] = ctx.value(matches[0].key);
      scopeMap.set(bindStmt.name, ctx.value(matches[0].key));
      continue;
    }

    if (matches.length === 0) {
      // Surface ALL blocked bindings in missing — required, optional, and defaulted.
      // Optional fields appear in the form but don't block Phase B resolution.
      missing.push({
        key: bindStmt.name,
        source: refSourceStr ?? '(dynamic)',
        constraint: bindStmt.constraint,
        type: constraintSchema ?? null,
        typeName: gateTypeName ?? refSourceStr ?? '(unnamed)',
        optional: isOptional,
        ...(stmtDefault ? {
          defaultValue: stmtDefault.type === 'literal' ? stmtDefault.value
            : stmtDefault.type === 'fieldtype' ? getLiteralValue(stmtDefault)
            : undefined,
        } : {}),
      });
      continue;
    }

    if (matches.length > 1) {
      // Multiple matches = branching suspension. Same mechanism as zero matches
      // but with candidates attached. The caller (UI/agent) selects one.
      missing.push({
        key: bindStmt.name,
        source: refSourceStr ?? '(dynamic)',
        constraint: bindStmt.constraint,
        type: constraintSchema ?? null,
        typeName: gateTypeName ?? refSourceStr ?? '(unnamed)',
        candidates: candidateList,
        optional: isOptional,
      });
      continue;
    }

    deps[bindStmt.name] = ctx.value(matches[0].key);
    // Add resolved dep value to scope for subsequent constraint ref substitution
    scopeMap.set(bindStmt.name, ctx.value(matches[0].key));

    // ── Behavioral constraint discovery ──
    // After resolving a ref gate, discover behavioral constraints on the matched
    // property. This concentrates ALL constraint discovery into the solver —
    // save() no longer needs to re-derive them via resolveConstraint().
    if (ctx.rootType) {
      for (const ct of BEHAVIORAL_CONSTRAINT_TYPES) {
        const bc = findBehavioralConstraint(ctx.rootType, matches[0].key, ct);
        if (bc) {
          const params: Record<string, unknown> = {};
          for (const [k, v] of Object.entries(bc)) {
            if (k === 'type' || k === 'basetype' || k === 'constrainttype') continue;
            params[k] = typeof v === 'string' ? scopeMap.get(v) ?? v : v;
          }
          behavioralActions.push({ bindingName: bindStmt.name, constrainttype: ct, params });
        }
      }
    }

    // ── VarType binding: record which concrete type each variable was instantiated to ──
    if (constraintVars.length > 0) {
      for (const cv of constraintVars) {
        if (!varBindings.has(cv.varId)) {
          varBindings.set(cv.varId, matches[0].value);
        }
      }
    }

    // After resolving a ref gate, inspect the matched ctx type for interior requirements.
    // Package types derived by derivePackageType() encode unresolved interior refs as
    // optional properties with metadata.name. These become constraint refs for cascade.
    const matchedType = matches[0].value;
    if (matchedType?.fieldtype === 'object' && matchedType.attributes?.length) {
      const innerProps = objectProperty(matchedType);
      for (const ip of innerProps) {
        if (ip.optional && ip.value?.metadata?.name) {
          const interiorRef = `${matches[0].key}.${ip.key}`;
          if (!allConstraintRefs.includes(interiorRef)) {
            allConstraintRefs.push(interiorRef);
          }
        }
      }
    }
  }

  // ── Pass 2: Behavioral constraint discovery for concrete (non-blocked) bindings ──
  // The ref-gate loop above only processes blocked bindings. Concrete bindings
  // (e.g., concrete('apiKey', literal('sk-123'))) bypass it, so behavioral
  // constraints on them are missed. This pass closes the gap — making
  // behavioralActions cover ALL bindings in the chain.
  if (ctx.rootType) {
    for (const stmt of allStatements) {
      if (stmt.type !== 'bind') continue;
      const bindStmt = stmt as BindStatement;
      if (isBlocked(bindStmt)) continue;      // already handled above
      if (bindStmt.level === 'type') continue; // type-level = structural, not behavioral
      if (!bindStmt.name) continue;
      // Skip if actions already discovered for this binding (from ref-gate path)
      if (behavioralActions.some(a => a.bindingName === bindStmt.name)) continue;

      // Populate scopeMap from literal values for param resolution
      if (!scopeMap.has(bindStmt.name)) {
        const litVal = getLiteralValue(bindStmt.expr);
        if (litVal !== undefined) scopeMap.set(bindStmt.name, litVal);
      }

      for (const ct of BEHAVIORAL_CONSTRAINT_TYPES) {
        const bc = findBehavioralConstraint(ctx.rootType, bindStmt.name, ct);
        if (bc) {
          const params: Record<string, unknown> = {};
          for (const [k, v] of Object.entries(bc)) {
            if (k === 'type' || k === 'basetype' || k === 'constrainttype') continue;
            params[k] = typeof v === 'string' ? scopeMap.get(v) ?? v : v;
          }
          behavioralActions.push({ bindingName: bindStmt.name, constrainttype: ct, params });
        }
      }
    }
  }

  // ── Phase A.4: Projection-based constraint propagation ──
  // Traverse function type projections to derive narrowed constraints for refs
  // nested inside call expressions. When a concrete binding has a call expression
  // like add(10, ref('y')), and the binding constraint says max(20), the projection
  // inverse derives y ≤ 10 and surfaces it as a FieldTypeMissing entry.
  {
    const projectedConstraints = new Map<string, FieldType>(); // ref name → narrowed

    for (const stmt of allStatements) {
      if (stmt.type !== 'bind') continue;
      const bindStmt = stmt as BindStatement;
      if (bindStmt.level !== 'concrete') continue;
      if (bindStmt.expr.type !== 'call') continue;
      if (!hasDeepRefConstraint(bindStmt.expr)) continue;

      const fnName = typeof bindStmt.expr.fn === 'string' ? bindStmt.expr.fn : null;
      if (!fnName) continue;

      const fnType = ARITHMETIC_FN_TYPES.get(fnName);
      if (!fnType) continue;

      // Find the projection constraint on the function type
      const projection = (fnType.attributes ?? []).find(
        (a: any) => ConstraintTypes.function.projection.describes(a),
      );
      if (!projection) continue;

      // Output constraint: from the binding's constraint annotation or rootType property
      let outputConstraint: FieldType | null = null;
      if (bindStmt.constraint) {
        outputConstraint = evaluateTypeExpr(bindStmt.constraint, varBindings, scopeMap, ctx);
      }
      if (!outputConstraint && bindStmt.name && ctx.rootType) {
        // Look up the property type from rootType
        const props = objectProperty(ctx.rootType);
        const prop = props.find((p: any) => p.key === bindStmt.name);
        if (prop?.value && FieldType.describes(prop.value)) {
          outputConstraint = prop.value;
        }
      }
      if (!outputConstraint) continue;

      // Classify args: known (literal or resolved from scopeMap) vs unknown (ref)
      const knownFTs: FieldType[] = [];
      const unknownRefNames: string[] = [];

      for (const arg of bindStmt.expr.args) {
        if (arg.type === 'literal' && typeof arg.value === 'number') {
          knownFTs.push(FieldType.number.create({
            attributes: [ConstraintTypes.any.literal.create(arg.value)],
          }));
        } else if (arg.type === 'fieldtype') {
          const litVal = getLiteralValue(arg);
          if (typeof litVal === 'number') {
            knownFTs.push(FieldType.number.create({
              attributes: [ConstraintTypes.any.literal.create(litVal)],
            }));
          } else {
            // Unknown fieldtype arg — treat as unknown
            const refSrc = (arg.attributes ?? []).find(
              (a: any) => ConstraintTypes.any.ref.describes(a),
            );
            if (refSrc?.source && !scopeMap.has(refSrc.source)) {
              unknownRefNames.push(refSrc.source);
            }
          }
        } else if (arg.type === 'ref' && typeof arg.source === 'string') {
          if (scopeMap.has(arg.source)) {
            const resolved = scopeMap.get(arg.source);
            if (typeof resolved === 'number') {
              knownFTs.push(FieldType.number.create({
                attributes: [ConstraintTypes.any.literal.create(resolved)],
              }));
            } else if (FieldType.describes(resolved)) {
              knownFTs.push(resolved);
            }
          } else {
            unknownRefNames.push(arg.source);
          }
        } else if (arg.type === 'name') {
          if (scopeMap.has(arg.id)) {
            const resolved = scopeMap.get(arg.id);
            if (typeof resolved === 'number') {
              knownFTs.push(FieldType.number.create({
                attributes: [ConstraintTypes.any.literal.create(resolved)],
              }));
            } else if (FieldType.describes(resolved)) {
              knownFTs.push(resolved);
            }
          } else {
            unknownRefNames.push(arg.id);
          }
        }
      }

      if (unknownRefNames.length === 0) continue;

      // Forward-combine known args using the combiner (identity element if none)
      const identityFT = FieldType.number.create({
        attributes: [ConstraintTypes.any.literal.create(projection.identity)],
      });
      let knownCombined: FieldType = identityFT;
      for (const kft of knownFTs) {
        const combinerExpr: Expression = {
          type: 'call',
          fn: projection.combiner,
          args: [
            { type: 'literal', value: knownCombined },
            { type: 'literal', value: kft },
          ],
        };
        const combined = evaluateTypeExpr(combinerExpr, varBindings, scopeMap, ctx);
        if (combined && FieldType.describes(combined)) {
          knownCombined = combined;
        }
      }

      // Evaluate inverse with output + known in scope
      const projScope = new Map(scopeMap);
      projScope.set('output', outputConstraint);
      projScope.set('known', knownCombined);
      const narrowed = evaluateTypeExpr(projection.inverse, varBindings, projScope, ctx);
      if (!narrowed || isNever(narrowed)) continue;

      // Accumulate: intersect bounds with prior constraints from other bindings.
      // Uses bound-level intersection (tightest min/max) instead of FieldType.compose,
      // since numeric constraint intersection is simpler and more precise.
      for (const refName of unknownRefNames) {
        const prior = projectedConstraints.get(refName);
        if (!prior) {
          projectedConstraints.set(refName, narrowed);
        } else {
          const pb = extractBounds(prior);
          const nb = extractBounds(narrowed);
          projectedConstraints.set(refName, boundsToFieldType({
            min: pb.min !== null && nb.min !== null ? Math.max(pb.min, nb.min)
              : pb.min ?? nb.min,
            max: pb.max !== null && nb.max !== null ? Math.min(pb.max, nb.max)
              : pb.max ?? nb.max,
            exclusiveMin: pb.exclusiveMin !== null && nb.exclusiveMin !== null
              ? Math.max(pb.exclusiveMin, nb.exclusiveMin)
              : pb.exclusiveMin ?? nb.exclusiveMin,
            exclusiveMax: pb.exclusiveMax !== null && nb.exclusiveMax !== null
              ? Math.min(pb.exclusiveMax, nb.exclusiveMax)
              : pb.exclusiveMax ?? nb.exclusiveMax,
            literal: null,
          }));
        }
      }
    }

    // Surface projected constraints as missing
    for (const [refName, constraint] of projectedConstraints) {
      if (scopeMap.has(refName)) continue;
      if (deps[refName] !== undefined) continue;
      if (missing.some(m => m.key === refName)) continue;
      if (isNever(constraint)) continue;

      missing.push({
        key: refName,
        source: refName,
        typeName: 'number',
        type: constraint,
        optional: false,
      });
    }
  }

  // ── Phase A.1b: Unresolved constraint refs become additional missing deps ──
  for (const refPath of allConstraintRefs) {
    if (scopeMap.has(refPath)) continue; // resolved during iteration
    if (deps[refPath] !== undefined) continue; // resolved as a dep
    if (missing.some(m => m.key === refPath)) continue; // already missing
    missing.push({
      key: refPath,
      source: refPath,
      typeName: `(constraint ref: ${refPath})`,
      type: null,
    });
  }

  // ── Phase B: Policy ──
  // Only required (non-optional) missing fields affect the resolved/pending decision.
  // Optional and defaulted fields appear in missing for the form but don't block.
  const requiredMissing = missing.filter(m => !m.optional);

  // Shared rich context for all return paths
  const shared = {
    key, deps, missing, chain, constraintRefs: allConstraintRefs,
    scopeMap: scopeMap as ReadonlyMap<string, any>,
    varBindings,
    candidateDomains: candidateDomains as ReadonlyMap<string, readonly { key: string; value?: unknown }[]>,
    behavioralActions,
  } as const;

  if (requiredMissing.length === 0 && missing.length === 0) {
    return { ...shared, status: 'resolved' as const };
  }

  if (requiredMissing.length === 0 && missing.length > 0) {
    // Only optional/defaulted fields — still return pending so the form shows,
    // but deps are complete enough for downstream use.
    if (!options?.allowDefer) {
      // No required fields missing — treat as resolved when defer isn't available
      return { ...shared, status: 'resolved' as const };
    }
    return { ...shared, status: 'pending' as const };
  }

  if (!options?.allowDefer) {
    const missingDesc = requiredMissing.map(m => `"${m.key}" (${m.typeName})`).join(', ');
    throw new Error(`patchResolve(${key}): unresolved — ${missingDesc}`);
  }

  // Return pending — caller creates Watcher and handles subscription
  return { ...shared, status: 'pending' as const };
}

// ─────────────────────────────────────────────────────────────────────────────
// Type-level expression evaluator (synchronous, for where-clause predicates)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Bindings accumulated during VarType resolution.
 * Maps varId → the concrete FieldType the variable was instantiated to.
 */
export type VarBindings = Map<string, FieldType>;

/**
 * Evaluate an expression at the type level — synchronous, no tool execution.
 *
 * Used to check `where` predicates after a VarType is bound:
 *   where getTool(T) extends SomeType
 *   →  intersect(call("getTool", [name("T")]), literal(SomeType))
 *
 * - literal: return the FieldType value directly
 * - name: lookup in varBindings (by varId), then scopeMap (by name)
 * - call: evaluate args, then look up the resolved address in ctx via
 *         ctx.value(key) and return the type (FieldType value or rootType property)
 * - intersect: evaluate both sides, compose. never = predicate fails
 * - object: return as-is (structural type literal)
 * - ref: not evaluable at type level — returns null (unresolved)
 */
export function evaluateTypeExpr(
  expr: Expression,
  varBindings: VarBindings,
  scopeMap: Map<string, any>,
  ctx: HEAD,
): FieldType | null {
  switch (expr.type) {
    case 'literal': {
      const v = expr.value;
      if (FieldType.describes(v)) return v;
      // Serialized FieldType (creation event)
      if (v?.eventtype && v?.fieldtype) return FieldType.fromCreationEvent(v);
      return null;
    }

    case 'fieldtype': {
      // FieldTypeExpr: reconstruct FieldType from the expression's fieldtype/attributes.
      // If it carries a literal constraint with a FieldType value, use that.
      const litVal = getLiteralValue(expr) as any;
      if (litVal && FieldType.describes(litVal)) return litVal;
      if (litVal?.eventtype && litVal?.fieldtype) return FieldType.fromCreationEvent(litVal);
      // Otherwise, if the expr itself describes a type, build from its shape
      if (expr.fieldtype && expr.fieldtype !== 'any') {
        try {
          return FieldType.fromCreationEvent({
            type: 'fieldtypeevent', eventtype: 'state', id: '',
            fieldtype: expr.fieldtype, attributes: expr.attributes,
            extensions: [],
            ...(expr.metadata ? { metadata: expr.metadata } : {}),
          } as any);
        } catch { return null; }
      }
      return null;
    }

    case 'name': {
      // Check varBindings first (variable name → bound concrete type)
      for (const [, binding] of varBindings) {
        if (FieldType.var.describes(binding) && (binding as any).name === expr.id) {
          return binding;
        }
      }
      // varBindings keyed by varId — also check by name in the values
      for (const [varId, bound] of varBindings) {
        // The varId itself won't match a human name, but the bound concrete will
        // If the name matches a varId's name, return the concrete binding
        const varInScope = scopeMap.get(expr.id);
        if (varInScope !== undefined && FieldType.var.describes(varInScope) &&
            (varInScope as any).varId === varId) {
          return bound;
        }
      }
      // Fall back to scopeMap
      const val = scopeMap.get(expr.id);
      if (val === undefined) return null;
      if (FieldType.describes(val)) return val;
      // Serialized FieldType in scope
      if (val?.eventtype && val?.fieldtype) return FieldType.fromCreationEvent(val);
      return null;
    }

    case 'call': {
      // Evaluate the function target
      const fnName = typeof expr.fn === 'string'
        ? expr.fn
        : (expr.fn.type === 'name' ? expr.fn.id : null);
      if (!fnName) return null;

      // Evaluate arguments — each should resolve to a concrete type or value
      const resolvedArgs: any[] = [];
      for (const arg of expr.args) {
        const resolved = evaluateTypeExpr(arg, varBindings, scopeMap, ctx);
        if (resolved === null) return null; // can't evaluate — unresolved dep
        resolvedArgs.push(resolved);
      }

      // ── Type-level arithmetic dispatch ──
      // Recognize numericAdd/Sub/Mul/Div as built-in type-level operations.
      // These operate on numeric FieldTypes, returning derived FieldTypes.
      const arithmeticFns = ['numericAdd', 'numericSub', 'numericMul', 'numericDiv'] as const;
      if ((arithmeticFns as readonly string[]).includes(fnName) && resolvedArgs.length === 2) {
        let [left, right] = resolvedArgs;
        // Wrap plain numbers as literal FieldTypes
        if (typeof left === 'number') left = FieldType.number.create({ attributes: [ConstraintTypes.any.literal.create(left)] });
        if (typeof right === 'number') right = FieldType.number.create({ attributes: [ConstraintTypes.any.literal.create(right)] });
        if (FieldType.describes(left) && FieldType.describes(right)) {
          switch (fnName) {
            case 'numericAdd': return numericAdd(left, right);
            case 'numericSub': return numericSub(left, right);
            case 'numericMul': return numericMul(left, right);
            case 'numericDiv': return numericDiv(left, right);
          }
        }
      }

      // Type-level call: look up the address in ctx, return the type surface.
      // The first arg is the address (the resolved VarType binding).
      // For getTool(T): T resolved to a concrete key, ctx.value(key) is the value,
      // which may itself be a FieldType (type-level binding).
      const address = resolvedArgs[0];

      // If the address is a string key in scope, dereference through ctx
      const addressKey = typeof address === 'string' ? address
        : (address?.metadata?.name ?? null);

      if (addressKey && ctx.value(addressKey) !== undefined) {
        const target = ctx.value(addressKey);
        // If the value itself is a FieldType (type-level binding)
        if (FieldType.describes(target)) return target;
      }

      // If the address itself is a FieldType, the call is a type-level accessor.
      // Look it up in ctx's rootType properties by compose-matching.
      if (FieldType.describes(address)) {
        const ctxType = ctx.rootType;
        if (ctxType?.fieldtype === 'object') {
          const ctxProps = objectProperty(ctxType);
          for (const ep of ctxProps) {
            if (!ep.value) continue;
            const composed = FieldType.compose(address, ep.value);
            if (!isNever(composed)) {
              const target = ctx.value(ep.key);
              if (FieldType.describes(target)) return target;
              return ep.value; // return the type from the type surface
            }
          }
        }
      }

      return null;
    }

    case 'intersect': {
      const left = evaluateTypeExpr(expr.left, varBindings, scopeMap, ctx);
      const right = evaluateTypeExpr(expr.right, varBindings, scopeMap, ctx);
      if (!left || !right) return null;
      return FieldType.compose(left, right);
    }

    case 'object':
      // Structural type literal — build an object FieldType from properties
      return types.object() as FieldType;

    case 'ref':
      // Refs are not evaluable at type level — they're holes
      return null;
  }
}

/**
 * Walk a FieldType tree and collect all VarType nodes.
 * Used to detect parameterized constraints before matching.
 */
export function collectVarTypes(ft: FieldType): Array<{ varId: string; name: string; bound?: FieldType }> {
  const result: Array<{ varId: string; name: string; bound?: FieldType }> = [];
  const visited = new Set<string>();

  function walk(node: any) {
    if (!node || !FieldType.describes(node)) return;
    const nodeId = node?.update?.id ?? node?.id;
    if (nodeId && visited.has(nodeId)) return;
    if (nodeId) visited.add(nodeId);

    if (FieldType.var.describes(node)) {
      result.push({
        varId: (node as any).varId,
        name: (node as any).name,
        bound: (node as any).bound,
      });
      return;
    }

    // Recurse into attributes (property values, etc.)
    for (const attr of (node.attributes ?? [])) {
      if (FieldType.describes(attr)) walk(attr);
      if ((attr as any)?.value && FieldType.describes((attr as any).value)) {
        walk((attr as any).value);
      }
    }
    // Recurse into extensions
    for (const ext of (node.extensions ?? [])) {
      if (FieldType.describes(ext)) walk(ext);
    }
  }

  walk(ft);
  return result;
}

/**
 * Substitute VarType nodes in a FieldType tree with their concrete bindings.
 * Returns a new tree (does not mutate the original).
 */
export function substituteVarBindings(ft: FieldType, bindings: VarBindings): FieldType {
  if (!FieldType.describes(ft)) return ft;

  if (FieldType.var.describes(ft)) {
    const bound = bindings.get((ft as any).varId);
    if (bound) return bound;
    return ft;
  }

  // Check if any attributes or extensions contain VarTypes that need substitution
  const attrs = (ft.attributes ?? []) as any[];
  const exts = (ft.extensions ?? []) as any[];
  let changed = false;

  const newAttrs = attrs.map(a => {
    if (FieldType.var.describes(a)) {
      const bound = bindings.get((a as any).varId);
      if (bound) { changed = true; return bound; }
    }
    if (a?.value && FieldType.describes(a.value)) {
      const sub = substituteVarBindings(a.value, bindings);
      if (sub !== a.value) {
        changed = true;
        return { ...a, value: sub };
      }
    }
    return a;
  });

  const newExts = exts.map(e => {
    if (FieldType.describes(e)) {
      const sub = substituteVarBindings(e, bindings);
      if (sub !== e) { changed = true; return sub; }
    }
    return e;
  });

  if (!changed) return ft;

  // Rebuild with substituted attributes/extensions
  const rebuilt = FieldType.create(ft.fieldtype, newAttrs, newExts, {
    metadata: (ft as any).metadata,
  });
  return rebuilt as FieldType;
}

// ─────────────────────────────────────────────────────────────────────────────
// Kit schema derivation
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Derive a block schema from a PendingResult's missing deps.
 *
 * Each missing dep becomes a `types.assignment(key, type)` in the block schema.
 * The UI renders this as a form. As users provide bindings and patchResolve
 * re-runs, the schema GROWS (cascade — providing dep A may reveal dep B).
 */
export function kitSchemaFromPending(pending: PendingResult): FieldType {
  const assignments = pending.missing.map(m => {
    const meta = m.type?.metadata;
    return types.assignment(m.key, m.type ?? types.any(), {
      reason: meta?.label ?? meta?.name,
      description: meta?.description,
      placeholder: meta?.placeholder,
      inputType: meta?.inputType,
      default: m.defaultValue,
    });
  });
  return types.block(assignments);
}

/**
 * Derive a block schema from MissingRequirement[] (graph compilation output).
 *
 * Each MissingRequirement becomes a `types.assignment(path, type)` in the block.
 * When `expectedSchema` is present, the FieldType is deserialized from it;
 * otherwise falls back to `types.string()` for legacy untyped entries.
 *
 * When `containsConstraints` is provided, they are appended to the block schema
 * as contains constraints — enabling dynamic-cardinality sections in the form
 * (e.g., annotations). These come from the original blueprint's block schema
 * metadata and are passed through by blockedEvent().
 */
export function kitSchemaFromMissing(
  missing: MissingRequirement[],
  containsConstraints?: Array<{ value: any; min?: number; max?: number; reason?: string }>,
): FieldType {
  const assignments = missing.map(m => {
    const type = m.expectedSchema
      ? FieldType.fromEvent(m.expectedSchema)
      : types.string();
    const meta = m.expectedSchema?.metadata;
    return types.assignment(m.path, type, {
      reason: meta?.label ?? m.description ?? m.expectedType,
      description: meta?.description,
      placeholder: meta?.placeholder,
      inputType: meta?.inputType,
      default: m.defaultValue,
    });
  });

  // Append contains constraints from the original block schema
  const containsParts: any[] = [];
  if (containsConstraints) {
    for (const cc of containsConstraints) {
      const containedType = cc.value?.eventtype
        ? FieldType.fromCreationEvent(cc.value)
        : (cc.value && FieldType.describes(cc.value) ? cc.value : types.any());
      const part = types.zeroToMany(containedType);
      // Override min/max if provided (zeroToMany defaults to min:0)
      if (cc.min !== undefined) (part as any).min = cc.min;
      if (cc.max !== undefined) (part as any).max = cc.max;
      if (cc.reason) (part as any).reason = cc.reason;
      containsParts.push(part);
    }
  }

  return types.block([...assignments, ...containsParts]);
}
