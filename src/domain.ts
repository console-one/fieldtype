import { types, extensionof } from './builders.js';


// TODO - Evaluate why claude thought it rational 
// to put local-app typed business logic in a 
// fucking generalized package library

// ── Atomic Types (defined once, referenced everywhere) ───────────
// Each is a single FieldType instance. Every object that uses
// "identity" references this exact node, enabling deduplication.

export const identityType     = types.string().meta({ name: 'Identity', description: 'User identity' });
export const organizationType = types.string().meta({ name: 'Organization', description: 'Organization identifier' });
export const chatIDType       = types.string().meta({ name: 'ChatID', description: 'Chat identifier' });
export const messageIDType    = types.string().meta({ name: 'MessageID', description: 'Message identifier' });
export const processIdType    = types.string().meta({ name: 'ProcessID', description: 'Process identifier' });
export const workflowIdType   = types.string().meta({ name: 'WorkflowID', description: 'Workflow identifier' });
export const packageIDType    = types.string().meta({ name: 'PackageID', description: 'Tool package identifier' });
export const toolsetIDType    = types.string().meta({ name: 'ToolsetID', description: 'Toolset identifier' });
export const constantIdType   = types.string().meta({ name: 'ConstantID', description: 'Constant identifier' });
export const groupIdType      = types.string().meta({ name: 'GroupID', description: 'Constant group identifier' });
export const connectionIdType = types.string().meta({ name: 'ConnectionID', description: 'Connection identifier' });
export const orgIdType        = types.string().meta({ name: 'OrgID', description: 'Organization ID (blueprint scope)' });
export const jwtTokenType     = types.string().meta({ name: 'JWTToken', description: 'JWT authentication token' });
export const timestampType    = types.number().meta({ name: 'Timestamp', description: 'Unix timestamp' });
export const isoTimestampType = types.string().meta({ name: 'ISOTimestamp', description: 'ISO 8601 timestamp string' });
export const aliasType        = types.string().meta({ name: 'Alias', description: 'Human-readable alias' });
export const descriptionType  = types.string().meta({ name: 'Description', description: 'Description text' });
export const filtersType      = types.array(types.any()).meta({ name: 'Filters', description: 'Query filters' });
export const labelsType       = types.array(types.any()).meta({ name: 'Labels', description: 'Label annotations' });

// ── Composed Base Types ──────────────────────────────────────────

export const SessionContext = types.object({
  identity: identityType,
  organization: organizationType,
});


// ── Infrastructure FieldTypes (constructor dep contracts) ──────────

export const StorageType = types.object({
  read: (types.fn(types.string(), types.string()) as any),
  write: (types.fn(types.any(), types.null()) as any),
  list: (types.fn(types.string(), types.array(types.string())) as any),
  exists: (types.fn(types.string(), types.bool()) as any),
  has: (types.fn(types.string(), types.bool()) as any),
  delete: (types.fn(types.string(), types.null()) as any),
}).meta({ name: 'IStorage' });

export const ArtifactDaoType = types.object({
  getArtifact: (types.fn(types.any(), types.any()) as any),
  setArtifact: (types.fn(types.any(), types.any()) as any),
  deleteArtifact: (types.fn(types.any(), types.any()) as any),
  getArtifacts: (types.fn(types.any(), types.array(types.any())) as any),
  getLabels: (types.fn(types.any(), types.array(types.any())) as any),
  updateLabels: (types.fn(types.any(), types.any()) as any),
  resolveLinkRef: (types.fn(types.any(), types.any()) as any),
}).meta({ name: 'ArtifactDao' });

export const EventBusType = types.object({
  publish: (types.fn(types.any(), types.null()) as any),
  subscribe: (types.fn(types.any(), types.null()) as any),
}).meta({ name: 'EventBus' });

export const IndexerType = types.object({
  ensure: (types.fn(types.object({ id: types.string() }), types.bool()) as any),
  getAll: (types.fn(types.object({ id: types.string() }), types.array(types.any())) as any),
  set: (types.fn(types.any(), types.array(types.any())) as any),
  get: (types.fn(types.object({ id: types.string(), pkey: types.string() }), types.any()) as any),
}).meta({ name: 'IndexerLike' });

export const ConstantStoreType = types.object({
  get: (types.fn(types.string(), types.any()) as any),
  set: (types.fn(types.string(), types.null()) as any),
  has: (types.fn(types.string(), types.bool()) as any),
  delete: (types.fn(types.string(), types.null()) as any),
  getAll: (types.fn(types.array(types.string()), types.array(types.any())) as any),
}).meta({ name: 'ConstantStore' });

export const UserSettingsType = types.object({
  set: (types.fn(types.any(), types.any()) as any),
  get: (types.fn(types.any(), types.any()) as any),
  query: (types.fn(types.any(), types.any()) as any),
}).meta({ name: 'IUserSettings' });

export const ChatDaoType = types.object({
  getLatestState: (types.fn(types.any(), types.any()) as any),
  getEvents: (types.fn(types.any(), types.any()) as any),
  putEvent: (types.fn(types.any(), types.any()) as any),
}).meta({ name: 'ChatDao' });

export const ContentAddressType = types.object({
  location: types.string(),
  id: types.string(),
}).meta({ name: 'ContentAddress' });

// ── Branded infrastructure types (disambiguate multiple instances of same structural type) ──

export const ArtifactStorageType  = extensionof(StorageType, { _scope: types.string().literal('artifacts') }).meta({ name: 'ArtifactStorage' });
export const ProcessStorageType   = extensionof(StorageType, { _scope: types.string().literal('processes') }).meta({ name: 'ProcessStorage' });

export const ArtifactIndexerType  = extensionof(IndexerType, { _scope: types.string().literal('artifacts') }).meta({ name: 'ArtifactIndexer' });

export const ChatStorageType      = extensionof(StorageType, { _scope: types.string().literal('chats') }).meta({ name: 'ChatStorage' });
export const SettingsStorageType  = extensionof(StorageType, { _scope: types.string().literal('settings') }).meta({ name: 'SettingsStorage' });
export const SettingsIndexerType  = extensionof(IndexerType, { _scope: types.string().literal('settings') }).meta({ name: 'SettingsIndexer' });
export const ProcessesIndexerType = extensionof(IndexerType, { _scope: types.string().literal('processes') }).meta({ name: 'ProcessesIndexer' });

export const OAuthTokenResolverType = (types.fn(types.string(), types.any()) as any)
  .meta({ name: 'OAuthTokenResolver' });

// ── Agent Blueprint Domain Types ──────────────────────────────────────

/** Reference type for model provider packages — matches env entries with [kind]: 'model'. */
export const ModelProviderRef = types.object({
  '[kind]': types.string().literal('model'),
}).meta({ name: 'ModelProvider', description: 'Reference to an installed model provider package' });

/** Reference type for toolset packages — matches env entries with [kind]: 'toolset'. */
export const ToolsetRef = types.object({
  '[kind]': types.string().literal('toolset'),
}).meta({ name: 'Toolset', description: 'Reference to an installed toolset' });

/**
 * Annotation node — either inline text or an artifact reference.
 * Matches the AnnotationNode type in statement.ts.
 */
export const AnnotationType = types.or(
  types.object({
    kind: types.string().literal('text'),
    content: types.string(),
  }),
  types.object({
    kind: types.string().literal('ref'),
    artifactType: types.string(),
    artifactID: types.string(),
  }),
).meta({ name: 'Annotation', description: 'Instruction annotation' });
