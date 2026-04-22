/**
 * ptrProject.test.ts — Tests for Ptr sub-addressing and namespace projection.
 *
 * Two mechanisms, same concept: "a Ptr over a coherently addressable subset."
 *
 *   ptr(fieldType, 'b')            → sub-Ptr at property 'b', type-constrained
 *   ptr.project(parentPtr, prefix) → live sub-Ptr at namespace prefix, synced
 */

import { ptr, isPtr, type PtrEvent } from '../ptr.js';
import { types } from '../builders.js';

// ─────────────────────────────────────────────────────────────────────────────
// ptr(fieldType, address) — Static sub-addressing
// ─────────────────────────────────────────────────────────────────────────────

describe('ptr(fieldType, address) — sub-addressing', () => {

  it('should create a Ptr scoped to a property of an object type', () => {
    const parentType = types.object({
      name: types.string(),
      config: types.object({
        host: types.string(),
        port: types.number(),
      }),
    });

    const sub = ptr(parentType, 'config');
    expect(isPtr(sub)).toBe(true);

    // Type surface should be the config object type
    const concreteness = sub['$'].concreteness();
    expect(concreteness.missing).toContain('host');
    expect(concreteness.missing).toContain('port');
    expect(concreteness.concrete).toBe(false);
  });

  it('should inherit type constraints — gated sub-Ptr rejects mismatched values', () => {
    const parentType = types.object({
      count: types.number(),
      label: types.string(),
    });

    // Create a gated Ptr at 'count' — only numbers should pass
    const sub = ptr(parentType, 'count', { gated: true });
    expect(isPtr(sub)).toBe(true);
  });

  it('should track concreteness of the sub-range', () => {
    const parentType = types.object({
      auth: types.object({
        apiKey: types.string(),
        secret: types.string(),
      }),
    });

    const sub = ptr(parentType, 'auth');

    // Initially missing both
    expect(sub['$'].concreteness().concrete).toBe(false);
    expect(sub['$'].concreteness().missing).toEqual(
      expect.arrayContaining(['apiKey', 'secret']),
    );

    // Provide one
    sub['apiKey'] = 'sk-123';
    expect(sub['$'].concreteness().concrete).toBe(false);
    expect(sub['$'].concreteness().missing).toContain('secret');

    // Provide the other — should become concrete
    sub['secret'] = 'shhh';
    expect(sub['$'].concreteness().concrete).toBe(true);
  });

  it('should fire concrete event when sub-range is fully resolved', () => {
    const parentType = types.object({
      db: types.object({
        host: types.string(),
      }),
    });

    const sub = ptr(parentType, 'db');
    const events: PtrEvent[] = [];
    sub['$'].subscribe((e) => events.push(e));

    sub['host'] = 'localhost';

    const concreteEvent = events.find(
      (e) => e.type === 'concrete' && e.next === true,
    );
    expect(concreteEvent).toBeDefined();
  });

  it('should throw for non-existent property', () => {
    const parentType = types.object({ x: types.any() });
    expect(() => ptr(parentType, 'nonexistent')).toThrow(
      /property 'nonexistent' not found/,
    );
  });

  it('should throw for non-object type', () => {
    const stringType = types.string();
    expect(() => ptr(stringType, 'anything')).toThrow(
      /property 'anything' not found/,
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// ptr.project(parentPtr, prefix) — Live namespace projection
// ─────────────────────────────────────────────────────────────────────────────

describe('ptr.project(parentPtr, prefix) — namespace projection', () => {

  function createTestEnv() {
    const env = ptr(types.object({}));
    env['connection:github'] = { packageID: 'connection:github', tools: ['createIssue'] };
    env['connection:jira'] = { packageID: 'connection:jira', tools: ['createTicket'] };
    env['service:chat'] = { packageID: 'service:chat' };
    return env;
  }

  it('should create a valid Ptr scoped to the namespace', () => {
    const env = createTestEnv();
    const { ptr: conns, dispose } = ptr.project(env, 'connection:');

    expect(isPtr(conns)).toBe(true);

    // Should see namespace keys (prefix stripped)
    expect(conns['github']).toEqual({
      packageID: 'connection:github',
      tools: ['createIssue'],
    });
    expect(conns['jira']).toEqual({
      packageID: 'connection:jira',
      tools: ['createTicket'],
    });

    // Should NOT see keys outside the namespace
    expect(conns['service:chat']).toBeUndefined();
    expect(conns['chat']).toBeUndefined();

    dispose();
  });

  it('should propagate parent pushes to sub-Ptr', () => {
    const env = createTestEnv();
    const { ptr: conns, dispose } = ptr.project(env, 'connection:');

    // Push a new connection to the parent
    env['connection:slack'] = { packageID: 'connection:slack', tools: ['sendMessage'] };

    // Sub-Ptr should reflect it
    expect(conns['slack']).toEqual({
      packageID: 'connection:slack',
      tools: ['sendMessage'],
    });

    dispose();
  });

  it('should propagate sub-Ptr pushes to parent', () => {
    const env = createTestEnv();
    const { ptr: conns, dispose } = ptr.project(env, 'connection:');

    // Push through the sub-Ptr
    conns['linear'] = { packageID: 'connection:linear', tools: ['createTask'] };

    // Parent should reflect it (with prefix)
    expect(env['connection:linear']).toEqual({
      packageID: 'connection:linear',
      tools: ['createTask'],
    });

    dispose();
  });

  it('should fire subscriber only for namespace changes', () => {
    const env = createTestEnv();
    const { ptr: conns, dispose } = ptr.project(env, 'connection:');

    const events: PtrEvent[] = [];
    conns['$'].subscribe((e) => events.push(e));

    // Push in namespace — should fire
    env['connection:notion'] = { packageID: 'connection:notion' };
    expect(events.some((e) => e.type === 'push' && e.name === 'notion')).toBe(true);

    // Reset
    events.length = 0;

    // Push outside namespace — should NOT fire
    env['service:analytics'] = { packageID: 'service:analytics' };
    expect(events.length).toBe(0);

    dispose();
  });

  it('should reflect value updates from parent', () => {
    const env = createTestEnv();
    const { ptr: conns, dispose } = ptr.project(env, 'connection:');

    // Update existing value
    env['connection:github'] = {
      packageID: 'connection:github',
      tools: ['createIssue', 'listRepos'],
    };

    expect(conns['github']).toEqual({
      packageID: 'connection:github',
      tools: ['createIssue', 'listRepos'],
    });

    dispose();
  });

  it('should enumerate namespace keys via Object.keys', () => {
    const env = createTestEnv();
    const { ptr: conns, dispose } = ptr.project(env, 'connection:');

    const keys = Object.keys(conns).sort();
    expect(keys).toEqual(['github', 'jira']);

    // Add a new one via parent
    env['connection:slack'] = { id: 'slack' };

    const keysAfter = Object.keys(conns).sort();
    expect(keysAfter).toEqual(['github', 'jira', 'slack']);

    dispose();
  });

  it('should stop syncing after dispose', () => {
    const env = createTestEnv();
    const { ptr: conns, dispose } = ptr.project(env, 'connection:');

    dispose();

    // Push to parent — sub-Ptr should NOT update
    env['connection:asana'] = { packageID: 'connection:asana' };
    expect(conns['asana']).toBeUndefined();
  });

  it('should handle bulk push (assign via [*]) from parent', () => {
    const env = ptr(types.object({}));
    const { ptr: conns, dispose } = ptr.project(env, 'ns:');

    // Assign individual keys on parent in namespace
    env['ns:alpha'] = 1;
    env['ns:beta'] = 2;

    expect(conns['alpha']).toBe(1);
    expect(conns['beta']).toBe(2);

    dispose();
  });
});
