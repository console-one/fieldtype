/**
 * Smoke test for @console-one/fieldtype.
 *
 * Exercises the headline operations: build a type, push statements to a chain,
 * reduce to a scope, and confirm resolution / unresolved tracking. The goal is
 * not test coverage (the full Jest suite lives under src/test/), only to prove
 * the compiled package runs end-to-end outside the source repo.
 */

import {
  types,
  createChain,
  push,
  reduce,
  concrete,
  literal,
  ref,
  createHead,
  concreteness,
} from './index.js';

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) {
    console.error(`SMOKE FAIL: ${msg}`);
    process.exit(1);
  }
}

// ─── 1. Build a type ──────────────────────────────────────────────────────
const UserSchema = types.object({
  name: types.string(),
  email: types.string(),
  'age?': types.number(),
});
assert(!!UserSchema && typeof UserSchema === 'object', 'types.object should produce a FieldType value');
console.log('[1/5] built UserSchema');

// ─── 2. Concreteness check ──────────────────────────────────────────────
const c = concreteness(UserSchema as any);
assert(typeof c === 'object' && c !== null, 'concreteness should return an object');
console.log('[2/5] concreteness computed');

// ─── 3. Chain: push statements and reduce to scope ───────────────────────
let chain = createChain('user');
chain = push(chain, concrete('name', literal('Alice')));
chain = push(chain, concrete('email', literal('alice@example.com')));
const reduced = reduce(chain);
assert(!!reduced.scope, 'reduce should return a scope');
assert(
  reduced.scope.bindings.get('name')?.resolved === true,
  'name should be resolved',
);
assert(
  reduced.scope.bindings.get('email')?.resolved === true,
  'email should be resolved',
);
console.log('[3/5] chain reduced — 2 bindings resolved');

// ─── 4. Ref (unresolved) keeps a binding in the gap set ──────────────────
let gapChain = createChain('profile');
gapChain = push(gapChain, concrete('name', literal('Bob')));
gapChain = push(gapChain, concrete('connection', ref('env.SECRET_API_KEY')));
const gapReduced = reduce(gapChain);
const connection = gapReduced.scope.bindings.get('connection');
assert(connection?.resolved === false, 'ref to missing env should be unresolved');
console.log('[4/5] gap detection works — unresolved ref surfaced');

// ─── 5. HEAD: reactive draft lifecycle ───────────────────────────────────
const head = createHead(UserSchema as any);
const draft = head.draft();
draft.write(concrete('name', literal('Carol')));
const preflight = draft.preflight();
assert(typeof preflight === 'object' && 'ok' in preflight, 'preflight returns PreflightResult');
draft.write(concrete('email', literal('carol@example.com')));
console.log('[5/5] HEAD draft lifecycle ok — preflight ok=', preflight.ok);

console.log('\n✓ @console-one/fieldtype smoke test passed');
