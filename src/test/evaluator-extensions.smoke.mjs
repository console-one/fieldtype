// evaluator-extensions.smoke.mjs — validates that fn / block / << calls
// produce the right FieldType shapes via fieldTypeFromExpression.

import { parse, fieldTypeFromExpression } from '../../dist/parse.js';

let pass = 0;
let fail = 0;

function check(label, source, predicate) {
  try {
    const stmts = parse(source);
    const last = stmts[stmts.length - 1];
    const expr = last.type === 'bind' ? last.expr : null;
    if (!expr) throw new Error('expected last stmt to be a bind');
    const ft = fieldTypeFromExpression(expr);
    const ok = predicate(ft, expr);
    if (ok === true) {
      pass++;
      console.log(`✓ ${label}`);
    } else {
      fail++;
      console.log(`✗ ${label} — predicate failed`);
      console.log('   ft fieldtype:', ft.fieldtype);
      console.log('   ft attrs:', JSON.stringify(ft.attributes, null, 2).slice(0, 300));
    }
  } catch (err) {
    fail++;
    console.log(`✗ ${label} — error: ${err.message}`);
  }
}

// 1. Function definition produces a function FT
check('fn → function FT',
  `concrete f = (x: string) -> [
     concrete y = x
   ]`,
  (ft) => ft.fieldtype === 'function');

// 2. Function param FT carries the parameter shape
check('fn param has the named-param shape',
  `concrete g = (chatID: string) -> [
     concrete inner = "x"
   ]`,
  (ft) => {
    if (ft.fieldtype !== 'function') return false;
    const paramAttr = (ft.attributes ?? []).find(
      (a) => a.constrainttype === 'param' && a.basetype === 'function',
    );
    if (!paramAttr) return false;
    const paramFt = paramAttr.value;
    if (!paramFt || paramFt.fieldtype !== 'object') return false;
    const props = (paramFt.attributes ?? []).filter(
      (a) => a.constrainttype === 'property',
    );
    return props.length === 1 && props[0].key === 'chatID';
  });

// 3. Block produces an object FT with bind statements as properties
check('block → object FT with bind properties',
  `concrete h = () -> [
     concrete a = 1
     concrete b = 2
   ]`,
  (ft) => {
    if (ft.fieldtype !== 'function') return false;
    const retAttr = (ft.attributes ?? []).find(
      (a) => a.constrainttype === 'returns' && a.basetype === 'function',
    );
    if (!retAttr) return false;
    const retFt = retAttr.value;
    if (!retFt || retFt.fieldtype !== 'object') return false;
    const props = (retFt.attributes ?? []).filter(
      (a) => a.constrainttype === 'property',
    );
    const keys = props.map((p) => p.key).sort();
    return keys.length === 2 && keys[0] === 'a' && keys[1] === 'b';
  });

// 4. `<<` at type-level produces a meet
check('string << values → meet (compose result)',
  `type s = string << values`,
  (ft) => {
    // compose(string, name'values') — values is unknown, becomes any
    // result should be string-shaped (since any meet string = string)
    return ft.fieldtype === 'string' || ft.fieldtype === 'and';
  });

// 5. `<<` of two literal-string types narrows to never
check('"a" << "b" narrows to never (incompatible literals)',
  `type s = "a" << "b"`,
  (ft) => ft.fieldtype === 'never');

// 6. Block with export filter still produces an object FT (filter is metadata)
check('block with export controls property visibility (FT carries all for now)',
  `concrete h = () -> [
     concrete a = 1
     concrete b = 2
     export { a }
   ]`,
  (ft) => {
    if (ft.fieldtype !== 'function') return false;
    const retAttr = (ft.attributes ?? []).find(
      (a) => a.constrainttype === 'returns' && a.basetype === 'function',
    );
    return retAttr && retAttr.value && retAttr.value.fieldtype === 'object';
  });

// 7. Nested function in a block — inner fn produces another function FT slot
check('nested fn → outer object has function-typed property',
  `concrete outer = () -> [
     concrete inner = (x: number) -> [
       concrete y = x
     ]
   ]`,
  (ft) => {
    if (ft.fieldtype !== 'function') return false;
    const retAttr = (ft.attributes ?? []).find(
      (a) => a.constrainttype === 'returns' && a.basetype === 'function',
    );
    if (!retAttr) return false;
    const retFt = retAttr.value;
    const innerProp = (retFt.attributes ?? []).find(
      (a) => a.constrainttype === 'property' && a.key === 'inner',
    );
    return innerProp && innerProp.value && innerProp.value.fieldtype === 'function';
  });

console.log();
console.log(`${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
