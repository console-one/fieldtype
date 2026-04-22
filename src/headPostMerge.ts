/**
 * headPostMerge.ts — Default post-merge handler extracted from head.ts.
 *
 * Application-level behavioral processing that fires after a draft merges:
 * solve, persist, subscribe, compact, label, receiver dispatch.
 */

import {
  type HeadState,
  type PostMergeContext,
  rt,
  effectiveRootType,
  getSolveResult,
  invalidate,
  getOrCreateSubscriptions,
  getSource,
  getSnapshot,
  wrapHead,
  getRootType,
} from './head.js';
import {
  reduce,
  push,
  collectStatements,
  compact,
  createChain,
} from './chain.js';
import { selectFromBounds, type SolveObjective } from './numericProjection.js';
import { FieldType } from './type.js';

// ─────────────────────────────────────────────────────────────────────────────
// Private Helpers — solve constraint detection
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Check if the root type declares a solve behavioral constraint.
 * Same scan pattern as hasAutoMerge — checks root attributes + property value types.
 */
function hasSolve(state: HeadState): boolean {
  const attrs = getRootType(state.root).attributes ?? [];
  for (const attr of attrs) {
    if ((attr as any)?.constrainttype === 'solve') return true;
    const valueAttrs = (attr as any)?.value?.attributes;
    if (Array.isArray(valueAttrs)) {
      for (const va of valueAttrs) {
        if ((va as any)?.constrainttype === 'solve') return true;
      }
    }
  }
  return false;
}

/**
 * Extract the objective from the first solve constraint found on the rootType.
 * Returns 'midpoint' as default if none found.
 */
function findSolveObjective(state: HeadState): SolveObjective {
  const attrs = getRootType(state.root).attributes ?? [];
  for (const attr of attrs) {
    if ((attr as any)?.constrainttype === 'solve') return (attr as any).objective ?? 'midpoint';
    const valueAttrs = (attr as any)?.value?.attributes;
    if (Array.isArray(valueAttrs)) {
      for (const va of valueAttrs) {
        if ((va as any)?.constrainttype === 'solve') return (va as any).objective ?? 'midpoint';
      }
    }
  }
  return 'midpoint';
}

// ─────────────────────────────────────────────────────────────────────────────
// Default Post-Merge Handler — application-level behavioral processing
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Default post-merge handler. Operationalizes behavioral constraints declared
 * in the HEAD's type: solve, persist, subscribe, compact, label, receiver dispatch.
 *
 * This is APPLICATION-LEVEL processing, not core HEAD mechanics. Different
 * environments can install different handlers. This handler implements the
 * production kernel's behavior: persist to disk, classify by label, etc.
 */
