import { concrete, type_, ref, import_, export_, annotate, isBlocked, isResolved } from '../statement.js';
import type { Expression, StatementLevel } from '../statement.js';

describe('isBlocked', () => {
  it('concrete + ref → blocked', () => {
    const stmt = concrete('apiKey', { type: 'ref', source: 'string' });
    expect(isBlocked(stmt)).toBe(true);
  });

  it('concrete + literal → not blocked', () => {
    const stmt = concrete('host', { type: 'literal', value: 'localhost' });
    expect(isBlocked(stmt)).toBe(false);
  });

  it('concrete + name → not blocked', () => {
    const stmt = concrete('x', { type: 'name', id: 'y' });
    expect(isBlocked(stmt)).toBe(false);
  });

  it('concrete + call → not blocked', () => {
    const stmt = concrete('x', { type: 'call', fn: 'foo', args: [] });
    expect(isBlocked(stmt)).toBe(false);
  });

  it('type + ref → not blocked', () => {
    const stmt = type_('schema', { type: 'ref', source: 'string' });
    expect(isBlocked(stmt)).toBe(false);
  });
});

describe('isResolved', () => {
  it('type-level → resolved', () => {
    const stmt = type_('schema', { type: 'ref', source: 'string' });
    expect(isResolved(stmt)).toBe(true);
  });

  it('concrete + literal → resolved', () => {
    const stmt = concrete('x', { type: 'literal', value: 42 });
    expect(isResolved(stmt)).toBe(true);
  });

  it('concrete + ref → not resolved', () => {
    const stmt = concrete('x', { type: 'ref', source: 'string' });
    expect(isResolved(stmt)).toBe(false);
  });
});

describe('concrete', () => {
  it('creates concrete bind statement', () => {
    const stmt = concrete('host', { type: 'literal', value: 'localhost' });
    expect(stmt.type).toBe('bind');
    expect(stmt.name).toBe('host');
    expect(stmt.level).toBe('concrete');
    expect(stmt.expr.type).toBe('literal');
  });

  it('supports constraint parameter', () => {
    const constraint: Expression = { type: 'literal', value: { eventtype: 'state', fieldtype: 'string' } };
    const stmt = concrete('key', { type: 'ref', source: 'string' }, constraint);
    expect(stmt.constraint).toBe(constraint);
  });
});

describe('type_', () => {
  it('creates type-level bind statement', () => {
    const stmt = type_('schema', { type: 'ref', source: 'StorageType' });
    expect(stmt.type).toBe('bind');
    expect(stmt.level).toBe('type');
    expect(stmt.expr.type).toBe('ref');
  });
});

describe('ref', () => {
  it('creates a RefExpr', () => {
    const expr = ref('string');
    expect(expr.type).toBe('ref');
    expect(expr.source).toBe('string');
  });

  it('works as expression in concrete()', () => {
    const stmt = concrete('apiKey', ref('string'));
    expect(stmt.type).toBe('bind');
    expect(stmt.level).toBe('concrete');
    expect(stmt.expr).toEqual({ type: 'ref', source: 'string' });
  });
});

describe('import_', () => {
  it('creates import statement', () => {
    const stmt = import_('myPackage');
    expect(stmt.type).toBe('import');
    expect(stmt.source).toBe('myPackage');
    expect(stmt.scope).toBe('myPackage');
  });

  it('passes names from clauses', () => {
    const stmt = import_('pkg', { names: ['a', 'b'] });
    expect(stmt.type).toBe('import');
    expect(stmt.names).toEqual(['a', 'b']);
  });
});

describe('export_', () => {
  it('creates export statement with names', () => {
    const stmt = export_(['a', 'b']);
    expect(stmt.type).toBe('export');
    expect(stmt.names).toEqual(['a', 'b']);
  });

  it('creates wildcard export', () => {
    const stmt = export_('*');
    expect(stmt.type).toBe('export');
    expect(stmt.names).toBe('*');
  });

  it('supports except option', () => {
    const stmt = export_('*', { except: ['internal'] });
    expect(stmt.except).toEqual(['internal']);
  });
});

describe('annotate', () => {
  it('creates annotation statement', () => {
    const stmt = annotate([{ kind: 'text', content: 'hello' }]);
    expect(stmt.type).toBe('annotate');
    expect(stmt.body).toEqual([{ kind: 'text', content: 'hello' }]);
  });

  it('supports renderTerms', () => {
    const stmt = annotate(
      [{ kind: 'text', content: 'test' }],
      { relationship: 'describes' },
    );
    expect(stmt.renderTerms).toEqual({ relationship: 'describes' });
  });
});
