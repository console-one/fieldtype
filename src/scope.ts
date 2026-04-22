/* ------------------------------------------------------------------ *
 *  scope.ts — Scope-cascade execution model                          *
 *                                                                    *
 *  The entire runtime is one pattern at different nesting depths:     *
 *    scope open → reduce → close → cascade                           *
 *                                                                    *
 *  Fork = nested write lock scope (NOT data copy).                   *
 *  Cascade = execution engine.                                       *
 *  Gaps = work queue.                                                *
 *  Subscribe = cascade trigger.                                      *
 *                                                                    *
 *  An "agent" is NOT a special concept. It's a callable on the       *
 *  session partition that guards reads/writes to its partition.       *
 *  When invoked it opens a scope, cascades (LLM + tools), closes.    *
 *  Zero agent implementations — the scope IS the agent.              *
 *                                                                    *
 *  driveAgent(443), agentPackage(284), headChatProto(388),           *
 *  chat.ts(352), llmInterpret(236), draftProjection(728)             *
 *  = 2431 lines, all one pattern: scope open, reduce, close.         *
 * ------------------------------------------------------------------ */

import type { Workspace, PatchResult } from './workspace.js';
import { ConstraintTypes } from './constraint.js';
import { classifyValue, type Interpreter, type StoreAccess } from './workspaceInterpreter.js';
import * as find from './find.js';

// ── Scope ──────────────────────────────────────────────────────────────

export type Scope = {
  /** The workspace backing this scope. */
  readonly ws: Workspace;

  /** Parent scope (undefined for root). */
  readonly parent: Scope | undefined;

  /** Interpreters available for reduction. */
  readonly interpreters: readonly Interpreter[];

  /** StoreAccess bound to this scope's workspace. */
  readonly store: StoreAccess;

  /**
   * Open a child scope — fork the workspace (nested write lock).
   * The child can READ the entire parent. It can only WRITE to its fork.
   */
  open(): Scope;

  /**
   * Reduce: dispatch interpreters on entries matching guards.
   * One pass. First match wins. Returns paths written by interpreters.
   */
  reduce(): string[];

  /**
   * Close: merge to parent (visibility promotion).
   * Data was always in the universal workspace — lock controlled visibility.
   */
  close(): PatchResult;

  /**
   * Cascade: reduce until stable. The execution engine.
   * Fixed-point convergence (Knaster-Tarski) — terminates when
   * no interpreter guard matches any unreduced entry.
   */
  cascade(): void;
};

// ── Factory ────────────────────────────────────────────────────────────

export function createScope(
  ws: Workspace,
  interpreters: readonly Interpreter[],
  parent?: Scope,
): Scope {
  const store: StoreAccess = {
    read: (path: string) => ws.read(path),
    entries: (path?: string) => ws.entries(path),
  };

  // Track reduced entries to prevent re-interpretation.
  const reduced = new Set<string>();

  const scope: Scope = {
    ws,
    parent: parent ?? undefined,
    interpreters,
    store,

    open(): Scope {
      return createScope(ws.fork(), interpreters, scope);
    },

    reduce(): string[] {
      const changed: string[] = [];

      // Recursive walk: workspace nests dotted paths (e.g., 'github.fetch_commits'
      // becomes github > fetch_commits). We must walk all levels to find
      // schematic values that interpreters can dispatch on.
      function walkEntries(prefix: string) {
        const names = prefix ? ws.entries(prefix) : ws.entries();
        for (const name of names) {
          const fullPath = prefix ? `${prefix}.${name}` : name;
          if (reduced.has(fullPath)) continue;

          // Already callable → skip
          try {
            const ft = ws.type(fullPath);
            if ((ft.attributes ?? []).some(
              (a: any) => ConstraintTypes.any.callable.describes(a),
            )) {
              reduced.add(fullPath);
              continue;
            }
          } catch { continue; }

          const value = ws.read(fullPath);

          // Non-object or undefined → still recurse (path may be a container
          // prefix with dispatchable values nested deeper, e.g. 'github' has
          // no value but 'github.fetch_commits' does).
          if (!value || typeof value !== 'object') {
            walkEntries(fullPath);
            continue;
          }

          // Dispatch: first interpreter whose guard matches → tell constraints
          let matched = false;
          for (const interp of interpreters) {
            if (classifyValue(interp.guard, value)) {
              const constraints = interp.constraints(value, store, [fullPath]);

              // Delete before rewrite: raw value (object) → callable (function).
              // Types differ — workspace rejects without delete first.
              if (constraints.fieldtype === 'object') {
                for (const prop of find.objectProperty(constraints)) {
                  const key = prop.key as string;
                  try { ws.delete(key); } catch { /* ok */ }
                  ws.write(key, prop.value);
                  changed.push(key);
                  reduced.add(key);
                }
              }

              reduced.add(fullPath);
              matched = true;
              break;
            }
          }

          // No interpreter matched → recurse into nested entries
          if (!matched) {
            walkEntries(fullPath);
          }
        }
      }

      walkEntries('');
      return changed;
    },

    close(): PatchResult {
      if (!parent) return { applied: [], conflicts: [], gaps: [] };
      return parent.ws.merge(ws);
    },

    cascade(): void {
      let round = 0;
      while (round < 100) {
        const changed = scope.reduce();
        if (changed.length === 0) break;
        round++;
      }
    },
  };

  return scope;
}

// ── Convenience ────────────────────────────────────────────────────────

/**
 * Scope open → reduce → close in one call.
 * The fundamental operation at every nesting depth.
 */
export function withScope(
  parent: Scope,
  reduceFn: (child: Scope) => void,
): PatchResult {
  const child = parent.open();
  reduceFn(child);
  return child.close();
}

/** Async version for IO-bound reductions (LLM, HTTP). */
export async function withScopeAsync(
  parent: Scope,
  reduceFn: (child: Scope) => Promise<void>,
): Promise<PatchResult> {
  const child = parent.open();
  await reduceFn(child);
  return child.close();
}
