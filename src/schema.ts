// import { ReferenceHolder } from "../../core/utils/noderef.js";
import { types, validate } from "./builders.js";
import { FieldType } from "./type.js";

/** Anchor for outer NodeRef wrapping (if/when you need it) */
export const Base = { references: [] };

/** For now, accept any constraint shape in attributes (keeps schema generic). */
export const FieldConstraint = types.any();

/** Patch (update) event */
export const PatchFieldTypeEventSchema = types.object({
  type: types.string().literal("fieldtypeevent"),
  eventtype: types.string().literal("patch"),
  id: types.string(),
  // string id or an inlined prior event (recursive — marked via metadata cue)
  target: types.or(
    types.string(),
    types.any().meta({ recursion: "FieldTypeEvent (previous)" }),
  ),
  // In practice a patch's `attributes` may be a single constraint OR an array.
  attributes: types.proptional(
    types.or(types.array(FieldConstraint), FieldConstraint),
  ),
  // free-form metadata (object expected)
  metadata: types.proptional(FieldType.object.nonce),
  // extension is a full FieldType node; mark recursive intent in metadata
  extension: types.proptional(types.any().meta({ recursion: "FieldType" })),
});

/** State (creation) event */
export const CreateFieldTypeEventSchema = types.object({
  type: types.string().literal("fieldtypeevent"),
  eventtype: types.string().literal("state"),
  id: types.string(),
  // concrete basetype identifier
  fieldtype: types.or(
    types.string().literal("any").save(),
    types.string().literal("string").save(),
    types.string().literal("number").save(),
    types.string().literal("boolean").save(),
    types.string().literal("null").save(),
    types.string().literal("object").save(),
    types.string().literal("array").save(),
    types.string().literal("or").save(),
    types.string().literal("and").save(),
    types.string().literal("not").save(),
    types.string().literal("never").save(),
  ),
  // optional attributes/metadata/extensions
  'attributes?': types.array(FieldConstraint),
  'metadata?': types.object(),
  'extensions?': types.array(types.any()),
});

/** Union of all event shapes */
export const FieldTypeEventSchema = types.or(
  PatchFieldTypeEventSchema,
  CreateFieldTypeEventSchema,
);

// (optional) handy validators if you want quick runtime checks elsewhere
export const validatePatchEvent = (e: unknown) =>
  validate(PatchFieldTypeEventSchema, e);

export const validateCreateEvent = (e: unknown) =>
  validate(CreateFieldTypeEventSchema, e);

export const validateAnyEvent = (e: unknown) =>
  validate(FieldTypeEventSchema, e);
