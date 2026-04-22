/**
 * ptr.ts — Typed proxy over Chain with version control + type gating.
 *
 * A ptr emulates a plain JavaScript object. Under the hood it maintains two
 * chains: a **type head** (gate chain — the schema) and a **value head**
 * (force chain — concrete values). Reads reduce the value chain; writes push
 * force statements. Merge validates the value head against the type head and
 * returns structured conflict data instead of throwing.
 *
 * Every write fires subscribers, enabling event logging, state snapshotting,
 * and CRDT-style sync when paired with a routing service.
 *
 * Phase 9 additions:
 *   - applyStatement() — type-gated mutation (gate validates before push)
 *   - gated proxy mode — set trap uses applyStatement() when gated: true
 *   - concreteness tracking — fires 'concrete' events on state transitions
 *
 * Phase 10 additions:
 *   - log integration — optional PtrLog auto-captures mutations
 *   - import() — apply external log entries through the type gate
 *
 * API:
 *   config.host = 'x'          // set — push force to value chain
 *   config.host                 // get — reduce value chain, extract binding
 *   config['*'] = value         // push entire value (map fields to forces)
 *   config['$'].merge()         // validate value vs type, return MergeResult
 *   config['$'].fork()          // → Chain (frozen snapshot, new write head)
 *   config['$'].subscribe(cb)   // event log hook
 *   config['$'].importEntries(entries) // CRDT delta exchange
 */

import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

import {
  type Chain,
  type Changeset,
  type CompactOptions,
  type ChainJSON,
  type Scope,
  createChain,
  push,
  fork as forkChain,
  reduce,
  snapshot,
  diff as diffChain,
  patch as patchChain,
  compact as compactChain,
  chainToJSON,
  chainFromJSON,
  chainFromFieldType,
} from './chain.js';
import { concrete, type_, export_, hasRefConstraint, getRefSource, getLiteralValue } from './statement.js';
import type { BindStatement, Expression, ExportStatement } from './statement.js';
import { FieldType } from './type.js';
import type { PtrLog, LogEntry } from './log.js';

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

/** Events emitted by a ptr on mutation. Wire these to event logs or sync. */
export type PtrEvent =
  | { type: 'push'; name: string; statement: BindStatement }
  | { type: 'assign'; statements: BindStatement[] }
  | { type: 'fork'; child: Chain }
  | { type: 'typeChange'; chain: Chain }
  | { type: 'rejected'; name: string; expected: string; actual: string }
  | { type: 'concrete'; prev: boolean; next: boolean; missing: string[]; resolved: string[] };

export type PtrSubscriber = (event: PtrEvent) => void;

export type MergeConflict = {
  name: string;
  expected: string;
  actual: string;
  message: string;
};

export type MergeResult =
  | { ok: true }
  | { ok: false; conflicts: MergeConflict[] };

/** Result of applying a statement through the type gate. */
export type ApplyResult =
  | { applied: true }
  | { applied: false; reason: string };

export type PtrJSON = {
  typeChain: ChainJSON;
  valueChain: ChainJSON;
};

/** Options for ptr creation. */
export type PtrOptions = {
  /** When true, set trap uses applyStatement() — rejects type mismatches at write time. */
  gated?: boolean;
  /** Enable logging with a replica ID. */
  log?: { replica: string };
};

/** The handle returned by config['$']. */
export type PtrHandle = {
  /** Validate value head against type head. */
  merge(): MergeResult;
  /** Update type chain then validate. */
  merge(typeChange: Chain): MergeResult;

  /** Fork the value chain — returns a Chain. Old references unaffected. */
  fork(): Chain;

  /** What's resolved and what's missing? */
  concreteness(): { concrete: boolean; missing: string[]; resolved: string[] };

  /** Import external log entries through type gate (CRDT delta exchange). */
  importEntries(entries: LogEntry[]): { applied: LogEntry[]; rejected: LogEntry[]; duplicates: LogEntry[] };

  /** Compute changeset between this ptr's value chain and another. */
  diff(other: Chain): Changeset;

  /** Apply changeset to value head. */
  patch(changeset: Changeset): void;

  /** Serialize both heads. */
  toJSON(): PtrJSON;

  /** Compact the value chain. */
  compact(opts?: CompactOptions): void;

  /** Subscribe to mutation events. Returns unsubscribe function. */
  subscribe(cb: PtrSubscriber): () => void;

  /** Raw value chain (escape hatch). */
  readonly chain: Chain;
  /** Raw type chain (escape hatch). */
  readonly typeChain: Chain;
  /** Stable identity from the value chain. */
  readonly id: string;
  /** FieldType snapshot of the type head. */
  readonly type: FieldType;
  /** Reduced scope of the value head. */
  readonly scope: Scope;
  /** Access log (if logging enabled). */
  readonly log?: PtrLog;
};