export async function defaultPostMergeHandler(ctx: PostMergeContext): Promise<void> {
  const { source, draftState, filteredStatements, prevSnapshot } = ctx;
  const rootType = effectiveRootType(draftState);

  // ── Solve: select values for projected constraint refs ──
  if (hasSolve(draftState)) {
    const objective = findSolveObjective(draftState);
    const solveResult = getSolveResult(draftState);
    let solveChanged = false;

    for (const m of solveResult.missing) {
      if (!m.type || m.type.fieldtype !== 'number') continue;
      const postScope = reduce(source.chain).scope;
      if (postScope.bindings.get(m.key)?.resolved) continue;

      const value = selectFromBounds(m.type, objective as SolveObjective);
      if (value === undefined) continue;

      source.chain = push(source.chain, {
        type: 'bind', name: m.key,
        expr: { type: 'literal', value },
        level: 'concrete',
      });
      solveChanged = true;
    }

    if (solveChanged) invalidate(source);
  }

  // ── Operationalize behavioral constraints for changed bindings ──
  {
    const postPatchScope = reduce(source.chain).scope;

    const filteredNames = new Set(
      filteredStatements
        .filter(s => (s.type === 'bind' && s.level !== 'type' && s.name) || s.type === 'delete')
        .map(s => (s as any).name as string),
    );

    const deletedNames = new Set(
      filteredStatements
        .filter(s => s.type === 'delete')
        .map(s => (s as any).name as string),
    );

    // ── Persist + Subscribe + Compact ──
    const solveResult = getSolveResult(draftState);
    const mergedActions = solveResult.behavioralActions.filter(
      a => filteredNames.has(a.bindingName),
    );

    let compacted = false;
    for (const action of mergedActions) {
      const params: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(action.params)) {
        if (typeof v === 'string') {
          const binding = postPatchScope.bindings.get(v);
          params[k] = binding?.resolved ? binding.value : v;
        } else {
          params[k] = v;
        }
      }

      switch (action.constrainttype) {
        case 'persist': {
          const sinkFn = typeof params.sink === 'function' ? params.sink : null;
          const transformFn = typeof params.transform === 'function' ? params.transform : null;

          if (deletedNames.has(action.bindingName)) {
            if (sinkFn) {
              await Promise.resolve(
                (sinkFn as Function)(undefined, { target: params.target, bindingName: action.bindingName, deleted: true }, wrapHead(source)),
              );
            }
            break;
          }

          const value = postPatchScope.bindings.get(action.bindingName)?.value;
          if (sinkFn && value !== undefined) {
            const transformed = transformFn
              ? await Promise.resolve((transformFn as Function)(value))
              : value;
            const ref = await Promise.resolve(
              (sinkFn as Function)(transformed, { target: params.target, bindingName: action.bindingName }, wrapHead(source)),
            );
            if (ref !== undefined && ref !== value) {
              source.chain = push(source.chain, {
                type: 'bind', name: action.bindingName,
                expr: { type: 'literal', value: ref },
                level: 'concrete',
              });
              invalidate(source);
            }
          }
          break;
        }
        case 'subscribe': {
          const targetName = typeof params.target === 'string' ? params.target : null;
          if (targetName) {
            const value = postPatchScope.bindings.get(action.bindingName)?.value;
            if (value !== undefined) {
              const subState = getOrCreateSubscriptions(source, 'subscriptions');
              subState.chain = push(subState.chain, {
                type: 'bind', name: targetName,
                expr: { type: 'literal', value },
                level: 'concrete',
              });
              invalidate(subState);
            }
          }
          break;
        }
        case 'compact': {
          if (!compacted && params.retain != null) {
            const stmtCount = collectStatements(source.chain).length;
            if (stmtCount > (params.retain as number)) {
              source.chain = compact(source.chain, { keep: params.retain as number });
              invalidate(source);
              compacted = true;
            }
          }
          break;
        }
      }
    }

    // ── Label (REMOVED) ──
    // Label classification is now fully demand-driven via ensureLabelProjection()
    // in head.ts. Label children are lazily created and populated on first at()
    // access by scanning entries against the rootType's label match constraints.
    // This works on committed HEADs AND drafts — no save()-time indexing needed.
  }

  // ── Receiver dispatch ──
  const nextSnapshot = getSnapshot(source);
  const pathSegments = source.path ? source.path.split('.') : [];
  const receiverStatements = await rt(source).receivers.dispatch({ path: pathSegments, nextType: nextSnapshot, prevType: prevSnapshot });

  if (receiverStatements.length > 0) {
    const sourceScope = reduce(source.chain).scope;
    let sourceChanged = false;
    for (const stmt of receiverStatements) {
      const isInstrumental = stmt.type === 'bind'
        && stmt.level === 'concrete'
        && sourceScope.bindings.has(stmt.name);
      if (isInstrumental) {
        source.chain = push(source.chain, stmt);
        sourceChanged = true;
      } else {
        const sr = rt(source);
        if (!sr.derived) {
          sr.derived = createChain('derived');
        }
        sr.derived = push(sr.derived, stmt);
      }
    }
    if (sourceChanged) invalidate(source);
  }
}
