/**
 * head-kernel.test.ts — HEAD as kernel with plugins.
 *
 * Proves the claim: creating N kernel configurations is N short functions.
 * Each test ties statement-level APIs (concrete/type/ref, FieldType constraints,
 * error outputs) into the overall execution structure (draft → write → save →
 * advance → finalize).
 *
 * No real storage, no real transport — mock functions in the chain.
 */

import { createHead } from '../head.js';
import { FieldType } from '../type.js';
import { ConstraintTypes } from '../constraint.js';
import { concrete, type_ } from '../statement.js';

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

function objectType(shape: Record<string, string>): FieldType {
  let ft = FieldType.object.create();
  for (const [key, typeName] of Object.entries(shape)) {
    const valueFT =
      typeName === 'string' ? FieldType.string.create() :
      typeName === 'number' ? FieldType.number.create() :
      typeName === 'boolean' ? FieldType.boolean.create() :
      FieldType.any.create();
    const prop = ConstraintTypes.object.property.create(key, valueFT);
    (ft.attributes ??= []).push(prop);
  }
  return ft.save();
}

// ─────────────────────────────────────────────────────────────────────────────
// 1. Bare kernel — empty HEAD as key-value store
// ─────────────────────────────────────────────────────────────────────────────

describe('bare kernel', () => {
  it('write concrete values, read them back via value()', () => {
    const env = createHead();
    env.write(concrete('host', { type: 'literal', value: 'localhost' }));
    env.write(concrete('port', { type: 'literal', value: 8080 }));

    expect(env.value('host')).toBe('localhost');
    expect(env.value('port')).toBe(8080);
    expect(env.value('missing')).toBeUndefined();
    expect(env.resolved).toBe(true);
  });

  it('type-level bindings are always resolved — never create gaps', () => {
    const env = createHead();
    // type_ declares structure. Even with a ref expression, type-level = resolved.
    env.write(type_('schema', { type: 'literal', value: { version: 2 } }));

    expect(env.value('schema')).toEqual({ version: 2 });
    expect(env.gaps.length).toBe(0);
  });

  it('last writer wins — concrete overrides concrete', () => {
    const env = createHead();
    env.write(concrete('x', { type: 'literal', value: 1 }));
    env.write(concrete('x', { type: 'literal', value: 2 }));

    expect(env.value('x')).toBe(2);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. Statement levels — how concreteness determines resolution
// ─────────────────────────────────────────────────────────────────────────────

describe('statement levels', () => {
  it('concrete literal = resolved; concrete ref = gap; type = always resolved', () => {
    const env = createHead();

    // concrete + literal → resolved
    env.write(concrete('name', { type: 'literal', value: 'alice' }));
    expect(env.value('name')).toBe('alice');
    expect(env.resolved).toBe(true);

    // concrete + ref → gap (blocked until external resolution)
    env.write(concrete('secret', { type: 'ref', source: 'vault.secret' }));
    expect(env.value('secret')).toBeUndefined();
    expect(env.resolved).toBe(false);
    expect(env.gaps.length).toBe(1);
    expect(env.gaps[0].key).toBe('secret');

    // type_ + literal → always resolved (structure, not value)
    env.write(type_('typeInfo', { type: 'literal', value: 'string' }));
    expect(env.value('typeInfo')).toBe('string');
    // Still one gap (the concrete ref is still unresolved)
    expect(env.gaps.length).toBe(1);
  });

  it('concrete literal resolves a previous concrete ref at the same name', () => {
    const env = createHead();

    // First: declare a ref gate
    env.write(concrete('apiKey', { type: 'ref', source: 'secrets.apiKey' }));
    expect(env.gaps.length).toBe(1);

    // Then: provide a concrete value — overrides the ref, resolves the gap
    env.write(concrete('apiKey', { type: 'literal', value: 'sk-test' }));
    expect(env.gaps.length).toBe(0);
    expect(env.value('apiKey')).toBe('sk-test');
  });

  it('ref gate carries source info for diagnostics', () => {
    const env = createHead();
    env.write(concrete('model', { type: 'ref', source: 'provider.model' }));

    const gap = env.gaps[0];
    expect(gap.key).toBe('model');
    expect(gap.source).toBe('provider.model');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. Typed kernel — FieldType schema defines requirements
// ─────────────────────────────────────────────────────────────────────────────

describe('typed kernel with FieldType requirements', () => {
  it('object schema creates typed gaps, concrete writes fill them', () => {
    const env = createHead(objectType({ apiKey: 'string', model: 'string', temp: 'number' }));

    expect(env.gaps.length).toBe(3);
    expect(env.resolved).toBe(false);

    env.write(concrete('apiKey', { type: 'literal', value: 'sk-test-123' }));
    expect(env.gaps.length).toBe(2);

    env.write(concrete('model', { type: 'literal', value: 'gpt-4' }));
    env.write(concrete('temp', { type: 'literal', value: 0.7 }));
    expect(env.gaps.length).toBe(0);
    expect(env.resolved).toBe(true);

    expect(env.value('apiKey')).toBe('sk-test-123');
    expect(env.value('model')).toBe('gpt-4');
    expect(env.value('temp')).toBe(0.7);
  });

  it('gaps carry FieldType schema for constraint checking', () => {
    const env = createHead(objectType({ port: 'number', host: 'string' }));
    const portGap = env.gaps.find(g => g.key === 'port');
    const hostGap = env.gaps.find(g => g.key === 'host');

    // Each gap has a typeName derived from its FieldType schema
    expect(portGap).toBeDefined();
    expect(hostGap).toBeDefined();
    expect(portGap!.typeName).toBe('number');
    expect(hostGap!.typeName).toBe('string');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 4. Error surface — save/preflight report typed errors
// ─────────────────────────────────────────────────────────────────────────────

describe('error surface', () => {
  it('save with unresolved gaps returns missing with type info', async () => {
    const env = createHead(objectType({ host: 'string', port: 'number' }));
    const draft = env.draft();

    // Only fill one of two required gaps
    draft.write(concrete('host', { type: 'literal', value: 'localhost' }));

    const result = await draft.save();
    expect(result.ok).toBe(false);
    if (!result.ok && 'missing' in result) {
      expect(result.missing).toBeDefined();
      expect(result.missing!.length).toBeGreaterThan(0);
      const portMissing = result.missing!.find((m: any) => m.key === 'port');
      expect(portMissing).toBeDefined();
      expect(portMissing!.typeName).toBe('number');
    }
  });

  it('preflight dry-runs without side effects', () => {
    const env = createHead(objectType({ x: 'number' }));
    const draft = env.draft();

    // Preflight before filling gaps → not ok
    const pf1 = draft.preflight();
    expect(pf1.ok).toBe(false);

    // Fill gap
    draft.write(concrete('x', { type: 'literal', value: 42 }));

    // Preflight after filling → ok
    const pf2 = draft.preflight();
    expect(pf2.ok).toBe(true);
  });

  it('disposed HEAD throws on write — not a silent failure', () => {
    const env = createHead();
    env.dispose();
    expect(() => env.write(concrete('x', { type: 'literal', value: 1 }))).toThrow('HEAD is disposed');
  });

  it('value() returns undefined for nonexistent keys — no throw', () => {
    const env = createHead();
    expect(env.value('nope')).toBeUndefined();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 5. Storage plugin — subscriber records advances for persistence
// ─────────────────────────────────────────────────────────────────────────────

describe('storage plugin via subscriber', () => {
  it('advance events carry snapshots a storage layer can persist', async () => {
    const env = createHead();

    // The "storage plugin" — just a subscriber
    const persisted: Array<{ prev: FieldType; next: FieldType }> = [];
    env.subscribe(e => {
      if (e.type === 'advance') persisted.push({ prev: e.prev, next: e.next });
    });

    const d = env.draft();
    d.write(concrete('config', { type: 'literal', value: { debug: true } }));
    await d.save();

    expect(persisted.length).toBe(1);
    expect(persisted[0].next).toBeDefined();
    expect(persisted[0].prev).not.toBe(persisted[0].next);
  });

  it('multiple saves accumulate history', async () => {
    const env = createHead();
    const history: FieldType[] = [];
    env.subscribe(e => {
      if (e.type === 'advance') history.push(e.next);
    });

    for (const v of [1, 2, 3]) {
      const d = env.draft();
      d.write(concrete('counter', { type: 'literal', value: v }));
      await d.save();
    }

    expect(history.length).toBe(3);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 6. Interpreter plugin — function binding in chain
// ─────────────────────────────────────────────────────────────────────────────

describe('interpreter as chain-bound function', () => {
  it('interpreter is a concrete literal function binding at a path', () => {
    const env = createHead();

    // "Install" a REST interpreter = write a function into the chain
    const restInterpreter = (url: string, method: string) => ({ url, method, status: 200 });
    env.write(concrete('interpreters.rest', { type: 'literal', value: restInterpreter }));

    const fn = env.value('interpreters.rest') as Function;
    expect(typeof fn).toBe('function');
    expect(fn('https://api.example.com', 'GET')).toEqual({
      url: 'https://api.example.com',
      method: 'GET',
      status: 200,
    });
  });

  it('multiple interpreters coexist as independent bindings', () => {
    const env = createHead();

    env.write(concrete('interpreters.rest', { type: 'literal', value: () => 'rest' }));
    env.write(concrete('interpreters.llm', { type: 'literal', value: () => 'llm' }));
    env.write(concrete('interpreters.binding', { type: 'literal', value: () => 'binding' }));

    expect((env.value('interpreters.rest') as Function)()).toBe('rest');
    expect((env.value('interpreters.llm') as Function)()).toBe('llm');
    expect((env.value('interpreters.binding') as Function)()).toBe('binding');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 7. Scope narrowing — the CYCLE at every level
// ─────────────────────────────────────────────────────────────────────────────

describe('scope narrowing — same operation at every level', () => {
  it('blueprint (type-state refs) → toolpackage (chain-bound) → call (frame-bound)', async () => {
    // ROOT ENV: has interpreter + storage bindings
    const root = createHead();
    root.write(concrete('interpreters.rest', {
      type: 'literal',
      value: (url: string) => ({ status: 200, body: `response from ${url}` }),
    }));
    root.write(concrete('storage.write', {
      type: 'literal',
      value: (key: string, val: unknown) => ({ key, val, persisted: true }),
    }));

    // BLUEPRINT: draft with ref gates (type-state — unbound)
    const blueprint = root.draft();
    blueprint.write(concrete('apiKey', { type: 'ref', source: 'env.secrets.apiKey' }));
    blueprint.write(concrete('baseUrl', { type: 'ref', source: 'env.config.baseUrl' }));
    expect(blueprint.lifecycle).toBe('pending'); // blocked on refs

    // TOOLPACKAGE: fill the refs with chain-bound paths (concrete values)
    blueprint.write(concrete('apiKey', { type: 'literal', value: 'sk-real-key' }));
    blueprint.write(concrete('baseUrl', { type: 'literal', value: 'https://api.openai.com' }));
    expect(blueprint.lifecycle).toBe('ready'); // all refs resolved

    // TOOL CALL: narrow further with frame-bound args
    const call = blueprint.draft();
    call.write(concrete('prompt', { type: 'literal', value: 'What is 2+2?' }));
    call.write(concrete('temperature', { type: 'literal', value: 0.7 }));

    // All scope levels visible: root (interpreter), toolpackage (apiKey), call (prompt)
    expect(call.value('interpreters.rest')).toBeDefined();
    expect(typeof call.value('interpreters.rest')).toBe('function');
    expect(call.value('apiKey')).toBe('sk-real-key');
    expect(call.value('prompt')).toBe('What is 2+2?');
    expect(call.value('temperature')).toBe(0.7);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 8. Draft cascade — layered resolution
// ─────────────────────────────────────────────────────────────────────────────

describe('draft cascade', () => {
  it('inner draft sees outer draft bindings', async () => {
    const root = createHead();

    const d1 = root.draft();
    d1.write(concrete('region', { type: 'literal', value: 'us-east-1' }));

    const d2 = d1.draft();
    d2.write(concrete('bucket', { type: 'literal', value: 'my-bucket' }));

    // Inner sees both its own and outer's bindings
    expect(d2.value('region')).toBe('us-east-1');
    expect(d2.value('bucket')).toBe('my-bucket');

    // Save inner → outer → root: values propagate up
    await d2.save();
    expect(d1.value('bucket')).toBe('my-bucket');

    await d1.save();
    expect(root.value('region')).toBe('us-east-1');
    expect(root.value('bucket')).toBe('my-bucket');
  });

  it('inner draft can override outer binding', async () => {
    const root = createHead();
    root.write(concrete('mode', { type: 'literal', value: 'base' }));

    const d = root.draft();
    d.write(concrete('mode', { type: 'literal', value: 'override' }));

    expect(d.value('mode')).toBe('override');
    expect(root.value('mode')).toBe('base'); // root unchanged until save

    await d.save();
    expect(root.value('mode')).toBe('override'); // now propagated
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 9. FINALIZE pattern — subscriber as classifier
// ─────────────────────────────────────────────────────────────────────────────

describe('finalize pattern', () => {
  it('advance subscriber classifies snapshot (grammar-like dispatch)', async () => {
    const env = createHead();
    const finalized: Array<{ classification: string; values: Record<string, unknown> }> = [];

    env.subscribe(e => {
      if (e.type !== 'advance') return;
      // Simulated grammar: if snapshot has 'schematictype', classify as tool
      // This is structural dispatch — check what bindings exist
    });

    // Wire a finalizer that reads values from the HEAD after advance
    env.subscribe(e => {
      if (e.type !== 'advance') return;
      const schematicType = env.value('schematictype');
      finalized.push({
        classification: schematicType ? 'tool' : 'data',
        values: {
          schematictype: env.value('schematictype'),
          endpoint: env.value('endpoint'),
        },
      });
    });

    const d = env.draft();
    d.write(concrete('schematictype', { type: 'literal', value: 'rest' }));
    d.write(concrete('endpoint', { type: 'literal', value: '/api/users' }));
    await d.save();

    expect(finalized.length).toBe(1);
    expect(finalized[0].classification).toBe('tool');
    expect(finalized[0].values.schematictype).toBe('rest');
    expect(finalized[0].values.endpoint).toBe('/api/users');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 10. Multiple kernel configs — N kernels in N short functions
// ─────────────────────────────────────────────────────────────────────────────

describe('multiple kernel configurations', () => {
  function createDevKernel() {
    const env = createHead();
    env.write(concrete('mode', { type: 'literal', value: 'development' }));
    env.write(concrete('debug', { type: 'literal', value: true }));
    env.write(concrete('storage', { type: 'literal', value: 'memory' }));
    return env;
  }

  function createProdKernel() {
    const env = createHead();
    env.write(concrete('mode', { type: 'literal', value: 'production' }));
    env.write(concrete('debug', { type: 'literal', value: false }));
    env.write(concrete('storage', { type: 'literal', value: 'sqlite' }));
    env.write(concrete('storagePath', { type: 'literal', value: '/data/app.db' }));
    return env;
  }

  function createTestKernel(mockStorage: { records: unknown[] }) {
    const env = createHead();
    env.write(concrete('mode', { type: 'literal', value: 'test' }));
    env.write(concrete('storage', { type: 'literal', value: 'mock' }));
    env.write(concrete('persist', {
      type: 'literal',
      value: (record: unknown) => { mockStorage.records.push(record); },
    }));
    return env;
  }

  it('dev kernel — simple config, no persistence', () => {
    const env = createDevKernel();
    expect(env.value('mode')).toBe('development');
    expect(env.value('debug')).toBe(true);
    expect(env.resolved).toBe(true);
  });

  it('prod kernel — config with storage path', () => {
    const env = createProdKernel();
    expect(env.value('mode')).toBe('production');
    expect(env.value('storagePath')).toBe('/data/app.db');
  });

  it('test kernel — mock persistence plugin receives writes', async () => {
    const mockStorage = { records: [] as unknown[] };
    const env = createTestKernel(mockStorage);

    // Use the persist function from the chain
    const persist = env.value('persist') as (r: unknown) => void;
    persist({ id: 1, name: 'test' });

    expect(mockStorage.records).toEqual([{ id: 1, name: 'test' }]);
  });

  it('test kernel — draft + save + finalizer writes to mock storage', async () => {
    const mockStorage = { records: [] as unknown[] };
    const env = createTestKernel(mockStorage);

    // Wire a finalizer that uses the persist function on advance
    env.subscribe(e => {
      if (e.type !== 'advance') return;
      const persist = env.value('persist') as (r: unknown) => void;
      persist({ event: 'advance', mode: env.value('mode') });
    });

    const d = env.draft();
    d.write(concrete('version', { type: 'literal', value: '1.0.0' }));
    await d.save();

    expect(mockStorage.records).toEqual([{ event: 'advance', mode: 'test' }]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 11. Fork parent indirection — effectiveChain makes drafts see live source
// ─────────────────────────────────────────────────────────────────────────────

describe('fork parent indirection', () => {
  it('basic cascade — source fill auto-resolves draft gap', async () => {
    const env = createHead();

    // Draft with a ref gate
    const draft = env.draft();
    draft.write(concrete('apiKey', { type: 'ref', source: 'secrets.apiKey' }));
    expect(draft.gaps.length).toBe(1);
    expect(draft.lifecycle).toBe('pending');

    // Separate draft fills apiKey on env
    const fill = env.draft();
    fill.write(concrete('apiKey', { type: 'literal', value: 'sk-real' }));
    await fill.save();

    // Draft auto-resolves: effectiveChain sees the new concrete value
    expect(draft.lifecycle).toBe('ready');
    expect(draft.gaps.length).toBe(0);
    expect(draft.value('apiKey')).toBe('sk-real');
  });

  it('multi-step cascade — draft resolves only after all gaps filled', async () => {
    const env = createHead();

    const draft = env.draft();
    draft.write(concrete('a', { type: 'ref', source: 'ext.a' }));
    draft.write(concrete('b', { type: 'ref', source: 'ext.b' }));
    expect(draft.gaps.length).toBe(2);

    // Fill A only
    const fillA = env.draft();
    fillA.write(concrete('a', { type: 'literal', value: 'alpha' }));
    await fillA.save();

    expect(draft.lifecycle).toBe('pending');
    expect(draft.gaps.length).toBe(1);
    expect(draft.gaps[0].key).toBe('b');

    // Fill B
    const fillB = env.draft();
    fillB.write(concrete('b', { type: 'literal', value: 'beta' }));
    await fillB.save();

    expect(draft.lifecycle).toBe('ready');
    expect(draft.gaps.length).toBe(0);
    expect(draft.value('a')).toBe('alpha');
    expect(draft.value('b')).toBe('beta');
  });

  it('own writes survive — draft keeps its writes and sees source fills', async () => {
    const env = createHead();

    const draft = env.draft();
    draft.write(concrete('x', { type: 'literal', value: 42 }));
    draft.write(concrete('y', { type: 'ref', source: 'ext.y' }));
    expect(draft.value('x')).toBe(42);
    expect(draft.gaps.length).toBe(1);

    // Source fills y
    const fill = env.draft();
    fill.write(concrete('y', { type: 'literal', value: 99 }));
    await fill.save();

    // Draft still has x AND now sees y
    expect(draft.value('x')).toBe(42);
    expect(draft.value('y')).toBe(99);
    expect(draft.lifecycle).toBe('ready');
  });

  it('sibling drafts — both auto-resolve from same source fill', async () => {
    const env = createHead();

    const d1 = env.draft();
    d1.write(concrete('apiKey', { type: 'ref', source: 'vault.key' }));

    const d2 = env.draft();
    d2.write(concrete('apiKey', { type: 'ref', source: 'vault.key' }));

    expect(d1.lifecycle).toBe('pending');
    expect(d2.lifecycle).toBe('pending');

    // Single fill on env
    const fill = env.draft();
    fill.write(concrete('apiKey', { type: 'literal', value: 'shared-key' }));
    await fill.save();

    // Both siblings auto-resolve
    expect(d1.lifecycle).toBe('ready');
    expect(d2.lifecycle).toBe('ready');
    expect(d1.value('apiKey')).toBe('shared-key');
    expect(d2.value('apiKey')).toBe('shared-key');
  });

  it('sequential cascade — d1 fills env, d2 auto-resolves, d2 fills env, d3 auto-resolves', async () => {
    const env = createHead();

    // d2 needs apiKey, d3 needs secret
    const d2 = env.draft();
    d2.write(concrete('apiKey', { type: 'ref', source: 'ext.apiKey' }));

    const d3 = env.draft();
    d3.write(concrete('secret', { type: 'ref', source: 'ext.secret' }));

    // d1 fills apiKey
    const d1 = env.draft();
    d1.write(concrete('apiKey', { type: 'literal', value: 'key-1' }));
    await d1.save();

    expect(d2.lifecycle).toBe('ready');
    expect(d3.lifecycle).toBe('pending'); // still needs secret

    // d2 saves, then fills secret
    await d2.save();

    const fillSecret = env.draft();
    fillSecret.write(concrete('secret', { type: 'literal', value: 'sec-1' }));
    await fillSecret.save();

    expect(d3.lifecycle).toBe('ready');

    const result = await d3.save();
    expect(result.ok).toBe(true);
  });

  it('merge correctness — save produces only draft own statements', async () => {
    const env = createHead();

    // Write some initial state on env
    env.write(concrete('existing', { type: 'literal', value: 'base' }));

    const draft = env.draft();
    draft.write(concrete('newKey', { type: 'literal', value: 'added' }));

    // Source advances while draft is open
    const fill = env.draft();
    fill.write(concrete('another', { type: 'literal', value: 'filled' }));
    await fill.save();

    // Draft should still be saveable — it only adds 'newKey'
    const result = await draft.save();
    expect(result.ok).toBe(true);

    // Env has all three values
    expect(env.value('existing')).toBe('base');
    expect(env.value('another')).toBe('filled');
    expect(env.value('newKey')).toBe('added');
  });

  it('post-lock recheck — concurrent saves both succeed', async () => {
    const env = createHead();

    // Two drafts, each adding different values
    const d1 = env.draft();
    d1.write(concrete('a', { type: 'literal', value: 1 }));

    const d2 = env.draft();
    d2.write(concrete('b', { type: 'literal', value: 2 }));

    // Both are ready (no gaps)
    expect(d1.lifecycle).toBe('ready');
    expect(d2.lifecycle).toBe('ready');

    // Race: both save. d1 acquires lock first, d2 waits.
    // After d1 releases, d2 acquires lock, re-validates with effectiveChain,
    // sees d1's changes in its live parent, and still passes.
    const [r1, r2] = await Promise.all([d1.save(), d2.save()]);

    expect(r1.ok).toBe(true);
    expect(r2.ok).toBe(true);

    // Env has both values
    expect(env.value('a')).toBe(1);
    expect(env.value('b')).toBe(2);
  });
});
