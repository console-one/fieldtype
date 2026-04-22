import type { FieldTypeCreationEvent } from './event.js';
import type { ConcretenessResult } from './concreteness.js';

/**
 * A typed constraint produced when scope evaluation hits a semantic wall.
 * Describes what must be true about a missing term for blocked bindings to resolve.
 *
 * Originally defined in the monorepo's toolset/graph module; moved here because
 * every field references types that live in this package — it is structurally
 * part of the type system, not a downstream consumer concept.
 */
export type MissingRequirement = {
  /** Ref path (e.g., "apiKey", "headers.Authorization") */
  path: string;
  /** Expected type — ref source or type name */
  expectedType: string;
  /** Full typed schema (serialized FieldType event) when available */
  expectedSchema?: FieldTypeCreationEvent;
  /** Human-readable description (for form labels) */
  description?: string;
  /** Which exports/bindings are blocked by this ref */
  constraintSource: string[];
  /** Kind of missing dependency */
  kind: 'ref' | 'name' | 'targetType';
  /** Rich semantic analysis from FieldType concreteness (when fieldType available) */
  concreteness?: ConcretenessResult;
  /** Env-matched candidates (from patchResolve) for picker UI */
  candidates?: readonly { key: string; displayName?: string; value?: unknown }[];
  /** Pre-fill value from statement default — shown in form, overridable */
  defaultValue?: unknown;
  /** Whether this field is optional (min:0 or has a default) */
  optional?: boolean;
};
