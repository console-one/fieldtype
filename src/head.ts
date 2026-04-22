/**
 * head.ts — HEAD: explicit cursor + draft into FieldType tree.
 *
 * HEAD = Ptr refactored: no Proxy, no ['$'], no set trap.
 * Explicit write(), draft(), save(), preflight().
 * A draft IS a HEAD (same type, different lifecycle — it has a source).
 *
 * Phase 0 of ARCHITECTURAL_SYNTHESIS.md.
 */

import {
  type Chain,
  createChain,
  push,
  fork as forkChain,
  reduce,
  evaluateExpr,
  snapshot as chainSnapshot,
  diff as diffChains,
  patch as patchChain,
  collectStatements,
  chainFromFieldType,
  isExported,
  type ReduceResult,
  type BindingLens,
} from './chain.js';
import { concrete, hasRefConstraint, getRefSource, getLiteralValue, isStatementArray, type Statement, type StatementLevel, type AnnotationNode } from './statement.js';
import { FieldType } from './type.js';
import type { FieldTypeMissing, SolveResult } from './patchResolve.js';
import { patchResolve } from './patchResolve.js';
import { isBehavioralConstraint, type BehavioralConstraint } from './constraint.js';
import type { HeadInterpreter, OverlayContext } from './headInterpreter.js';
import {
  classifyValue,
  findAllBehavioralConstraints,
  getMergePolicy,
  resolveConstraint,
  parseBehavioralBindName,
} from './headInterpreter.js';
import { defaultPostMergeHandler } from './headPostMerge.js';

// ─────────────────────────────────────────────────────────────────────────────
// HeadReceiverRegistry — typed pub-sub for lifecycle dispatch
// ─────────────────────────────────────────────────────────────────────────────

export type HeadReceiverId = string & { readonly __brand: 'HeadReceiverId' };

let _headReceiverSeq = 0;

/**
 * Active write context — set by write() before evaluateExpr() so the interpret
 * dispatch function knows which HEAD is calling it. Without this, ctx.host()
 * always returns the rootHead that created the dispatch (via closure), even
 * when a draft calls write(). JS is single-threaded and dispatch is synchronous,
 * so a module-level variable is safe here.
 */
let _activeWriteState: HeadState | null = null;
const nextHeadReceiverId = (): HeadReceiverId => `hr${_headReceiverSeq++}` as HeadReceiverId;

/** Fired when a HeadState's type-level snapshot changes. */
export type HeadAdvanceEvent = {
  readonly path: readonly string[];
  readonly prevType: FieldType | null;
  readonly nextType: FieldType;
};

/** Receiver callback — returns statements to route (instrumental → source chain, rest → _derived). */
export type HeadReceiverFn = (event: HeadAdvanceEvent) => Promise<Statement[]>;

export type HeadReceiverRegistry = {
  readonly receivers: ReadonlyMap<HeadReceiverId, HeadReceiverFn>;
  add(fn: HeadReceiverFn): HeadReceiverId;
  remove(id: HeadReceiverId): void;
  dispatch(event: HeadAdvanceEvent): Promise<Statement[]>;
};

