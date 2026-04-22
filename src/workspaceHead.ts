/**
 * workspaceHead.ts — WorkspaceHead adapter: HEAD interface backed by Workspace.
 *
 * Migration bridge (Phase 3): consumers call HEAD methods, internals use
 * workspace patch/read/fork/merge. Statement writes are parsed into
 * workspace operations. Gaps are derived from unresolved refs in the
 * workspace's FieldType. Draft/save maps to fork/merge.
 *
 * Once all consumers migrate to workspace-native APIs, this adapter and
 * the original head.ts can both be deleted.
 */

import { FieldType, literalFromAttributes } from './type.js';
import { createWorkspace, type Workspace, type PatchResult } from './workspace.js';
import {
  ConstraintTypes,
  constraintRef,
  isConstraintRef,
  isBehavioralConstraint,
  collectConstraintRefs,
  type BehavioralConstraint,
  type CallableConstraint,
} from './constraint.js';
import { createRefIndex } from './head.js';
import type {
  HEAD,
  HeadEvent,
  HeadSubscriber,
  HeadReceiverFn,
  HeadReceiverId,
  Gap,
  DraftSpec,
  PreflightResult,
  MergeResult,
  RefIndex,
} from './head.js';
import type { Chain } from './chain.js';
import type { Statement, AnnotationNode } from './statement.js';
import type { FieldTypeMissing } from './patchResolve.js';
import * as find from './find.js';

// ─────────────────────────────────────────────────────────────────────────────
// Statement → Workspace operation translation
// ─────────────────────────────────────────────────────────────────────────────

function evaluateExprToValue(expr: any): unknown {
  if (!expr) return undefined;

  switch (expr.type) {
    case 'literal':
      return expr.value;

    case 'fieldtype': {
      // FieldType expression — reconstruct the FieldType
      const ft = FieldType.create(expr.fieldtype, expr.attributes ?? []);
      return ft;
    }

    case 'ref': {
      // Reference — store as ConstraintRef for workspace resolution
      const source = typeof expr.source === 'string' ? expr.source : undefined;
      if (source) {
        return FieldType.any.create({
          attributes: [ConstraintTypes.any.ref.create(source)],
        });
      }
      return undefined;
    }

    case 'name':
      // Name expression — treat as ref
      return FieldType.any.create({
        attributes: [ConstraintTypes.any.ref.create(expr.id)],
      });

    default:
      return expr;
  }
}

function isRefExpr(expr: any): boolean {
  if (!expr) return false;
  return expr.type === 'ref' || expr.type === 'name';
}

// ─────────────────────────────────────────────────────────────────────────────
// Gap computation from workspace FieldType
// ─────────────────────────────────────────────────────────────────────────────

function computeGaps(ws: Workspace, rootType: FieldType): FieldTypeMissing[] {
  const gaps: FieldTypeMissing[] = [];
  const ft = ws.ft;

  if (ft.fieldtype !== 'object') return gaps;

  for (const prop of find.objectProperty(ft)) {
    const key = prop.key as string;
    const valueFt = prop.value as FieldType;

    // Check if the value is a ref gate (unresolved reference)
    const refAttr = (valueFt.attributes ?? []).find(ConstraintTypes.any.ref.describes) as any;
    const isRef = !!refAttr;

    // Check if it has a literal value
    const lit = literalFromAttributes(valueFt.attributes);
    const hasLiteral = lit !== undefined && !isConstraintRef(lit);

    if (isRef && !hasLiteral) {
      // This is a gap — unresolved ref
      const source = refAttr?.source ?? '';
      const optional = !!prop.optional;

      // Get the type constraint from rootType if available
      let typeName = '';
      let type: FieldType | undefined;
      try {
        const rootProp = find.objectProperty(rootType).find((p: any) => p.key === key);
        if (rootProp) {
          type = rootProp.value as FieldType;
          typeName = type?.fieldtype ?? '';
        }
      } catch { /* no rootType prop */ }

      gaps.push({
        key,
        source,
        typeName,
        type,
        optional,
        defaultValue: prop.default,
      });
    } else if (!hasLiteral && valueFt.fieldtype !== 'object' && valueFt.fieldtype !== 'array' && valueFt.fieldtype !== 'function') {
      // Non-ref, non-literal scalar type = gap (type declaration without value)
      // But only if the rootType declares this as required
      const rootProp = find.objectProperty(rootType).find((p: any) => p.key === key);
      if (rootProp && !rootProp.optional) {
        // Check for unresolved constraint refs in the value
        const refs = collectConstraintRefs(valueFt.attributes);
        if (refs.length > 0) {
          const unresolvedRefs = refs.filter(r => ws.read(r) === undefined);
          if (unresolvedRefs.length > 0) {
            gaps.push({
              key,
              source: unresolvedRefs[0],
              typeName: valueFt.fieldtype ?? '',
              type: valueFt,
              optional: !!rootProp.optional,
              defaultValue: rootProp.default,
            });
          }
        }
      }
    }
  }

  // Also check rootType for required properties not yet in the workspace
  for (const prop of find.objectProperty(rootType)) {
    const key = prop.key as string;
    if (gaps.some(g => g.key === key)) continue;
    if (prop.optional) continue;

    // Check if workspace has this property with a concrete value
    const wsValue = ws.read(key);
    if (wsValue !== undefined) continue;

    // Check if property exists in workspace FT at all
    try {
      const wsProp = find.objectProperty(ft).find((p: any) => p.key === key);
      if (wsProp) {
        const wsFt = wsProp.value as FieldType;
        const lit = literalFromAttributes(wsFt.attributes);
        if (lit !== undefined && !isConstraintRef(lit)) continue;
      }
    } catch { /* not found */ }

    // This is a gap — required property missing from workspace
    const valueFt = prop.value as FieldType;
    gaps.push({
      key,
      source: valueFt.fieldtype ?? '',
      typeName: valueFt.fieldtype ?? '',
      type: valueFt,
      optional: false,
      defaultValue: prop.default,
    });
  }

  return gaps;
}

