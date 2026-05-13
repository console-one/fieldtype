import type { FieldType } from "./type.js";

export interface CompletionGap {
  path: string;
  type: FieldType;
}

export interface CompletionState {
  type: FieldType;
  bindings: Record<string, unknown>;
  cursor: string | null;
  history: Array<{ path: string; value: unknown }>;
}

export interface SerializedCompletionState {
  bindings: Record<string, unknown>;
  history: Array<{ path: string; value: unknown }>;
}

export interface IdentityConstraint {
  basetype?: "function";
  constrainttype: "identity";
  outputPath: string;
  inputPath: string;
  reason?: string;
}

export interface PreservesConstraint {
  basetype?: "function";
  constrainttype: "preserves";
  inputPath: string;
  outputPath?: string;
  reason?: string;
}

export interface ImplConstraint {
  basetype?: "function";
  constrainttype: "impl";
  id: string;
  reason?: string;
}

export interface CompletionTemporalConstraint {
  basetype?: "function";
  constrainttype: "temporal";
  dir: "gt" | "lt";
  lhs: string;
  bound: unknown;
  reason?: string;
}

export interface PropagateResult {
  bindings: Record<string, unknown>;
  conflicts: Array<{
    edge: { outputPath: string; inputPath: string };
    inputValue: unknown;
    outputValue: unknown;
  }>;
}

const attrs = (ft: FieldType | undefined): Array<Record<string, unknown>> =>
  ((ft as unknown as { attributes?: unknown[] })?.attributes ?? []) as Array<
    Record<string, unknown>
  >;

const kindOf = (ft: FieldType | undefined): string | undefined =>
  (ft as unknown as { fieldtype?: string })?.fieldtype;

const readMeta = (ft: FieldType | undefined): Record<string, unknown> =>
  (ft as unknown as { metadata?: Record<string, unknown> })?.metadata ?? {};

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

const isFnConstraint = (
  c: Record<string, unknown>,
  constrainttype: string,
): boolean =>
  c.constrainttype === constrainttype &&
  (c.basetype === undefined || c.basetype === "function");

export function inputOf(fnType: FieldType): FieldType | undefined {
  return attrs(fnType).find((a) => a.constrainttype === "param")?.value as
    | FieldType
    | undefined;
}

export function outputOf(fnType: FieldType): FieldType | undefined {
  return attrs(fnType).find((a) => a.constrainttype === "returns")?.value as
    | FieldType
    | undefined;
}

export function identitiesOf(fnType: FieldType): IdentityConstraint[] {
  return attrs(fnType).filter(
    (c): c is Record<string, unknown> & IdentityConstraint =>
      isObject(c) &&
      isFnConstraint(c, "identity") &&
      typeof c.outputPath === "string" &&
      typeof c.inputPath === "string",
  ) as IdentityConstraint[];
}

export function preservesOf(fnType: FieldType): PreservesConstraint[] {
  return attrs(fnType).filter(
    (c): c is Record<string, unknown> & PreservesConstraint =>
      isObject(c) &&
      isFnConstraint(c, "preserves") &&
      typeof c.inputPath === "string",
  ) as PreservesConstraint[];
}

export function implOf(fnType: FieldType): string | undefined {
  const c = attrs(fnType).find(
    (x): x is Record<string, unknown> & ImplConstraint =>
      isObject(x) &&
      isFnConstraint(x, "impl") &&
      typeof x.id === "string",
  );
  return c?.id;
}

export function temporalOf(fnType: FieldType): CompletionTemporalConstraint[] {
  return attrs(fnType).filter(
    (c): c is Record<string, unknown> & CompletionTemporalConstraint =>
      isObject(c) &&
      isFnConstraint(c, "temporal") &&
      (c.dir === "gt" || c.dir === "lt") &&
      typeof c.lhs === "string",
  ) as CompletionTemporalConstraint[];
}

export function openSlots(
  rootType: FieldType,
  bindings: Record<string, unknown>,
): CompletionGap[] {
  const gaps: CompletionGap[] = [];

  const walk = (
    t: FieldType,
    prefix: string[],
    parentBindings: Record<string, unknown> = {},
  ): void => {
    const kind = kindOf(t);
    if (kind === "function") {
      const input = inputOf(t);
      if (input) walk(input, [...prefix, "input"]);
      return;
    }
    if (kind !== "object") return;

    for (const a of attrs(t)) {
      if (a.constrainttype !== "property") continue;
      const key = a.key as string;
      const childType = a.value as FieldType;
      const childMeta = readMeta(childType);
      const path = [...prefix, key];
      const pathStr = path.join(".");

      if (childMeta.produced) continue;
      if (a.optional === true) continue;
      if (parentBindings[key] !== undefined) continue;
      if (bindings[pathStr] !== undefined) continue;

      if (kindOf(childType) === "object") {
        const nestedPreBinds =
          (childMeta.bindings as Record<string, unknown>) ?? {};
        walk(childType, path, nestedPreBinds);
      } else {
        gaps.push({ path: pathStr, type: childType });
      }
    }
  };

  walk(rootType, []);
  return gaps;
}

