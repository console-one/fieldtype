# @console-one/fieldtype

A CUE-inspired structural type system that doubles as a reactive rule engine. `FieldType + Chain + HEAD`: types carry evaluation, merge, persistence, and scheduling policy as structural constraints, so every value, schema, service definition, or agent is the same kind of thing — a composition of five primitives.

> **HEAD = Chain + Type = Statement[] + FieldType = data + rules.**

There is no separate query engine, ORM, or external schema registry. The type IS the fold function: given previous state + a new statement + the type's constraint rules, produce the next state.

## Install

```bash
npm install @console-one/fieldtype
```

Peer dep (optional): `zod` — only needed if you call `zodToFieldType`.
Runtime dep: `@console-one/wire` (structural codec for serialization).

## Quick tour

```ts
import {
  types, FieldType, ConstraintTypes,            // build types
  createChain, push, reduce,                     // chain operations
  concrete, type_, ref, literal, typed,          // statement constructors
  createHead,                                    // reactive HEAD
} from '@console-one/fieldtype';

// 1. Build a type
const UserSchema = types.object({
  name:  types.string(),
  email: types.string(),
  'age?': types.number(),   // trailing ? = optional
});

// 2. Create a chain, push statements, reduce to scope
let chain = createChain('user');
chain = push(chain, concrete('name', literal('Alice')));
chain = push(chain, concrete('email', literal('alice@example.com')));
const { scope } = reduce(chain);
scope.bindings.get('name')?.resolved;  // true
scope.bindings.get('name')?.value;     // 'Alice'

// 3. Use a HEAD (reactive constraint solver with draft lifecycle)
const head = createHead(UserSchema);
const draft = head.draft();
draft.write(concrete('name', literal('Bob')));
const preflight = draft.preflight();
// preflight.ok = false, preflight.gaps = ['email'] — still unresolved
draft.write(concrete('email', literal('bob@example.com')));
await draft.save(); // merges back into head
```

## Function and claim vocabulary

`fieldtype` owns the serializable vocabulary for typed capabilities and
semantic claims. It does not execute commitments, run tools, or maintain
append-only process state; runtimes such as HEAD, sequence, or an app-specific
effect runner interpret these constraints.

```ts
const Summarizer = types.fn({
  input: types.object({
    sourceTopic: types.string().meta({ ref: 'topic:claude-jsonl' }),
    prompt: types.string(),
  }),
  output: types.object({
    narrativeTopic: types.string(),
    attachTo: types.string(),
  }),
  impl: 'kit:summarizer',
  identity: [
    ['output.attachTo', 'output.narrativeTopic'],
  ],
  preserves: [
    ['sourceTopic.tenant', 'narrativeTopic.tenant'],
  ],
});

const Service = types.object({
  setReport: types.fn(types.object({ body: types.string() }), types.object({ id: types.string() })),
  getReport: types.fn(types.object({ id: types.string() }), types.object({ body: types.string() })),
}).claim('identity', {
  lhs: 'getReport.output.body',
  rhs: 'setReport.input.body',
  temporal: { until: ['add', 'setReport.output._rt', 86_400_000] },
  confidence: 0.99,
});
```

## Examples: typed complexity as data

These examples show the intended modeling style: use `FieldType` for the
shape and semantic vocabulary, use `Chain` or `HEAD` for instance updates, and
let runtimes interpret higher-level claims or effects.

### Class and instance composition

A class is just a type with a stable discriminator. An instance is a narrower
type composed with the class: same structural contract, plus concrete literals.

```ts
import { FieldType, types, validate } from '@console-one/fieldtype';

const TopicClass = types.object({
  kind: types.string().literal('topic'),
  id: types.string().matches(/^topic:[a-z0-9-]+$/),
  title: types.string(),
  tenant: types.string(),
  'archived?': types.bool().literal(false),
});

const ClaudeTranscriptTopic = types.object({
  kind: types.string().literal('topic'),
  id: types.string().literal('topic:claude-transcripts'),
  title: types.string().literal('Claude transcripts'),
  tenant: types.string().literal('personal'),
});

const TopicInstance = FieldType.compose(TopicClass, ClaudeTranscriptTopic);

validate(TopicInstance, {
  kind: 'topic',
  id: 'topic:claude-transcripts',
  title: 'Claude transcripts',
  tenant: 'personal',
}); // { ok: true }
```

The class/instance distinction is conventional, not a separate primitive. That
is deliberate: classes, instances, schemas, partially-filled forms, and
capability declarations stay in the same composition system.

### Deep documents with keyed maps and indexed children

`indexBy()` lets an object act like a keyed map where each entry must agree with
its key. This catches a common document-model failure: the map key says one
thing, the object payload says another.