// ─────────────────────────────────────────────────────────────────────────────
// Receiver Registry (lightweight copy for workspace-backed HEADs)
// ─────────────────────────────────────────────────────────────────────────────

type ReceiverEntry = { id: HeadReceiverId; fn: HeadReceiverFn };

let _receiverSeq = 0;

// ─────────────────────────────────────────────────────────────────────────────
// WorkspaceHead Options
// ─────────────────────────────────────────────────────────────────────────────

export type WorkspaceHeadOptions = {
  path?: string;
  onMerge?: ((ctx: any) => Promise<void>) | null;
};

// ─────────────────────────────────────────────────────────────────────────────
// Factory
// ─────────────────────────────────────────────────────────────────────────────

export function createWorkspaceHead(
  initialType?: FieldType,
  opts?: WorkspaceHeadOptions | string,
): HEAD {
  const rootType = initialType ?? FieldType.object.create().save();
  const path = typeof opts === 'string' ? opts : opts?.path ?? '';

  // Initialize workspace from the rootType
  const ws = createWorkspace(rootType);

  return wrapWorkspace(ws, rootType, path, null, []);
}

/**
 * Create a WorkspaceHead backed by an existing Workspace.
 *
 * Used by kernel.ts to wrap the root/session workspace for backward-compat
 * consumers (headBridge, draftProjection, agentRunner). Workspace writes
 * are bridged to HEAD events so subscribers (headBridge → renderer) see changes.
 */
export function createWorkspaceHeadFromWorkspace(
  ws: Workspace,
  rootType?: FieldType,
  opts?: WorkspaceHeadOptions,
): HEAD {
  const rt = rootType ?? FieldType.object.create().save();
  const path = typeof opts === 'string' ? opts : opts?.path ?? '';
  return wrapWorkspace(ws, rt, path, null, [], true);
}

