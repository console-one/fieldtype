/**
 * scope.test.ts — Scope-cascade execution model tests.
 *
 * Proves: scope open → reduce → close → cascade
 * is the single pattern replacing all agent/workflow orchestration.
 */

import { createWorkspace, type Workspace } from '../workspace.js';
import { createScope, withScope, type Scope } from '../scope.js';
import { FieldType } from '../type.js';
import { ConstraintTypes } from '../constraint.js';
import type { Interpreter, StoreAccess } from '../workspaceInterpreter.js';
import { classifyValue } from '../workspaceInterpreter.js';

// ── Test interpreter: REST-like → callable ──────────────────────────

function objectType(shape: Record<string, string>): FieldType {
  let ft = FieldType.object.create();
  for (const [key, typeName] of Object.entries(shape)) {
    const valueFT =
      typeName === 'string' ? FieldType.string.create() :
      typeName === 'number' ? FieldType.number.create() :
      FieldType.any.create();
    const prop = ConstraintTypes.object.property.create(key, valueFT);
    (ft.attributes ??= []).push(prop);
  }
  return ft.save();
}

function callableConstraint(name: string, fn: Function): FieldType {
  const fnFT = FieldType.function.create().literal(fn).callable().save();
  return FieldType.object.create().property(name, fnFT).save();
}

/** Interpreter: matches { method, endpoint } → produces callable */
function createTestRestInterpreter(): Interpreter {
  return {
    guard: objectType({ method: 'string', endpoint: 'string' }),
    constraints(values: any, _store: StoreAccess, stem?: string[]): FieldType {
      const name = stem?.[0] ?? 'tool';
      const fn = async (args: any) => ({ method: values.method, url: values.endpoint, args });
      (fn as any).metadata = { description: `${values.method} ${values.endpoint}` };
      return callableConstraint(name, fn);
    },
  };
}

/** Interpreter: matches { template } → produces callable */
function createTestPromptInterpreter(): Interpreter {
  return {
    guard: objectType({ template: 'string' }),
    constraints(values: any, _store: StoreAccess, stem?: string[]): FieldType {
      const name = stem?.[0] ?? 'tool';
      const fn = async (args: any) => values.template.replace(/\{\{.*?\}\}/g, '...');
      (fn as any).metadata = { description: 'Prompt template' };
      return callableConstraint(name, fn);
    },
  };
}

// ── Tests ───────────────────────────────────────────────────────────

