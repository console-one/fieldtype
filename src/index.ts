
// ── Public API ──
export { FieldType } from "./type.js";
export type {
  ObjWithout, BaseFieldType, BaseFT, Augment,
  ObjectType, ArrayType, StringType, NumberType, BooleanType, NullType, FunctionType,
  AnyType, NeverType, OrType, AndType, NotType, VarType,
  Fluentize, FluentCommon, FluentString, FluentNumber, FluentObject, FluentArray,
  FluentOr, FluentAnd, FluentNot, FluentFunction,
  BaseFieldTypeProps,
} from "./type.js";
export { ConstraintTypes, isBehavioralConstraint } from "./constraint.js";
export type {
  FieldConstraintType, BehavioralConstraint, BehavioralConstraintType,
  MergeConstraint, PersistConstraint, CompactConstraint,
  SubscribeConstraint, ForkConstraint, VisibilityConstraint, DecoratorConstraint, AutoMergeConstraint,
  MountConstraint, ClaimConstraint,
  FunctionImplConstraint, FunctionIdentityConstraint, FunctionPreservesConstraint, FunctionTemporalConstraint,
  AnyConstraint, ObjectConstraint, ArrayConstraint, StringConstraint, NumberConstraint,
  FunctionConstraint, BaseFieldTypeConstraint, FieldTypeConstraint, AnyTypeConstraint,
  ObjectTypeConstraint, ArrayTypeConstraint,
  LiteralConstraint, ReturnTypeConstraint, RefConstraint, CallConstraint, TemporalConstraint,
  ConstraintRef, ConstraintRefValue,
  ObjectPropertyConstraint, ObjectPropertiesConstraint, ObjectAdditionalConstraint, ObjectIndexConstraint,
  ArrayIndexRange, SolveConstraint, LabelConstraint, CallableConstraint,
} from "./constraint.js";
export { FieldTypeBuilder, types, extensionof, zodToFieldType } from "./builders.js";
export { validate } from "./validate.js";
export type { ValidationFault, ValidationResult } from "./validate.js";
export { FieldTypeError } from "./error.js";
export type { FieldTypeErrorCode } from "./error.js";
export { FieldTypeEvent } from "./event.js";
export type { FieldTypeCreationEvent, FieldTypePatchEvent } from "./event.js";
export { concreteness } from "./concreteness.js";
export type { ConcretenessResult, MissingReq } from "./concreteness.js";
export { jsonSchemaToFieldType } from "./jsonschema.js";
export * from "./schema.js";
export * from './domain.js';
export type {
  Infer,
  Shaped, Elemented, Varianted, Composed, Functioned,
} from './infer.js';
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
export { parse, chainFromSyntax, fieldTypeFromExpression, fromCompactJSON } from './parse.js';
export { createHead, defaultPostMergeHandler } from './head.js';
export { electConstraints } from './headElect.js';
export type { HEAD, HeadEvent, Gap, PostMergeHandler } from './head.js';
export {
  applyHeadRule, applyHeadRules, canApplyHeadRule, canApplyHeadRules,
  resolveRuleValue, renderTemplate,
  lit as ruleLit, ctx as ruleCtx, head as ruleHead, eq as ruleEq,
  exists as ruleExists, includes as ruleIncludes, write as ruleWrite,
} from './headRules.js';
export type { HeadRule, HeadRuleResult, RuleContext, RuleValue, RuleWhere, RuleWrite } from './headRules.js';
export { interpret, classifyValue, findBehavioralConstraint } from './headInterpreter.js';
export type { HeadInterpreter } from './headInterpreter.js';
export { snapshotAt, diffSnapshot, chainHistory } from './history.js';
export type { SnapshotPatch, SnapshotDiff } from './history.js';
export type { MissingRequirement } from './missingRequirement.js';
export { kitSchemaFromMissing } from './patchResolve.js';
export { ref as artifactRef, isRef as isArtifactRef, deref, getRefMeta } from './artifactRef.js';
export type { ArtifactRefMeta } from './artifactRef.js';
export {
  deserializeCompletion,
  gapsOf,
  gapsOfFn,
  identitiesOf,
  implOf,
  initialCompletionState,
  initialState,
  inputOf,
  isComplete,
  mount,
  mountCompletion,
  openSlots,
  openSlotsOfFn,
  outputOf,
  preservesOf,
  propagateIdentities,
  replay,
  replayCompletion,
  serialize,
  serializeCompletion,
  step,
  stepCompletion,
  temporalOf,
} from './completion.js';
export type {
  CompletionGap,
  CompletionState,
  CompletionTemporalConstraint,
  IdentityConstraint,
  ImplConstraint,
  PreservesConstraint,
  PropagateResult,
  SerializedCompletionState,
} from './completion.js';