function wrapWorkspace(
  ws: Workspace,
  rootType: FieldType,
  path: string,
  sourceHead: HEAD | null,
  parentEdges: Array<{ type: string; name: string; target: HEAD }>,
  syncWorkspaceChanges = false,
): HEAD {
  let disposed = false;
  const subscribers = new Set<HeadSubscriber>();
  const receivers: ReceiverEntry[] = [];
  const children = new Map<string, HEAD>();
  const drafts: HEAD[] = [];

  // Caches — invalidated on write
  let _cachedGaps: readonly Gap[] | null = null;
  let _cachedSnapshot: FieldType | null = null;
  let _fillDraft: HEAD | null = null;

  // Track annotations written via annotate statements
  const annotations: Array<{ body: AnnotationNode[] }> = [];

  // Track exports (null = export all)
  let exportedNames: Set<string> | null = null;

  // Track deleted names (for draft semantics)
  const deletedNames = new Set<string>();

  // Flag to prevent double event firing when HEAD.write() writes to workspace
  let _headWriteInProgress = false;

  function invalidate() {
    _cachedGaps = null;
    _cachedSnapshot = null;
  }

  function notifySubscribers(event: HeadEvent) {
    for (const sub of subscribers) {
      try { sub(event); } catch { /* subscriber errors don't break HEAD */ }
    }
  }

  const head: HEAD = {
    // ── Getters ──

    get snapshot(): FieldType {
      if (_cachedSnapshot) return _cachedSnapshot;
      _cachedSnapshot = ws.ft;
      return _cachedSnapshot;
    },

    get path() { return path; },
    get source() { return sourceHead; },

    get lifecycle() {
      if (!sourceHead) return null;
      const gaps = head.gaps;
      return gaps.length === 0 ? 'ready' : 'pending';
    },

    get refs(): RefIndex {
      const idx = createRefIndex();
      // Scan workspace FT for ref constraints
      if (ws.ft.fieldtype === 'object') {
        for (const prop of find.objectProperty(ws.ft)) {
          const valueFt = prop.value as FieldType;
          const refAttr = (valueFt.attributes ?? []).find(ConstraintTypes.any.ref.describes) as any;
          if (refAttr?.source) {
            idx.add('outgoing', refAttr.source, refAttr.source);
          }
        }
      }
      return idx;
    },

    get rootType() { return rootType; },

    get chain(): Chain {
      // Migration shim: return a minimal chain-like object for consumers that read it
      // but don't deeply manipulate it. Full chain consumers should migrate to workspace.
      return { statements: [], head: 0, parent: null } as any;
    },

    get lens() { return null; },

    get gaps(): readonly Gap[] {
      if (_cachedGaps) return _cachedGaps;

      const rawGaps = computeGaps(ws, rootType);

      // Attach fill() to each gap
      for (const g of rawGaps) {
        (g as any).fill = (value: unknown) => {
          if (sourceHead) {
            // Draft — write directly
            head.write({
              type: 'bind',
              name: g.key,
              level: 'concrete',
              expr: { type: 'literal', value },
            } as Statement);
          } else {
            // Committed HEAD — stage to internal fill draft
            if (!_fillDraft) {
              const gapNames = rawGaps.map(gap => gap.key);
              _fillDraft = head.draft({ exclude: gapNames });
            }
            _fillDraft.write({
              type: 'bind',
              name: g.key,
              level: 'concrete',
              expr: { type: 'literal', value },
            } as Statement);
          }
        };
      }

      _cachedGaps = rawGaps as unknown as readonly Gap[];
      return _cachedGaps;
    },

    get resolved() { return head.gaps.length === 0; },

    get annotations() { return annotations; },

    get derived() { return null; },
    get subscriptions() { return null; },

    get drafts() {
      return drafts.filter(d => !(d as any)._disposed);
    },

    // ── value() ──

    value(name: string): unknown {
      if (deletedNames.has(name)) return undefined;

      // Check exports
      if (exportedNames && !exportedNames.has(name)) return undefined;

      const value = ws.read(name);
      if (value !== undefined) return value;

      // Draft: fall through to source
      if (sourceHead) {
        return sourceHead.value(name);
      }

      return undefined;
    },

    // ── entries() ──

    entries(): Map<string, unknown> {
      const result = new Map<string, unknown>();

      // Source entries first (if draft)
      if (sourceHead) {
        const sourceEntries = sourceHead.entries();
        for (const [k, v] of sourceEntries) {
          result.set(k, v);
        }
      }

      // Own entries (override source)
      for (const key of ws.entries()) {
        if (deletedNames.has(key)) {
          result.delete(key);
          continue;
        }
        const value = ws.read(key);
        if (value !== undefined) {
          result.set(key, value);
        }
      }

      // Filter by exports
      if (exportedNames) {
        for (const [name] of [...result]) {
          if (!exportedNames.has(name)) result.delete(name);
        }
      }

      return result;
    },

    // ── callables() ──

    callables(): Map<string, unknown> {
      const result = new Map<string, unknown>();
      const entries = head.entries();

      for (const [name, value] of entries) {
        // Check if this entry has a callable constraint in the rootType
        try {
          const propFt = find.objectProperty(rootType).find((p: any) => p.key === name);
          if (propFt) {
            const valueFt = propFt.value as FieldType;
            const hasCallable = (valueFt.attributes ?? []).some(
              (a: any) => ConstraintTypes.any.callable.describes(a)
            );
            if (hasCallable) {
              result.set(name, value);
            }
          }
        } catch { /* no constraint */ }

        // Also check if the workspace FT declares callable
        try {
          const wsPropFt = ws.type(name);
          const hasCallable = (wsPropFt.attributes ?? []).some(
            (a: any) => ConstraintTypes.any.callable.describes(a)
          );
          if (hasCallable) {
            result.set(name, value);
          }
        } catch { /* path doesn't exist */ }
      }

      return result;
    },

    // ── at() ──

    at(subpath: string): HEAD {
      const existing = children.get(subpath);
      if (existing) return existing;

      const fullPath = path ? `${path}.${subpath}` : subpath;
      let childType: FieldType;
      try {
        childType = FieldType.typeAtPath(rootType, subpath) ?? FieldType.any.create().save();
      } catch {
        childType = FieldType.any.create().save();
      }

      // Create child workspace from child type
      const childHead = createWorkspaceHead(childType, { path: fullPath });
      children.set(subpath, childHead);
      return childHead;
    },

    // ── draft() ──

    draft(spec?: DraftSpec): HEAD {
      const forkedWs = ws.fork();

      // Apply DraftSpec masking — mask excluded bindings with ref gates
      if (spec) {
        const excludeSet = spec.exclude ? new Set(spec.exclude) : null;
        for (const key of ws.entries()) {
          const shouldMask = (excludeSet && excludeSet.has(key)) ||
            (spec.filter && spec.filter(key));
          if (shouldMask) {
            // Write a ref gate to mask this binding
            forkedWs.write(key, FieldType.any.create({
              attributes: [ConstraintTypes.any.ref.create('any')],
            }));
          }
        }
      }

      const draftHead = wrapWorkspace(forkedWs, rootType, path, head, []);
      drafts.push(draftHead);
      return draftHead;
    },

    // ── write() ──

    write(statement: Statement): void {
      if (disposed) throw new Error('HEAD is disposed');

      const prevGaps = _cachedGaps;
      _headWriteInProgress = true;

      try {
      switch (statement.type) {
        case 'bind': {
          const name = (statement as any).name;
          if (!name) {
            // Nameless bind — skip (no workspace path to write)
            break;
          }

          deletedNames.delete(name);

          const value = evaluateExprToValue((statement as any).expr);
          if (value !== undefined) {
            ws.write(name, value);
          }
          break;
        }

        case 'delete': {
          const name = (statement as any).name;
          if (name) {
            ws.delete(name);
            deletedNames.add(name);
          }
          break;
        }

        case 'annotate': {
          const body = (statement as any).body;
          if (Array.isArray(body)) {
            annotations.push({ body });
          }
          break;
        }

        case 'export': {
          const names = (statement as any).names;
          if (Array.isArray(names)) {
            if (!exportedNames) exportedNames = new Set();
            for (const n of names) exportedNames.add(n);
          }
          break;
        }

        case 'scope':
        case 'import':
          // Scope and import management — not directly mapped to workspace ops
          // These are structural statements that affect reduce() semantics
          break;
      }
      } finally {
        _headWriteInProgress = false;
      }

      invalidate();

      notifySubscribers({ type: 'write', statement });

      // Notify gaps-changed if they differ
      const nextGaps = head.gaps;
      if (prevGaps !== nextGaps) {
        notifySubscribers({
          type: 'gaps-changed',
          prev: prevGaps ?? [],
          next: nextGaps,
        });
      }
    },

    // ── preflight() ──

    preflight(): PreflightResult {
      if (!sourceHead) return { ok: true };
      const gaps = head.gaps;
      const required = gaps.filter(g => !g.optional);
      if (required.length > 0) {
        return { ok: false, conflicts: [], missing: [...gaps] };
      }
      return { ok: true };
    },

    // ── save() ──

    async save(): Promise<MergeResult> {
      if (!sourceHead) {
        return { ok: false, conflicts: [], missing: [] };
      }

      const pf = head.preflight();
      if (!pf.ok) return pf;

      // The source HEAD must also be workspace-backed for merge to work.
      // Access the underlying workspace through the source head's adapter.
      const sourceWs = (sourceHead as any)._ws as Workspace | undefined;
      if (!sourceWs) {
        // Fallback: write each changed entry to source via write()
        for (const key of ws.entries()) {
          if (deletedNames.has(key)) continue;
          const value = ws.read(key);
          if (value !== undefined) {
            const baseValue = sourceHead.value(key);
            if (value !== baseValue) {
              sourceHead.write({
                type: 'bind',
                name: key,
                level: 'concrete',
                expr: { type: 'literal', value },
              } as Statement);
            }
          }
        }
        // Handle deletions
        for (const name of deletedNames) {
          sourceHead.write({ type: 'delete', name } as Statement);
        }

        const prevSnapshot = sourceHead.snapshot;
        // Notify source subscribers of advance
        return { ok: true };
      }

      // Native workspace merge
      const prevSnapshot = sourceWs.ft;
      const mergeResult = sourceWs.merge(ws);
      if (mergeResult.conflicts.length > 0 && !mergeResult.conflicts.includes('NOT_A_FORK')) {
        return { ok: false, conflicts: [], missing: [] };
      }

      // Handle deletions
      for (const name of deletedNames) {
        sourceWs.delete(name);
      }

      return { ok: true };
    },

    // ── exec() ──

    async exec(): Promise<MergeResult> {
      if (sourceHead) {
        return head.save();
      }
      if (!_fillDraft) {
        return { ok: true };
      }
      const result = await _fillDraft.save();
      if (result.ok) {
        _fillDraft = null;
      }
      return result;
    },

    // ── Receiver API ──

    addReceiver(fn: HeadReceiverFn): HeadReceiverId {
      const id = `whr${_receiverSeq++}` as HeadReceiverId;
      receivers.push({ id, fn });
      return id;
    },

    removeReceiver(id: HeadReceiverId): void {
      const idx = receivers.findIndex(r => r.id === id);
      if (idx >= 0) receivers.splice(idx, 1);
    },

    effectiveConstraints(constrainttype?: string): BehavioralConstraint[] {
      const result: BehavioralConstraint[] = [];
      const attrs = rootType.attributes ?? [];
      for (const attr of attrs) {
        if (!isBehavioralConstraint(attr)) continue;
        if (constrainttype && (attr as any).constrainttype !== constrainttype) continue;
        result.push(attr);
      }
      return result;
    },

    // ── Edge API ──

    addEdge(type: string, name: string, target: HEAD): void {
      parentEdges.push({ type, name, target });
    },

    edges(type?: string): ReadonlyArray<{ type: string; name: string; target: HEAD }> {
      const all = [
        ...parentEdges,
        ...[...children.entries()].map(([name, target]) => ({ type: 'child', name, target })),
      ];
      return type != null ? all.filter(e => e.type === type) : all;
    },

    inbound(type?: string): ReadonlyArray<{ type: string; name: string; from: HEAD }> {
      // WorkspaceHead tracks limited inbound edges
      return [];
    },

    reachable(types?: string[]): HEAD[] {
      const visited = new Set<HEAD>();
      const queue: HEAD[] = [];
      for (const edge of head.edges()) {
        if (types && !types.includes(edge.type)) continue;
        if (!visited.has(edge.target)) {
          visited.add(edge.target);
          queue.push(edge.target);
        }
      }
      while (queue.length) {
        const current = queue.shift()!;
        for (const edge of current.edges()) {
          if (types && !types.includes(edge.type)) continue;
          if (!visited.has(edge.target)) {
            visited.add(edge.target);
            queue.push(edge.target);
          }
        }
      }
      return [...visited];
    },

    // ── Subscribe / Dispose ──

    subscribe(cb: HeadSubscriber): () => void {
      subscribers.add(cb);
      return () => { subscribers.delete(cb); };
    },

    dispose(): void {
      if (disposed) return;
      disposed = true;
      (head as any)._disposed = true;

      // Dispose children
      for (const child of children.values()) {
        child.dispose();
      }
      children.clear();

      // Dispose drafts
      for (const d of drafts) {
        d.dispose();
      }
      drafts.length = 0;

      subscribers.clear();
    },
  };

  // Expose workspace for save() to access
  (head as any)._ws = ws;

  // Bridge workspace changes to HEAD events — when code writes to the workspace
  // directly (not through HEAD.write()), fire HEAD events so subscribers
  // (headBridge → renderer) see the changes.
  if (syncWorkspaceChanges) {
    ws.subscribe('*', (_value: unknown, changedPath: string) => {
      if (_headWriteInProgress || disposed) return;
      invalidate();
      notifySubscribers({
        type: 'write',
        statement: {
          type: 'bind',
          name: changedPath,
          level: 'concrete',
          expr: { type: 'literal', value: ws.read(changedPath) },
        } as Statement,
      });
    });
  }

  return head;
}