function createReceiverRegistry(): HeadReceiverRegistry {
  const receivers = new Map<HeadReceiverId, HeadReceiverFn>();
  return {
    get receivers() { return receivers as ReadonlyMap<HeadReceiverId, HeadReceiverFn>; },
    add(fn: HeadReceiverFn): HeadReceiverId {
      const id = nextHeadReceiverId();
      receivers.set(id, fn);
      return id;
    },
    remove(id: HeadReceiverId): void {
      receivers.delete(id);
    },
    async dispatch(event: HeadAdvanceEvent): Promise<Statement[]> {
      const all: Statement[] = [];
      for (const fn of receivers.values()) {
        const stmts = await fn(event);
        for (const s of stmts) all.push(s);
      }
      return all;
    },
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Types — Draft Lifecycle
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Lifecycle states for a draft HEAD:
 * - drafting: user is writing statements, gaps may or may not exist
 * - pending:  gaps exist, waiting for external resolution (receivers watching)
 * - ready:    gaps cleared, preflight passes — save() can proceed
 * - merging:  actively advancing source (serialized via rt(source).mergeLock)
 */
export type DraftLifecycle = 'drafting' | 'pending' | 'ready' | 'merging';

/**
 * Call-site scoping for draft(). Controls which parent bindings are masked
 * in the forked chain via optional ref gates — making them read-only (still
 * accessible via parent fallthrough in value()) but unshadowable and excluded
 * from save() diffs.
 */
export type DraftSpec = {
  /** Names to mask in the forked chain (caller-side blocklist). */
  readonly exclude?: readonly string[];
  /** Predicate — return true to MASK a binding. For dynamic classification. */
  readonly filter?: (name: string) => boolean;
  /** Reduce lens for the draft. If omitted, inherits parent's lens. */
  readonly lens?: BindingLens;
};

// ─────────────────────────────────────────────────────────────────────────────
// Types — RefIndex
// ─────────────────────────────────────────────────────────────────────────────

export type RefDirection = 'incoming' | 'outgoing';

export type RefEntry = {
  readonly direction: RefDirection;
  readonly path: string;
  readonly source: string;
  receiverID: HeadReceiverId | null;
};

export type RefIndex = {
  readonly entries: ReadonlyMap<string, RefEntry>;
  add(direction: RefDirection, path: string, source: string): void;
  remove(key: string): void;
  outgoing(): RefEntry[];
  incoming(): RefEntry[];
  clear(): void;
};

// ─────────────────────────────────────────────────────────────────────────────
// Types — Events + Results
// ─────────────────────────────────────────────────────────────────────────────

export type HeadEvent =
  | { type: 'write'; statement: Statement }
  | { type: 'advance'; prev: FieldType; next: FieldType }
  | { type: 'gaps-changed'; prev: readonly FieldTypeMissing[]; next: readonly FieldTypeMissing[] }
  | { type: 'pending-call'; name: string; callId: string; promise: Promise<unknown> };

export type HeadSubscriber = (event: HeadEvent) => void;

export type MergeConflict = FieldTypeMissing & {
  /** What the source currently provides at this path (the contradicting value). */
  provided?: FieldType;
};

export type PreflightResult =
  | { ok: true }
  | { ok: false; conflicts: MergeConflict[]; missing?: FieldTypeMissing[] };

export type MergeResult =
  | { ok: true }
  | { ok: false; conflicts: MergeConflict[]; missing?: FieldTypeMissing[] };

// ─────────────────────────────────────────────────────────────────────────────
// Types — Gap (request-response transition)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * A gap is a suspension point — an unresolved requirement on a HEAD.
 *
 * Gaps are the interaction surface of a HEAD read. When you read a HEAD
 * (gaps, value, entries, callables), the response includes the current state
 * AND the gaps. Each gap carries a `fill()` method — the only intended way
 * to resolve it. This is the request-response model: you read, you get back
 * the data and the affordances, you invoke an affordance, which triggers the
 * next read cycle. There are no free writes — every mutation is a response
 * to a presented gap or callable.
 */
export type Gap = FieldTypeMissing & {
  /** Fill this gap with a value. Constructs and writes the appropriate statement. */
  fill(value: unknown): void;
};

// ─────────────────────────────────────────────────────────────────────────────
// Types — HEAD (public interface)
// ─────────────────────────────────────────────────────────────────────────────

export type HEAD = {

  readonly snapshot: FieldType;
  readonly path: string;
  readonly source: HEAD | null;
  readonly lifecycle: DraftLifecycle | null;
  readonly refs: RefIndex;
  readonly rootType: FieldType;
  readonly chain: Chain;
  /** Per-HEAD reduce lens. Null = default behavior. */
  readonly lens: BindingLens | null;

  at(subpath: string): HEAD;
  draft(spec?: DraftSpec): HEAD;
  write(statement: Statement): void;
  preflight(): PreflightResult;
  save(): Promise<MergeResult>;
  /** Gaps = suspension points. Each carries fill() — the request-response transition. */
  readonly gaps: readonly Gap[];
  readonly resolved: boolean;
  /** Chain annotations — written via annotate() statements, stored in scope.meta. */
  readonly annotations: readonly { body: AnnotationNode[] }[];
  /**
   * Submit staged gap fills. Externally, the only operation on a HEAD is fork-merge.
   * gap.fill() stages to an internal draft. exec() merges it back.
   * On a draft HEAD, delegates to save(). On committed HEAD, saves the internal fill draft.
   */
  exec(): Promise<MergeResult>;
  value(name: string): unknown;
  /** All resolved binding names → values (excludes unresolved ref gates). */
  entries(): Map<string, unknown>;
  /** Callable facet — resolved bindings classified as callable by behavioral constraint. */
  callables(): Map<string, unknown>;

  /** Register a receiver that fires on state advances. Returns an ID for removal. */
  addReceiver(fn: HeadReceiverFn): HeadReceiverId;
  /** Remove a previously registered receiver. */
  removeReceiver(id: HeadReceiverId): void;

  /** Effective behavioral constraints for this node, walking ancestors to root. */
  effectiveConstraints(constrainttype?: string): BehavioralConstraint[];

  /**
   * Derived state chain — labels, classification markers computed by type rules.
   * Never persisted. Deterministic from source chain + type rules.
   * Returns null if no derived state has been computed.
   */
  readonly derived: Chain | null;

  /**
   * Subscriptions state — full HeadState managing subscriber topology.
   * Subscribe constraints write here, NOT into the source chain.
   * Durable: chain survives across save cycles; only cached reduce is invalidated.
   * Returns null if no subscriptions have fired.
   */
  readonly subscriptions: HeadState | null;

  /** Active drafts forked from this HEAD (not yet saved or disposed). */
  readonly drafts: readonly HEAD[];

  /** Create a typed directed edge from this HEAD to target HEAD. */
  addEdge(type: string, name: string, target: HEAD): void;
  /** Query outgoing edges from this HEAD, optionally filtered by type. */
  edges(type?: string): ReadonlyArray<{ type: string; name: string; target: HEAD }>;
  /** Query inbound edges to this HEAD, optionally filtered by type. */
  inbound(type?: string): ReadonlyArray<{ type: string; name: string; from: HEAD }>;
  /** BFS reachability over outgoing edges. Returns all transitively reachable HEADs (excludes self). */
  reachable(types?: string[]): HEAD[];

  subscribe(cb: HeadSubscriber): () => void;
  dispose(): void;
};

// ─────────────────────────────────────────────────────────────────────────────
// Internal State
// ─────────────────────────────────────────────────────────────────────────────

// ─────────────────────────────────────────────────────────────────────────────
// HeadEdge — uniform typed directed edge between HeadState nodes
// ─────────────────────────────────────────────────────────────────────────────

/**
 * A directed, typed edge between two HeadState nodes.
 *
 * Replaces ad-hoc structural fields (children, _subscriptions, draftLink, _drafts)
 * with a uniform topology. Edge types:
 *   'child'     — at() navigation child (was children Map)
 *   'subscribe' — behavioral subscription target (was _subscriptions)
 *   'fork'      — draft → source lineage (was draftLink.source)
 *   'label'     — label index child (was children.set('label:X', ...))
 */
export type HeadEdge = {
  readonly type: string;
  readonly name: string;
  readonly from: HeadState;
  readonly target: HeadState;
};

/** @internal */
export function addEdge(from: HeadState, type: string, name: string, target: HeadState): HeadEdge {
  const edge: HeadEdge = { type, name, from, target };
  from.edges.push(edge);
  target._inbound.add(edge);
  return edge;
}

function removeEdge(edge: HeadEdge): void {
  const idx = edge.from.edges.indexOf(edge);
  if (idx >= 0) edge.from.edges.splice(idx, 1);
  edge.target._inbound.delete(edge);
}

function edgesOfType(state: HeadState, type: string): HeadEdge[] {
  return state.edges.filter(e => e.type === type);
}

function edgeByName(state: HeadState, type: string, name: string): HeadEdge | undefined {
  return state.edges.find(e => e.type === type && e.name === name);
}

function inboundOfType(state: HeadState, type: string): HeadEdge[] {
  const result: HeadEdge[] = [];
  for (const edge of state._inbound) {
    if (edge.type === type) result.push(edge);
  }
  return result;
}

/** Is this a draft HEAD (has a fork edge to a source)? Replaces `state.draftLink !== null`. */
function isDraft(state: HeadState): boolean {
  return state.edges.some(e => e.type === 'fork');
}

/** @internal */
/** Get the source HeadState for a draft. Replaces `state.draftLink.source`. */
export function getSource(state: HeadState): HeadState | null {
  const forkEdge = state.edges.find(e => e.type === 'fork');
  return forkEdge ? forkEdge.target : null;
}

/** Get the parent HeadState for an interpreter-linked HEAD. */
function getInterpreterParent(state: HeadState): HeadState | null {
  for (const edge of state._inbound) {
    if (edge.type === 'interpreter') return edge.from;
  }
  return null;
}

/** Get all interpreter children of a HeadState. */
function getInterpreterChildren(state: HeadState): HeadState[] {
  return state.edges.filter(e => e.type === 'interpreter').map(e => e.target);
}

// ─────────────────────────────────────────────────────────────────────────────
// Interpreter Result Tagging — detect HEAD returns from interpret() dispatch
// ─────────────────────────────────────────────────────────────────────────────

const INTERPRETER_RESULT = Symbol('InterpreterResult');

type InterpreterResultTag = { [INTERPRETER_RESULT]: true; head: HEAD };

function tagInterpreterResult(head: HEAD): InterpreterResultTag {
  return { [INTERPRETER_RESULT]: true, head };
}

function isInterpreterResult(v: unknown): v is InterpreterResultTag {
  return v !== null && typeof v === 'object' && INTERPRETER_RESULT in (v as any);
}

// ─────────────────────────────────────────────────────────────────────────────
// Constraint Inheritance — tree walk from node to root
// ─────────────────────────────────────────────────────────────────────────────

/** Walk _inbound edges to find the parent HeadState (child or label edge). */
function getParentState(state: HeadState): HeadState | null {
  for (const edge of state._inbound) {
    if (edge.type === 'child' || edge.type === 'label') return edge.from;
  }
  return null;
}

/**
 * Collect effective behavioral constraints for a HeadState by walking
 * the tree from node to root. Ports VTree.effectiveConstraintsAt semantics:
 * - Behavioral constraints inherit from ancestors
 * - Non-behavioral constraints: own node only
 * - `override: 'final'` seals a constraint type for ancestors
 */

/**
 * Canonical rootType for behavioral constraint lookup.
 * state.rootType is the full behavioral source (schema + runtime additions like sinks).
 * chain.rootType is the declared schema (what chainFromFieldType was given).
 * For behavioral constraint lookup, state.rootType is authoritative.
 */
/** @internal */
export function getRootType(state: HeadState): FieldType {
  return state.rootType;
}

function effectiveConstraints(state: HeadState, constrainttype?: string): BehavioralConstraint[] {
  const result: BehavioralConstraint[] = [];
  const sealedTypes = new Set<string>();
  let current: HeadState | null = state;

  while (current) {
    const attrs = getRootType(current).attributes ?? [];
    for (const attr of attrs) {
      if (!isBehavioralConstraint(attr)) continue;
      const ct = (attr as any).constrainttype as string;
      if (constrainttype && ct !== constrainttype) continue;
      if (sealedTypes.has(ct)) continue;
      result.push(attr);
      if ((attr as any).override === 'final') sealedTypes.add(ct);
    }

    // Also check property-level constraints (nested inside 'property' attributes)
    for (const attr of attrs) {
      const valueAttrs = (attr as any)?.value?.attributes;
      if (!Array.isArray(valueAttrs)) continue;
      for (const va of valueAttrs) {
        if (!isBehavioralConstraint(va)) continue;
        const ct = (va as any).constrainttype as string;
        if (constrainttype && ct !== constrainttype) continue;
        if (sealedTypes.has(ct)) continue;
        result.push(va);
        if ((va as any).override === 'final') sealedTypes.add(ct);
      }
    }

    if (current === current.root) break; // reached root
    const parent = getParentState(current);
    if (!parent) {
      // No parent edge — jump to root as fallback
      if (current !== state.root) { current = state.root; continue; }
      break;
    }
    current = parent;
  }

  return result;
}

/**
 * Build a synthetic FieldType that merges own type with inherited behavioral
 * constraints from the tree walk. Used where resolveConstraint/getMergePolicy
 * expect a single FieldType.
 */
/** @internal */
export function effectiveRootType(state: HeadState): FieldType {
  const ownType = getRootType(state);

  // Root node — no inheritance needed
  if (state === state.root) return ownType;
  // Drafts inherit their source's rootType directly — no tree walk needed
  if (isDraft(state)) return getRootType(state.root);

  const inherited = effectiveConstraints(state);
  if (inherited.length === 0) return ownType;

  // Check if all inherited constraints already exist on own type
  const ownAttrs = (ownType.attributes ?? []) as readonly unknown[];
  const missing = inherited.filter(c => !ownAttrs.includes(c));
  if (missing.length === 0) return ownType;

  // Build synthetic type by extending with inherited constraints
  return FieldType.extend(ownType, { type: 'draftpatch', attributes: missing } as any);
}

/** @internal */
/** Get the subscription HeadState for a node. Returns null if none exists. */
export function getSubscriptions(state: HeadState): HeadState | null {
  const edge = state.edges.find(e => e.type === 'subscribe');
  return edge ? edge.target : null;
}

/** @internal */
/** Get or create the subscription HeadState for a node. */
export function getOrCreateSubscriptions(state: HeadState, chainName: string): HeadState {
  const existing = getSubscriptions(state);
  if (existing) return existing;

  const path = state.path ? `${state.path}._subscriptions` : '_subscriptions';
  const subState = mkHeadState(path, createChain(chainName), state.root, FieldType.any.create().save(), null);
  addEdge(state, 'subscribe', '', subState);
  return subState;
}

/** @internal */
/** Get a child HeadState by name. Replaces `state.children.get(name)`. */
export function getChild(state: HeadState, name: string): HeadState | undefined {
  const edge = state.edges.find(e => (e.type === 'child' || e.type === 'label') && e.name === name);
  return edge?.target;
}

/** Get all child HeadStates. Replaces `state.children.values()`. */
function getChildren(state: HeadState): HeadState[] {
  return state.edges.filter(e => e.type === 'child' || e.type === 'label').map(e => e.target);
}

/** Get all drafts forked from this HEAD. Replaces `state._drafts`. */
function getDrafts(state: HeadState): HeadState[] {
  return inboundOfType(state, 'fork').map(e => e.from);
}

// ─────────────────────────────────────────────────────────────────────────────
// Internal State
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Post-merge handler — application-level processing that fires after a draft merges.
 *
 * The HEAD primitive does pure merge mechanics: diff → filter → patch → invalidate.
 * Everything else (persist, subscribe, compact, label, solve, receiver dispatch)
 * is application-level processing installed via this handler.
 *
 * Different environments install different handlers:
 * - Production kernel: persist to disk, classify by label, subscribe to channels
 * - Test environment: assert expectations, record calls
 * - Client proxy: forward changeset to upstream server
 * - No handler (null): pure merge, no side effects
 */
export type PostMergeHandler = (ctx: PostMergeContext) => Promise<void>;

export type PostMergeContext = {
  /** The committed HEAD that received the merge. */
  source: HeadState;
  /** The draft that was merged (still available for solver results, rootType). */
  draftState: HeadState;
  /** The statements that were actually merged (after filtering). */
  filteredStatements: Statement[];
  /** The source's snapshot BEFORE the merge. */
  prevSnapshot: FieldType;
};

/** @internal */
export type HeadState = {
  path: string;
  chain: Chain;
  root: HeadState;
  /** The initial FieldType — used to look up behavioral constraints (merge policy, etc.). */
  rootType: FieldType;
  edges: HeadEdge[];
  _inbound: Set<HeadEdge>;
  _reduceResult: ReduceResult | null;
  _snapshot: FieldType | null;
  _gaps: readonly FieldTypeMissing[] | null;
  _solveResult: SolveResult | null;

  // 12 fields moved to module-level WeakMap/WeakSet (see HeadRuntime):
  // _head, _mergeLock, _callSeq, _sourceUnsub, _onMerge, _derived, disposed, _lazyInterpDone,
  // subscribers, interpreters, lens, receivers
};

// ─────────────────────────────────────────────────────────────────────────────
// Runtime Storage — implementation details stored off HeadState
//
// These are NOT cursor state. They are runtime bookkeeping: locks, counters,
// cleanup hooks, disposal flags, wrapper cache, derived cache. Previously
// these were fields on HeadState (inflating it to 24 fields). Moving them
// here keeps HeadState focused on what a cursor IS (chain + path + type +
// graph topology + reduce cache).
// ─────────────────────────────────────────────────────────────────────────────

/** @internal */
export type HeadRuntime = {
  head: HEAD | null;
  mergeLock: Promise<void> | null;
  callSeq: number;
  sourceUnsub: (() => void) | null;
  onMerge: PostMergeHandler | null;
  derived: Chain | null;
  subscribers: Set<HeadSubscriber>;
  interpreters: readonly HeadInterpreter[];
  /** Per-HEAD reduce lens. Null = default (compilationLens behavior). */
  lens: BindingLens | null;
  /** Typed receiver registry for lifecycle dispatch. */
  receivers: HeadReceiverRegistry;
};

const _rt = new WeakMap<HeadState, HeadRuntime>();
const _disposed = new WeakSet<HeadState>();
const _lazyDone = new WeakSet<HeadState>();
const _merging = new WeakSet<HeadState>();
/** Label children created by ensureLabelProjection (demand-driven, rebuilt on invalidation). */
const _lazyLabelChildren = new WeakSet<HeadState>();

/** @internal */
/** Get or create the runtime bag for a HeadState. */
export function rt(state: HeadState): HeadRuntime {
  let r = _rt.get(state);
  if (!r) {
    r = { head: null, mergeLock: null, callSeq: 0, sourceUnsub: null, onMerge: null, derived: null, subscribers: new Set(), interpreters: [], lens: null, receivers: createReceiverRegistry() };
    _rt.set(state, r);
  }
  return r;
}

// ─────────────────────────────────────────────────────────────────────────────
// RefIndex Factory
// ─────────────────────────────────────────────────────────────────────────────

export function createRefIndex(): RefIndex {
  const entries = new Map<string, RefEntry>();

  return {
    get entries() { return entries as ReadonlyMap<string, RefEntry>; },

    add(direction: RefDirection, path: string, source: string): void {
      const key = `${direction}:${path}`;
      entries.set(key, { direction, path, source, receiverID: null });
    },

    remove(key: string): void {
      entries.delete(key);
    },

    outgoing(): RefEntry[] {
      return [...entries.values()].filter(e => e.direction === 'outgoing');
    },

    incoming(): RefEntry[] {
      return [...entries.values()].filter(e => e.direction === 'incoming');
    },

    clear(): void {
      entries.clear();
    },
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Internal Helpers
// ─────────────────────────────────────────────────────────────────────────────

/** @internal */
export function getSnapshot(state: HeadState): FieldType {
  if (state._snapshot !== null) return state._snapshot;
  state._snapshot = chainSnapshot(effectiveChain(state));
  return state._snapshot;
}

function getReduceResult(state: HeadState): ReduceResult {
  if (state._reduceResult) return state._reduceResult;
  state._reduceResult = reduce(effectiveChain(state), rt(state).lens ?? undefined);
  return state._reduceResult;
}

/** @internal */
export function getSolveResult(state: HeadState): SolveResult {
  if (state._solveResult) return state._solveResult;
  const head = wrapHead(state);
  state._solveResult = patchResolve(head, { allowDefer: true });
  return state._solveResult;
}

function getGaps(state: HeadState): readonly FieldTypeMissing[] {
  if (state._gaps !== null) return state._gaps;
  ensureLazyInterpretations(state);

  // Use reduce()-based gap detection. The solver (patchResolve) is used
  // separately for behavioral constraint discovery in save(), but getGaps()
  // retains the reduce()-based approach because patchResolve conflates
  // "type surface has matching property" with "concrete value is available" —
  // which gives false negatives when the source has unresolved ref gates.
  const { scope, unresolved } = getReduceResult(state);

  // For drafts: exclude gaps that the live parent already resolves.
  const parentBindings = getParentScope(state);

  const gaps: FieldTypeMissing[] = [];

  for (const name of unresolved) {
    if (parentBindings?.get(name)?.resolved) continue;
    const binding = scope.bindings.get(name);
    if (!binding) continue;

    let source = '';
    if (binding.expr) {
      source = getRefSource(binding.expr) ?? (binding.expr.type === 'ref' && typeof binding.expr.source === 'string' ? binding.expr.source : '');
    }

    let typeName = '';
    let type: any = undefined;
    if (binding.schema) {
      typeName = binding.schema.fieldtype ?? '';
      type = binding.schema;
    } else if (binding.constraint && hasRefConstraint(binding.constraint)) {
      typeName = getRefSource(binding.constraint) ?? '';
    } else if (binding.constraint?.type === 'ref') {
      typeName = typeof binding.constraint.source === 'string'
        ? binding.constraint.source
        : '';
    }

    let defaultValue: unknown = undefined;
    if (binding.default) {
      defaultValue = binding.default.type === 'literal' ? (binding.default as any).value
        : binding.default.type === 'fieldtype' ? getLiteralValue(binding.default)
        : undefined;
    }

    gaps.push({
      key: name,
      source,
      constraint: binding.constraint,
      typeName,
      type,
      optional: binding.scope === 'optional',
      defaultValue,
    });
  }

  // Escalate interpreter children's unresolved gaps into parent.
  // If the parent (or its parent) already resolves a gap, skip it.
  for (const child of getInterpreterChildren(state)) {
    const childGaps = getGaps(child);
    for (const gap of childGaps) {
      if (scope.bindings.get(gap.key)?.resolved) continue;
      if (parentBindings?.get(gap.key)?.resolved) continue;
      // Avoid duplicate gap entries
      if (gaps.some(g => g.key === gap.key)) continue;
      gaps.push(gap);
    }
  }

  state._gaps = gaps;
  return gaps;
}

// ─────────────────────────────────────────────────────────────────────────────
// Demand-Driven Interpreter Dispatch — runs on first read, not on write
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Lazily dispatch interpreters for raw bindings on the read path.
 *
 * When a concrete binding holds a raw value (e.g., a ServicePrototype or
 * blueprint proto) that an interpreter can classify, create the interpreter
 * child HEAD on first read — same mechanism as write-side dispatch, but
 * triggered by demand rather than by the caller wrapping data in interpret().
 *
 * Bindings that already have interpreter edges (from write-side dispatch or
 * a previous lazy pass) are skipped. Results are cached via the edge graph.
 *
 * Map iteration order = chain insertion order = write order, so dependencies
 * between interpreted bindings resolve correctly (earlier bindings are
 * interpreted before later ones can read them).
 */
function ensureLazyInterpretations(state: HeadState): void {
  if (_lazyDone.has(state)) return;
  _lazyDone.add(state);

  const interpreters = rt(state.root).interpreters;
  if (interpreters.length === 0) return;

  const { scope } = getReduceResult(state);
  const head = wrapHead(state);

  for (const [name, binding] of scope.bindings) {
    if (!binding.resolved) continue;
    if (binding.value === null || binding.value === undefined) continue;
    // Only classify object values — strings, numbers, functions are not interpreter targets
    if (typeof binding.value !== 'object') continue;
    // Skip if already has an interpreter edge for this binding
    if (edgeByName(state, 'interpreter', name)) continue;
    // Skip the interpreter dispatch function itself and pending-call ref gates
    if (name === 'interpret') continue;
    if (name.startsWith('_call:')) continue;
    // Skip behavioral constraint bindings (e.g., 'apiKey:persist')
    if (parseBehavioralBindName(name)) continue;

    for (const interp of interpreters) {
      if (!classifyValue(interp.type, binding.value)) continue;

      // Build overlay context (same as write-side dispatch in createHead)
      const prevWriteState = _activeWriteState;
      _activeWriteState = state;
      const ctx: OverlayContext = {
        value: (n: string) => head.value(n),
        callables: () => head.callables(),
        entries: () => head.entries(),
        host: () => head,
      };

      const result = interp.impl(binding.value, [name], ctx);
      _activeWriteState = prevWriteState;

      // HEAD result — link as interpreter edge (same as head.ts write-side lines 1416-1436)
      // Only HEAD returns are supported for demand-driven dispatch.
      // Statement[] overlays are a legacy path — they require explicit interpret() on write.
      if (result && typeof result === 'object' && 'write' in result && 'value' in result && 'gaps' in result) {
        const interpHead = result as HEAD;
        const interpState = headToState.get(interpHead);
        if (interpState) {
          // Re-parent for live parent scope visibility
          interpState.chain = { ...interpState.chain, parent: { chain: state.chain, at: state.chain.head } };
          interpState.root = state.root;
          rt(interpState).interpreters = rt(state).interpreters;

          addEdge(state, 'interpreter', name, interpState);
          registerInterpreterGate(state, interpState);
          invalidate(interpState);
        }
      }
      break; // first matching interpreter wins
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Label Projection — demand-driven label child derivation
//
// Instead of building label indices eagerly during save() (headPostMerge Phase 2),
// label children are derived lazily on first at() access. This follows the same
// demand-driven pattern as ensureLazyInterpretations: compute on first read,
// cache via the edge graph, invalidate when the chain changes.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Resolve a subpath to a label projection if the rootType declares a matching
 * label constraint. Returns the label child HeadState if found, null otherwise.
 *
 * Handles both direct label paths ('label:toolpackage') and path aliases ('packages').
 *
 * The label child's subscriptions chain is populated by scanning the current
 * HEAD's entries against the label constraint's match type. This works on
 * committed HEADs AND drafts — no save() required.
 */
function ensureLabelProjection(state: HeadState, subpath: string): HeadState | null {
  const rootType = effectiveRootType(state);
  if (rootType.fieldtype !== 'object') return null;
  const attrs = (rootType.attributes ?? []) as any[];

  // Find all label constraints on the rootType
  let labelName: string | null = null;
  let matchType: FieldType | null = null;

  for (const attr of attrs) {
    if (!isBehavioralConstraint(attr) || attr.constrainttype !== 'label') continue;
    const ln = typeof attr.value === 'string' ? attr.value : null;
    const pa = typeof attr.path === 'string' ? attr.path : null;
    if (!ln) continue;

    // Match by direct label path or by path alias
    if (subpath === `label:${ln}` || (pa && subpath === pa)) {
      labelName = ln;
      matchType = attr.match as unknown as FieldType ?? null;
      break;
    }
  }

  if (!labelName || !matchType) return null;

  // Already created (by a prior at() call or by headPostMerge) — return existing
  const labelPath = `label:${labelName}`;
  const existingLabel = getChild(state, labelPath);
  if (existingLabel) return existingLabel;

  // Find the path alias for this label (if any)
  const pathAlias = attrs.find(
    (a: any) => isBehavioralConstraint(a) && a.constrainttype === 'label'
      && a.value === labelName && typeof a.path === 'string',
  )?.path as string | undefined;

  // Create the label child workspace
  const displayPath = pathAlias ?? labelPath;
  const fullPath = state.path ? `${state.path}.${displayPath}` : displayPath;
  const labelChild = mkHeadState(fullPath, createChain(labelPath), state.root, FieldType.any.create().save());

  // Mark as lazily derived so invalidate() can clean it up for rebuilding
  _lazyLabelChildren.add(labelChild);

  // Link label edge
  addEdge(state, 'label', labelPath, labelChild);
  // Also add path alias edge so at('packages') finds it via getChild
  if (pathAlias && !getChild(state, pathAlias)) {
    addEdge(state, 'child', pathAlias, labelChild);
  }

  // Populate: scan entries, classify each against the match type
  populateLabelChild(state, labelChild, labelPath, matchType);

  return labelChild;
}

/**
 * Scan a HEAD's entries and populate the label child's subscriptions with
 * bindings whose values match the label's match type.
 */
function populateLabelChild(
  state: HeadState,
  labelChild: HeadState,
  labelPath: string,
  matchType: FieldType,
): void {
  const head = wrapHead(state);
  const entries = head.entries();

  const labelSubState = getOrCreateSubscriptions(labelChild, `${labelPath}:subscriptions`);

  for (const [name, value] of entries) {
    if (value === undefined || value === null) continue;
    if (typeof value !== 'object') continue;
    if (classifyValue(matchType, value)) {
      labelSubState.chain = push(labelSubState.chain, {
        type: 'bind', name,
        expr: { type: 'literal', value: true },
        level: 'concrete',
      });
    }
  }
  invalidate(labelSubState);
}

/** @internal */
export function invalidate(state: HeadState): void {
  state._reduceResult = null;
  state._snapshot = null;
  state._gaps = null;
  state._solveResult = null;
  rt(state).derived = null;
  _lazyDone.delete(state);
  // Durable: only invalidate the subscription HeadState's cached reduce,
  // not the HeadState itself. The subscription chain survives across save cycles.
  const subState = getSubscriptions(state);
  if (subState) {
    subState._reduceResult = null;
    subState._snapshot = null;
    subState._gaps = null;
    subState._solveResult = null;
  }
  // Remove lazily-derived label children so they rebuild from fresh data on next at().
  // Label children created by headPostMerge (durable) are NOT in _lazyLabelChildren.
  const lazyLabels = state.edges.filter(e =>
    (e.type === 'label' || e.type === 'child') && _lazyLabelChildren.has(e.target),
  );
  for (const edge of lazyLabels) {
    removeEdge(edge);
  }
}

/**
 * For drafts: return a Chain view with live parent resolution.
 * Instead of the stale parent.chain captured at fork time, use
 * the source's current chain from the fork edge.
 *
 * For interpreter-linked HEADs: same live parent resolution via
 * the interpreter parent edge. Interpreter children see parent scope
 * through the same mechanism as drafts.
 *
 * For non-drafts / non-interpreter: return state.chain as-is.
 */
function effectiveChain(state: HeadState): Chain {
  const source = getSource(state) ?? getInterpreterParent(state);
  if (!source) return state.chain;
  const liveParent = source.chain;
  return {
    ...state.chain,
    parent: { chain: liveParent, at: liveParent.head },
  };
}

/**
 * For drafts: return names resolved in the live parent's scope.
 * Used by getGaps to exclude ref gates that the parent satisfies,
 * and by value() to fall through to parent values.
 *
 * Returns null for non-drafts (no parent to check).
 */
function getParentScope(state: HeadState): Map<string, { resolved: boolean; value?: unknown }> | null {
  const source = getSource(state);
  if (!source) return null;
  const { scope } = reduce(source.chain);
  return scope.bindings;
}

function evaluateLifecycle(state: HeadState, prevSnapshot?: FieldType | null, prevGaps?: readonly FieldTypeMissing[] | null): void {
  if (!isDraft(state)) return;
  if (_merging.has(state)) return;

  const gaps = getGaps(state);
  const wasReady = prevGaps != null && prevGaps.length === 0;
  const isReady = gaps.length === 0;

  // ── receiver dispatch on lifecycle transitions ──
  if (prevGaps != null && wasReady !== isReady && prevSnapshot) {
    const nextSnapshot = getSnapshot(state);
    const pathSegments = state.path ? state.path.split('.') : [];
    rt(state).receivers.dispatch({ path: pathSegments, nextType: nextSnapshot, prevType: prevSnapshot })
      .then(statements => {
        if (_disposed.has(state) || statements.length === 0) return;
        const scopeResult = reduce(state.chain).scope;
        for (const stmt of statements) {
          const isInstrumental = stmt.type === 'bind'
            && (stmt as any).level === 'concrete'
            && (stmt as any).name
            && scopeResult.bindings.has((stmt as any).name);
          if (isInstrumental) {
            state.chain = push(state.chain, stmt);
          } else {
            const r = rt(state);
            if (!r.derived) r.derived = createChain('derived');
            r.derived = push(r.derived, stmt);
          }
        }
        invalidate(state);
      })
      .catch(() => {});
  }

  // ── autoMerge: trigger on transition to ready ──
  if (isReady && !wasReady && hasAutoMerge(state)) {
    const head = wrapHead(state);
    Promise.resolve().then(() => {
      if (!_disposed.has(state) && getGaps(state).length === 0) {
        head.save();
      }
    });
  }
}

/**
 * Check if the root type or draft's own type declares an autoMerge behavioral constraint.
 * autoMerge can live on any property's value type in the root FieldType.
 */
function hasAutoMerge(state: HeadState): boolean {
  const attrs = getRootType(state.root).attributes ?? [];
  for (const attr of attrs) {
    if ((attr as any)?.constrainttype === 'autoMerge') return true;
    // Check property value types (behavioral constraints nest inside property values)
    const valueAttrs = (attr as any)?.value?.attributes;
    if (Array.isArray(valueAttrs)) {
      for (const va of valueAttrs) {
        if ((va as any)?.constrainttype === 'autoMerge') return true;
      }
    }
  }
  return false;
}

function notifySubscribers(state: HeadState, event: HeadEvent): void {
  for (const sub of rt(state).subscribers) {
    try { sub(event); } catch { /* subscriber errors don't break HEAD */ }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Merge Lock — serializes merges into a given HEAD
// ─────────────────────────────────────────────────────────────────────────────

async function acquireMergeLock(state: HeadState): Promise<() => void> {
  // Wait for any existing lock to release.
  // Safe from TOCTOU because JS is single-threaded between await points:
  // check-then-set is atomic within a synchronous block.
  const r = rt(state);
  while (r.mergeLock) {
    await r.mergeLock;
  }

  let resolve!: () => void;
  r.mergeLock = new Promise(res => { resolve = res; });

  return () => {
    rt(state).mergeLock = null;
    resolve();
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Ref Tracking — scan chain for ref expressions, manage receiver gates
// ─────────────────────────────────────────────────────────────────────────────


/**
 * Validate a statement against mount constraint rules.
 * Throws TypeError if the statement violates any active mount restriction.
 *
 * Mount constraints gate writes at the scope level:
 * - allow: restricts which statement types (bind, import, export, annotate) are accepted
 * - levels: restricts which bind levels (concrete, type) are accepted
 * - pattern: regex restricting which binding names are accepted
 */
function validateMount(statement: Statement, mount: Record<string, unknown>): void {
  const reason = mount.reason as string | undefined;

  // Check allowed statement types
  if (mount.allow) {
    const allow = mount.allow as readonly string[];
    if (!allow.includes(statement.type)) {
      throw new TypeError(
        reason ?? `Mount constraint rejects statement type '${statement.type}' (allowed: ${allow.join(', ')})`,
      );
    }
  }

  // Check allowed bind levels
  if (mount.levels && statement.type === 'bind') {
    const levels = mount.levels as readonly string[];
    const stmtLevel = (statement as any).level ?? 'concrete';
    if (!levels.includes(stmtLevel)) {
      throw new TypeError(
        reason ?? `Mount constraint rejects bind level '${stmtLevel}' (allowed: ${levels.join(', ')})`,
      );
    }
  }

  // Check binding name pattern
  if (mount.pattern && statement.type === 'bind' && (statement as any).name) {
    const re = new RegExp(mount.pattern as string);
    if (!re.test((statement as any).name)) {
      throw new TypeError(
        reason ?? `Mount constraint rejects binding name '${(statement as any).name}' (pattern: ${mount.pattern})`,
      );
    }
  }
}

function registerSourceGate(state: HeadState): void {
  const source = getSource(state);
  if (!source) return;

  // Subscribe to source's advance events to re-evaluate draft.
  // When source advances, draft's snapshot/gaps may change.
  const sourceHead = wrapHead(source);
  const unsub = sourceHead.subscribe((event) => {
    if (_disposed.has(state)) return;
    if (event.type === 'advance') {
      const prevGaps = state._gaps ?? [];
      const prevSnap = isDraft(state) ? getSnapshot(state) : null;
      invalidate(state);
      evaluateLifecycle(state, prevSnap, prevGaps);
      const nextGaps = getGaps(state);
      notifySubscribers(state, { type: 'gaps-changed', prev: prevGaps, next: nextGaps });
    }
  });

  rt(state).sourceUnsub = unsub;
}

/**
 * Register observation between parent and interpreter child.
 * When parent chain advances, interpreter HEAD re-evaluates (gaps may close
 * as parent provides bindings the interpreter needs).
 */
function registerInterpreterGate(parentState: HeadState, interpState: HeadState): void {
  const parentHead = wrapHead(parentState);
  parentHead.subscribe((ev) => {
    if (_disposed.has(interpState)) return;
    if (ev.type === 'write') {
      const prevGaps = interpState._gaps;
      invalidate(interpState);
      const nextGaps = getGaps(interpState);
      if (prevGaps !== nextGaps) {
        // Parent gaps may have changed (interpreter gap closed → parent gap list shrinks)
        invalidate(parentState);
        notifySubscribers(parentState, {
          type: 'gaps-changed',
          prev: prevGaps ?? [],
          next: getGaps(parentState),
        });
      }
    }
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Intra-HEAD Ref Resolution
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Auto-resolve refs whose source is now concrete within the same HEAD.
 * This is the general mechanism: when `bind('x', ref('_call:0'))` and
 * `_call:0` is a concrete binding in scope, push `concrete('x', value)`
 * to collapse the ref gate. Returns true if any resolutions occurred.
 */
function resolveInternalRefs(state: HeadState): boolean {
  const { scope } = getReduceResult(state);
  const toResolve: Array<[string, unknown]> = [];

  for (const [name, binding] of scope.bindings) {
    if (binding.resolved) continue;
    if (!binding.expr) continue;
    const refSource = getRefSource(binding.expr);
    if (!refSource) continue;
    const sourceBinding = scope.bindings.get(refSource);
    if (sourceBinding?.resolved && sourceBinding.value !== undefined) {
      toResolve.push([name, sourceBinding.value]);
    }
  }

  if (toResolve.length === 0) return false;
  for (const [name, value] of toResolve) {
    state.chain = push(state.chain, concrete(name, { type: 'literal', value }));
  }
  invalidate(state);
  return true;
}

// ─────────────────────────────────────────────────────────────────────────────
// HeadState Factory — canonical constructor for new HeadState nodes
// ─────────────────────────────────────────────────────────────────────────────

/** @internal */
/** Create a new HeadState with default fields. Shares root's interpreters/receivers. */
export function mkHeadState(path: string, chain: Chain, root: HeadState, rootType: FieldType, lens?: BindingLens | null): HeadState {
  const state: HeadState = {
    path,
    chain,
    root,
    rootType,
    edges: [],
    _inbound: new Set(),
    _reduceResult: null,
    _snapshot: null,
    _gaps: null,
    _solveResult: null,
  };
  // Inherit application-level handler from root
  rt(state).onMerge = rt(root).onMerge;
  rt(state).interpreters = rt(root).interpreters;
  rt(state).lens = lens !== undefined ? lens : (rt(root).lens ?? null);
  rt(state).receivers = rt(root).receivers;
  return state;
}

// ─────────────────────────────────────────────────────────────────────────────
// Public Wrapper — wraps HeadState into the HEAD interface
// ─────────────────────────────────────────────────────────────────────────────

/** Reverse lookup: HEAD public wrapper → backing HeadState. Used by addEdge(). */
const headToState = new WeakMap<HEAD, HeadState>();

/** @internal */
export function wrapHead(state: HeadState): HEAD {
  if (rt(state).head) return rt(state).head!;

  // ── Internal fill draft — fork-merge staging for gap.fill() on committed HEADs ──
  let _fillDraft: HEAD | null = null;

  const head: HEAD = {
    // ── Getters ──

    get snapshot() { return getSnapshot(state); },
    get path() { return state.path; },
    get source() { const s = getSource(state); return s ? wrapHead(s) : null; },
    get lifecycle() {
      if (!isDraft(state)) return null;
      if (_merging.has(state)) return 'merging';
      return getGaps(state).length === 0 ? 'ready' : 'pending';
    },
    get refs(): RefIndex {
      const idx = createRefIndex();
      const stmts = collectStatements(effectiveChain(state));
      for (const stmt of stmts) {
        if (stmt.type !== 'bind') continue;
        if (stmt.expr.type !== 'ref') continue;
        const refSrc = typeof stmt.expr.source === 'string' ? stmt.expr.source : undefined;
        if (!refSrc) continue;
        idx.add('outgoing', refSrc, refSrc);
      }
      return idx;
    },
    get rootType() { return getRootType(state); },
    get chain() { return state.chain; },
    get lens() { return rt(state).lens; },
    get gaps(): readonly Gap[] {
      const raw = getGaps(state);
      // Attach fill() to each gap — the request-response transition.
      // fill() stages to a draft (fork-merge model), never writes directly.
      // On a draft HEAD, the draft IS the staging area — write directly.
      // On a committed HEAD, lazily create an internal draft for staging.
      for (const g of raw) {
        if (!('fill' in g)) {
          (g as any).fill = (value: unknown) => {
            if (isDraft(state)) {
              // Draft IS the staging area — write directly, save() is the exec
              head.write(concrete(g.key, { type: 'literal', value }));
            } else {
              // Committed HEAD — stage to internal fill draft.
              // Exclude all current gaps so the draft starts with zero required gaps.
              // Fills write concrete values that diff cleanly on save().
              if (!_fillDraft) {
                const gapNames = getGaps(state).map(gap => gap.key);
                _fillDraft = head.draft({ exclude: gapNames });
              }
              _fillDraft.write(concrete(g.key, { type: 'literal', value }));
            }
          };
        }
      }
      return raw as unknown as readonly Gap[];
    },
    get resolved() { return getGaps(state).length === 0; },
    get annotations(): readonly { body: AnnotationNode[] }[] {
      const { scope } = getReduceResult(state);
      const result: { body: AnnotationNode[] }[] = [];
      for (const [key, value] of Object.entries(scope.meta)) {
        if (key.startsWith('annotate:') && Array.isArray(value)) {
          result.push({ body: value as AnnotationNode[] });
        }
      }
      return result;
    },
    get derived() { return rt(state).derived; },
    get subscriptions(): HeadState | null { return getSubscriptions(state); },
    get drafts() {
      return getDrafts(state)
        .filter(d => !_disposed.has(d))
        .map(d => wrapHead(d));
    },

    value(name: string): unknown {
      ensureLazyInterpretations(state);
      const { scope } = getReduceResult(state);
      const ownExported = isExported(scope, name);

      let raw: unknown;

      // ── Interpreter edge check (by name) ──
      // If an interpreter edge exists for this binding, prefer the interpreter
      // child's export. This handles demand-driven dispatch where the raw value
      // is still in scope but has been superseded by the interpreted result.
      const interpEdge = edgeByName(state, 'interpreter', name);
      if (interpEdge) {
        const interpVal = wrapHead(interpEdge.target).value(name);
        if (interpVal !== undefined) {
          // Apply decorator transform if present
          const decorator = resolveConstraint(effectiveRootType(state), scope, name, 'decorator');
          if (decorator) {
            const transformFn = typeof decorator.transform === 'function' ? decorator.transform : null;
            if (transformFn) return (transformFn as Function)(interpVal, head);
          }
          return interpVal;
        }
      }

      // Own scope bindings (subject to export filtering)
      if (ownExported) {
        const binding = scope.bindings.get(name);

        // Tombstone: draft explicitly deleted this binding — don't fall through to parent.
        if (binding?.deleted) return undefined;

        if (binding?.resolved) {
          raw = binding.value;
        } else if (getSource(state) && binding && !binding.resolved) {
          // For drafts: if this is an unresolved ref gate, check if the parent provides it
          const parentBindings = getParentScope(state);
          const parentBinding = parentBindings?.get(name);
          if (parentBinding?.resolved) raw = parentBinding.value;
        }

        // ── Overlay: check subscriptions and _derived ──
        // Subscriptions is a full HeadState; reduce its chain for bindings.
        // Subscriptions overlay source values; derived provides labels/classifications.
        const subState = getSubscriptions(state);
        if (raw === undefined && subState) {
          const subBinding = reduce(subState.chain).scope.bindings.get(name);
          if (subBinding?.resolved) raw = subBinding.value;
        }
        if (raw === undefined && rt(state).derived) {
          const derBinding = reduce(rt(state).derived!).scope.bindings.get(name);
          if (derBinding?.resolved) raw = derBinding.value;
        }
      }

      // ── Overlay: interpreter children's exported bindings ──
      // NOT filtered by parent's exports — interpreter children manage their own
      // exports. The child's export declarations govern visibility, not the parent's.
      if (raw === undefined) {
        for (const child of getInterpreterChildren(state)) {
          const v = wrapHead(child).value(name);
          if (v !== undefined) { raw = v; break; }
        }
      }

      if (raw === undefined) return undefined;

      // ── Decorator: transform on read ──
      const decorator = resolveConstraint(effectiveRootType(state), scope, name, 'decorator');
      if (decorator) {
        const transformFn = typeof decorator.transform === 'function' ? decorator.transform : null;
        if (transformFn) raw = (transformFn as Function)(raw, head);
      }

      return raw;
    },

    entries(): Map<string, unknown> {
      ensureLazyInterpretations(state);
      const result = new Map<string, unknown>();
      const { scope } = getReduceResult(state);
      const parentBindings = getSource(state) ? getParentScope(state) : null;

      // Layer 1: _derived chain (lowest priority — labels/classifications)
      if (rt(state).derived) {
        for (const [name, binding] of reduce(rt(state).derived!).scope.bindings) {
          if (binding.resolved && binding.value !== undefined) {
            result.set(name, binding.value);
          }
        }
      }

      // Layer 2: subscriptions HeadState (subscriber topology)
      const subState = getSubscriptions(state);
      if (subState) {
        for (const [name, binding] of reduce(subState.chain).scope.bindings) {
          if (binding.resolved && binding.value !== undefined) {
            result.set(name, binding.value);
          }
        }
      }

      // Layer 3: parent bindings (draft inherits parent)
      if (parentBindings) {
        for (const [name, binding] of parentBindings) {
          if (binding.resolved && binding.value !== undefined) {
            result.set(name, binding.value);
          }
        }
      }

      // Layer 4: own source bindings (highest priority — override everything)
      for (const [name, binding] of scope.bindings) {
        // Tombstone: draft explicitly deleted this binding — remove from result
        // even if parent or subscription layers added it.
        if (binding.deleted) {
          result.delete(name);
          continue;
        }
        if (binding.resolved && binding.value !== undefined) {
          result.set(name, binding.value);
        } else if (parentBindings?.get(name)?.resolved) {
          // Already set from parent, keep it
        }
      }

      // ── Decorator: transform each value on read ──
      for (const [name, value] of result) {
        const decorator = resolveConstraint(effectiveRootType(state), scope, name, 'decorator');
        if (decorator) {
          const transformFn = typeof decorator.transform === 'function' ? decorator.transform : null;
          if (transformFn) result.set(name, (transformFn as Function)(value, head));
        }
      }

      // ── Export filtering: if chain declares exports, only exported names are visible ──
      for (const [name] of [...result]) {
        if (!isExported(scope, name)) result.delete(name);
      }

      // ── Interpreter children's exported bindings ──
      // Added AFTER export filtering: interpreter children manage their own exports.
      // The parent's export declarations should not hide computation results from
      // linked interpreters — the child's exports flow through unconditionally.
      for (const child of getInterpreterChildren(state)) {
        const childEntries = wrapHead(child).entries();
        for (const [name, value] of childEntries) {
          result.set(name, value);
        }
      }

      // ── Visibility: filter entries by constraint ──
      // Handles BOTH per-binding constraints AND scope-synthesized constraints
      // uniformly via resolveConstraint() — scope constraints were synthesized
      // into per-binding behavioral bindings during reduce().
      for (const [name] of [...result]) {
        const vis = resolveConstraint(effectiveRootType(state), scope, name, 'visibility');
        if (vis) {
          if (!vis.scope) result.delete(name);
        }
      }

      return result;
    },

    callables(): Map<string, unknown> {
      ensureLazyInterpretations(state);
      const result = new Map<string, unknown>();
      const { scope } = getReduceResult(state);
      for (const [name, binding] of scope.bindings) {
        if (!binding.resolved || binding.value === undefined) continue;
        // Export filtering: non-exported bindings are not callable
        if (!isExported(scope, name)) continue;
        if (resolveConstraint(effectiveRootType(state), scope, name, 'callable')) {
          // Visibility applies to callables too — private-scope callables are hidden
          const vis = resolveConstraint(effectiveRootType(state), scope, name, 'visibility');
          if (vis && !vis.scope) continue;
          result.set(name, binding.value);
        }
      }
      // Merge interpreter children's callables
      for (const child of getInterpreterChildren(state)) {
        const childCallables = wrapHead(child).callables();
        for (const [name, value] of childCallables) {
          result.set(name, value);
        }
      }
      return result;
    },

    // ── receiver API ──

    addReceiver(fn: HeadReceiverFn): HeadReceiverId {
      return rt(state).receivers.add(fn);
    },

    removeReceiver(id: HeadReceiverId): void {
      rt(state).receivers.remove(id);
    },

    effectiveConstraints(constrainttype?: string): BehavioralConstraint[] {
      return effectiveConstraints(state, constrainttype);
    },

    // ── at() — lazy child navigation ──

    at(subpath: string): HEAD {
      const existing = getChild(state, subpath);
      if (existing) return wrapHead(existing);

      // Demand-driven label projection: if the rootType declares a label
      // constraint matching this subpath (by label name or path alias),
      // create and populate the label child lazily from current entries.
      // Works on committed HEADs AND drafts — no save() required.
      const labelChild = ensureLabelProjection(state, subpath);
      if (labelChild) return wrapHead(labelChild);

      // Drafts inherit source's children (structural children, path aliases).
      const source = getSource(state);
      if (source) {
        const sourceChild = getChild(source, subpath);
        if (sourceChild) return wrapHead(sourceChild);
      }
      const fullPath = state.path ? `${state.path}.${subpath}` : subpath;
      const parentSnapshot = getSnapshot(state);
      let childType: FieldType;
      try {
        childType = FieldType.typeAtPath(parentSnapshot, subpath) ?? FieldType.any.create().save();
      } catch {
        childType = FieldType.any.create().save();
      }
      const childChain = chainFromFieldType(childType);
      const childState: HeadState = mkHeadState(fullPath, childChain, state.root, childType);
      addEdge(state, 'child', subpath, childState);
      return wrapHead(childState);
    },

    // ── draft() — fork from this HEAD ──

    draft(spec?: DraftSpec): HEAD {
      let forkedChain = forkChain(state.chain);

      // ── Pass 1: Type-declared fork constraints (existing behavior) ──
      const { scope: forkScope } = getReduceResult(state);
      for (const [name] of forkScope.bindings) {
        const parsed = parseBehavioralBindName(name);
        if (!parsed || parsed.constrainttype !== 'fork') continue;
        const forkConstraint = resolveConstraint(effectiveRootType(state), forkScope, parsed.key, 'fork');
        if (!forkConstraint) continue;
        if (forkConstraint.value === 'exclude') {
          // Mask this binding in the draft — push an optional ref gate
          forkedChain = push(forkedChain, {
            type: 'bind', name: parsed.key,
            expr: { type: 'ref', source: 'any' },
            level: 'concrete',
            scope: 'optional',
          });
        }
      }

      // ── Pass 2: Call-site DraftSpec masking ──
      if (spec) {
        const excludeSet = spec.exclude ? new Set<string>(spec.exclude) : null;
        for (const [name] of forkScope.bindings) {
          // Never mask behavioral constraint declarations (e.g. 'identity:persist')
          if (parseBehavioralBindName(name)) continue;
          if ((spec.filter && spec.filter(name)) || (excludeSet && excludeSet.has(name))) {
            forkedChain = push(forkedChain, {
              type: 'bind', name,
              expr: { type: 'ref', source: 'any' },
              level: 'concrete',
              scope: 'optional',
            });
          }
        }
      }

      const draftState: HeadState = mkHeadState(state.path, forkedChain, state.root, getRootType(state), spec?.lens);

      // Fork edge: draft → source (reverse gives us "all drafts of source")
      addEdge(draftState, 'fork', '', state);

      // Evaluate gaps → may transition from drafting to pending or ready
      evaluateLifecycle(draftState);
      // Register source observation
      registerSourceGate(draftState);

      return wrapHead(draftState);
    },

    // ── write() — append statement to chain ──

    write(statement: Statement): void {
      if (_disposed.has(state)) throw new Error('HEAD is disposed');

      // ── Mount constraint check ──
      // Scope annotations may gate which statements are accepted.
      // Scope open/terminate always bypass mount checks (you must be able
      // to manage scopes within a mount-constrained region).
      if (statement.type !== 'scope') {
        const { scope } = getReduceResult(state);
        for (let i = scope.scopes.length - 1; i >= 0; i--) {
          const mount = scope.scopes[i].constraints.get('mount');
          if (mount && typeof mount === 'object') {
            validateMount(statement, mount as Record<string, unknown>);
            break; // innermost mount wins
          }
        }
      }

      const prevGaps = state._gaps;

      // ── Call expression pre-evaluation ──
      // Evaluate call expressions BEFORE they enter the chain. This ensures
      // the function is called exactly ONCE — subsequent reduce() passes
      // see either a ref gate (async) or a concrete result (sync), never
      // the raw call expression.
      if (
        statement.type === 'bind' &&
        statement.name &&
        statement.expr.type === 'call'
      ) {
        // Inject stem into interpret() calls so interpreters know the target binding name.
        // The dispatch function receives stem as its second argument.
        let exprToEval = statement.expr;
        if (typeof statement.expr.fn === 'string' && statement.expr.fn === 'interpret' && statement.name) {
          exprToEval = {
            ...statement.expr,
            args: [...statement.expr.args, { type: 'literal' as const, value: [statement.name] }],
          };
        }

        // Set active write state so interpret dispatch resolves ctx.host()
        // to the calling HEAD (this draft), not the rootHead that created dispatch.
        const prevWriteState = _activeWriteState;
        _activeWriteState = state;
        const { scope } = getReduceResult(state);
        const result = evaluateExpr(exprToEval, scope);
        _activeWriteState = prevWriteState;

        if (result.pending) {
          // Async call: write a ref gate instead of the original call.
          // The environment will settle the promise and write back the value.
          const callId = `_call:${rt(state).callSeq++}`;
          state.chain = push(state.chain, {
            type: 'bind',
            name: statement.name,
            expr: { type: 'ref', source: callId },
            level: 'concrete',
          } as Statement);
          invalidate(state);
          notifySubscribers(state, {
            type: 'pending-call',
            name: statement.name,
            callId,
            promise: result.pending,
          });
        } else if (result.concrete && isInterpreterResult(result.value)) {
          // Interpreter HEAD: link as 'interpreter' edge, don't flatten into chain.
          const interpHead = result.value.head;
          const interpState = headToState.get(interpHead);
          if (!interpState) throw new Error('Interpreter impl() returned HEAD without backing state');

          // Re-parent interpreter's chain for live parent scope visibility
          interpState.chain = { ...interpState.chain, parent: { chain: state.chain, at: state.chain.head } };
          // Share root context (interpreters, receivers)
          interpState.root = state.root;
          rt(interpState).interpreters = rt(state).interpreters;

          // Link edge: parent → interpreter child
          addEdge(state, 'interpreter', statement.name!, interpState);

          // Subscribe to parent writes so interpreter HEAD re-evaluates
          // when parent provides bindings that close interpreter gaps
          registerInterpreterGate(state, interpState);

          invalidate(state);
          invalidate(interpState);
        } else if (result.overlay && isStatementArray(result.value)) {
          // Overlay call: function returned Statement[] — expand inline.
          // Do NOT push the original call statement. Instead, write each
          // overlay statement into the chain (within the current scope).
          for (const s of result.value as Statement[]) {
            head.write(s);
          }
        } else if (result.concrete && result.value !== undefined) {
          // Sync call with concrete result: bind as literal.
          state.chain = push(state.chain, {
            type: 'bind', name: statement.name,
            expr: { type: 'literal', value: result.value },
            level: statement.level ?? 'concrete',
          } as Statement);
          invalidate(state);
        } else {
          // Non-concrete call: push original statement as-is (gap).
          state.chain = push(state.chain, statement);
          invalidate(state);
        }
      } else {
        // Non-call statement: push directly.
        state.chain = push(state.chain, statement);
        invalidate(state);
      }

      // Resolve intra-HEAD refs whose source became available
      resolveInternalRefs(state);
      // Re-evaluate lifecycle. Don't pass prevSnapshot here — write() is an
      // active mutation, and save() will fire patchType on the source. Firing
      // lifecycle dispatch from write() would consume receiver activations,
      // preventing save's patchType from triggering receivers.
      evaluateLifecycle(state, undefined, prevGaps);

      notifySubscribers(state, { type: 'write', statement });

      // Notify gaps-changed if they differ
      const nextGaps = getGaps(state);
      if (prevGaps !== nextGaps) {
        notifySubscribers(state, {
          type: 'gaps-changed',
          prev: prevGaps ?? [],
          next: nextGaps,
        });
      }
    },

    // ── preflight() — dry-run: would save() succeed? ──

    preflight(): PreflightResult {
      // Committed HEAD — nothing to merge
      const source = getSource(state);
      if (!source) return { ok: true };

      // Check for required gaps
      const gaps = getGaps(state);
      const requiredGaps = gaps.filter(g => !g.optional);
      if (requiredGaps.length > 0) {
        return { ok: false, conflicts: [], missing: [...gaps] };
      }

      // Attempt diff — if it fails, report conflict
      try {
        diffChains(source.chain, effectiveChain(state));
        return { ok: true };
      } catch {
        return { ok: false, conflicts: [], missing: [...gaps] };
      }
    },

    // ── save() — merge draft into source (async, serialized via source lock) ──

    async save(): Promise<MergeResult> {
      const source = getSource(state);
      if (!source) {
        return { ok: false, conflicts: [], missing: [] };
      }

      // Preflight check
      const pf = head.preflight();
      if (!pf.ok) return pf;

      _merging.add(state);

      const release = await acquireMergeLock(source);
      try {
        // Source may have advanced between preflight and lock acquisition.
        // effectiveChain already sees the live source.chain — just revalidate.
        invalidate(state);
        const postLockGaps = getGaps(state).filter(g => !g.optional);
        if (postLockGaps.length > 0) {
          _merging.delete(state);
          return { ok: false, conflicts: [], missing: [...getGaps(state)] };
        }

        const prevSnapshot = getSnapshot(source);

        // Diff draft against source via effectiveChain (live parent), apply changeset.
        // Filter out:
        //   1. Ref gates for names the source already resolves (draft requirements)
        //   2. Concrete binds blocked by merge('source-wins') policy
        // Type-level binds (behavioral constraint declarations) always pass through.
        const changeset = diffChains(source.chain, effectiveChain(state));
        const sourceScope = reduce(source.chain).scope;
        const rootType = effectiveRootType(state);
        const filteredStatements = changeset.statements.filter(stmt => {
          if (stmt.type !== 'bind') return true;

          // Type-level binds always pass through — they're structural declarations
          if (stmt.level === 'type') return true;

          // Nameless binds (bare expressions / splices) always pass through
          if (!stmt.name) return true;

          // Ref gates: filter if source already resolves them
          if (hasRefConstraint(stmt.expr)) {
            return !sourceScope.bindings.get(stmt.name)?.resolved;
          }

          // Concrete binds: consult merge policy when source already has a value
          const sourceBinding = sourceScope.bindings.get(stmt.name);
          if (sourceBinding?.resolved) {
            // Try rootType-based merge policy, then scope-based fallback (chain-based HEAD)
            const policy = getMergePolicy(rootType, stmt.name);
            let mergeValue = policy?.value;
            if (!mergeValue) {
              const mb = sourceScope.bindings.get(`${stmt.name}:merge`);
              if (mb?.resolved && typeof mb.value === 'object') {
                mergeValue = (mb.value as any)?.value;
              }
            }
            if (mergeValue === 'source-wins') return false;
            if (mergeValue === 'error') {
              throw new Error(`Merge conflict: '${stmt.name}' already resolved (policy: error)`);
            }
            // 'last-write' or no policy: draft's value wins (pass through)
          }

          return true;
        });
        source.chain = patchChain(source.chain, { ...changeset, statements: filteredStatements });
        invalidate(source);

        // ── Post-merge handler — application-level processing ──
        // The handler is installed on the source (or inherited from root).
        // It does: solve, persist, subscribe, compact, label, receiver dispatch.
        // Different environments install different handlers.
        // Null = pure merge, no side effects.
        const handler = rt(source).onMerge ?? rt(source.root).onMerge;
        if (handler) {
          await handler({ source, draftState: state, filteredStatements, prevSnapshot });
        }

        const nextSnapshot = getSnapshot(source);

        // Remove draft from source tracking (merged successfully)
        const forkEdge = state.edges.find(e => e.type === 'fork');
        if (forkEdge) removeEdge(forkEdge);

        // Notify source subscribers
        notifySubscribers(source, { type: 'advance', prev: prevSnapshot, next: nextSnapshot });

        return { ok: true };
      } finally {
        release();
      }
    },

    // ── exec() — submit staged gap fills via fork-merge ──

    async exec(): Promise<MergeResult> {
      if (isDraft(state)) {
        // Draft IS the staging area — exec = save
        return head.save();
      }
      if (!_fillDraft) {
        // Nothing staged
        return { ok: true };
      }
      const result = await _fillDraft.save();
      if (result.ok) {
        _fillDraft = null; // Reset for next interaction cycle
      }
      return result;
    },

    // ── edge API ──

    addEdge(edgeType: string, name: string, target: HEAD): void {
      const targetState = headToState.get(target);
      if (!targetState) throw new Error('addEdge: target HEAD has no backing state');
      addEdge(state, edgeType, name, targetState);
    },

    edges(type?: string): ReadonlyArray<{ type: string; name: string; target: HEAD }> {
      const raw = type != null ? edgesOfType(state, type) : state.edges;
      return raw.map(e => ({ type: e.type, name: e.name, target: wrapHead(e.target) }));
    },

    inbound(type?: string): ReadonlyArray<{ type: string; name: string; from: HEAD }> {
      const raw = type != null ? inboundOfType(state, type) : [...state._inbound];
      return raw.map(e => ({ type: e.type, name: e.name, from: wrapHead(e.from) }));
    },

    reachable(types?: string[]): HEAD[] {
      const visited = new Set<HeadState>();
      const queue: HeadState[] = [];
      for (const edge of state.edges) {
        if (types && !types.includes(edge.type)) continue;
        if (!visited.has(edge.target)) {
          visited.add(edge.target);
          queue.push(edge.target);
        }
      }
      while (queue.length) {
        const current = queue.shift()!;
        for (const edge of current.edges) {
          if (types && !types.includes(edge.type)) continue;
          if (!visited.has(edge.target)) {
            visited.add(edge.target);
            queue.push(edge.target);
          }
        }
      }
      return [...visited].map(s => wrapHead(s));
    },

    // ── subscribe / dispose ──

    subscribe(cb: HeadSubscriber): () => void {
      rt(state).subscribers.add(cb);
      return () => { rt(state).subscribers.delete(cb); };
    },

    dispose(): void {
      if (_disposed.has(state)) return;
      _disposed.add(state);

      // Remove fork edge (removes this draft from source's inbound tracking)
      const forkEdge = state.edges.find(e => e.type === 'fork');
      if (forkEdge) removeEdge(forkEdge);

      // Unregister source observation
      const unsub = rt(state).sourceUnsub;
      if (unsub) {
        unsub();
      }

      // Dispose children recursively (child + label edges)
      for (const child of getChildren(state)) {
        wrapHead(child).dispose();
      }
      // Remove all outgoing edges
      while (state.edges.length > 0) {
        removeEdge(state.edges[state.edges.length - 1]);
      }
      rt(state).subscribers.clear();
    },
  };

  rt(state).head = head;
  headToState.set(head, state);
  return head;
}

// ─────────────────────────────────────────────────────────────────────────────
// Public API
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Create a HEAD.
 *
 * No-arg form creates an empty HEAD (empty object type, no gaps).
 * FieldType form uses the type as initial committed state: resolved properties
 * become concrete literals, unresolved refs become gates (gaps).
 *
 * @example
 * ```ts
 * // Empty HEAD — write anything into it
 * const h = createHead();
 * const d = h.draft();
 * d.write(concrete('x', { type: 'literal', value: 42 }));
 * await d.save();
 * h.value('x') // 42
 *
 * // Typed HEAD — schema with gaps to fill
 * const h = createHead(objectType({ host: 'string', port: 'number' }));
 * h.gaps // ['host', 'port']
 * ```
 */
export type HeadOptions = {
  path?: string;
  interpreters?: HeadInterpreter[];
  lens?: BindingLens;
  /** Post-merge handler. Default: behavioral constraint processing. Null: pure merge. */
  onMerge?: PostMergeHandler | null;
};

export function createHead(): HEAD;
export function createHead(opts: HeadOptions): HEAD;
export function createHead(initialType: FieldType, path?: string): HEAD;
export function createHead(initialType: FieldType, opts?: HeadOptions): HEAD;
export function createHead(chain: Chain, opts?: HeadOptions): HEAD;
export function createHead(
  firstArg?: FieldType | HeadOptions | Chain,
  secondArg?: string | HeadOptions,
): HEAD {
  // Discriminators
  const isOpts = (v: any): v is HeadOptions =>
    v && typeof v === 'object' && !('fieldtype' in v) && !('save' in v) && !('statements' in v);
  const isChain = (v: any): v is Chain =>
    v && typeof v === 'object' && 'statements' in v && typeof v.head === 'number';

  let chain: Chain;
  let rootType: FieldType;
  let opts: string | HeadOptions | undefined;

  if (!firstArg) {
    // No-arg: empty HEAD
    const ft = FieldType.object.create().save();
    chain = chainFromFieldType(ft);
    rootType = ft;
    opts = undefined;
  } else if (isChain(firstArg)) {
    // Chain-based: system image — snapshot captures full chain state for behavioral constraints.
    // chain.rootType is the declared schema; snapshot includes runtime additions (sinks, adapters).
    chain = firstArg;
    rootType = chainSnapshot(chain);
    opts = secondArg;
  } else if (isOpts(firstArg)) {
    // HeadOptions as first arg
    const ft = FieldType.object.create().save();
    chain = chainFromFieldType(ft);
    rootType = ft;
    opts = firstArg;
  } else {
    // FieldType
    const ft = firstArg as FieldType;
    chain = chainFromFieldType(ft);
    rootType = ft;
    opts = secondArg;
  }

  const path = typeof opts === 'string' ? opts : (opts as HeadOptions)?.path ?? '';
  const interpreters = typeof opts === 'object' ? (opts as HeadOptions)?.interpreters ?? [] : [];
  const lensOpt = typeof opts === 'object' ? (opts as HeadOptions)?.lens : undefined;
  const onMergeOpt = typeof opts === 'object' ? (opts as HeadOptions)?.onMerge : undefined;

  const state: HeadState = {
    path,
    chain,
    root: null as any, // set below
    rootType,
    edges: [],
    _inbound: new Set(),

    _reduceResult: null,
    _snapshot: null,
    _gaps: null,
    _solveResult: null,
  };

  // Root is self for top-level HEAD
  state.root = state;

  // Initialize runtime bag for top-level HEAD
  const r = rt(state);
  r.onMerge = onMergeOpt !== undefined ? onMergeOpt : defaultPostMergeHandler;
  r.interpreters = interpreters;
  r.lens = lensOpt ?? null;

  // Write interpret function as a chain binding so call('interpret', [...])
  // resolves via reduce(). This is the "interpreter as chain binding" step:
  // the dispatch function lives in the chain graph alongside every other binding.
  if (interpreters.length > 0) {
    const dispatch = (value: unknown, stem?: string[]) => {
      // Build overlay context — lazy HEAD reads for self-assembly.
      // Use _activeWriteState (set by write()) so ctx.host() returns the HEAD
      // that called write(), not the HEAD that created this dispatch function.
      // This is critical for drafts: when sessionDraft.write(interpret(...)) runs,
      // ctx.host() must return sessionDraft so interpreters set their cursor to
      // the draft (which has packages), not rootHead (which is empty).
      const activeState = _activeWriteState ?? state;
      const ctx: OverlayContext = {
        value: (name: string) => wrapHead(activeState).value(name),
        callables: () => wrapHead(activeState).callables(),
        entries: () => wrapHead(activeState).entries(),
        host: () => wrapHead(activeState),
      };
      for (const interp of interpreters) {
        if (classifyValue(interp.type, value)) {
          const result = interp.impl(value, stem ?? [], ctx);
          // If impl() returned a HEAD, tag it for write() to handle as interpreter edge.
          // Duck-type: HEAD has write + value + gaps. Statement[] doesn't.
          if (result && typeof result === 'object' && 'write' in result && 'value' in result && 'gaps' in result) {
            return tagInterpreterResult(result as HEAD);
          }
          // Statement[] overlay falls through to existing isStatementArray detection
          return result;
        }
      }
      return undefined;
    };
    state.chain = push(state.chain, {
      type: 'bind',
      name: 'interpret',
      level: 'concrete' as StatementLevel,
      expr: { type: 'literal', value: dispatch },
    });
  }

  return wrapHead(state);
}

// Re-export from headPostMerge.ts so existing importers don't break
export { defaultPostMergeHandler } from './headPostMerge.js';
