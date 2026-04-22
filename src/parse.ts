/**
 * parse.ts — Surface syntax parser for the chain/statement system.
 *
 * Accepts the CUE-style notation the formatter generates, plus statement-level
 * constructs (bind, import, export, annotate). An LLM reads formatted output →
 * writes continuations in the same syntax → parser converts back to Statement[].
 *
 * Exports:
 *   parse(input)          → Statement[]
 *   chainFromSyntax(input) → Chain
 */

import type {
  Statement, Expression, AnnotationNode,
} from './statement.js';
import { concrete, type_, ref, import_, export_, annotate, union_ } from './statement.js';
import { createChain, push } from './chain.js';
import type { Chain } from './chain.js';

// ─────────────────────────────────────────────────────────────────────────────
// Parse Error
// ─────────────────────────────────────────────────────────────────────────────

export class ParseError extends Error {
  line: number;
  col: number;
  constructor(message: string, line: number, col: number) {
    super(`${message} (line ${line}, col ${col})`);
    this.name = 'ParseError';
    this.line = line;
    this.col = col;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Token Types
// ─────────────────────────────────────────────────────────────────────────────

type TokenType =
  | 'ident' | 'string' | 'number' | 'boolean' | 'null'
  | 'type' | 'import' | 'export' | 'from' | 'except' | 'not' | 'int' | 'extends'
  | '=' | ':' | '?' | '&' | '|' | ',' | '.' | '(' | ')' | '{' | '}' | '[' | ']'
  | '*' | '>=' | '<=' | '>' | '<' | '=>' | '...' | '=~' | '%'
  | '---' | 'annotate_body'
  | 'newline' | 'eof';

type Token = {
  type: TokenType;
  value: string;
  line: number;
  col: number;
};

const KEYWORDS = new Set<TokenType>(['type', 'import', 'export', 'from', 'except', 'not', 'int', 'extends']);
const PRIMITIVE_KEYWORDS = new Set(['any', 'never', 'boolean', 'null', 'string', 'number', 'int']);

// ─────────────────────────────────────────────────────────────────────────────
// Tokenizer
// ─────────────────────────────────────────────────────────────────────────────

function tokenize(input: string): Token[] {
  const tokens: Token[] = [];
  let pos = 0;
  let line = 1;
  let col = 1;

  const peek = () => pos < input.length ? input[pos] : '';
  const peekAt = (offset: number) => pos + offset < input.length ? input[pos + offset] : '';
  const advance = () => {
    const ch = input[pos++];
    if (ch === '\n') { line++; col = 1; } else { col++; }
    return ch;
  };
  const emit = (type: TokenType, value: string, startLine: number, startCol: number) => {
    tokens.push({ type, value, line: startLine, col: startCol });
  };

  while (pos < input.length) {
    const startLine = line;
    const startCol = col;
    const ch = peek();

    // Whitespace (non-newline)
    if (ch === ' ' || ch === '\t' || ch === '\r') { advance(); continue; }

    // Newline
    if (ch === '\n') {
      advance();
      // Collapse consecutive newlines
      if (tokens.length === 0 || tokens[tokens.length - 1].type === 'newline') continue;
      emit('newline', '\n', startLine, startCol);
      continue;
    }

    // Comment: // to end of line
    if (ch === '/' && peekAt(1) === '/') {
      while (pos < input.length && peek() !== '\n') advance();
      continue;
    }

    // Annotation fence: ---
    if (ch === '-' && peekAt(1) === '-' && peekAt(2) === '-') {
      advance(); advance(); advance();
      // Skip rest of line (may have trailing whitespace)
      while (pos < input.length && peek() !== '\n') advance();
      emit('---', '---', startLine, startCol);

      // If the previous non-newline token wasn't '---', capture body
      const prevFence = tokens.findIndex(t => t.type === '---');
      if (prevFence >= 0 && prevFence < tokens.length - 1) {
        // This is the closing fence — body was already captured
        continue;
      }

      // Opening fence — capture body until next ---
      if (pos < input.length && peek() === '\n') advance(); // skip newline after opening ---
      let body = '';
      while (pos < input.length) {
        if (peek() === '-' && peekAt(1) === '-' && peekAt(2) === '-') {
          // Check it's start of line (body already trimmed)
          advance(); advance(); advance();
          while (pos < input.length && peek() !== '\n') advance();
          break;
        }
        body += advance();
      }
      // Remove trailing newline from body
      if (body.endsWith('\n')) body = body.slice(0, -1);
      emit('annotate_body', body, startLine + 1, 1);
      continue;
    }

    // Spread / dots
    if (ch === '.' && peekAt(1) === '.' && peekAt(2) === '.') {
      advance(); advance(); advance();
      emit('...', '...', startLine, startCol);
      continue;
    }
    if (ch === '.') { advance(); emit('.', '.', startLine, startCol); continue; }

    // Multi-char operators
    if (ch === '=' && peekAt(1) === '>') { advance(); advance(); emit('=>', '=>', startLine, startCol); continue; }
    if (ch === '=' && peekAt(1) === '~') { advance(); advance(); emit('=~', '=~', startLine, startCol); continue; }
    if (ch === '>' && peekAt(1) === '=') { advance(); advance(); emit('>=', '>=', startLine, startCol); continue; }
    if (ch === '<' && peekAt(1) === '=') { advance(); advance(); emit('<=', '<=', startLine, startCol); continue; }

    // Single-char operators
    if ('=:?&|,(){}[]*%><'.includes(ch)) {
      advance();
      emit(ch as TokenType, ch, startLine, startCol);
      continue;
    }

    // String literal
    if (ch === '"' || ch === "'") {
      const quote = ch;
      advance(); // skip opening quote
      let value = '';
      while (pos < input.length && peek() !== quote) {
        if (peek() === '\\') {
          advance(); // skip backslash
          const esc = advance();
          if (esc === 'n') value += '\n';
          else if (esc === 't') value += '\t';
          else if (esc === '\\') value += '\\';
          else if (esc === quote) value += quote;
          else value += esc;
        } else {
          value += advance();
        }
      }
      if (pos >= input.length) throw new ParseError('Unterminated string literal', startLine, startCol);
      advance(); // skip closing quote
      emit('string', value, startLine, startCol);
      continue;
    }

    // Number literal (including negative)
    if (ch >= '0' && ch <= '9' || (ch === '-' && peekAt(1) >= '0' && peekAt(1) <= '9')) {
      let num = '';
      if (ch === '-') num += advance();
      while (pos < input.length && peek() >= '0' && peek() <= '9') num += advance();
      if (pos < input.length && peek() === '.' && peekAt(1) >= '0' && peekAt(1) <= '9') {
        num += advance(); // dot
        while (pos < input.length && peek() >= '0' && peek() <= '9') num += advance();
      }
      emit('number', num, startLine, startCol);
      continue;
    }

    // Identifier / keyword
    if (ch === '_' || ch === '$' || (ch >= 'a' && ch <= 'z') || (ch >= 'A' && ch <= 'Z')) {
      let id = '';
      while (pos < input.length && (peek() === '_' || peek() === '$' || (peek() >= 'a' && peek() <= 'z') || (peek() >= 'A' && peek() <= 'Z') || (peek() >= '0' && peek() <= '9'))) {
        id += advance();
      }
      if (id === 'true' || id === 'false') {
        emit('boolean', id, startLine, startCol);
      } else if (id === 'null') {
        emit('null', id, startLine, startCol);
      } else if (KEYWORDS.has(id as TokenType)) {
        emit(id as TokenType, id, startLine, startCol);
      } else {
        emit('ident', id, startLine, startCol);
      }
      continue;
    }

    throw new ParseError(`Unexpected character: ${ch}`, line, col);
  }

  // Ensure trailing newline token is removed
  if (tokens.length > 0 && tokens[tokens.length - 1].type === 'newline') {
    tokens.pop();
  }
  emit('eof', '', line, col);
  return tokens;
}

// ─────────────────────────────────────────────────────────────────────────────
// Parser
// ─────────────────────────────────────────────────────────────────────────────

class Parser {
  private tokens: Token[];
  private pos = 0;

  constructor(tokens: Token[]) {
    this.tokens = tokens;
  }

  // ── helpers ──

  private peek(): Token { return this.tokens[this.pos]; }

  private advance(): Token { return this.tokens[this.pos++]; }

  private match(type: TokenType): Token | null {
    if (this.peek().type === type) return this.advance();
    return null;
  }

  private expect(type: TokenType): Token {
    const tok = this.peek();
    if (tok.type !== type) {
      throw new ParseError(`Expected '${type}', got '${tok.type}' (${tok.value})`, tok.line, tok.col);
    }
    return this.advance();
  }

  private skipNewlines(): void {
    while (this.peek().type === 'newline') this.advance();
  }

  private isAtEnd(): boolean {
    return this.peek().type === 'eof';
  }

  // ── top level ──

  parseProgram(): Statement[] {
    const stmts: Statement[] = [];
    this.skipNewlines();
    while (!this.isAtEnd()) {
      stmts.push(this.parseStatement());
      this.skipNewlines();
    }
    return stmts;
  }

  // ── statement dispatch ──

  private parseStatement(): Statement {
    const tok = this.peek();

    switch (tok.type) {
      case 'import': return this.parseImport();
      case 'export': return this.parseExport();
      case 'type': return this.parseTypeBind();
      case '---': return this.parseAnnotation();
      default: return this.parseBindOrRef();
    }
  }

  // ── import ──

  private parseImport(): Statement {
    this.expect('import');

    // import './module'
    if (this.peek().type === 'string') {
      const source = this.advance().value;
      return import_(source);
    }

    // import { a, b } from './m.js'
    if (this.peek().type === '{') {
      this.advance(); // {
      const names: string[] = [];
      while (this.peek().type !== '}') {
        names.push(this.expectIdent());
        if (this.peek().type === ',') this.advance();
      }
      this.expect('}');
      this.expect('from');
      const source = this.expect('string').value;
      return import_(source, { names });
    }

    // import * from './m.js'
    if (this.peek().type === '*') {
      this.advance();
      this.expect('from');
      const source = this.expect('string').value;
      return import_(source);
    }

    const next = this.peek();
    throw new ParseError('Expected string, { or * after import', next.line, next.col);
  }

  // ── export ──

  private parseExport(): Statement {
    this.expect('export');

    // export { a, b }
    if (this.peek().type === '{') {
      this.advance();
      const names: string[] = [];
      while (this.peek().type !== '}') {
        names.push(this.expectIdent());
        if (this.peek().type === ',') this.advance();
      }
      this.expect('}');
      return export_(names);
    }

    // export * OR export * except { a }
    if (this.peek().type === '*') {
      this.advance();
      if (this.peek().type === 'except') {
        this.advance();
        this.expect('{');
        const except: string[] = [];
        while (this.peek().type !== '}') {
          except.push(this.expectIdent());
          if (this.peek().type === ',') this.advance();
        }
        this.expect('}');
        return export_('*', { except });
      }
      return export_('*');
    }

    throw new ParseError('Expected { or * after export', this.peek().line, this.peek().col);
  }

  // ── type bind ──

  private parseTypeBind(): Statement {
    this.expect('type');
    const name = this.expectIdent();
    this.expect('=');
    const expr = this.parseExpression();
    return type_(name, expr);
  }

  // ── annotation ──

  private parseAnnotation(): Statement {
    this.expect('---');
    let body = '';
    if (this.peek().type === 'annotate_body') {
      body = this.advance().value;
    }
    const node: AnnotationNode = { kind: 'text', content: body };
    return annotate([node]);
  }

  // ── bind or ref gate ──

  private parseBindOrRef(): Statement {
    const name = this.expectIdent();

    // name?: Type  (optional ref gate)
    if (this.peek().type === '?') {
      this.advance();
      this.expect(':');
      const typeExpr = this.parseExpression();
      const stmt = concrete(name, ref(exprToRefSource(typeExpr)));
      stmt.scope = 'optional';
      // Check for default: = value
      if (this.peek().type === '=') {
        this.advance();
        stmt.default = this.parseExpression();
      }
      return stmt;
    }

    // name: Type [= default]  (ref gate)
    if (this.peek().type === ':') {
      this.advance();
      const typeExpr = this.parseExpression();
      const stmt = concrete(name, ref(exprToRefSource(typeExpr)));
      // Check for default: = value
      if (this.peek().type === '=') {
        this.advance();
        stmt.default = this.parseExpression();
      }
      return stmt;
    }

    // name = expr  (concrete bind)
    if (this.peek().type === '=') {
      this.advance();
      const expr = this.parseExpression();
      return concrete(name, expr);
    }

    throw new ParseError(
      `Expected ':', '=', or '?' after identifier '${name}'`,
      this.peek().line,
      this.peek().col,
    );
  }

  // ── expressions (precedence climbing) ──

  private parseExpression(): Expression {
    return this.parseUnion();
  }

  // Lowest precedence: union (|)
  private parseUnion(): Expression {
    let left = this.parseIntersect();
    if (this.peek().type === '|') {
      const members: Expression[] = [left];
      while (this.match('|')) {
        members.push(this.parseIntersect());
      }
      return union_(members);
    }
    return left;
  }

  // Intersect (&)
  private parseIntersect(): Expression {
    let left = this.parseUnary();
    while (this.peek().type === '&') {
      this.advance();
      const right = this.parseUnary();
      left = { type: 'intersect', left, right };
    }
    return left;
  }

  // Unary: not T
  private parseUnary(): Expression {
    if (this.peek().type === 'not') {
      this.advance();
      const operand = this.parsePostfix();
      return { type: 'call', fn: 'not', args: [operand] };
    }
    return this.parsePostfix();
  }

  // Postfix: function calls, extends
  private parsePostfix(): Expression {
    let expr = this.parseAtom();

    // Var with bound: T extends Bound
    if (this.peek().type === 'extends' && expr.type === 'name') {
      this.advance();
      const bound = this.parseAtom();
      return { type: 'call', fn: 'var', args: [expr, bound] };
    }

    // Call: name(args) or name.prop(args)
    while (this.peek().type === '(' || this.peek().type === '.') {
      if (this.peek().type === '.') {
        this.advance();
        const prop = this.expectIdent();
        if (expr.type === 'name') {
          expr = { type: 'name', id: `${expr.id}.${prop}` };
        } else {
          expr = { type: 'call', fn: '.', args: [expr, { type: 'name', id: prop }] };
        }
        continue;
      }

      // Call: expr(args)
      if (this.peek().type === '(') {
        // Don't consume paren if this is the start of a function type
        // at statement level — we only call if expr is already a name/call
        if (expr.type !== 'name' && expr.type !== 'call') break;
        this.advance(); // (
        const args = this.parseCallArgs();
        this.expect(')');
        const fn = expr.type === 'name' ? expr.id : expr;
        expr = { type: 'call', fn, args };
      }
    }

    return expr;
  }

  // Call arguments: positional or named
  private parseCallArgs(): Expression[] {
    if (this.peek().type === ')') return [];

    this.skipNewlines();

    // Detect named args: ident = expr (not ==, =>, =~)
    const isNamed = this.peek().type === 'ident' &&
      this.pos + 1 < this.tokens.length &&
      this.tokens[this.pos + 1].type === '=';

    if (isNamed) {
      // Named args → collect as single ObjectExpr
      const properties: Record<string, Expression> = {};
      while (this.peek().type !== ')' && this.peek().type !== 'eof') {
        this.skipNewlines();
        const key = this.expectIdent();
        this.expect('=');
        const value = this.parseExpression();
        properties[key] = value;
        if (this.peek().type === ',') this.advance();
        this.skipNewlines();
      }
      return [{ type: 'object', properties }];
    }

    // Positional args
    const args: Expression[] = [];
    while (this.peek().type !== ')' && this.peek().type !== 'eof') {
      this.skipNewlines();
      args.push(this.parseExpression());
      if (this.peek().type === ',') this.advance();
      this.skipNewlines();
    }
    return args;
  }

  // ── atoms ──

  private parseAtom(): Expression {
    const tok = this.peek();

    // Primitives: any, never, boolean, null, string, number
    if (tok.type === 'ident' && PRIMITIVE_KEYWORDS.has(tok.value)) {
      this.advance();
      return { type: 'name', id: tok.value };
    }
    if (tok.type === 'int') {
      this.advance();
      return { type: 'name', id: 'int' };
    }

    // Boolean literal
    if (tok.type === 'boolean') {
      this.advance();
      return { type: 'literal', value: tok.value === 'true' };
    }

    // Null literal
    if (tok.type === 'null') {
      this.advance();
      return { type: 'literal', value: null };
    }

    // String literal
    if (tok.type === 'string') {
      this.advance();
      return { type: 'literal', value: tok.value };
    }

    // Number literal
    if (tok.type === 'number') {
      this.advance();
      const val = tok.value.includes('.') ? parseFloat(tok.value) : parseInt(tok.value, 10);
      return { type: 'literal', value: val };
    }

    // Comparison operators as names (for constraint context: >=5 etc.)
    if (tok.type === '>=' || tok.type === '<=' || tok.type === '>' || tok.type === '<') {
      this.advance();
      const operand = this.parseAtom();
      return { type: 'call', fn: tok.value, args: [operand] };
    }

    // Modulo constraint: %(N)
    if (tok.type === '%') {
      this.advance();
      this.expect('(');
      const operand = this.parseExpression();
      this.expect(')');
      return { type: 'call', fn: '%', args: [operand] };
    }

    // =~ "pattern"
    if (tok.type === '=~') {
      this.advance();
      const pattern = this.expect('string');
      return { type: 'call', fn: '=~', args: [{ type: 'literal', value: pattern.value }] };
    }

    // Identifier (includes keywords allowed as names in expression position)
    if (tok.type === 'ident' || tok.type === 'from' || tok.type === 'except') {
      this.advance();
      return { type: 'name', id: tok.value };
    }

    // Parenthesized expression, or function type (Param) => Return
    if (tok.type === '(') {
      this.advance();
      this.skipNewlines();

      // Empty parens: ()
      if (this.peek().type === ')') {
        this.advance();
        // () => Return is a function type with 'any' param
        if (this.peek().type === '=>') {
          this.advance();
          const ret = this.parseExpression();
          return { type: 'call', fn: '=>', args: [{ type: 'name', id: 'any' }, ret] };
        }
        // Just empty parens — unit/void
        return { type: 'object', properties: {} };
      }

      const inner = this.parseExpression();
      this.skipNewlines();
      this.expect(')');

      // Function type: (Param) => Return
      if (this.peek().type === '=>') {
        this.advance();
        const ret = this.parseExpression();
        return { type: 'call', fn: '=>', args: [inner, ret] };
      }

      return inner;
    }

    // Object: { key: type, ... }
    if (tok.type === '{') {
      return this.parseObject();
    }

    // Array/Tuple: [...]
    if (tok.type === '[') {
      return this.parseArrayOrTuple();
    }

    // Spread: ...T (in array context usually, but can appear as expression)
    if (tok.type === '...') {
      this.advance();
      const inner = this.parseAtom();
      return { type: 'call', fn: '...', args: [inner] };
    }

    throw new ParseError(
      `Unexpected token '${tok.value}' (${tok.type})`,
      tok.line,
      tok.col,
    );
  }

  // ── object ──

  private parseObject(): Expression {
    this.expect('{');
    this.skipNewlines();
    const properties: Record<string, Expression> = {};
    const optionals = new Set<string>();
    const defaults = new Map<string, Expression>();

    while (this.peek().type !== '}' && this.peek().type !== 'eof') {
      this.skipNewlines();
      if (this.peek().type === '}') break;

      const key = this.expectIdent();
      let optional = false;

      if (this.peek().type === '?') {
        this.advance();
        optional = true;
      }

      this.expect(':');
      const value = this.parseExpression();
      properties[key] = value;
      if (optional) optionals.add(key);

      // Default value
      if (this.peek().type === '=') {
        this.advance();
        defaults.set(key, this.parseExpression());
      }

      // Skip separator (comma or newline)
      if (this.peek().type === ',') this.advance();
      this.skipNewlines();
    }
    this.expect('}');

    // Encode optionals + defaults into the expression tree
    // For now, optional/default metadata is encoded by wrapping the value
    // in a structured way the consumer can extract
    const result: Expression = { type: 'object', properties };

    // Store optional/default info as metadata on the object
    if (optionals.size > 0 || defaults.size > 0) {
      const meta: Record<string, Expression> = { ...properties };
      for (const [key, def] of defaults) {
        // Wrap value with default: intersect(value, call('default', [defValue]))
        meta[key] = {
          type: 'intersect',
          left: properties[key],
          right: { type: 'call', fn: 'default', args: [def] },
        };
      }
      for (const key of optionals) {
        if (defaults.has(key)) continue; // already handled
        // Wrap optional: intersect(value, call('optional', []))
        meta[key] = {
          type: 'intersect',
          left: properties[key],
          right: { type: 'call', fn: 'optional', args: [] },
        };
      }
      return { type: 'object', properties: meta };
    }

    return result;
  }

  // ── array / tuple ──

  private parseArrayOrTuple(): Expression {
    this.expect('[');
    this.skipNewlines();

    // Empty array: []
    if (this.peek().type === ']') {
      this.advance();
      return { type: 'literal', value: [] };
    }

    // Spread array: [...T]
    if (this.peek().type === '...') {
      this.advance();
      const inner = this.parseExpression();
      this.skipNewlines();
      this.expect(']');
      return { type: 'call', fn: 'Array', args: [inner] };
    }

    // Parse first element
    const elements: Expression[] = [];
    elements.push(this.parseExpression());

    // Check if this might be optional (for tuples)
    let hasOptional = false;
    if (this.peek().type === '?') {
      this.advance();
      hasOptional = true;
      // Wrap in optional marker
      elements[0] = { type: 'call', fn: 'optional', args: [elements[0]] };
    }

    // Collect remaining elements
    while (this.peek().type === ',' && this.peek().type !== 'eof') {
      this.advance(); // comma
      this.skipNewlines();
      if (this.peek().type === ']') break;

      // Spread in tail: ..., ...T]
      if (this.peek().type === '...') {
        this.advance();
        const rest = this.parseExpression();
        elements.push({ type: 'call', fn: '...', args: [rest] });
        this.skipNewlines();
        break;
      }

      let elem = this.parseExpression();
      if (this.peek().type === '?') {
        this.advance();
        hasOptional = true;
        elem = { type: 'call', fn: 'optional', args: [elem] };
      }
      elements.push(elem);
    }
    this.skipNewlines();
    this.expect(']');

    // Distinguish: all literals → literal array, otherwise → tuple
    const allLiterals = elements.every(e => e.type === 'literal');
    if (allLiterals && !hasOptional) {
      return { type: 'literal', value: elements.map(e => (e as any).value) };
    }

    // Tuple
    return { type: 'call', fn: 'Tuple', args: elements };
  }

  // ── helpers ──

  /** Expect any identifier-like token (including keywords valid as names). */
  private expectIdent(): string {
    const tok = this.peek();
    // Allow keywords to be used as property keys
    if (tok.type === 'ident' || tok.type === 'from' || tok.type === 'except' ||
        tok.type === 'not' || tok.type === 'type' || tok.type === 'import' ||
        tok.type === 'export' || tok.type === 'extends' || tok.type === 'int') {
      this.advance();
      return tok.value;
    }
    throw new ParseError(`Expected identifier, got '${tok.type}' (${tok.value})`, tok.line, tok.col);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Convert a type expression to a ref source string.
 * For simple name expressions, extracts the string directly.
 * For complex expressions, keeps the expression itself.
 */
function exprToRefSource(expr: Expression): string | Expression {
  if (expr.type === 'name') return expr.id;
  return expr;
}

// ─────────────────────────────────────────────────────────────────────────────
// Public API
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Parse surface syntax into Statement[].
 *
 * Accepts the CUE-style notation the formatter generates, plus statement-level
 * constructs for binds, imports, exports, and annotations.
 */
export function parse(input: string): Statement[] {
  const tokens = tokenize(input);
  const parser = new Parser(tokens);
  return parser.parseProgram();
}

/**
 * Parse surface syntax and build a Chain.
 *
 * Convenience: parse(input) → createChain() + push() for each statement.
 */
export function chainFromSyntax(input: string, constructor?: string): Chain {
  const stmts = parse(input);
  let chain = createChain(constructor ?? 'object');
  for (const stmt of stmts) {
    chain = push(chain, stmt);
  }
  return chain;
}

// ─────────────────────────────────────────────────────────────────────────────
// FieldType reconstruction from Expression AST
// ─────────────────────────────────────────────────────────────────────────────

import { FieldType } from './type.js';

/**
 * Convert a parsed Expression AST node back to a FieldType.
 *
 * This closes the round-trip: format() → string → parse() → Expression → fieldTypeFromExpression() → FieldType.
 * If parse() can parse it, this function must reconstruct it. If it can't, the encoding is broken.
 */
export function fieldTypeFromExpression(expr: Expression): FieldType {
  switch (expr.type) {
    case 'name':
      return nameToFieldType(expr.id);

    case 'literal':
      return literalToFieldType(expr.value);

    case 'object':
      return objectExprToFieldType(expr.properties);

    case 'call':
      return callExprToFieldType(expr.fn, expr.args);

    case 'intersect':
      return FieldType.compose(
        fieldTypeFromExpression(expr.left),
        fieldTypeFromExpression(expr.right),
      );

    case 'union':
      return FieldType.or.create(expr.members.map(fieldTypeFromExpression));

    case 'fieldtype':
      // Already a FieldType-shaped expression — pass through
      return FieldType.create(expr.fieldtype, expr.attributes ?? []) as FieldType;

    case 'ref':
      // Ref expressions don't map to FieldTypes directly — return any
      return FieldType.any.create();
  }
}

function nameToFieldType(id: string): FieldType {
  switch (id) {
    case 'string':  return FieldType.string.create();
    case 'number':  return FieldType.number.create();
    case 'boolean': return FieldType.boolean.create();
    case 'any':     return FieldType.any.create();
    case 'never':   return FieldType.never.create({});
    case 'null':    return FieldType.null.create();
    case 'int':     return FieldType.number.create().integer().save();
    default:
      // Unknown name — treat as any (could be a var reference)
      return FieldType.any.create();
  }
}

function literalToFieldType(value: any): FieldType {
  if (value === null) return FieldType.null.create();
  if (typeof value === 'boolean') return FieldType.boolean.create().literal(value).save();
  if (typeof value === 'string') return FieldType.string.create().literal(value).save();
  if (typeof value === 'number') {
    return Number.isInteger(value)
      ? FieldType.number.create().integer().literal(value).save()
      : FieldType.number.create().literal(value).save();
  }
  if (Array.isArray(value)) return FieldType.array.create().literal(value).save();
  if (typeof value === 'object') return FieldType.object.create().literal(value).save();
  return FieldType.any.create().literal(value).save();
}

function objectExprToFieldType(properties: Record<string, Expression>): FieldType {
  let ft = FieldType.object.create();
  for (const [key, valExpr] of Object.entries(properties)) {
    // Check for optional/default wrappers (produced by parser for key?: type)
    let propType: FieldType;
    let optional = false;
    let defaultValue: unknown;

    if (valExpr.type === 'intersect') {
      // Unwrap: intersect(type, call('optional', [])) or intersect(type, call('default', [val]))
      const left = valExpr.left;
      const right = valExpr.right;
      if (right.type === 'call' && right.fn === 'optional') {
        propType = fieldTypeFromExpression(left);
        optional = true;
      } else if (right.type === 'call' && right.fn === 'default') {
        propType = fieldTypeFromExpression(left);
        optional = true;
        defaultValue = right.args[0]?.type === 'literal' ? (right.args[0] as any).value : undefined;
      } else {
        propType = fieldTypeFromExpression(valExpr);
      }
    } else {
      propType = fieldTypeFromExpression(valExpr);
    }

    ft = ft.property(key, propType, {
      ...(optional ? { optional: true } : {}),
      ...(defaultValue !== undefined ? { default: defaultValue } : {}),
    });
  }
  return ft.save();
}

function callExprToFieldType(fn: string | Expression, args: Expression[]): FieldType {
  // Function type: (param) => return
  if (fn === '=>') {
    let ft = FieldType.function.create();
    if (args[0]) ft = ft.param(fieldTypeFromExpression(args[0]));
    if (args[1]) ft = ft.returns(fieldTypeFromExpression(args[1]));
    return ft.save();
  }

  // Array: Array(elementType) — from [...T] syntax
  if (fn === 'Array') {
    const elemType = args[0] ? fieldTypeFromExpression(args[0]) : FieldType.any.create();
    return FieldType.array.create().values(elemType).save();
  }

  // Tuple: Tuple(T1, T2, ...)
  if (fn === 'Tuple') {
    let ft = FieldType.array.create();
    for (let i = 0; i < args.length; i++) {
      const arg = args[i];
      // Spread element: call('...', [innerType])
      if (arg.type === 'call' && arg.fn === '...') {
        const restType = fieldTypeFromExpression(arg.args[0]);
        ft = ft.values(restType);
      } else {
        // Optional: call('optional', [innerType])
        const isOptional = arg.type === 'call' && arg.fn === 'optional';
        const elemType = isOptional ? fieldTypeFromExpression(arg.args[0]) : fieldTypeFromExpression(arg);
        ft = ft.index(elemType, [i]);
      }
    }
    return ft.save();
  }

  // Not type: not(T)
  if (fn === 'not') {
    return FieldType.not.create(fieldTypeFromExpression(args[0]));
  }

  // Spread (rest): ...(T)
  if (fn === '...') {
    const inner = args[0] ? fieldTypeFromExpression(args[0]) : FieldType.any.create();
    return FieldType.array.create().values(inner).save();
  }

  // Var: var(name, bound?)
  if (fn === 'var') {
    const name = args[0]?.type === 'name' ? (args[0] as any).id : '?';
    const bound = args[1] ? fieldTypeFromExpression(args[1]) : undefined;
    return FieldType.var.create({ name, bound });
  }

  // Number constraints: >=, <=, >, <
  if (fn === '>=' || fn === '<=' || fn === '>' || fn === '<') {
    const val = args[0]?.type === 'literal' ? (args[0] as any).value : 0;
    let ft = FieldType.number.create();
    if (fn === '>=' || fn === '>') ft = ft.min(val);
    if (fn === '<=' || fn === '<') ft = ft.max(val);
    return ft.save();
  }

  // Regex match: =~(pattern)
  if (fn === '=~') {
    const pattern = args[0]?.type === 'literal' ? String((args[0] as any).value) : '';
    return FieldType.string.create().matches(new RegExp(pattern)).save();
  }

  // Modulo: %(n)
  if (fn === '%') {
    // multipleOf constraint — not directly available via fluent API, return number
    return FieldType.number.create();
  }

  // Named function calls like list.MinItems, list.MaxItems, has(), len()
  if (typeof fn === 'string') {
    // has("value") — string includes constraint
    if (fn === 'has' && args[0]?.type === 'literal') {
      return FieldType.string.create().includes(String((args[0] as any).value)).save();
    }

    // len(constraints) — string length
    if (fn === 'len') {
      let ft = FieldType.string.create();
      // Args could be >=N, <=N, or named min/max
      for (const arg of args) {
        if (arg.type === 'call' && arg.fn === '>=' && arg.args[0]?.type === 'literal') {
          ft = ft.length({ min: (arg.args[0] as any).value });
        }
        if (arg.type === 'call' && arg.fn === '<=' && arg.args[0]?.type === 'literal') {
          ft = ft.length({ max: (arg.args[0] as any).value });
        }
      }
      return ft.save();
    }
  }

  // Fallback: unknown call — return any
  return FieldType.any.create();
}

// ─────────────────────────────────────────────────────────────────────────────
// Compact JSON round-trip
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Reconstruct a FieldType from its compact JSON form.
 *
 * FieldType.toJSON() produces { __ft: "(string) => any" }.
 * This function parses the CUE string back into a FieldType.
 *
 * Contract: format(fromCompactJSON(ft.toJSON())) === format(ft)
 */
export function fromCompactJSON(json: { __ft: string }): FieldType {
  if (!json || typeof json.__ft !== 'string') {
    throw new ParseError('Expected { __ft: string }', 0, 0);
  }
  const text = json.__ft;
  // Wrap in a binding statement so the parser has something to parse
  const stmts = parse(`_ = ${text}`);
  if (stmts.length === 0 || stmts[0].type !== 'bind') {
    throw new ParseError('Failed to parse compact FieldType', 0, 0);
  }
  return fieldTypeFromExpression((stmts[0] as any).expr);
}
