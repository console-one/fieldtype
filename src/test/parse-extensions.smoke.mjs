// parse-extensions.smoke.mjs — validate the parser extensions against
// chat-scope-shaped chain text. Run via `node src/test/parse-extensions.smoke.mjs`
// after `npm run build`.
//
// Validates:
//   - `concrete` keyword as explicit alias for default-level bind
//   - `<<` operator at type and value level
//   - `() -> [block]` no-arg function definition
//   - `(name: T) -> [block]` typed-param function definition
//   - `[concrete X = Y; ...]` block expressions
//   - `[...T] & max N` array-spread + intersect (already supported)
//   - Nesting of all of the above

import { parse } from '../../dist/parse.js';

let pass = 0;
let fail = 0;

function check(label, source, predicate) {
  try {
    const stmts = parse(source);
    const ok = predicate(stmts);
    if (ok === true) {
      pass++;
      console.log(`✓ ${label}`);
    } else {
      fail++;
      console.log(`✗ ${label} — predicate failed`);
      console.log('   ast:', JSON.stringify(stmts, null, 2).slice(0, 400));
    }
  } catch (err) {
    fail++;
    console.log(`✗ ${label} — parse error: ${err.message}`);
  }
}

// 1. Explicit concrete keyword
check('concrete X = Y',
  `concrete X = "hello"`,
  (stmts) => stmts.length === 1 && stmts[0].type === 'bind' && stmts[0].level === 'concrete' && stmts[0].name === 'X');

// 2. concrete X: Type (gap form)
check('concrete X: Type',
  `concrete X: string`,
  (stmts) => stmts.length === 1 && stmts[0].type === 'bind' && stmts[0].level === 'concrete' && stmts[0].name === 'X');

// 3. <<  at type level (string << values)
check('string << values',
  `type status = string << statusValues`,
  (stmts) => stmts.length === 1 && stmts[0].type === 'bind' && stmts[0].level === 'type'
    && stmts[0].expr.type === 'call' && stmts[0].expr.fn === '<<');

// 4. <<  at value level (resolution.messages << message)
check('messages << message (concrete RHS)',
  `concrete accepted = messages << newMessage`,
  (stmts) => stmts.length === 1 && stmts[0].type === 'bind' && stmts[0].level === 'concrete'
    && stmts[0].expr.type === 'call' && stmts[0].expr.fn === '<<');

// 5. No-arg function definition
check('() -> [...]',
  `concrete f = () -> [
     concrete x = 1
   ]`,
  (stmts) => stmts.length === 1 && stmts[0].expr.type === 'call' && stmts[0].expr.fn === 'fn'
    && stmts[0].expr.args.length === 2
    && stmts[0].expr.args[1].type === 'call' && stmts[0].expr.args[1].fn === 'block');

// 6. Typed-param function definition
check('(chatID: string) -> [...]',
  `concrete g = (chatID: string) -> [
     concrete y = 2
   ]`,
  (stmts) => {
    const e = stmts[0].expr;
    return e.type === 'call' && e.fn === 'fn'
      && e.args[0].type === 'object'
      && Object.keys(e.args[0].properties).includes('chatID');
  });

// 7. Block expression contains multiple statements
check('block with multiple statements',
  `concrete h = () -> [
     concrete a = 1
     concrete b = 2
     export { a, b }
   ]`,
  (stmts) => {
    const block = stmts[0].expr.args[1];
    return block.type === 'call' && block.fn === 'block' && block.args.length === 3;
  });

// 8. Array spread + intersect (existing but verify still works)
check('[...T] & max N still parses',
  `type Bounded = [...string] & max(5)`,
  (stmts) => stmts.length === 1 && stmts[0].type === 'bind' && stmts[0].level === 'type'
    && stmts[0].expr.type === 'intersect');

// 9. Nested function definitions inside a block
check('nested function definitions',
  `concrete outer = () -> [
     concrete inner = () -> [
       concrete x = 1
     ]
   ]`,
  (stmts) => {
    const outerBlock = stmts[0].expr.args[1];
    const innerStmt = outerBlock.args[0];
    // innerStmt is stmt:concrete encoded
    return innerStmt.fn === 'stmt:concrete';
  });

// 10. Import statement followed by concrete bindings — full preamble
check('preamble: import + concrete',
  `import { ChatConfigScope } from './schemas'
concrete configs: ChatConfigScope`,
  (stmts) => stmts.length === 2 && stmts[0].type === 'import' && stmts[1].type === 'bind' && stmts[1].level === 'concrete');

// 11. Return value table inside block (with calls)
check('block with calls: ref(...) and similar',
  `concrete f = () -> [
     concrete chatpath = join("chats", chatID)
     concrete resolution = ref(chatpath)
     export { resolution }
   ]`,
  (stmts) => {
    const block = stmts[0].expr.args[1];
    return block.fn === 'block' && block.args.length === 3;
  });

// 12. << is left-associative (a << b << c parses as ((a << b) << c))
check('<< left-associative',
  `concrete chained = a << b << c`,
  (stmts) => {
    const e = stmts[0].expr;
    return e.fn === '<<' && e.args[0].type === 'call' && e.args[0].fn === '<<';
  });

console.log();
console.log(`${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
