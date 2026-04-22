/**
 * log.ts — Event log + CRDT sync for ptr.
 *
 * Every ptr mutation can be captured as a LogEntry with ordering metadata.
 * Logs can be exported as deltas, imported through type gates, and compacted
 * for compressed state transfer. Two replicas can sync by exchanging deltas.
 *
 * This is a convergent state-based CRDT with operation log: two replicas
 * importing each other's deltas converge to the same state.
 *
 * The "compressed" in compressed CRDT = chain compaction. You don't send
 * full history — you send snapshot + recent tail.
 */

import type { Chain } from './chain.js';
import type { ChainJSON } from './chain.js';
import { chainToJSON } from './chain.js';
import type { BindStatement } from './statement.js';

/** Inline of ApplyResult to avoid circular import with ptr.ts. */
type ApplyResult =
  | { applied: true }
  | { applied: false; reason: string };

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

/** A single log entry with causal ordering metadata. */
export type LogEntry = {
  /** Unique entry ID: `${replica}:${lamport}` */
  id: string;
  /** Logical clock for causal ordering. */
  lamport: number;
  /** Which replica produced this entry. */
  replica: string;
  /** Wall clock (informational, not for ordering). */
  timestamp: number;
  /** The actual mutation (Ptr only ever pushes bind statements). */
  statement: BindStatement;
};

/** Compressed snapshot for state transfer. */
export type LogSnapshot = {
  /** Compacted chain state. */
  chain: ChainJSON;
  /** Lamport at snapshot time. */
  lamport: number;
  /** Entries after compaction point. */
  tailEntries: LogEntry[];
};

/** Serialization format for PtrLog. */
export type PtrLogJSON = {
  replica: string;
  lamport: number;
  entries: LogEntry[];
};

// ─────────────────────────────────────────────────────────────────────────────
// PtrLog
// ─────────────────────────────────────────────────────────────────────────────

export class PtrLog {
  /** @internal */ _lamport: number = 0;
  private _replica: string;
  private _entries: LogEntry[] = [];
  private _entryIds: Set<string> = new Set();

  constructor(replica: string) {
    this._replica = replica;
  }

  // ── Read ────────────────────────────────────────────────────────────────

  get entries(): readonly LogEntry[] {
    return this._entries;
  }

  get lamport(): number {
    return this._lamport;
  }

  get replica(): string {
    return this._replica;
  }

  // ── Append ──────────────────────────────────────────────────────────────

  /** Append a statement to the log. Called by ptr subscriber. */
  append(statement: BindStatement): LogEntry {
    this._lamport++;
    const entry: LogEntry = {
      id: `${this._replica}:${this._lamport}`,
      lamport: this._lamport,
      replica: this._replica,
      timestamp: Date.now(),
      statement,
    };
    this._entries.push(entry);
    this._entryIds.add(entry.id);
    return entry;
  }

  // ── Delta export ────────────────────────────────────────────────────────

  /** Return entries after a marker. null = all entries. */
  since(entryId: string | null): LogEntry[] {
    if (entryId === null) return [...this._entries];

    const idx = this._entries.findIndex(e => e.id === entryId);
    if (idx === -1) return [];

    return this._entries.slice(idx + 1);
  }

  // ── Import ──────────────────────────────────────────────────────────────

  /**
   * Import external entries through the type gate.
   * Returns which entries were applied vs rejected vs duplicates.
   *
   * LWW ordering: entries sorted by lamport (tiebreak: replica ID).
   * Each calls the pusher (applyStatement) which validates against the type gate.
   */
  import(
    entries: LogEntry[],
    _typeChain: Chain,
    pusher: (stmt: BindStatement) => ApplyResult,
  ): { applied: LogEntry[]; rejected: LogEntry[]; duplicates: LogEntry[] } {
    const applied: LogEntry[] = [];
    const rejected: LogEntry[] = [];
    const duplicates: LogEntry[] = [];

    // Sort by lamport, tiebreak by replica ID
    const sorted = [...entries].sort((a, b) => {
      if (a.lamport !== b.lamport) return a.lamport - b.lamport;
      return a.replica < b.replica ? -1 : a.replica > b.replica ? 1 : 0;
    });

    for (const entry of sorted) {
      // Dedup by entry ID
      if (this._entryIds.has(entry.id)) {
        duplicates.push(entry);
        continue;
      }

      // Update lamport (Lamport clock rule: max of local and received + 1)
      if (entry.lamport > this._lamport) {
        this._lamport = entry.lamport;
      }

      // Apply through gate
      const result = pusher(entry.statement);
      if (result.applied) {
        // Record in our log
        this._entries.push(entry);
        this._entryIds.add(entry.id);
        applied.push(entry);
      } else {
        rejected.push(entry);
      }
    }

    return { applied, rejected, duplicates };
  }

  // ── Snapshot (compressed sync) ──────────────────────────────────────────

  /**
   * Compact: snapshot chain state + keep recent tail.
   * Returns serializable snapshot.
   */
  snapshot(chain: Chain, keep?: number): LogSnapshot {
    const keepCount = keep ?? 0;
    const tailStart = Math.max(0, this._entries.length - keepCount);
    const tailEntries = this._entries.slice(tailStart);

    return {
      chain: chainToJSON(chain),
      lamport: this._lamport,
      tailEntries,
    };
  }

  // ── Serialization ───────────────────────────────────────────────────────

  toJSON(): PtrLogJSON {
    return {
      replica: this._replica,
      lamport: this._lamport,
      entries: [...this._entries],
    };
  }

  static fromJSON(data: PtrLogJSON): PtrLog {
    const log = new PtrLog(data.replica);
    log._lamport = data.lamport;
    log._entries = [...data.entries];
    log._entryIds = new Set(data.entries.map(e => e.id));
    return log;
  }
}
