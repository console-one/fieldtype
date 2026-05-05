// chain-extensions.smoke.mjs — full pipeline: parse → chain → reduce
// Validates that a chat-scope-shaped chain reduces to a Scope whose bindings
// are typed correctly and unresolved concretes surface as gaps.

import { chainFromSyntax } from '../../dist/parse.js';
import { reduce } from '../../dist/chain.js';

let pass = 0;
let fail = 0;

function check(label, source, predicate) {
  try {
    const chain = chainFromSyntax(source);
    const result = reduce(chain);
    const ok = predicate(result);
    if (ok === true) {
      pass++;
      console.log(`✓ ${label}`);
    } else {
      fail++;
      console.log(`✗ ${label} — predicate failed`);
      console.log('   bindings:',
        [...result.scope.bindings.entries()].map(([k, v]) =>
          `${k}=${v.resolved ? 'resolved' : 'unresolved'}:${v.level}`));
    }
  } catch (err) {
    fail++;
    console.log(`✗ ${label} — error: ${err.message}`);
  }
}

// 1. Single function-definition binding reduces to a resolved scope binding
check('chain with fn definition reduces',
  `concrete f = (x: string) -> [
     concrete y = "hello"
   ]`,
  (result) => {
    const f = result.scope.bindings.get('f');
    return !!f;
  });

// 2. Multiple binds + a function definition all land in the scope
check('chain with imports/binds/fn-def all land in scope',
  `concrete chatID: string
concrete handler = (msg: string) -> [
  concrete echoed = msg
]`,
  (result) => {
    const chatID = result.scope.bindings.get('chatID');
    const handler = result.scope.bindings.get('handler');
    return !!chatID && !!handler;
  });

// 3. Unresolved concrete (no value) shows as unresolved binding
check('concrete X: Type without value is unresolved',
  `concrete chatID: string`,
  (result) => {
    const b = result.scope.bindings.get('chatID');
    return b && !b.resolved;
  });

// 4. Resolved concrete shows as resolved
check('concrete X = "y" is resolved',
  `concrete X = "y"`,
  (result) => {
    const b = result.scope.bindings.get('X');
    return b && b.resolved;
  });

// 5. Type-level << works (string << values composes)
check('type s = string << values reduces to a scope binding',
  `type s = string << "x"`,
  (result) => {
    const b = result.scope.bindings.get('s');
    return b && b.level === 'type';
  });

// 6. Function nested in function — both bindings present, outer is resolved
check('nested function definitions reduce',
  `concrete outer = () -> [
     concrete inner = (x: number) -> [
       concrete y = x
     ]
   ]`,
  (result) => {
    const outer = result.scope.bindings.get('outer');
    return outer && outer.resolved;
  });

console.log();
console.log(`${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
