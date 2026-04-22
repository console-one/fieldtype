/**
 * formatter.ts — Shared type formatter with hoisting
 *
 * Builds a formatter that converts FieldType trees into string representations.
 * Complex types are hoisted into named definitions; simple types are inlined.
 * Names are shared across all methods so the same type referenced by multiple
 * methods gets one name.
 *
 * Used by:
 *   - registryBridge (ServicePrototype → ToolPackageCompat)
 *   - view engine (DefinitionPlaneNode[] → Declaration)
 */

import { makeFieldTypeHoistHandler } from './hoist.js';
import { FieldType } from './type.js';

// ── isSimple heuristic ───────────────────────────────────────────────────────
// Named types are ALWAYS hoisted — the name carries meaning.
// Unnamed trivial types (primitives, simple unions of primitives) inline.

function viewIsSimple(ft: any): boolean {
  if (ft?.metadata?.name || ft?.metadata?.tsName) return false;

  const attrs: any[] = ft?.attributes ?? [];
  switch (ft?.fieldtype) {
    case 'any': case 'boolean': case 'null': case 'never':
      return true;
    case 'string': case 'number':
      return attrs.length <= 1;
    case 'array':
      return true; // unnamed arrays inline; their elements hoist if complex
    case 'object': {
      // Empty/featureless object inlines as 'object' — no need to hoist as T<N>
      const props = attrs.filter(
        (a: any) => a.basetype === 'object' && a.constrainttype === 'property'
      );
      if (props.length === 0) return true;
      return false;
    }
    case 'or': case 'and': {
      const kids = attrs.filter((a: any) => a.fieldtype);
      return kids.length <= 2 && kids.every((k: any) =>
        ['any', 'string', 'number', 'boolean', 'null'].includes(k.fieldtype));
    }
    default:
      return false;
  }
}

// ── Formatter state ──────────────────────────────────────────────────────────

export type TypeFormatter = {
  /** Format a FieldType to a string, hoisting complex types as side-effect. */
  fmt: (ft: any) => string;
  /** All hoisted type definitions accumulated during formatting. */
  hoisted: Map<string, { name: string; body: string; doc?: string }>;
};

/**
 * Build a fresh type formatter. Each call produces an independent hoisting
 * namespace — types are deduplicated within the scope of one formatter.
 */
export function buildTypeFormatter(): TypeFormatter {
  const handler = makeFieldTypeHoistHandler({ isSimple: viewIsSimple });
  const hoisted = new Map<string, { name: string; body: string; doc?: string }>();
  const keyToName = new Map<string, string>();
  const bodyToName = new Map<string, string>();
  const usedNames = new Set<string>();

  const fmt = (ft: any): string => {
    if (!ft || !ft.fieldtype) return 'any';
    if (handler.isSimple(ft)) return handler.renderInline(ft, fmt);

    // Complex type — check structural key first (within-scope dedup)
    const key = handler.key?.(ft) ?? handler.id?.(ft);
    if (key && keyToName.has(key)) return keyToName.get(key)!;

    const rendered = handler.renderHoisted(ft, fmt);

    // Dedup by body — if an identical body was already hoisted, reuse its name
    // Skip for explicitly named types — they are semantically distinct even if bodies match
    if (!rendered.name && bodyToName.has(rendered.body)) {
      const existing = bodyToName.get(rendered.body)!;
      if (key) keyToName.set(key, existing);
      return existing;
    }

    const baseName = rendered.name ?? `T${hoisted.size + 1}`;
    let assigned = baseName;
    let i = 2;
    while (usedNames.has(assigned)) assigned = `${baseName}_${i++}`;
    usedNames.add(assigned);

    if (key) keyToName.set(key, assigned);
    bodyToName.set(rendered.body, assigned);
    hoisted.set(assigned, { name: assigned, body: rendered.body, doc: rendered.doc });
    return assigned;
  };

  return { fmt, hoisted };
}

// ── Session key filtering ────────────────────────────────────────────────────

const SESSION_KEYS = new Set(['identity', 'organization']);

/**
 * Extract formatted input params from a FieldType (object type with property
 * constraints). Filters out session keys (identity, organization) since those
 * are injected automatically and shouldn't be shown to callers.
 */
export function extractFormattedInputs(
  inputType: any,
  fmt: (ft: any) => string,
): { name: string; type: string; required: boolean; description?: string }[] {
  if (!inputType || !inputType.attributes) return [];
  return inputType.attributes
    .filter((a: any) =>
      a.basetype === 'object' &&
      a.constrainttype === 'property' &&
      !SESSION_KEYS.has(a.key))
    .map((a: any) => ({
      name: a.key,
      type: a.value ? fmt(a.value) : 'any',
      required: !a.optional,
      description: a.reason ?? a.value?.metadata?.description,
    }));
}

/**
 * Extract formatted inputs from a FieldTypeCreationEvent (serialized form).
 * Reconstructs the live FieldType, then delegates to extractFormattedInputs.
 */
export function extractFormattedInputsFromEvent(
  inputTypeEvent: any,
  fmt: (ft: any) => string,
): { name: string; type: string; required: boolean; description?: string }[] {
  if (!inputTypeEvent) return [];
  try {
    const ft = FieldType.fromEvent(inputTypeEvent);
    return extractFormattedInputs(ft, fmt);
  } catch {
    return [];
  }
}

/**
 * Format an output type from a FieldTypeCreationEvent (serialized form).
 */
export function formatOutputTypeFromEvent(
  outputTypeEvent: any,
  fmt: (ft: any) => string,
): string | undefined {
  if (!outputTypeEvent) return undefined;
  try {
    const ft = FieldType.fromEvent(outputTypeEvent);
    return fmt(ft);
  } catch {
    return undefined;
  }
}
