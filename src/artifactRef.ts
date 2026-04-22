/**
 * ref.ts — Artifact reference annotations for grammar-driven edge extraction.
 *
 * NOT a new FieldType kind — uses existing `.meta()` to annotate fields
 * that represent references to other artifacts.
 */

import { FieldType } from './type.js';
import { types } from './builders.js';

export type ArtifactRefMeta = {
  label?: string;
  pathPrefix?: string;
  targetType?: FieldType;
};

/**
 * Mark a field as an artifact reference. The resulting FieldType
 * carries metadata.artifactRef with label, pathPrefix, and targetType
 * from the target grammar (if provided).
 */
export function ref(targetType?: FieldType): FieldType {
  const meta = targetType ? (targetType as any).metadata ?? {} : {};
  return types.any().meta({
    artifactRef: {
      label: meta.grammarLabel,
      pathPrefix: meta.grammarPathPrefix,
      targetType,
    } satisfies ArtifactRefMeta,
  });
}

/** Check if a FieldType is an artifact reference (has artifactRef metadata). */
export function isRef(type: FieldType): boolean {
  return !!(type as any).metadata?.artifactRef;
}

/** Extract the target type from an artifact reference annotation. */
export function deref(type: FieldType): FieldType | undefined {
  return (type as any).metadata?.artifactRef?.targetType;
}

/** Extract the ref metadata from an annotated FieldType. */
export function getRefMeta(type: FieldType): ArtifactRefMeta | undefined {
  return (type as any).metadata?.artifactRef;
}
