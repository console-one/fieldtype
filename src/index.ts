
// ── Public API ──
export { FieldType } from "./type.js";
export type { ObjWithout, BaseFieldType } from "./type.js";
export { ConstraintTypes, isBehavioralConstraint } from "./constraint.js";
export type {
  FieldConstraintType, BehavioralConstraint, BehavioralConstraintType,
  MergeConstraint, PersistConstraint, CompactConstraint,
  SubscribeConstraint, ForkConstraint, VisibilityConstraint, DecoratorConstraint, AutoMergeConstraint,
  MountConstraint,
} from "./constraint.js";
export { FieldTypeBuilder, types, validate, extensionof, zodToFieldType } from "./builders.js";
export type { ValidationOutcome } from "./builders.js";
export { FieldTypeError } from "./error.js";
export type { FieldTypeErrorCode } from "./error.js";
export { FieldTypeEvent } from "./event.js";
export type { FieldTypeCreationEvent, FieldTypePatchEvent } from "./event.js";
export { concreteness } from "./concreteness.js";
export type { ConcretenessResult, MissingReq } from "./concreteness.js";
export { jsonSchemaToFieldType } from "./jsonschema.js";
export * from "./schema.js";
export { createScope, withScope, withScopeAsync } from './scope.js';
export type { Scope } from './scope.js';
export * from './domain.js';
export type { Infer } from './infer.js';
export {
  concrete, type_, ref, patch, import_, export_, annotate, delete_,
  typed, literal,
} from './statement.js';
export type {
  Statement, BindStatement, ImportStatement, ExportStatement, AnnotateStatement, DeleteStatement,
  AnnotationNode,
} from './statement.js';
export {
  createChain, push, fork, reduce,
  compilationLens,
} from './chain.js';
export type { Chain } from './chain.js';
export { ptr } from './ptr.js';
export type { Ptr } from './ptr.js';
export { createHead, defaultPostMergeHandler } from './head.js';
export { electConstraints } from './headElect.js';
export type { HEAD, HeadEvent, Gap, PostMergeHandler } from './head.js';
export { interpret, classifyValue, findBehavioralConstraint } from './headInterpreter.js';
export type { HeadInterpreter } from './headInterpreter.js';
export { snapshotAt, diffSnapshot, chainHistory } from './history.js';
export type { SnapshotPatch, SnapshotDiff } from './history.js';
export type { MissingRequirement } from './missingRequirement.js';
export { kitSchemaFromMissing } from './patchResolve.js';
export { ref as artifactRef, isRef as isArtifactRef, deref, getRefMeta } from './artifactRef.js';
export type { ArtifactRefMeta } from './artifactRef.js';
