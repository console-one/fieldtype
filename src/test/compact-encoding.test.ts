/**
 * compact-encoding.test.ts — Round-trip tests for FieldType compact encoding.
 *
 * Contract: format(ft) → string → parse("_ = " + string) → Expression → fieldTypeFromExpression() → FieldType
 * The reconstructed FieldType must format() to the same string.
 *
 * If any test here fails, either format() produces unparseable output,
 * or fieldTypeFromExpression() can't reconstruct from the parsed AST.
 * Both are bugs.
 */

import { FieldType } from '../type.js';
import format from '../format.js';
import { parse, fieldTypeFromExpression, fromCompactJSON } from '../parse.js';

function roundTrip(ft: FieldType): string {
  const compact = format(ft);
  const stmts = parse(`_ = ${compact}`);
  expect(stmts.length).toBeGreaterThan(0);
  const rebuilt = fieldTypeFromExpression((stmts[0] as any).expr);
  return format(rebuilt);
}

describe('FieldType compact encoding round-trip', () => {
  // ── Primitives ──

  test('any', () => {
    const ft = FieldType.any.create();
    expect(roundTrip(ft)).toBe(format(ft));
  });

  test('string', () => {
    const ft = FieldType.string.create();
    expect(roundTrip(ft)).toBe(format(ft));
  });

  test('number', () => {
    const ft = FieldType.number.create();
    expect(roundTrip(ft)).toBe(format(ft));
  });

  test('boolean', () => {
    const ft = FieldType.boolean.create();
    expect(roundTrip(ft)).toBe(format(ft));
  });

  test('null', () => {
    const ft = FieldType.null.create();
    expect(roundTrip(ft)).toBe(format(ft));
  });

  // ── Literals ──

  test('string literal', () => {
    const ft = FieldType.string.create().literal('hello').save();
    expect(roundTrip(ft)).toBe(format(ft));
  });

  test('number literal', () => {
    const ft = FieldType.number.create().literal(42).save();
    expect(roundTrip(ft)).toBe(format(ft));
  });

  test('boolean literal', () => {
    const ft = FieldType.boolean.create().literal(true).save();
    expect(roundTrip(ft)).toBe(format(ft));
  });

  // ── Objects ──

  test('empty object', () => {
    const ft = FieldType.object.create();
    expect(roundTrip(ft)).toBe(format(ft));
  });

  test('object with properties', () => {
    const ft = FieldType.object.create()
      .property('name', FieldType.string.create())
      .property('age', FieldType.number.create())
      .save();
    expect(roundTrip(ft)).toBe(format(ft));
  });

  test('object with optional property', () => {
    const ft = FieldType.object.create()
      .property('name', FieldType.string.create())
      .property('email', FieldType.string.create(), { optional: true })
      .save();
    expect(roundTrip(ft)).toBe(format(ft));
  });

  // ── Arrays ──

  test('array of strings', () => {
    const ft = FieldType.array.create().values(FieldType.string.create()).save();
    expect(roundTrip(ft)).toBe(format(ft));
  });

  // ── Functions ──

  test('function any → any', () => {
    const ft = FieldType.function.create();
    expect(roundTrip(ft)).toBe(format(ft));
  });

  test('function string → number', () => {
    const ft = FieldType.function.create()
      .param(FieldType.string.create())
      .returns(FieldType.number.create())
      .save();
    expect(roundTrip(ft)).toBe(format(ft));
  });

  test('function with object param', () => {
    const ft = FieldType.function.create()
      .param(
        FieldType.object.create()
          .property('model', FieldType.string.create())
          .property('toolset', FieldType.string.create())
          .save()
      )
      .returns(FieldType.any.create())
      .save();
    expect(roundTrip(ft)).toBe(format(ft));
  });

  // ── Union ──

  test('string | number', () => {
    const ft = FieldType.or.create([
      FieldType.string.create(),
      FieldType.number.create(),
    ]);
    expect(roundTrip(ft)).toBe(format(ft));
  });

  // ── toJSON / fromCompactJSON ──

  test('toJSON returns compact form', () => {
    const ft = FieldType.function.create()
      .param(FieldType.string.create())
      .returns(FieldType.number.create())
      .save();
    const json = (ft as any).toJSON();
    expect(json).toHaveProperty('__ft');
    expect(typeof json.__ft).toBe('string');
    expect(json.__ft).toBe(format(ft));
  });

  test('fromCompactJSON reconstructs FieldType', () => {
    const ft = FieldType.object.create()
      .property('name', FieldType.string.create())
      .property('age', FieldType.number.create())
      .save();
    const json = (ft as any).toJSON();
    const rebuilt = fromCompactJSON(json);
    expect(format(rebuilt)).toBe(format(ft));
  });

  test('JSON.stringify uses compact form', () => {
    const ft = FieldType.string.create();
    const json = JSON.stringify(ft);
    const parsed = JSON.parse(json);
    expect(parsed).toEqual({ __ft: 'string' });
  });

  test('JSON.stringify of object containing FieldType', () => {
    const ft = FieldType.function.create()
      .param(FieldType.string.create())
      .returns(FieldType.any.create())
      .save();
    const obj = { myType: ft, name: 'test' };
    const json = JSON.stringify(obj);
    const parsed = JSON.parse(json);
    expect(parsed.myType.__ft).toBe(format(ft));
    expect(parsed.name).toBe('test');
  });
});

describe('FieldType compact encoding size reduction', () => {
  test('complex function type is compact', () => {
    const ft = FieldType.function.create()
      .param(
        FieldType.object.create()
          .property('model', FieldType.string.create())
          .property('toolset', FieldType.string.create(), { optional: true })
          .property('steps', FieldType.array.create().values(FieldType.string.create()).save())
          .save()
      )
      .returns(FieldType.any.create())
      .save();

    const compact = JSON.stringify((ft as any).toJSON());
    // The compact form should be well under 200 chars
    expect(compact.length).toBeLessThan(200);

    // Verify round-trip
    const rebuilt = fromCompactJSON((ft as any).toJSON());
    expect(format(rebuilt)).toBe(format(ft));
  });
});