// ─────────────────────────────────────────────────────────────────────────────
// Internal State
// ─────────────────────────────────────────────────────────────────────────────

/** @internal */
type PtrState = {
  typeChain: Chain;
  valueChain: Chain;
  subscribers: Set<PtrSubscriber>;
  lastConcrete: boolean;
  options: PtrOptions;
  ptrLog?: PtrLog;
};

const PTR_STATE = Symbol('ptr_state');

const INSPECT_SYM: symbol | undefined =
  typeof Symbol !== 'undefined' && (Symbol as any).for
    ? (Symbol as any).for('nodejs.util.inspect.custom')
    : undefined;

// ─────────────────────────────────────────────────────────────────────────────
// Display
// ─────────────────────────────────────────────────────────────────────────────

function displayPtr(state: PtrState): string {
  const typeResult = reduce(state.typeChain);
  const valueResult = reduce(state.valueChain);

  const ctor = state.typeChain.constructor;
  const typeName = ctor.charAt(0).toUpperCase() + ctor.slice(1);

  const hasValues = valueResult.resolved.length > 0;

  if (!hasValues) {
    return `*Type<${typeName}>:undefined`;
  }

  const valueDisplay = formatBindings(valueResult);
  const mergeable = checkMergeable(typeResult, valueResult);

  if (!mergeable) {
    return `*UnmergeableType<${typeName}, ${valueDisplay}>`;
  }

  return `*Type<${typeName}, ${valueDisplay}>`;
}

function formatBindings(result: { scope: Scope }): string {
  const entries: string[] = [];
  for (const [name, binding] of result.scope.bindings) {
    if (binding.resolved && binding.value !== undefined) {
      entries.push(`${name}: ${JSON.stringify(binding.value)}`);
    }
  }
  if (entries.length === 0) return '{}';
  if (entries.length <= 3) return `{ ${entries.join(', ')} }`;
  return `{ ${entries.slice(0, 3).join(', ')}, ... }`;
}

// ─────────────────────────────────────────────────────────────────────────────
// Merge Validation
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Quick check — does the value head conform to the type head?
 * Used for display purposes (*Type vs *UnmergeableType).
 */
function checkMergeable(
  typeResult: { scope: Scope },
  valueResult: { scope: Scope },
): boolean {
  for (const [name, valueBinding] of valueResult.scope.bindings) {
    if (!valueBinding.resolved) continue;
    const typeBinding = typeResult.scope.bindings.get(name);
    const expectedType = typeBinding?.schema?.fieldtype ?? (typeBinding?.expr ? (getRefSource(typeBinding.expr) ?? (typeBinding.expr.type === 'ref' && typeof typeBinding.expr.source === 'string' ? typeBinding.expr.source : undefined)) : undefined);
    if (!expectedType) continue;
    if (!jsTypeMatchesFieldType(expectedType, valueBinding.value)) {
      return false;
    }
  }
  return true;
}

/**
 * Full merge validation — returns structured conflicts.
 */
function validateMerge(state: PtrState): MergeResult {
  const typeResult = reduce(state.typeChain);
  const valueResult = reduce(state.valueChain);
  const conflicts: MergeConflict[] = [];

  for (const [name, valueBinding] of valueResult.scope.bindings) {
    if (!valueBinding.resolved) continue;
    const typeBinding = typeResult.scope.bindings.get(name);
    const expectedType = typeBinding?.schema?.fieldtype ?? (typeBinding?.expr ? (getRefSource(typeBinding.expr) ?? (typeBinding.expr.type === 'ref' && typeof typeBinding.expr.source === 'string' ? typeBinding.expr.source : undefined)) : undefined);
    if (!expectedType) continue;

    if (!jsTypeMatchesFieldType(expectedType, valueBinding.value)) {
      const actualType = valueBinding.value === null ? 'null' : typeof valueBinding.value;
      conflicts.push({
        name,
        expected: expectedType,
        actual: `${actualType} (${JSON.stringify(valueBinding.value)})`,
        message: `${name}: expected ${expectedType}, got ${actualType}`,
      });
    }
  }

  if (conflicts.length > 0) return { ok: false, conflicts };
  return { ok: true };
}

