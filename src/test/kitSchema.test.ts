/**
 * kitSchema.test.ts — Tests for kitSchemaFromMissing + blockEntries
 *
 * Verifies the bridge from MissingRequirement[] (graph compilation output)
 * to block FieldType (typed form schema), and the decomposition back into
 * UI-friendly entries via blockEntries().
 */

import { types } from '../builders.js';
import { FieldType } from '../type.js';
import { kitSchemaFromMissing } from '../patchResolve.js';
import { blockEntries } from '../find.js';
import { arrayNamed } from '../find.js';
import type { MissingRequirement } from '../missingRequirement.js';
import type { FieldTypeCreationEvent } from '../event.js';

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

function makeMissing(overrides: Partial<MissingRequirement> & { path: string }): MissingRequirement {
  return {
    expectedType: 'string',
    constraintSource: [],
    kind: 'ref',
    ...overrides,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// kitSchemaFromMissing
// ─────────────────────────────────────────────────────────────────────────────

describe('kitSchemaFromMissing', () => {
  it('converts MissingRequirement[] with expectedSchema → block with typed assignments', () => {
    const stringSchema = types.string().toEvent() as FieldTypeCreationEvent;
    const numberSchema = types.number().toEvent() as FieldTypeCreationEvent;

    const missing: MissingRequirement[] = [
      makeMissing({ path: 'apiKey', expectedType: 'secret', expectedSchema: stringSchema, description: 'API Key' }),
      makeMissing({ path: 'maxRetries', expectedType: 'number', expectedSchema: numberSchema, description: 'Max retries' }),
    ];

    const block = kitSchemaFromMissing(missing);

    expect(block.fieldtype).toBe('array');
    const named = arrayNamed(block);
    expect(named).toHaveLength(2);

    expect(named[0].key).toBe('apiKey');
    expect(named[0].reason).toBe('API Key');
    expect((named[0].value as FieldType).fieldtype).toBe('string');

    expect(named[1].key).toBe('maxRetries');
    expect(named[1].reason).toBe('Max retries');
    expect((named[1].value as FieldType).fieldtype).toBe('number');
  });

  it('converts MissingRequirement[] without expectedSchema → block with string fallback', () => {
    const missing: MissingRequirement[] = [
      makeMissing({ path: 'token', expectedType: 'secret' }),
    ];

    const block = kitSchemaFromMissing(missing);
    const named = arrayNamed(block);
    expect(named).toHaveLength(1);
    expect(named[0].key).toBe('token');
    // Falls back to string when no expectedSchema
    expect((named[0].value as FieldType).fieldtype).toBe('string');
    // Reason falls through to expectedType when no description
    expect(named[0].reason).toBe('secret');
  });

  it('produces an empty block for empty missing array', () => {
    const block = kitSchemaFromMissing([]);
    expect(block.fieldtype).toBe('array');
    const named = arrayNamed(block);
    expect(named).toHaveLength(0);
  });

  it('round-trips through .toEvent() — serialized block preserves named constraints', () => {
    const missing: MissingRequirement[] = [
      makeMissing({
        path: 'endpoint',
        expectedType: 'string',
        expectedSchema: types.string().toEvent() as FieldTypeCreationEvent,
        description: 'API endpoint URL',
      }),
      makeMissing({
        path: 'port',
        expectedType: 'number',
        expectedSchema: types.number().toEvent() as FieldTypeCreationEvent,
        description: 'Port number',
      }),
    ];

    const block = kitSchemaFromMissing(missing);
    const serialized = block.toEvent() as FieldTypeCreationEvent;

    // Verify the serialized form is a valid FieldTypeCreationEvent
    expect(serialized.type).toBe('fieldtypeevent');
    expect(serialized.eventtype).toBe('state');
    expect(serialized.fieldtype).toBe('array');

    // Extract named constraints from serialized attributes
    const namedAttrs = (serialized.attributes ?? []).filter(
      (a: any) => a.constrainttype === 'named',
    );
    expect(namedAttrs).toHaveLength(2);
    expect((namedAttrs[0] as any).key).toBe('endpoint');
    expect((namedAttrs[0] as any).reason).toBe('API endpoint URL');
    expect((namedAttrs[1] as any).key).toBe('port');
    expect((namedAttrs[1] as any).reason).toBe('Port number');

    // Verify nested value types are serialized
    const endpointValue = (namedAttrs[0] as any).value;
    expect(endpointValue).toBeDefined();
    // The value should be a FieldType (live object within the constraint)
    // After toEvent(), constraints are serialized but nested FieldTypes
    // remain as objects with a fieldtype property
    expect(endpointValue.fieldtype).toBe('string');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// blockEntries
// ─────────────────────────────────────────────────────────────────────────────

describe('blockEntries', () => {
  it('extracts UI-friendly entries from a block FieldType', () => {
    const block = types.block([
      types.assignment('apiKey', types.string(), { reason: 'Your API key' }),
      types.assignment('timeout', types.number(), { reason: 'Request timeout', min: 0, max: 5 }),
    ]);

    const entries = blockEntries(block);
    expect(entries).toHaveLength(2);

    expect(entries[0].key).toBe('apiKey');
    expect(entries[0].type.fieldtype).toBe('string');
    expect(entries[0].required).toBe(true); // default min=1
    expect(entries[0].reason).toBe('Your API key');
    expect(entries[0].typeSerialized).toBeDefined();
    expect(entries[0].typeSerialized.fieldtype).toBe('string');

    expect(entries[1].key).toBe('timeout');
    expect(entries[1].type.fieldtype).toBe('number');
    expect(entries[1].reason).toBe('Request timeout');
    expect(entries[1].min).toBe(0);
    expect(entries[1].max).toBe(5);
    expect(entries[1].required).toBe(false); // min=0 → not required
  });

  it('returns empty array for empty block', () => {
    const block = types.block([]);
    expect(blockEntries(block)).toHaveLength(0);
  });
});
