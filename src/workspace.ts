/* ------------------------------------------------------------------ *
 *  workspace.ts — mutable FieldType cell with patch-resolve semantics  *
 *                                                                      *
 *  The workspace is the runtime. It takes patches, walks the block     *
 *  (materializing constraints as needed), validates against existing    *
 *  constraints, and either applies or reports conflicts/gaps.           *
 *                                                                      *
 *  Every patch is paired with a timestamp which simultaneously updates *
 *  REAL_TIME — the workspace's global clock. All schedule-based        *
 *  reactive constraints subscribe to REAL_TIME.                        *
 *                                                                      *
 *  fork() creates an isolated workspace for an interpreter. The fork   *
 *  has a reference to its root workspace so the interpreter can        *
 *  subscribe to root changes (reactive gates for conflict detection).  *
 *  merge() diffs the fork against its base and patches the root.       *
 *                                                                      *
 *  Refs resolve WITHIN a single workspace. Cross-workspace rendering   *
 *  is render(sourceWS, gapPath, receiverWS, receiverPath).             *
 *                                                                      *
 *  Version control: each patch is a tick. The tick stack is the        *
 *  workspace-layer history. The FieldType's prev chain is the          *
 *  data-layer history. Both coexist.                                   *
 * ------------------------------------------------------------------ */

import { FieldType, literalFromAttributes } from './type.js';
import { replaceProps } from './event.js';
import { ConstraintTypes, collectConstraintRefs, isConstraintRef } from './constraint.js';
import * as find from './find.js';

// ── Types ──────────────────────────────────────────────────────────────

type Callback = (value: unknown, path: string) => void;
type Unsubscribe = () => void;

export type WorkspaceTick = {
  readonly paths: string[];       // all affected paths
  readonly ft: FieldType;         // root FieldType AFTER this tick
  readonly prev: FieldType;       // root FieldType BEFORE this tick
  readonly tick: number;          // monotonic counter
  readonly timestamp: number;     // paired timestamp
};

export type PatchResult = {
  applied: string[];              // paths successfully patched
  conflicts: string[];            // paths rejected (type incompatibility)
  gaps: string[];                 // unresolved ref targets detected
};

export type Workspace = {
  /** Current FieldType (the state). */
  readonly ft: FieldType;

  /** Current tick number. */
  readonly tick: number;

  /** Global clock — updated on every patch. */
  readonly REAL_TIME: number;

  /** For forks: the root workspace this was forked from. */
  readonly root: Workspace | undefined;

  /** For forks: the FieldType at fork time. */
  readonly base: FieldType | undefined;

  /** Apply a set of patches. undefined values delete the path. */
  patch(entries: Record<string, unknown>): PatchResult;

  /** Convenience: single-path write. */
  write(path: string, value: unknown): void;

  /** Convenience: single-path delete. */
  delete(path: string): void;

  /** Read literal at path, resolving refs within this workspace. */
  read(path: string): unknown;

  /** Raw FieldType at path. */
  type(path: string): FieldType;

  /** Property keys at path (or root). */
  entries(path?: string): string[];

  /** Subscribe to value changes at a path. */
  subscribe(path: string, fn: Callback): Unsubscribe;

  /** Create an isolated workspace for an interpreter. */
  fork(): Workspace;

  /** Merge a fork's changes back into this workspace. */
  merge(fork: Workspace): PatchResult;

  /** Undo last tick. */
  undo(): WorkspaceTick | undefined;

  /** Full timeline. */
  readonly history: readonly WorkspaceTick[];

  /** FieldType at a specific tick. */
  at(tick: number): FieldType | undefined;
};

// ── Helpers ────────────────────────────────────────────────────────────

function valueToFieldType(value: unknown): FieldType {
  if (FieldType.describes(value)) return value;
  if (typeof value === 'string') return FieldType.string.create().literal(value).save();
  if (typeof value === 'number') return FieldType.number.create().literal(value).save();
  if (typeof value === 'boolean') return FieldType.boolean.create().literal(value).save();
  if (value === null) return FieldType.null.create().literal(null).save();
  if (Array.isArray(value)) return FieldType.array.create().literal(value).save();
  if (typeof value === 'object' && value !== null) {
    const entries = Object.entries(value);
    if (entries.length === 0) return FieldType.object.create().literal(value).save();
    let obj = FieldType.object.create();
    for (const [k, v] of entries) obj = obj.property(k, valueToFieldType(v));
    return obj.literal(value).save();
  }
  return FieldType.any.create().literal(value).save();
}

function writeAtPath(root: FieldType, path: string, value: FieldType): FieldType {
  const parts = path.split('.').filter(Boolean);
  if (parts.length === 0) return value;
  const [head, ...rest] = parts;
  let child: FieldType;
  try { child = FieldType.typeAtPath(root, head); }
  catch { child = FieldType.object.create(); }
  const newChild = rest.length === 0 ? value : writeAtPath(child, rest.join('.'), value);
  return replaceProps(root, { [head]: newChild });
}