export const gapsOf = openSlots;

const isQualified = (p: string): boolean =>
  p === "input" ||
  p === "output" ||
  p.startsWith("input.") ||
  p.startsWith("output.");

const qualifyAsInput = (p: string): string =>
  isQualified(p) ? p : p === "." ? "input" : `input.${p}`;

const qualifyAsOutput = (p: string): string =>
  isQualified(p) ? p : p === "." ? "output" : `output.${p}`;

export function propagateIdentities(
  fnType: FieldType,
  bindings: Record<string, unknown>,
): PropagateResult {
  if (kindOf(fnType) !== "function") {
    return { bindings: { ...bindings }, conflicts: [] };
  }

  const next: Record<string, unknown> = { ...bindings };
  const conflicts: PropagateResult["conflicts"] = [];

  let changed = true;
  let safety = 32;
  while (changed && safety-- > 0) {
    changed = false;
    for (const e of identitiesOf(fnType)) {
      const inK = qualifyAsInput(e.inputPath);
      const outK = qualifyAsOutput(e.outputPath);
      const inV = next[inK];
      const outV = next[outK];

      if (inV === undefined && outV === undefined) continue;
      if (inV !== undefined && outV === undefined) {
        next[outK] = inV;
        changed = true;
        continue;
      }
      if (outV !== undefined && inV === undefined) {
        next[inK] = outV;
        changed = true;
        continue;
      }
      if (inV !== outV && !deepEqual(inV, outV)) {
        conflicts.push({
          edge: { outputPath: e.outputPath, inputPath: e.inputPath },
          inputValue: inV,
          outputValue: outV,
        });
      }
    }
  }

  return { bindings: next, conflicts };
}

export function openSlotsOfFn(
  fnType: FieldType,
  bindings: Record<string, unknown>,
): CompletionGap[] {
  if (kindOf(fnType) !== "function") {
    return openSlots(fnType, bindings);
  }

  const propagated = propagateIdentities(fnType, bindings).bindings;
  const input = inputOf(fnType);
  if (!input) return [];

  const inputBindings: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(propagated)) {
    if (k === "input") continue;
    if (k.startsWith("input.")) inputBindings[k.slice("input.".length)] = v;
  }

  return openSlots(input, inputBindings).map((g) => ({
    path: `input.${g.path}`,
    type: g.type,
  }));
}

export const gapsOfFn = openSlotsOfFn;

export function initialCompletionState(type: FieldType): CompletionState {
  const gaps = openSlots(type, {});
  return {
    type,
    bindings: {},
    cursor: gaps[0]?.path ?? null,
    history: [],
  };
}

export const initialState = initialCompletionState;

export function stepCompletion(
  state: CompletionState,
  input: unknown,
): CompletionState {
  if (state.cursor === null) return state;
  return mountCompletion(state, state.cursor, input);
}

export const step = stepCompletion;

export function mountCompletion(
  state: CompletionState,
  path: string,
  value: unknown,
): CompletionState {
  const nextBindings = { ...state.bindings, [path]: value };
  const remaining = openSlots(state.type, nextBindings);
  return {
    type: state.type,
    bindings: nextBindings,
    cursor: remaining[0]?.path ?? null,
    history: [...state.history, { path, value }],
  };
}

export const mount = mountCompletion;

export function isComplete(state: CompletionState): boolean {
  return state.cursor === null;
}

export function serializeCompletion(
  state: CompletionState,
): SerializedCompletionState {
  return { bindings: state.bindings, history: state.history };
}

export const serialize = serializeCompletion;

export function deserializeCompletion(
  type: FieldType,
  data: SerializedCompletionState,
): CompletionState {
  const remaining = openSlots(type, data.bindings);
  return {
    type,
    bindings: { ...data.bindings },
    cursor: remaining[0]?.path ?? null,
    history: [...data.history],
  };
}

export const deserialize = deserializeCompletion;

export function* replayCompletion(
  type: FieldType,
  history: Array<{ path: string; value: unknown }>,
): Generator<CompletionState> {
  let state = initialCompletionState(type);
  yield state;
  for (const event of history) {
    state = mountCompletion(state, event.path, event.value);
    yield state;
  }
}

export const replay = replayCompletion;

function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== "object" || typeof b !== "object") return false;
  if (a === null || b === null) return false;
  const ak = Object.keys(a as object).sort();
  const bk = Object.keys(b as object).sort();
  if (ak.length !== bk.length) return false;
  for (let i = 0; i < ak.length; i++) {
    if (ak[i] !== bk[i]) return false;
    const k = ak[i] as string;
    if (
      !deepEqual(
        (a as Record<string, unknown>)[k],
        (b as Record<string, unknown>)[k],
      )
    ) {
      return false;
    }
  }
  return true;
}