```ts
const Block = types.object({
  id: types.string(),
  kind: types.or(
    types.string().literal('paragraph'),
    types.string().literal('code'),
    types.string().literal('callout'),
  ),
  body: types.string(),
  order: types.number().integer().min(0),
});

const Section = types.object({
  id: types.string(),
  heading: types.string(),
  // blocks.<key>.id must equal <key>
  blocks: types.object().indexBy('id', Block),
});

const Document = types.object({
  id: types.string(),
  title: types.string(),
  author: types.object({
    id: types.string(),
    displayName: types.string(),
  }),
  // sections.<key>.id must equal <key>
  sections: types.object().indexBy('id', Section),
  // Arbitrary metadata is allowed, but if present each value must be string.
  metadata: types.object().additional(types.string()),
});

const bad = validate(Document, {
  id: 'doc-1',
  title: 'Architecture Notes',
  author: { id: 'u1', displayName: 'Andrew' },
  sections: {
    intro: {
      id: 'wrong-id',
      heading: 'Intro',
      blocks: {
        b1: { id: 'b1', kind: 'paragraph', body: '...', order: 0 },
      },
    },
  },
  metadata: { status: 'draft' },
});

// bad.ok === false
// bad.faults includes a path like ['sections', 'intro', 'id']
// because object key "intro" must equal value at "id".
```

This is still only type data. A runtime can later add projections, search
indexes, or sync behavior, but the document contract is already inspectable.

### Functions, params, returns, identities, and claims

Function types describe capabilities without embedding live closures. `impl` is
a serializable identifier. `identity` and `preserves` are claims about the
relationship between input and output.

```ts
const SourceTopic = types.object({
  id: types.string(),
  tenant: types.string(),
  codec: types.string().literal('claude-jsonl'),
});

const NarrativeTopic = types.object({
  id: types.string(),
  tenant: types.string(),
  kind: types.string().literal('narrative'),
});

const SummarizeTranscript = types.fn({
  input: types.object({
    sourceTopic: SourceTopic,
    directive: types.string(),
    model: types.or(
      types.string().literal('claude-sonnet-4-6'),
      types.string().literal('claude-opus-4-7'),
    ),
  }),
  output: types.object({
    narrativeTopic: NarrativeTopic,
    attachTo: types.string(),
    config: types.object({
      sourceTopic: types.string(),
      directive: types.string(),
      model: types.string(),
    }),
  }),
  impl: 'kit:summarizer',
  identity: [
    ['config.sourceTopic', 'sourceTopic.id'],
    ['config.directive', 'directive'],
    ['config.model', 'model'],
    ['output.attachTo', 'output.narrativeTopic.id'],
  ],
  preserves: [
    ['sourceTopic.tenant', 'narrativeTopic.tenant'],
  ],
});
```

Broader cross-tool facts can be carried as generic `claim` constraints. A
runtime may observe or enforce them; `fieldtype` only stores the vocabulary.

```ts
const CacheService = types.object({
  set: types.fn(types.object({ key: types.string(), value: types.string() }), types.object({ ok: types.bool() })),
  get: types.fn(types.object({ key: types.string() }), types.object({ value: types.string() })),
}).claim('identity', {
  lhs: 'get.output.value',
  rhs: 'set.input.value',
  scope: 'same key',
  temporal: { until: ['add', 'set.output._rt', 300_000] },
  confidence: 0.98,
});
```

### Streaming instance updates through a Chain

A chain is an append-only stream of statements. Reducing it gives the current
scope. This makes instance updates replayable and diffable instead of hidden in
an imperative setter.

```ts
import {
  createChain, push, reduce,
  concrete, literal, ref,
} from '@console-one/fieldtype';

let chain = createChain('install-session');

chain = push(chain, concrete('sourceTopic', literal('topic:claude-transcripts')));
chain = push(chain, concrete('directive', literal('Summarize material outcomes.')));
chain = push(chain, concrete('oauthToken', ref('secrets.claude.oauthToken')));

const reduced = reduce(chain);

reduced.scope.bindings.get('sourceTopic')?.resolved; // true
reduced.scope.bindings.get('oauthToken')?.resolved;  // false, still a ref
```

The important distinction is explicit: unresolved refs are still represented in
the stream. A UI can show "waiting on secret" instead of throwing away context.

### Drafting and applying updates with HEAD

HEAD is a reactive cursor over a chain and root type. Drafts let callers stage
updates, preflight gaps, then save when the instance is coherent enough.

