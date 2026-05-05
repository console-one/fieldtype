// runtime-evaluator.smoke.mjs — validates the new runtime branches in
// chain.ts:evaluateExpr for `fn`, `block`, and `<<` calls.
//
// Pipeline: chain text → parse → reduce → scope. Then for each binding,
// evaluate its expression against the reduced scope. Function definitions
// produce closures; calling them through the existing call dispatch should
// just work.

import { chainFromSyntax } from '../../dist/parse.js';
import { reduce, evaluateExpr } from '../../dist/chain.js';

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
          `${k}=${v.resolved ? 'resolved:' + JSON.stringify(v.value) : 'unresolved'}`));
    }
  } catch (err) {
    fail++;
    console.log(`✗ ${label} — error: ${err.message}`);
  }
}

// 1. A function-defined-in-chain produces a closure (callable JS function)
check('fn definition produces a callable closure',
  `concrete f = (name: string) -> [
     concrete y = "hi"
     export { y }
   ]`,
  (result) => {
    const f = result.scope.bindings.get('f');
    return f && f.resolved && typeof f.value === 'function';
  });

// 2. Closure captures outer scope: reading a free variable inside the body
check('closure captures outer scope (free variable visible)',
  `concrete prefix = "user_"
concrete makeID = (name: string) -> [
  concrete result = prefix
  export { result }
]`,
  (result) => {
    const f = result.scope.bindings.get('makeID');
    if (!f || typeof f.value !== 'function') return false;
    const out = f.value('alice');
    return out && out.result === 'user_';
  });

// 3. Block expression: evaluating produces an object of declared bindings
check('block produces an object of bindings',
  `concrete b = () -> [
     concrete a = 1
     concrete b = 2
     export { a, b }
   ]`,
  (result) => {
    const f = result.scope.bindings.get('b');
    if (!f || typeof f.value !== 'function') return false;
    const out = f.value();
    return out && out.a === 1 && out.b === 2;
  });

// 4. << on an array transcludes (appends)
check('<< on array appends',
  `concrete xs = [1, 2, 3]
concrete ys = xs << 4`,
  (result) => {
    const ys = result.scope.bindings.get('ys');
    return ys && ys.resolved && Array.isArray(ys.value)
      && ys.value.length === 4
      && ys.value[3] === 4;
  });

// 5. Block respects export filter
check('block export filter limits visible bindings',
  `concrete f = () -> [
     concrete a = 1
     concrete b = 2
     export { a }
   ]`,
  (result) => {
    const f = result.scope.bindings.get('f');
    if (!f || typeof f.value !== 'function') return false;
    const out = f.value();
    return out && out.a === 1 && !('b' in out);
  });

// 6. Function called from another expression in the same chain
check('chain-internal call — fn defined and invoked',
  `concrete double = (x: number) -> [
     concrete out = x
     export { out }
   ]
concrete result = double(42)`,
  (result) => {
    const r = result.scope.bindings.get('result');
    return r && r.resolved && r.value && r.value.out === 42;
  });

// 7. Nested function: inner closure captures outer's params + scope
check('nested closures: inner sees outer param',
  `concrete outer = (a: number) -> [
     concrete inner = (b: number) -> [
       concrete sum = a
       export { sum }
     ]
     export { inner }
   ]`,
  (result) => {
    const f = result.scope.bindings.get('outer');
    if (!f || typeof f.value !== 'function') return false;
    const outerOut = f.value(10);
    if (!outerOut || typeof outerOut.inner !== 'function') return false;
    const innerOut = outerOut.inner(20);
    return innerOut && innerOut.sum === 10;
  });

// 8. << on an object: shallow merge
check('<< on object: shallow merge',
  `concrete a = { x: 1 }
concrete b = a << { y: 2 }`,
  (result) => {
    const b = result.scope.bindings.get('b');
    return b && b.resolved && b.value
      && b.value.x === 1 && b.value.y === 2;
  });

// 9. Block with stmt:type included
check('block with type-level binding still produces value bindings',
  `concrete f = () -> [
     type T = string
     concrete x = "hi"
     export { x }
   ]`,
  (result) => {
    const f = result.scope.bindings.get('f');
    if (!f || typeof f.value !== 'function') return false;
    const out = f.value();
    return out && out.x === 'hi';
  });

console.log();
console.log(`${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