function deleteAtPath(root: FieldType, path: string): FieldType {
  const parts = path.split('.').filter(Boolean);
  if (parts.length === 0) return root;
  if (parts.length === 1) {
    const key = parts[0];
    const kept = (root.attributes ?? []).filter(
      a => !(ConstraintTypes.object.property.describes(a) && (a as any).key === key)
    );
    return FieldType.create('object', kept as any[]) as FieldType;
  }
  const [head, ...rest] = parts;
  let child: FieldType;
  try { child = FieldType.typeAtPath(root, head); }
  catch { return root; }
  return replaceProps(root, { [head]: deleteAtPath(child, rest.join('.')) });
}

function readLiteral(root: FieldType, path: string, visited?: Set<string>, realTime?: number): unknown {
  visited ??= new Set();
  if (visited.has(path)) return undefined;
  visited.add(path);
  let ft: FieldType;
  try { ft = path ? FieldType.typeAtPath(root, path) : root; }
  catch { return undefined; }

  // TemporalConstraint: if active (REAL_TIME >= after), shadow with temporal value
  if (realTime !== undefined) {
    const temporals = (ft.attributes ?? []).filter(ConstraintTypes.any.temporal.describes) as any[];
    if (temporals.length > 0) {
      // Find the most recent applicable temporal constraint
      const active = temporals
        .filter((t: any) => realTime >= t.after)
        .sort((a: any, b: any) => b.after - a.after);
      if (active.length > 0) return active[0].value;
    }
  }

  // CallConstraint: resolve fn + args, invoke if all concrete
  const callAttr = (ft.attributes ?? []).find(ConstraintTypes.any.call.describes) as any;
  if (callAttr) {
    const fnRef = callAttr.fn;
    const fn = isConstraintRef(fnRef) ? readLiteral(root, fnRef.path, new Set(visited), realTime) : fnRef;
    if (typeof fn !== 'function') return undefined; // gap — fn not yet concrete

    const resolvedArgs: any[] = [];
    for (const arg of callAttr.args ?? []) {
      if (isConstraintRef(arg)) {
        const resolved = readLiteral(root, arg.path, new Set(visited), realTime);
        if (resolved === undefined) return undefined; // gap — arg not yet concrete
        resolvedArgs.push(resolved);
      } else {
        resolvedArgs.push(arg);
      }
    }
    return fn(...resolvedArgs);
  }

  const lit = literalFromAttributes(ft.attributes);
  if (lit !== undefined) {
    if (isConstraintRef(lit)) return readLiteral(root, lit.path, visited, realTime);
    return lit;
  }
  const refAttr = (ft.attributes ?? []).find(ConstraintTypes.any.ref.describes) as any;
  if (refAttr?.source) return readLiteral(root, refAttr.source, visited, realTime);
  return undefined;
}

function collectAllRefs(ft: FieldType): string[] {
  const paths: string[] = [];
  paths.push(...collectConstraintRefs(ft.attributes));
  for (const attr of ft.attributes ?? []) {
    if (ConstraintTypes.any.ref.describes(attr)) paths.push((attr as any).source);
  }
  return paths;
}

function buildRefIndex(root: FieldType, currentPath: string = ''): Map<string, Set<string>> {
  const index = new Map<string, Set<string>>();
  for (const refPath of collectAllRefs(root)) {
    if (!index.has(refPath)) index.set(refPath, new Set());
    index.get(refPath)!.add(currentPath);
  }
  if (root.fieldtype === 'object') {
    for (const prop of find.objectProperty(root)) {
      const childPath = currentPath ? `${currentPath}.${prop.key}` : prop.key;
      for (const [refPath, owners] of buildRefIndex(prop.value as FieldType, childPath)) {
        if (!index.has(refPath)) index.set(refPath, new Set());
        for (const owner of owners) index.get(refPath)!.add(owner);
      }
    }
  }
  return index;
}

function ancestorPaths(path: string): string[] {
  const parts = path.split('.').filter(Boolean);
  const ancestors: string[] = [];
  for (let i = parts.length - 1; i >= 0; i--) {
    ancestors.push(parts.slice(0, i).join('.'));
  }
  return ancestors;
}

// ── Factory ────────────────────────────────────────────────────────────