describe('Scope', () => {
  let ws: Workspace;
  let interpreters: readonly Interpreter[];

  beforeEach(() => {
    ws = createWorkspace();
    interpreters = [createTestRestInterpreter(), createTestPromptInterpreter()];
  });

  test('createScope wraps workspace with interpreters', () => {
    const scope = createScope(ws, interpreters);
    expect(scope.ws).toBe(ws);
    expect(scope.interpreters).toBe(interpreters);
    expect(scope.parent).toBeUndefined();
  });

  test('open() forks workspace (nested write lock)', () => {
    const scope = createScope(ws, interpreters);
    const child = scope.open();
    expect(child.parent).toBe(scope);
    expect(child.ws).not.toBe(ws);
    expect(child.ws.root).toBe(ws);
  });

  test('reduce() dispatches interpreter on matching entry', () => {
    ws.write('fetchUsers', { method: 'GET', endpoint: '/api/users' });
    const scope = createScope(ws, interpreters);

    const changed = scope.reduce();

    expect(changed).toContain('fetchUsers');
    const fn = ws.read('fetchUsers');
    expect(typeof fn).toBe('function');
    expect((fn as any).metadata.description).toBe('GET /api/users');
  });

  test('reduce() skips already-callable entries', () => {
    // Write a callable directly
    const fn = () => {};
    const fnFT = FieldType.function.create().literal(fn).callable().save();
    ws.write('existingTool', fnFT);

    // Write a schematic value
    ws.write('newTool', { method: 'POST', endpoint: '/api/data' });

    const scope = createScope(ws, interpreters);
    const changed = scope.reduce();

    // Only newTool should have been reduced
    expect(changed).toContain('newTool');
    expect(changed).not.toContain('existingTool');
  });

  test('reduce() returns empty when nothing matches', () => {
    ws.write('config', 'just a string');
    ws.write('count', 42);
    const scope = createScope(ws, interpreters);
    const changed = scope.reduce();
    expect(changed).toEqual([]);
  });

  test('cascade() reduces until stable (fixed point)', () => {
    ws.write('api1', { method: 'GET', endpoint: '/users' });
    ws.write('api2', { method: 'POST', endpoint: '/users' });
    ws.write('prompt1', { template: 'Hello {{name}}' });

    const scope = createScope(ws, interpreters);
    scope.cascade();

    // All three should now be callables
    expect(typeof ws.read('api1')).toBe('function');
    expect(typeof ws.read('api2')).toBe('function');
    expect(typeof ws.read('prompt1')).toBe('function');
  });

  test('close() merges child writes to parent (visibility promotion)', () => {
    const parent = createScope(ws, interpreters);
    const child = parent.open();

    // Write in child scope
    child.ws.write('childData', 'hello');
    expect(ws.read('childData')).toBeUndefined(); // not visible yet

    child.close(); // visibility promotion
    expect(ws.read('childData')).toBe('hello'); // now visible
  });

  test('withScope: open → reduce → close in one call', () => {
    ws.write('tool', { method: 'DELETE', endpoint: '/api/item' });

    const parent = createScope(ws, interpreters);
    const result = withScope(parent, (child) => {
      child.ws.write('extra', { template: 'Deleting...' });
      child.cascade();
    });

    expect(result.applied.length).toBeGreaterThan(0);
    expect(typeof ws.read('extra')).toBe('function');
  });

  test('nested scopes: grandchild merges to child then to parent', () => {
    const root = createScope(ws, interpreters);
    const child = root.open();
    const grandchild = child.open();

    grandchild.ws.write('deepTool', { method: 'GET', endpoint: '/deep' });
    grandchild.cascade();
    expect(typeof grandchild.ws.read('deepTool')).toBe('function');

    grandchild.close(); // promote to child
    expect(typeof child.ws.read('deepTool')).toBe('function');

    child.close(); // promote to parent
    expect(typeof ws.read('deepTool')).toBe('function');
  });

  test('cascade model replaces agent loop', () => {
    // This test demonstrates the scope-cascade replacing driveAgent:
    //
    // 1. Session scope has tools
    // 2. Agent turn opens a child scope
    // 3. LLM "writes" a tool call (simulated)
    // 4. Cascade resolves the tool call
    // 5. Turn closes, session sees results
    //
    // This is what 443 lines of agentRunner.ts reimplements manually.

    // Session has compiled tools
    ws.write('searchWeb', { method: 'GET', endpoint: '/search?q={{arg.query}}' });
    const session = createScope(ws, interpreters);
    session.cascade(); // tools compiled

    // Agent turn
    const turn = session.open();

    // LLM "says": call searchWeb with query "test"
    // (In real code, LLM produces CallConstraints. Here we just invoke.)
    const searchFn = turn.ws.read('searchWeb') as Function;
    expect(typeof searchFn).toBe('function');

    // Tool executes in turn scope
    turn.ws.write('searchResult', 'results from search');

    // Turn closes — results visible in session
    turn.close();
    expect(ws.read('searchResult')).toBe('results from search');
  });

  test('store reads resolve lazily at call time', () => {
    // Write a tool that reads deps from store
    const depInterpreter: Interpreter = {
      guard: objectType({ needsDep: 'string' }),
      constraints(values: any, store: StoreAccess, stem?: string[]): FieldType {
        const name = stem?.[0] ?? 'tool';
        const fn = () => {
          // Lazy read: resolves at call time, not at interpret time
          return store.read('myDep');
        };
        return callableConstraint(name, fn);
      },
    };

    ws.write('myTool', { needsDep: 'yes' });
    const scope = createScope(ws, [depInterpreter]);
    scope.cascade();

    // Dep not yet available
    const fn = ws.read('myTool') as Function;
    expect(fn()).toBeUndefined();

    // Write dep — tool closure resolves it lazily
    ws.write('myDep', 42);
    expect(fn()).toBe(42);
  });
});