```ts
import { createHead, concrete, literal } from '@console-one/fieldtype';

const InstallForm = types.object({
  sourceTopic: types.string(),
  directive: types.string(),
  model: types.string(),
});

const head = createHead(InstallForm);
const events: unknown[] = [];
head.subscribe((event) => events.push(event));

const draft = head.draft();
draft.write(concrete('sourceTopic', literal('topic:claude-transcripts')));

const first = draft.preflight();
// first.ok === false; directive and model are still missing.

draft.write(concrete('directive', literal('Summarize material outcomes.')));
draft.write(concrete('model', literal('claude-sonnet-4-6')));

const ready = draft.preflight();
// ready.ok === true

await draft.save();
// Subscribers receive the head advance event; the chain keeps the audit trail.
```

### Concreteness for form gaps and readiness

Concreteness answers "is this type now a value?" It is useful for generated
forms, install workflows, and progressive disclosure.

```ts
import { concreteness } from '@console-one/fieldtype';

const NeedsInput = types.object({
  rootPath: types.string(),
  backfill: types.bool().literal(true),
  model: types.or(
    types.string().literal('claude-sonnet-4-6'),
    types.string().literal('claude-opus-4-7'),
  ),
});

const c = concreteness(NeedsInput);

// c.concrete === false
// c.missing contains:
// - rootPath: string value required
// - model: choose one branch / discriminant still unresolved
```

Defaults and literals reduce missing work. Optional object properties do not
block concreteness in the same way required properties do.

### Validation faults as UI messages

Validation returns structured faults rather than a single string. Product code
can turn those faults into precise form messages or install errors.

```ts
const ProcessorConfig = types.object({
  processKind: types.string().literal('summarizer'),
  idleFinalizeMs: types.number().integer().min(60_000).max(3_600_000),
  model: types.or(
    types.string().literal('claude-sonnet-4-6'),
    types.string().literal('claude-opus-4-7'),
  ),
});

const result = validate(ProcessorConfig, {
  processKind: 'summarizer',
  idleFinalizeMs: 10,
  model: 'unknown-model',
});

if (!result.ok) {
  for (const fault of result.faults) {
    console.log({
      path: fault.path.join('.'),
      expectedType: fault.typeName,
      constraint: fault.constraint?.constrainttype,
      provided: fault.provided,
    });
  }
}
```

This is the product-facing payoff: the same type information can drive forms,
preflight, validation, install gaps, and explainable failure messages.

## Layering

```
┌─────────────────────────────────────────────────────────┐
│  HEAD (head.ts)                                         │
│  Reactive cursor + draft lifecycle + self-scheduling    │
│  constraint solver.                                     │
├─────────────────────────────────────────────────────────┤
│  Chain (chain.ts)                                       │
│  Append-only Statement sequence. Fork, reduce, diff,    │
│  patch, rebase, cherry-pick, compact. Lenses.           │
├─────────────────────────────────────────────────────────┤
│  FieldType (type.ts, builders.ts, constraint.ts,        │
│             compose.ts, concreteness.ts)                │
│  Structural types + constraints + composition.          │
└─────────────────────────────────────────────────────────┘
```

See `dist/` for the compiled JS and the in-source test suite at `src/test/` (33 test files, ~14k LOC — extracted from the source repo's Jest suite).

## Smoke test

The package ships with a runnable end-to-end smoke:

```bash
npm run smoke
```

This builds a type, reduces a chain, and drives a HEAD lifecycle — exercising every top-level primitive in one script.

## Status and provenance

This is **v0.1** — extracted from its origin monorepo at commit `c3b20b72` (Mar 13, 2026: *"Scope-cascade execution model — 0 test failures"*), which was the stable high-water point of the system before an internal rewrite began. The extraction follows the console-one `EXTRACTION_PLAYBOOK.md`: no refactoring during extraction, same interfaces, vendored deps.

### Known v0 limitations

- **Four adapter modules dropped.** `compilation.ts`, `resolution.ts`, `resolvers.ts`, `scopeAdapter.ts` were bridges to the origin repo's service/toolset/prompt layers. None were in the public API. If you need patchResolve's `kitSchemaFromMissing`, it's available — the `MissingRequirement` type travels with the package.

### Intentionally dropped / inlined during extraction

| Origin import | Replacement |
|---|---|
| `../wire/codec` | → `@console-one/wire` peer package |
| `../utils/patch` | → dropped; `type.ts`'s `metadata?: PatchSet` annotation now uses `ObjectPatch` from `@console-one/patchkit`, which gained a `DEFAULT` command and typed-path helpers (`Paths<T>`, `PathValue<T,P>`, `TypedObjectPatch<T>`) to close the functional gap |
| `@shared/artifact/ref` | → inlined as `src/artifactRef.ts` |
| `@shared/toolset/graph#MissingRequirement` | → `src/missingRequirement.ts` (structurally part of this package) |

## License

MIT