export function createWorkspace(
  initial?: FieldType,
  opts?: { clock?: () => number; root?: Workspace; base?: FieldType },
): Workspace {
  let ft = initial ?? FieldType.object.create();
  const clock = opts?.clock ?? (() => Date.now());
  let realTime = clock();
  const ticks: WorkspaceTick[] = [];
  const subs = new Map<string, Set<Callback>>();
  const rootWs = opts?.root;
  const baseFt = opts?.base;

  let ws: Workspace;

  function notify(path: string, value: unknown) {
    const set = subs.get(path);
    if (set) for (const fn of set) fn(value, path);
    // Global wildcard subscribers — notified on every write
    if (path !== '*') {
      const globalSet = subs.get('*');
      if (globalSet) for (const fn of globalSet) fn(value, path);
    }
  }

  function notifyWithAncestors(path: string) {
    notify(path, readLiteral(ft, path, undefined, realTime));
    for (const a of ancestorPaths(path)) {
      notify(a, a ? readLiteral(ft, a, undefined, realTime) : undefined);
    }
  }

  function notifyRefDependents(changedPath: string, visited: Set<string>) {
    if (visited.has(changedPath)) return;
    visited.add(changedPath);
    const deps = buildRefIndex(ft).get(changedPath);
    if (!deps) return;
    for (const dep of deps) {
      notify(dep, readLiteral(ft, dep, undefined, realTime));
      notifyRefDependents(dep, visited);
    }
  }

  ws = {
    get ft() { return ft; },
    get tick() { return ticks.length; },
    get REAL_TIME() { return realTime; },
    get history() { return ticks; },
    get root() { return rootWs; },
    get base() { return baseFt; },

    patch(entries: Record<string, unknown>): PatchResult {
      const prev = ft;
      const timestamp = clock();
      realTime = timestamp;

      const applied: string[] = [];
      const conflicts: string[] = [];
      const gaps: string[] = [];

      for (const [path, value] of Object.entries(entries)) {
        if (value === undefined) {
          ft = deleteAtPath(ft, path);
          applied.push(path);
          continue;
        }

        const ftValue = valueToFieldType(value);

        // Validate: materialize existing constraints at path, check type compatibility
        try {
          const existing = path ? FieldType.typeAtPath(ft, path) : ft;
          if (existing.fieldtype !== 'any' && ftValue.fieldtype !== 'any' &&
              existing.fieldtype !== ftValue.fieldtype) {
            conflicts.push(path);
            continue;
          }
        } catch {
          // Path doesn't exist yet — valid
        }

        ft = writeAtPath(ft, path, ftValue);
        applied.push(path);
      }

      // Detect unresolved refs (gaps) at applied paths
      for (const path of applied) {
        try {
          const pathFt = path ? FieldType.typeAtPath(ft, path) : ft;
          for (const refPath of collectAllRefs(pathFt)) {
            if (readLiteral(ft, refPath) === undefined) gaps.push(refPath);
          }
        } catch { /* path removed, skip */ }
      }

      // Record tick
      ticks.push({ paths: applied, ft, prev, tick: ticks.length, timestamp });

      // Notify subscribers + ref dependents
      for (const path of applied) {
        notifyWithAncestors(path);
        notifyRefDependents(path, new Set());
      }
      notify('REAL_TIME', realTime);

      return { applied, conflicts, gaps: [...new Set(gaps)] };
    },

    write(path: string, value: unknown) {
      ws.patch({ [path]: value });
    },

    delete(path: string) {
      ws.patch({ [path]: undefined });
    },

    read(path: string): unknown {
      if (path === 'REAL_TIME') return realTime;
      return readLiteral(ft, path, undefined, realTime);
    },

    type(path: string): FieldType {
      return path ? FieldType.typeAtPath(ft, path) : ft;
    },

    entries(path?: string): string[] {
      const target = path ? FieldType.typeAtPath(ft, path) : ft;
      if (target.fieldtype !== 'object') return [];
      return find.objectProperty(target).map((p: any) => p.key);
    },

    subscribe(path: string, fn: Callback): Unsubscribe {
      if (!subs.has(path)) subs.set(path, new Set());
      subs.get(path)!.add(fn);
      return () => {
        const set = subs.get(path);
        if (set) {
          set.delete(fn);
          if (set.size === 0) subs.delete(path);
        }
      };
    },

    fork(): Workspace {
      return createWorkspace(ft, { clock, root: ws, base: ft });
    },

    merge(fork: Workspace): PatchResult {
      if (fork.root !== ws || !fork.base) {
        return { applied: [], conflicts: ['NOT_A_FORK'], gaps: [] };
      }

      const changes: Record<string, unknown> = {};

      // Find properties changed in fork vs base
      if (fork.ft.fieldtype === 'object') {
        for (const prop of find.objectProperty(fork.ft)) {
          const key = prop.key as string;
          try {
            const baseVal = FieldType.typeAtPath(fork.base, key);
            if (baseVal !== prop.value) changes[key] = prop.value;
          } catch {
            changes[key] = prop.value; // new in fork
          }
        }
      }

      // Find properties deleted in fork
      if (fork.base.fieldtype === 'object') {
        for (const prop of find.objectProperty(fork.base)) {
          const key = prop.key as string;
          try { FieldType.typeAtPath(fork.ft, key); }
          catch { changes[key] = undefined; }
        }
      }

      if (Object.keys(changes).length === 0) {
        return { applied: [], conflicts: [], gaps: [] };
      }
      return ws.patch(changes);
    },

    undo(): WorkspaceTick | undefined {
      const last = ticks.pop();
      if (!last) return undefined;
      ft = last.prev;
      for (const path of last.paths) {
        notifyWithAncestors(path);
        notifyRefDependents(path, new Set());
      }
      return last;
    },

    at(tick: number): FieldType | undefined {
      if (tick < 0) return undefined;
      if (tick < ticks.length) return ticks[tick].ft;
      if (tick === ticks.length) return ft;
      return undefined;
    },
  };

  return ws;
}
