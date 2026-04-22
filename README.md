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