/** Does a JS runtime value match a FieldType constructor name? */
function jsTypeMatchesFieldType(fieldtype: string, value: unknown): boolean {
  if (value === undefined || value === null) return true; // unset is always ok
  const jsType = typeof value;
  switch (fieldtype) {
    case 'string': return jsType === 'string';
    case 'number': return jsType === 'number';
    case 'boolean': return jsType === 'boolean';
    case 'object': return jsType === 'object' && !Array.isArray(value);
    case 'array': return Array.isArray(value);
    case 'null': return value === null;
    case 'any': return true;
    default: return true; // or, and, not, function — permissive for now
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Concreteness Tracking
// ─────────────────────────────────────────────────────────────────────────────

/** Compute concreteness and fire event if state changed. */
function checkAndFireConcreteness(state: PtrState): void {
  const typeResult = reduce(state.typeChain);
  const valueResult = reduce(state.valueChain);

  const missing: string[] = [];
  const resolved: string[] = [];

  for (const [name] of typeResult.scope.bindings) {
    const valueBinding = valueResult.scope.bindings.get(name);
    if (valueBinding?.resolved) {
      resolved.push(name);
    } else {
      missing.push(name);
    }
  }

  const next = missing.length === 0;
  const prev = state.lastConcrete;

  if (next !== prev) {
    state.lastConcrete = next;
    notify(state, { type: 'concrete', prev, next, missing, resolved });
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Type-Gated Apply
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Apply a statement through the type gate.
 * 1. Reduce type chain, get binding for stmt.name
 * 2. Extract expectedType (from schema.fieldtype or ref source)
 * 3. If gate exists and value doesn't match → reject, fire 'rejected' event
 * 4. If gate passes or no gate → push to value chain, fire 'push' event
 * 5. Check concreteness before/after → if transition, fire 'concrete' event
 */
function applyStatementImpl(state: PtrState, stmt: BindStatement): ApplyResult {
  if (!stmt.name) return { applied: false, reason: 'nameless bind — no type gate' };
  const typeResult = reduce(state.typeChain);
  const typeBinding = typeResult.scope.bindings.get(stmt.name);
  const expectedType = typeBinding?.schema?.fieldtype ?? (typeBinding?.expr ? (getRefSource(typeBinding.expr) ?? (typeBinding.expr.type === 'ref' && typeof typeBinding.expr.source === 'string' ? typeBinding.expr.source : undefined)) : undefined);

  // If there's a type gate, validate
  if (expectedType) {
    const value = stmt.expr.type === 'literal' ? stmt.expr.value
      : stmt.expr.type === 'fieldtype' ? getLiteralValue(stmt.expr)
      : undefined;
    if (!jsTypeMatchesFieldType(expectedType, value)) {
      const actualType = value === null ? 'null' : typeof value;
      notify(state, { type: 'rejected', name: stmt.name, expected: expectedType, actual: actualType });
      return { applied: false, reason: `${stmt.name}: expected ${expectedType}, got ${actualType}` };
    }
  }

  // Gate passed or no gate — push
  state.valueChain = push(state.valueChain, stmt);
  notify(state, { type: 'push', name: stmt.name, statement: stmt });

  // Log if enabled
  if (state.ptrLog) {
    state.ptrLog.append(stmt);
  }

  // Check concreteness transition
  checkAndFireConcreteness(state);

  return { applied: true };
}

// ─────────────────────────────────────────────────────────────────────────────
// Notifications
// ─────────────────────────────────────────────────────────────────────────────

function notify(state: PtrState, event: PtrEvent): void {
  for (const sub of state.subscribers) {
    try { sub(event); } catch { /* subscriber errors don't break the ptr */ }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Expression Detection
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Detect chain expression objects (ref, call, name, intersect).
 * These are type-level declarations — NOT concrete literals.
 * Literal and object expressions are excluded: plain values go through
 * the concrete path as before.
 */
function isChainExpression(v: unknown): v is Expression {
  if (!v || typeof v !== 'object') return false;
  const t = (v as any).type;
  return t === 'ref' || t === 'call' || t === 'name' || t === 'intersect';
}

// ─────────────────────────────────────────────────────────────────────────────
// Push Entire Value (['*'] = value)
// ─────────────────────────────────────────────────────────────────────────────

function pushEntireValue(state: PtrState, value: unknown): void {
  if (value === null || value === undefined) return;

  const statements: BindStatement[] = [];

  if (typeof value === 'object' && !Array.isArray(value)) {
    // Object — map each field to a force statement
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      const stmt = concrete(k, { type: 'literal', value: v });
      state.valueChain = push(state.valueChain, stmt);
      statements.push(stmt);
    }
  } else {
    // Primitive or array — push as __value__ binding
    const stmt = concrete('__value__', { type: 'literal', value });
    state.valueChain = push(state.valueChain, stmt);
    statements.push(stmt);
  }

  // Log if enabled
  if (state.ptrLog) {
    for (const stmt of statements) {
      state.ptrLog.append(stmt);
    }
  }

  notify(state, { type: 'assign', statements });
  checkAndFireConcreteness(state);
}

// ─────────────────────────────────────────────────────────────────────────────
// Handle ($)
// ─────────────────────────────────────────────────────────────────────────────

function createHandle(state: PtrState): PtrHandle {
  const handle: PtrHandle = {
    merge(typeChange?: Chain): MergeResult {
      if (typeChange) {
        state.typeChain = typeChange;
        notify(state, { type: 'typeChange', chain: typeChange });
      }
      return validateMerge(state);
    },

    fork(): Chain {
      const child = forkChain(state.valueChain);
      notify(state, { type: 'fork', child });
      return child;
    },

    concreteness() {
      const typeResult = reduce(state.typeChain);
      const valueResult = reduce(state.valueChain);

      const missing: string[] = [];
      const resolved: string[] = [];

      for (const [name] of typeResult.scope.bindings) {
        const valueBinding = valueResult.scope.bindings.get(name);
        if (valueBinding?.resolved) {
          resolved.push(name);
        } else {
          missing.push(name);
        }
      }

      return { concrete: missing.length === 0, missing, resolved };
    },

    importEntries(entries: LogEntry[]): { applied: LogEntry[]; rejected: LogEntry[]; duplicates: LogEntry[] } {
      if (!state.ptrLog) {
        // No log — still apply through gate, but no dedup
        const applied: LogEntry[] = [];
        const rejected: LogEntry[] = [];
        for (const entry of entries) {
          const result = applyStatementImpl(state, entry.statement);
          if (result.applied) {
            applied.push(entry);
          } else {
            rejected.push(entry);
          }
        }
        return { applied, rejected, duplicates: [] };
      }

      return state.ptrLog.import(
        entries,
        state.typeChain,
        (stmt) => applyStatementImpl(state, stmt),
      );
    },

    diff(other: Chain): Changeset {
      return diffChain(state.valueChain, other);
    },

    patch(changeset: Changeset): void {
      state.valueChain = patchChain(state.valueChain, changeset);
    },

    toJSON(): PtrJSON {
      return {
        typeChain: chainToJSON(state.typeChain),
        valueChain: chainToJSON(state.valueChain),
      };
    },

    compact(opts?: CompactOptions): void {
      state.valueChain = compactChain(state.valueChain, opts);
    },

    subscribe(cb: PtrSubscriber): () => void {
      state.subscribers.add(cb);
      return () => { state.subscribers.delete(cb); };
    },

    get chain() { return state.valueChain; },
    get typeChain() { return state.typeChain; },
    get id() { return state.valueChain.id; },
    get type() { return snapshot(state.typeChain); },
    get scope() { return reduce(state.valueChain).scope; },
    get log() { return state.ptrLog; },
  };

  return handle;
}

// ─────────────────────────────────────────────────────────────────────────────
// Factory
// ─────────────────────────────────────────────────────────────────────────────

function createProxy(state: PtrState): Ptr {
  return new Proxy({} as any, {
    get(_target, prop) {
      // Internal state access
      if (prop === PTR_STATE) return state;

      // Handle
      if (prop === '$') return createHandle(state);

      // Display
      if (prop === Symbol.toPrimitive) return () => displayPtr(state);
      if (INSPECT_SYM && prop === INSPECT_SYM) return () => displayPtr(state);
      if (prop === 'toString') return () => displayPtr(state);
      if (prop === 'toJSON') return () => createHandle(state).toJSON();

      // Value read — reduce and extract
      const name = prop as string;
      const { scope } = reduce(state.valueChain);
      const binding = scope.bindings.get(name);

      if (!binding || !binding.resolved) return undefined;
      return binding.value;
    },

    set(_target, prop, value) {
      // ['*'] = push entire value
      if (prop === '*') {
        pushEntireValue(state, value);
        return true;
      }

      // Export shorthand: ptr['export'] = ['name1', 'name2'] or '*'
      if (prop === 'export') {
        const exportStmt = export_(value as string[] | '*');
        state.valueChain = push(state.valueChain, exportStmt);
        return true;
      }

      const name = prop as string;

      // Expression values (ref, call, name, intersect) → type-level bind.
      // Only plain JS values become concrete literals.
      const stmt: BindStatement = isChainExpression(value)
        ? type_(name, value as Expression)
        : concrete(name, { type: 'literal', value });

      // Gated mode: validate via applyStatement
      if (state.options.gated) {
        const result = applyStatementImpl(state, stmt);
        return result.applied;
      }

      // Non-gated: push directly
      state.valueChain = push(state.valueChain, stmt);
      notify(state, { type: 'push', name, statement: stmt });

      // Log if enabled
      if (state.ptrLog) {
        state.ptrLog.append(stmt);
      }

      // Check concreteness
      checkAndFireConcreteness(state);

      return true;
    },

    has(_target, prop) {
      if (prop === PTR_STATE || prop === '$' || prop === '*') return true;
      const { scope } = reduce(state.valueChain);
      return scope.bindings.has(prop as string);
    },

    ownKeys() {
      // Return all type-declared keys (the shape) plus any value-only keys
      const typeKeys = new Set<string>();
      const typeResult = reduce(state.typeChain);
      for (const name of typeResult.scope.bindings.keys()) typeKeys.add(name);

      const valueResult = reduce(state.valueChain);
      for (const name of valueResult.scope.bindings.keys()) typeKeys.add(name);

      return [...typeKeys];
    },

    getOwnPropertyDescriptor(_target, prop) {
      if (typeof prop === 'symbol') return undefined;

      const typeResult = reduce(state.typeChain);
      const valueResult = reduce(state.valueChain);

      if (typeResult.scope.bindings.has(prop) || valueResult.scope.bindings.has(prop)) {
        return { configurable: true, enumerable: true, writable: true };
      }
      return undefined;
    },
  }) as Ptr;
}

/** Detect whether a value is a ptr. */
export function isPtr(value: unknown): value is Ptr {
  return !!value && typeof value === 'object' && PTR_STATE in (value as any);
}

// ─────────────────────────────────────────────────────────────────────────────
// Property Extraction
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Extract a property's FieldType from an object FieldType.
 * Returns null if the type isn't an object or the property doesn't exist.
 */
function extractPropertyType(ft: FieldType, key: string): FieldType | null {
  if (ft.fieldtype !== 'object') return null;
  for (const attr of ft.attributes ?? []) {
    if (
      (attr as any).type === 'typeconstraint' &&
      (attr as any).constrainttype === 'property' &&
      (attr as any).basetype === 'object' &&
      (attr as any).key === key
    ) {
      return (attr as any).value as FieldType;
    }
  }
  return null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Public API
// ─────────────────────────────────────────────────────────────────────────────

export type Ptr = {
  [key: string]: any;
  readonly ['$']: PtrHandle;
};

/**
 * Create a ptr from a FieldType (schema) or a Chain (raw).
 *
 * From FieldType: type properties become the type head (gates),
 * value head starts empty.
 *
 * From Chain: used as the value head, type head empty.
 *
 * With address: extract the property FieldType at `address` from an object
 * type, creating a sub-Ptr whose type surface IS the addressed property.
 * All pushes inherit the type constraint of the addressed property.
 *
 *   const sub = ptr(types.object({ b: types.string() }), 'b', { gated: true });
 *   sub.value = 'hello';  // accepted — string matches b's type
 *   sub.value = 42;       // rejected — number doesn't match string gate
 */
export function ptr(
  source: FieldType | Chain,
  optionsOrAddress?: PtrOptions | string,
  maybeOptions?: PtrOptions,
): Ptr {
  // ── Parse overloads: ptr(src, opts?) or ptr(src, address, opts?) ──
  let address: string | undefined;
  let options: PtrOptions | undefined;

  if (typeof optionsOrAddress === 'string') {
    address = optionsOrAddress;
    options = maybeOptions;
  } else {
    options = optionsOrAddress;
  }

  // ── Sub-addressing: ptr(fieldType, 'propertyName') ──
  // Extract the property's FieldType and create a Ptr over it.
  // The sub-Ptr's type chain IS the property's type, so concreteness
  // and gating are scoped to the addressed range.
  if (address && isFieldType(source)) {
    const subType = extractPropertyType(source, address);
    if (!subType) {
      throw new Error(`ptr: property '${address}' not found on type '${source.fieldtype}'`);
    }
    return ptr(subType, options);
  }

  let typeChain: Chain;
  let valueChain: Chain;

  if (isFieldType(source)) {
    typeChain = chainFromFieldType(source);
    valueChain = createChain(source.fieldtype);
  } else {
    // Chain — use as value chain
    valueChain = source as Chain;
    typeChain = createChain(valueChain.constructor);
  }

  const state: PtrState = {
    typeChain,
    valueChain,
    subscribers: new Set(),
    lastConcrete: false,
    options: options ?? {},
  };

  // Initialize log if requested
  if (options?.log) {
    // Lazy import to avoid circular — PtrLog is lightweight
    const { PtrLog: PtrLogClass } = require('./log');
    state.ptrLog = new PtrLogClass(options.log.replica);
  }

  return createProxy(state);
}

/** Restore a ptr from serialized JSON. */
ptr.fromJSON = function fromJSON(data: PtrJSON, options?: PtrOptions): Ptr {
  const typeChain = chainFromJSON(data.typeChain);
  const valueChain = chainFromJSON(data.valueChain);

  const state: PtrState = {
    typeChain,
    valueChain,
    subscribers: new Set(),
    lastConcrete: false,
    options: options ?? {},
  };

  if (options?.log) {
    const { PtrLog: PtrLogClass } = require('./log');
    state.ptrLog = new PtrLogClass(options.log.replica);
  }

  return createProxy(state);
};

/** Wrap an existing chain pair as a ptr. */
ptr.fromChains = function fromChains(typeChain: Chain, valueChain: Chain, options?: PtrOptions): Ptr {
  const state: PtrState = {
    typeChain,
    valueChain,
    subscribers: new Set(),
    lastConcrete: false,
    options: options ?? {},
  };

  if (options?.log) {
    const { PtrLog: PtrLogClass } = require('./log');
    state.ptrLog = new PtrLogClass(options.log.replica);
  }

  return createProxy(state);
};

/** Restore a ptr from a log snapshot. */
ptr.fromSnapshot = function fromSnapshot(
  snapshotData: import('./log.js').LogSnapshot,
  typeSource: FieldType | Chain,
  options?: PtrOptions,
): Ptr {
  const { chainFromJSON: fromJSON } = require('./chain');
  let valueChain = fromJSON(snapshotData.chain);

  // Replay tail entries
  for (const entry of snapshotData.tailEntries) {
    valueChain = push(valueChain, entry.statement);
  }

  let typeChain: Chain;
  if (isFieldType(typeSource)) {
    typeChain = chainFromFieldType(typeSource);
  } else {
    typeChain = typeSource as Chain;
  }

  const state: PtrState = {
    typeChain,
    valueChain,
    subscribers: new Set(),
    lastConcrete: false,
    options: options ?? {},
  };

  if (options?.log) {
    const { PtrLog: PtrLogClass } = require('./log');
    state.ptrLog = new PtrLogClass(options.log.replica);
    // Set lamport to snapshot level
    (state.ptrLog as any)._lamport = snapshotData.lamport;
    // Re-add tail entries to the log
    for (const entry of snapshotData.tailEntries) {
      state.ptrLog.append(entry.statement);
    }
  }

  return createProxy(state);
};

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

function isFieldType(x: unknown): x is FieldType {
  return (
    !!x &&
    typeof x === 'object' &&
    (x as any).type === 'baseType' &&
    typeof (x as any).fieldtype === 'string'
  );
}


// ─────────────────────────────────────────────────────────────────────────────
// Namespace Projection
// ─────────────────────────────────────────────────────────────────────────────

/** Result of projecting a namespace sub-Ptr from a parent. */
export type ProjectedPtr = {
  /** The namespace-scoped Ptr. Keys are prefix-stripped. */
  ptr: Ptr;
  /** Stop syncing with the parent. After dispose, the sub-Ptr is inert. */
  dispose: () => void;
};

/**
 * Project a namespace sub-Ptr from a parent Ptr.
 *
 * The returned Ptr reflects only the keys matching `prefix`, with the prefix
 * stripped. Pushes propagate bidirectionally — parent namespace changes flow
 * to the sub-Ptr, and sub-Ptr writes flow to the parent.
 *
 * This is the flat-namespace equivalent of ptr(fieldType, address):
 *   ptr(type, 'b')                  → static sub-Ptr at property 'b'
 *   ptr.project(env, 'connection:') → live sub-Ptr at namespace 'connection:'
 *
 * Both create a Ptr over a coherently addressable subset of a type.
 *
 *   const { ptr: conns, dispose } = ptr.project(env, 'connection:');
 *   conns['github']               // reads env['connection:github']
 *   conns['github'] = pkg         // writes env['connection:github'] = pkg
 *   conns['$'].subscribe(cb)      // fires only for connection:* changes
 */
ptr.project = function project(
  source: Ptr,
  prefix: string,
  options?: PtrOptions,
): ProjectedPtr {
  // ── Snapshot parent namespace ──
  const parentScope = source['$'].scope;
  let valueChain = createChain(`ns:${prefix}`);

  for (const [name, binding] of parentScope.bindings) {
    if (!name.startsWith(prefix)) continue;
    const stripped = name.slice(prefix.length);
    if (!stripped) continue;
    if (binding.resolved && binding.value !== undefined) {
      valueChain = push(valueChain, concrete(stripped, { type: 'literal', value: binding.value }));
    }
  }

  const sub = ptr.fromChains(createChain(`ns:${prefix}`), valueChain, options);

  // ── Bidirectional sync ──
  // A syncing flag prevents propagation loops (parent→sub→parent→...).
  let syncing = false;

  // Parent → Sub: namespace pushes propagate down (prefix stripped)
  const unsubParent = source['$'].subscribe((event: PtrEvent) => {
    if (syncing) return;

    if (event.type === 'push' && event.name.startsWith(prefix)) {
      const stripped = event.name.slice(prefix.length);
      if (!stripped) return;
      syncing = true;
      try { sub[stripped] = source[event.name]; }
      finally { syncing = false; }
    }

    if (event.type === 'assign') {
      syncing = true;
      try {
        for (const stmt of event.statements) {
          if (!stmt.name) continue;
          if (stmt.name.startsWith(prefix)) {
            const stripped = stmt.name.slice(prefix.length);
            if (!stripped) continue;
            sub[stripped] = source[stmt.name];
          }
        }
      } finally { syncing = false; }
    }
  });

  // Sub → Parent: pushes propagate up (prefix re-added)
  const unsubSub = sub['$'].subscribe((event: PtrEvent) => {
    if (syncing) return;

    if (event.type === 'push') {
      syncing = true;
      try { source[prefix + event.name] = sub[event.name]; }
      finally { syncing = false; }
    }

    if (event.type === 'assign') {
      syncing = true;
      try {
        for (const stmt of event.statements) {
          if (stmt.name) source[prefix + stmt.name] = sub[stmt.name];
        }
      } finally { syncing = false; }
    }
  });

  return {
    ptr: sub,
    dispose() { unsubParent(); unsubSub(); },
  };
};
