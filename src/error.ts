/**
 * error.ts — Structured error types for the FieldType library.
 *
 * All errors thrown by the library are instances of FieldTypeError with a
 * machine-readable code, optional path, and optional context bag. Consumers
 * can catch FieldTypeError and inspect .code for programmatic handling.
 */

export type FieldTypeErrorCode =
  | 'COMPOSE_CONFLICT'
  | 'INVALID_CONSTRAINT'
  | 'UNRESOLVED_REF'
  | 'VALIDATION_FAILED'
  | 'MISSING_REQUIREMENT'
  | 'TYPE_MISMATCH'
  | 'CHAIN_ERROR'
  | 'INVALID_INPUT'
  | 'INTERNAL';

export class FieldTypeError extends Error {
  constructor(
    public readonly code: FieldTypeErrorCode,
    message: string,
    public readonly path?: (string | number)[],
    public readonly context?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'FieldTypeError';
  }
}
