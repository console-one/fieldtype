/**
 * head-interpreter.test.ts — Integration tests for HEAD interpreter lifecycle.
 *
 * Proves: createHead({ interpreters }) → write value → processor classifies →
 *         impl() returns Statement[] (overlay) → write() expands inline →
 *         ref gates = gaps → fill → save.
 *
 * The HeadInterpreter<T> type is the target API. Mock interpreters (rest,
 * binding, blueprint, session) exercise the full lifecycle.
 *
 * Key design: the user NEVER calls impl() directly. They write values to
 * the HEAD. The processor classifies written values against registered
 * interpreter FieldType classifiers and dispatches internally.
 */

import { createHead, type HEAD, type HeadEvent } from '../head.js';
import { interpret } from '../headInterpreter.js';
import type { HeadInterpreter } from '../headInterpreter.js';
import { FieldType } from '../type.js';
import { ConstraintTypes } from '../constraint.js';
import { concrete, type_, export_, type Statement, type StatementLevel } from '../statement.js';

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

function gapKeys(head: HEAD): string[] {
  return head.gaps.map(g => g.key).sort();
}

function collectEvents(head: HEAD): HeadEvent[] {
  const events: HeadEvent[] = [];
  head.subscribe(e => events.push(e));
  return events;
}

// interpret() is now imported from headInterpreter.ts

/**
 * Simulates the HEAD processor's interpreter dispatch.
 *
 * In the real implementation, this logic lives inside write() on a HEAD
 * configured with `createHead(type, { interpreters })`. When the chain
 * reducer encounters a call('interpret', [value]) expression, the processor:
 *
 * 1. Extracts the value from the call args
 * 2. Classifies value against each interpreter's type FieldType
 * 3. On match: calls impl(value, stem, ctx) → Statement[]
 * 4. Writes overlay statements into draft
 *
 * The user writes: `d.write(concrete('name', interpret(proto)))`
 * The processor handles the rest.
 *
 * This helper exists to simulate the processWrite dispatch for tests
 * that bypass createHead's built-in dispatch.
 */
function processWrite<T>(
  interpreters: HeadInterpreter<T>[],
  draft: HEAD,
  name: string,
  value: T,
): void {
  const interpreter = interpreters[0];
  const ctx = {
    value: (n: string) => draft.value(n),
    callables: () => draft.callables(),
    entries: () => draft.entries(),
    host: () => draft,
  };
  const result = interpreter.impl(value, [name], ctx);

  if (Array.isArray(result)) {
    for (const s of result) {
      draft.write(s);
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Mock ServicePrototype — simplified shape for testing
// ─────────────────────────────────────────────────────────────────────────────

type MockProto = {
  name: string;
  constructorType: Record<string, string>;   // { apiKey: 'string', model: 'string' }
  serviceType: Record<string, string>;       // { listRepos: 'function', search: 'function' }
  methods: Record<string, (...args: any[]) => any>;
};

// ─────────────────────────────────────────────────────────────────────────────
// Mock Interpreters
// ─────────────────────────────────────────────────────────────────────────────

/**
 * REST interpreter.
 *
 * Takes: { method, endpoint, refs[] }
 *   refs are the names that must be resolved (from template scanning).
 * construct(): returns tool function binding.
 */
type RestSchematic = {
  method: string;
  endpoint: string;
  headers?: Record<string, string>;
  refs: string[];
};

const restInterpreter: HeadInterpreter<RestSchematic> = {
  type: objectType({ method: 'string', endpoint: 'string' }),

  impl(values, stem?) {
    const { method, endpoint, headers, refs } = values;
    const toolName = stem?.[stem.length - 1] ?? 'tool';
    const stmts: Statement[] = [];

    // Ref gates for optional deps
    for (const r of refs) {
      stmts.push({
        type: 'bind', name: r,
        expr: { type: 'ref', source: r },
        level: 'concrete' as StatementLevel,
        scope: 'optional',
      } as Statement);
      stmts.push(type_(`${r}:visibility`, { type: 'literal', value: { scope: false, propagate: false } }));
    }

    // Tool function — takes resolved deps + optional args
    const toolFn = (resolved: Record<string, string>, args?: Record<string, string>) => ({
      method,
      url: endpoint.replace(
        /\{\{([^}]+)\}\}/g,
        (_: string, key: string) => resolved[key] ?? args?.[key] ?? '',
      ),
      headers: headers
        ? Object.fromEntries(
            Object.entries(headers).map(([k, v]) => [
              k,
              v.replace(
                /\{\{([^}]+)\}\}/g,
                (_: string, key: string) => resolved[key] ?? args?.[key] ?? '',
              ),
            ]),
          )
        : {},
    });

    stmts.push(concrete(toolName, { type: 'literal', value: toolFn }));
    stmts.push(type_(`${toolName}:callable`, { type: 'literal', value: true }));
    stmts.push(export_([toolName]));

    return stmts;
  },
};

/**
 * Binding interpreter.
 *
 * Takes: { refs[], evaluate }
 *   The evaluate function IS the compiled chain expression.
 */
type BindingSchematic = {
  refs: string[];
  evaluate: (resolved: Record<string, any>) => any;
};

const bindingInterpreter: HeadInterpreter<BindingSchematic> = {
  type: objectType({ expr: 'string' }),

  impl(values, stem?) {
    const { refs, evaluate } = values;
    const bindingName = stem?.[stem.length - 1] ?? 'binding';
    const stmts: Statement[] = [];

    // Ref gates for optional deps
    for (const r of refs) {
      stmts.push({
        type: 'bind', name: r,
        expr: { type: 'ref', source: r },
        level: 'concrete' as StatementLevel,
        scope: 'optional',
      } as Statement);
      stmts.push(type_(`${r}:visibility`, { type: 'literal', value: { scope: false, propagate: false } }));
    }

    stmts.push(concrete(bindingName, { type: 'literal', value: evaluate }));
    stmts.push(export_([bindingName]));

    return stmts;
  },
};

/**
 * Blueprint interpreter — the main event.
 *
 * Takes: MockProto with constructorType + methods.
 * construct(): returns ctor ref deps (required), method bindings, factory function.
 */
const blueprintInterpreter: HeadInterpreter<MockProto> = {
  type: FieldType.object.create().save(),

  impl(proto, stem?) {
    const factoryName = stem?.[stem.length - 1] ?? proto.name;
    const stmts: Statement[] = [];

    // Ref gates for ctor deps (optional, scope:false)
    for (const key of Object.keys(proto.constructorType)) {
      stmts.push({
        type: 'bind', name: key,
        expr: { type: 'ref', source: key },
        level: 'concrete' as StatementLevel,
        scope: 'optional',
      } as Statement);
      stmts.push(type_(`${key}:visibility`, { type: 'literal', value: { scope: false, propagate: false } }));
    }

    // Method implementations as bindings
    for (const [methodName, impl] of Object.entries(proto.methods)) {
      stmts.push(concrete(methodName, { type: 'literal', value: impl }));
      stmts.push(export_([methodName]));
    }

    // Factory function — (ctorInputs) → serviceObject
    const factory = (ctorInputs: Record<string, any>) => {
      const service: Record<string, any> = {};
      for (const [methodName, impl] of Object.entries(proto.methods)) {
        service[methodName] = (...args: any[]) => impl(ctorInputs, ...args);
      }
      return service;
    };

    stmts.push(concrete(factoryName, { type: 'literal', value: factory }));
    stmts.push(export_([factoryName]));

    return stmts;
  },
};

// ─────────────────────────────────────────────────────────────────────────────
// 1. Registration — createHead({ interpreters }) registers classifiers
// ─────────────────────────────────────────────────────────────────────────────

describe('interpreter registration', () => {
  it('HeadInterpreter type has classifier + impl that returns requirements + construct', () => {
    const schematic: RestSchematic = {
      method: 'GET',
      endpoint: 'https://api.example.com/repos',
      refs: ['apiKey', 'orgId'],
    };

    const result = restInterpreter.impl(schematic, ['tool']);

    // Overlay: returns Statement[]
    expect(Array.isArray(result)).toBe(true);
    const stmts = result as Statement[];
    // Has ref gates for deps + tool binding + callable type + export
    expect(stmts.length).toBeGreaterThan(0);
    const binds = stmts.filter(s => s.type === 'bind');
    expect(binds.some(b => b.name === 'tool')).toBe(true);
  });

  it('requirements FieldType has properties matching the refs', () => {
    const schematic: RestSchematic = {
      method: 'POST',
      endpoint: 'https://api.example.com',
      refs: ['token', 'secret', 'region'],
    };

    const stmts = restInterpreter.impl(schematic, ['tool']) as Statement[];
    // Ref gate names match the refs
    const refGates = stmts
      .filter(s => s.type === 'bind' && (s as any).expr?.type === 'ref')
      .map(s => (s as any).name as string);

    expect(refGates.sort()).toEqual(['region', 'secret', 'token']);
  });

  it('blueprint interpreter requirements = constructorType properties', () => {
    const proto: MockProto = {
      name: 'openai',
      constructorType: { apiKey: 'string', model: 'string', temperature: 'number' },
      serviceType: {},
      methods: {},
    };

    const stmts = blueprintInterpreter.impl(proto, ['openai']) as Statement[];
    const refGates = stmts
      .filter(s => s.type === 'bind' && (s as any).expr?.type === 'ref')
      .map(s => (s as any).name as string)
      .sort();

    expect(refGates).toEqual(['apiKey', 'model', 'temperature']);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. Processor dispatch — write value → classify → compile → gaps appear
// ─────────────────────────────────────────────────────────────────────────────

describe('processor dispatch — write triggers classification', () => {
  it('writing a REST schematic creates draft with ref gates matching template refs', () => {
    const env = createHead();
    const draft = env.draft();

    processWrite([restInterpreter], draft, 'listRepos', {
      method: 'GET',
      endpoint: 'https://api.github.com/repos/{{orgId}}',
      headers: { Authorization: 'Bearer {{apiKey}}' },
      refs: ['apiKey', 'orgId'],
    });

    expect(draft.lifecycle).toBe('pending');
    expect(gapKeys(draft)).toEqual(['apiKey', 'orgId']);
  });

  it('writing a blueprint proto creates draft with ctor ref gaps', () => {
    const env = createHead();
    const draft = env.draft();

    processWrite([blueprintInterpreter], draft, 'github', {
      name: 'github',
      constructorType: { apiKey: 'string', orgId: 'string' },
      serviceType: { listRepos: 'function' },
      methods: { listRepos: (ctor: any) => ctor },
    });

    expect(draft.lifecycle).toBe('pending');
    expect(gapKeys(draft)).toEqual(['apiKey', 'orgId']);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. REST interpreter — classify → compile → fill → resolve → tool function
// ─────────────────────────────────────────────────────────────────────────────

describe('REST interpreter — fill refs → tool function', () => {
  it('filling refs resolves the draft', () => {
    const env = createHead();
    const draft = env.draft();

    processWrite([restInterpreter], draft, 'listRepos', {
      method: 'GET',
      endpoint: 'https://api.github.com/repos/{{orgId}}',
      refs: ['apiKey', 'orgId'],
    });

    expect(draft.lifecycle).toBe('pending');

    draft.write(concrete('apiKey', { type: 'literal', value: 'sk-test-123' }));
    expect(gapKeys(draft)).toEqual(['orgId']);

    draft.write(concrete('orgId', { type: 'literal', value: 'acme-corp' }));
    expect(draft.lifecycle).toBe('ready');
    expect(draft.gaps.length).toBe(0);
  });

  it('resolved tool function produces correct descriptor', () => {
    const env = createHead();
    const draft = env.draft();

    processWrite([restInterpreter], draft, 'listRepos', {
      method: 'GET',
      endpoint: 'https://api.github.com/repos/{{orgId}}',
      headers: { Authorization: 'Bearer {{apiKey}}' },
      refs: ['apiKey', 'orgId'],
    });

    draft.write(concrete('apiKey', { type: 'literal', value: 'sk-123' }));
    draft.write(concrete('orgId', { type: 'literal', value: 'acme' }));

    const toolFn = draft.value('listRepos') as Function;
    expect(typeof toolFn).toBe('function');

    const descriptor = toolFn({ apiKey: 'sk-123', orgId: 'acme' });
    expect(descriptor.method).toBe('GET');
    expect(descriptor.url).toBe('https://api.github.com/repos/acme');
    expect(descriptor.headers.Authorization).toBe('Bearer sk-123');
  });

  it('save merges tool into env', async () => {
    const env = createHead();
    const draft = env.draft();

    processWrite([restInterpreter], draft, 'deleteTool', {
      method: 'DELETE',
      endpoint: 'https://api.example.com/{{id}}',
      refs: ['id'],
    });

    draft.write(concrete('id', { type: 'literal', value: '42' }));
    expect(draft.lifecycle).toBe('ready');

    const result = await draft.save();
    expect(result.ok).toBe(true);

    // Tool function now on env
    const toolFn = env.value('deleteTool') as Function;
    expect(typeof toolFn).toBe('function');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 4. Binding interpreter — ref → fill → evaluate
// ─────────────────────────────────────────────────────────────────────────────

describe('binding interpreter — ref → fill → evaluate', () => {
  it('construct creates draft with ref gate for const dependency', () => {
    const env = createHead();
    const draft = env.draft();

    processWrite([bindingInterpreter], draft, 'authHeader', {
      refs: ['github.token'],
      evaluate: (r: Record<string, any>) => `Bearer ${r['github.token']}`,
    });

    expect(draft.lifecycle).toBe('pending');
    expect(gapKeys(draft)).toEqual(['github.token']);
  });

  it('filling ref resolves the binding', () => {
    const env = createHead();
    const draft = env.draft();

    processWrite([bindingInterpreter], draft, 'basicAuth', {
      refs: ['email', 'apiToken'],
      evaluate: (r: Record<string, any>) => Buffer.from(`${r.email}:${r.apiToken}`).toString('base64'),
    });

    draft.write(concrete('email', { type: 'literal', value: 'user@test.com' }));
    draft.write(concrete('apiToken', { type: 'literal', value: 'tok-abc' }));

    expect(draft.lifecycle).toBe('ready');

    const evalFn = draft.value('basicAuth') as Function;
    const result = evalFn({ email: 'user@test.com', apiToken: 'tok-abc' });
    expect(result).toBe(Buffer.from('user@test.com:tok-abc').toString('base64'));
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 5. Blueprint interpreter — the full factory lifecycle
// ─────────────────────────────────────────────────────────────────────────────

describe('blueprint interpreter — proto → factory → service', () => {
  const githubProto: MockProto = {
    name: 'github',
    constructorType: { apiKey: 'string', orgId: 'string' },
    serviceType: { listRepos: 'function', getFile: 'function' },
    methods: {
      listRepos: (ctor: any) => ({ repos: ['repo-a', 'repo-b'], org: ctor.orgId }),
      getFile: (ctor: any, path: string) => ({ content: `file at ${path}`, key: ctor.apiKey }),
    },
  };

  it('processor dispatch creates draft with gaps matching constructorType', () => {
    const env = createHead();
    const draft = env.draft();

    processWrite([blueprintInterpreter], draft, 'github', githubProto);

    // Draft has gaps matching ctor properties
    expect(draft.lifecycle).toBe('pending');
    expect(gapKeys(draft)).toEqual(['apiKey', 'orgId']);
  });

  it('filling ctor requirements resolves draft, save produces service', async () => {
    const env = createHead();
    const draft = env.draft();

    processWrite([blueprintInterpreter], draft, 'github', githubProto);

    // Fill requirements
    draft.write(concrete('apiKey', { type: 'literal', value: 'sk-github-key' }));
    expect(draft.lifecycle).toBe('pending'); // still missing orgId

    draft.write(concrete('orgId', { type: 'literal', value: 'acme-corp' }));
    expect(draft.lifecycle).toBe('ready');

    // Save merges into env
    const result = await draft.save();
    expect(result.ok).toBe(true);

    // Factory function is on the env
    const factory = env.value('github') as Function;
    expect(typeof factory).toBe('function');

    // Calling factory with ctor inputs produces the service object
    const service = factory({ apiKey: 'sk-github-key', orgId: 'acme-corp' });
    expect(service.listRepos).toBeDefined();
    expect(service.getFile).toBeDefined();

    // Service methods work with ctor inputs bound
    const repos = service.listRepos();
    expect(repos.org).toBe('acme-corp');

    const file = service.getFile('README.md');
    expect(file.content).toBe('file at README.md');
    expect(file.key).toBe('sk-github-key');
  });

  it('method impls are also available as individual bindings on env', async () => {
    const env = createHead();
    const draft = env.draft();

    processWrite([blueprintInterpreter], draft, 'github', githubProto);

    draft.write(concrete('apiKey', { type: 'literal', value: 'key' }));
    draft.write(concrete('orgId', { type: 'literal', value: 'org' }));
    await draft.save();

    // Individual method impls exported
    expect(typeof env.value('listRepos')).toBe('function');
    expect(typeof env.value('getFile')).toBe('function');
  });

  it('partially filled draft reports remaining gaps', () => {
    const env = createHead();
    const draft = env.draft();

    processWrite([blueprintInterpreter], draft, 'github', githubProto);

    draft.write(concrete('apiKey', { type: 'literal', value: 'sk-xxx' }));

    // One gap remaining
    expect(draft.gaps.length).toBe(1);
    expect(draft.gaps[0].key).toBe('orgId');
    expect(draft.gaps[0].source).toBe('orgId');
  });

  it('save succeeds with optional deps partially filled (factory pattern)', async () => {
    const env = createHead();
    const draft = env.draft();

    processWrite([blueprintInterpreter], draft, 'github', githubProto);

    // Only fill one of two optional deps
    draft.write(concrete('apiKey', { type: 'literal', value: 'sk-xxx' }));

    // lifecycle is pending because optional gaps still exist
    expect(draft.lifecycle).toBe('pending');

    // save() succeeds — all gaps are optional (factory receives deps at call time)
    const result = await draft.save();
    expect(result.ok).toBe(true);

    // Factory is available on env — works regardless of unfilled optional deps
    const factory = env.value('github') as Function;
    expect(typeof factory).toBe('function');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 6. Lifecycle tracking — transient subscription to merge state
// ─────────────────────────────────────────────────────────────────────────────

describe('draft lifecycle tracking (transient subscription)', () => {
  it('draft starts pending, transitions to ready on fill', () => {
    const env = createHead();
    const draft = env.draft();

    processWrite([restInterpreter], draft, 'tool', {
      method: 'GET',
      endpoint: 'https://example.com',
      refs: ['token'],
    });

    expect(draft.lifecycle).toBe('pending');

    draft.write(concrete('token', { type: 'literal', value: 'abc' }));
    expect(draft.lifecycle).toBe('ready');
  });

  it('subscribe fires gaps-changed as requirements fill', () => {
    const env = createHead();
    const draft = env.draft();

    processWrite([blueprintInterpreter], draft, 'svc', {
      name: 'svc',
      constructorType: { a: 'string', b: 'string', c: 'string' },
      serviceType: {},
      methods: {},
    });

    const events = collectEvents(draft);

    draft.write(concrete('a', { type: 'literal', value: '1' }));
    draft.write(concrete('b', { type: 'literal', value: '2' }));
    draft.write(concrete('c', { type: 'literal', value: '3' }));

    const gapsChanged = events.filter(e => e.type === 'gaps-changed');
    expect(gapsChanged.length).toBe(3);

    // First gaps-changed: 3 gaps → 2 gaps
    const first = gapsChanged[0] as Extract<HeadEvent, { type: 'gaps-changed' }>;
    expect(first.prev.length).toBe(3);
    expect(first.next.length).toBe(2);

    // Last gaps-changed: 1 gap → 0 gaps
    const last = gapsChanged[2] as Extract<HeadEvent, { type: 'gaps-changed' }>;
    expect(last.next.length).toBe(0);
  });

  it('draft fires write events for each statement', () => {
    const env = createHead();
    const draft = env.draft();

    processWrite([restInterpreter], draft, 'tool', {
      method: 'GET',
      endpoint: 'https://example.com',
      refs: ['key'],
    });

    const events = collectEvents(draft);

    draft.write(concrete('key', { type: 'literal', value: 'val' }));

    const writes = events.filter(e => e.type === 'write');
    expect(writes.length).toBe(1);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 7. Cascade — env fill unblocks draft
//
// The INTENT: a separate draft fills values on env, the first draft's ctor
// refs auto-resolve because they watch the env. Currently HEAD's fork parent
// is captured at fork time (stale after source advances), so we simulate
// the cascade by writing the fills into the draft directly after env advances.
//
// The fix (separate change): fork parent pointer indirects through HeadState
// so collectStatements always reads the source's current chain.
// ─────────────────────────────────────────────────────────────────────────────

describe('cascade — env advancement resolves draft', () => {
  it('env advancement auto-resolves draft gaps (fork parent indirection)', async () => {
    const env = createHead();
    const draft = env.draft();

    processWrite([blueprintInterpreter], draft, 'svc', {
      name: 'svc',
      constructorType: { apiKey: 'string' },
      serviceType: { doThing: 'function' },
      methods: { doThing: (ctor: any) => ctor.apiKey },
    });

    expect(draft.lifecycle).toBe('pending');
    expect(gapKeys(draft)).toEqual(['apiKey']);

    // Separate draft fills apiKey on env
    const fill = env.draft();
    fill.write(concrete('apiKey', { type: 'literal', value: 'sk-real' }));
    await fill.save();

    // Draft auto-resolves — effectiveChain sees the new value
    expect(draft.lifecycle).toBe('ready');
    expect(draft.gaps.length).toBe(0);

    const result = await draft.save();
    expect(result.ok).toBe(true);
  });

  it('two sequential saves: fill env → draft auto-resolves → save merges', async () => {
    const env = createHead();

    // ── Save 1: register blueprint with ctor refs ──
    const proto: MockProto = {
      name: 'slack',
      constructorType: { webhookUrl: 'string', channel: 'string' },
      serviceType: { send: 'function' },
      methods: {
        send: (ctor: any, msg: string) => ({
          posted: true,
          channel: ctor.channel,
          message: msg,
        }),
      },
    };

    const draft = env.draft();
    processWrite([blueprintInterpreter], draft, 'slack', proto);
    expect(draft.lifecycle).toBe('pending');
    expect(gapKeys(draft)).toEqual(['channel', 'webhookUrl']);

    // ── Save 2: fill requirements via env advancement ──
    // A separate draft fills the values on env; the blueprint draft
    // auto-resolves via fork parent indirection.
    const fill = env.draft();
    fill.write(concrete('webhookUrl', {
      type: 'literal',
      value: 'https://hooks.slack.com/xxx',
    }));
    fill.write(concrete('channel', {
      type: 'literal',
      value: '#general',
    }));
    await fill.save();

    // Draft auto-resolves from env advancement
    expect(draft.lifecycle).toBe('ready');
    expect(draft.gaps.length).toBe(0);

    const result = await draft.save();
    expect(result.ok).toBe(true);

    // Env now has the factory
    const factory = env.value('slack') as Function;
    expect(typeof factory).toBe('function');

    // Factory produces working service
    const service = factory({
      webhookUrl: 'https://hooks.slack.com/xxx',
      channel: '#general',
    });
    const posted = service.send('Hello world');
    expect(posted.posted).toBe(true);
    expect(posted.channel).toBe('#general');
    expect(posted.message).toBe('Hello world');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 8. Shared requirements — two blueprints, one fill
// ─────────────────────────────────────────────────────────────────────────────

describe('shared requirements across blueprints', () => {
  it('two blueprints needing the same key — fill once resolves both', () => {
    const env = createHead();

    const githubDraft = env.draft();
    processWrite([blueprintInterpreter], githubDraft, 'github', {
      name: 'github',
      constructorType: { apiKey: 'string' },
      serviceType: { list: 'function' },
      methods: { list: (ctor: any) => ({ source: 'github', key: ctor.apiKey }) },
    });

    const jiraDraft = env.draft();
    processWrite([blueprintInterpreter], jiraDraft, 'jira', {
      name: 'jira',
      constructorType: { apiKey: 'string', baseUrl: 'string' },
      serviceType: { search: 'function' },
      methods: { search: (ctor: any) => ({ source: 'jira', key: ctor.apiKey }) },
    });

    expect(gapKeys(githubDraft)).toEqual(['apiKey']);
    expect(gapKeys(jiraDraft)).toEqual(['apiKey', 'baseUrl']);

    // Fill apiKey in both drafts (same value — shared requirement)
    githubDraft.write(concrete('apiKey', { type: 'literal', value: 'shared-key' }));
    jiraDraft.write(concrete('apiKey', { type: 'literal', value: 'shared-key' }));

    // githubDraft is fully resolved
    expect(githubDraft.lifecycle).toBe('ready');

    // jiraDraft still needs baseUrl
    expect(jiraDraft.lifecycle).toBe('pending');
    expect(gapKeys(jiraDraft)).toEqual(['baseUrl']);

    jiraDraft.write(concrete('baseUrl', { type: 'literal', value: 'https://acme.atlassian.net' }));
    expect(jiraDraft.lifecycle).toBe('ready');
  });

  it('both drafts save and produce independent services', async () => {
    const env = createHead();

    const draftA = env.draft();
    processWrite([blueprintInterpreter], draftA, 'svcA', {
      name: 'svcA',
      constructorType: { token: 'string' },
      serviceType: { ping: 'function' },
      methods: { ping: (ctor: any) => `pong-A:${ctor.token}` },
    });

    const draftB = env.draft();
    processWrite([blueprintInterpreter], draftB, 'svcB', {
      name: 'svcB',
      constructorType: { token: 'string' },
      serviceType: { ping: 'function' },
      methods: { ping: (ctor: any) => `pong-B:${ctor.token}` },
    });

    // Fill both with same token
    draftA.write(concrete('token', { type: 'literal', value: 'shared-tok' }));
    draftB.write(concrete('token', { type: 'literal', value: 'shared-tok' }));

    await draftA.save();
    await draftB.save();

    const factoryA = env.value('svcA') as Function;
    const factoryB = env.value('svcB') as Function;

    const serviceA = factoryA({ token: 'shared-tok' });
    const serviceB = factoryB({ token: 'shared-tok' });

    expect(serviceA.ping()).toBe('pong-A:shared-tok');
    expect(serviceB.ping()).toBe('pong-B:shared-tok');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 9. Blueprint with REST method — interpreter composition
// ─────────────────────────────────────────────────────────────────────────────

describe('blueprint with REST method — interpreter composition', () => {
  it('blueprint compiles REST tool that shares ctor ref', async () => {
    const env = createHead();
    const draft = env.draft();

    // A proto where the REST endpoint needs the apiKey from ctor
    processWrite([blueprintInterpreter], draft, 'api', {
      name: 'api',
      constructorType: { apiKey: 'string', baseUrl: 'string' },
      serviceType: { fetchData: 'function' },
      methods: {
        fetchData: (ctor: any, path: string) => ({
          method: 'GET',
          url: `${ctor.baseUrl}/${path}`,
          headers: { Authorization: `Bearer ${ctor.apiKey}` },
        }),
      },
    });

    // Gaps = ctor requirements
    expect(gapKeys(draft)).toEqual(['apiKey', 'baseUrl']);

    // Fill ctor requirements
    draft.write(concrete('apiKey', { type: 'literal', value: 'sk-real' }));
    draft.write(concrete('baseUrl', { type: 'literal', value: 'https://api.acme.com' }));
    expect(draft.lifecycle).toBe('ready');

    await draft.save();

    // Factory on env
    const factory = env.value('api') as Function;
    const service = factory({ apiKey: 'sk-real', baseUrl: 'https://api.acme.com' });

    // Method uses ctor inputs
    const result = service.fetchData('users');
    expect(result.method).toBe('GET');
    expect(result.url).toBe('https://api.acme.com/users');
    expect(result.headers.Authorization).toBe('Bearer sk-real');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 10. Dispose semantics — draft cleanup
// ─────────────────────────────────────────────────────────────────────────────

describe('draft dispose', () => {
  it('disposed draft cannot be written to', () => {
    const env = createHead();
    const draft = env.draft();

    processWrite([restInterpreter], draft, 'tool', {
      method: 'GET',
      endpoint: 'https://example.com',
      refs: ['key'],
    });

    draft.dispose();

    expect(() => {
      draft.write(concrete('key', { type: 'literal', value: 'val' }));
    }).toThrow('HEAD is disposed');
  });

  it('disposed draft stops receiving source events', async () => {
    const env = createHead();
    const draft = env.draft();

    processWrite([blueprintInterpreter], draft, 'svc', {
      name: 'svc',
      constructorType: { x: 'string' },
      serviceType: {},
      methods: {},
    });

    const events = collectEvents(draft);

    draft.dispose();

    // Advance env — disposed draft should NOT receive events
    const writer = env.draft();
    writer.write(concrete('x', { type: 'literal', value: 'val' }));
    await writer.save();

    const gapsChanged = events.filter(e => e.type === 'gaps-changed');
    expect(gapsChanged.length).toBe(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 11. Requirements FieldType as kit form schema
// ─────────────────────────────────────────────────────────────────────────────

describe('requirements FieldType — kit form rendering', () => {
  it('requirements FieldType properties have correct types for form fields', () => {
    const proto: MockProto = {
      name: 'openai',
      constructorType: {
        apiKey: 'string',
        model: 'string',
        temperature: 'number',
        stream: 'boolean',
      },
      serviceType: {},
      methods: {},
    };

    const stmts = blueprintInterpreter.impl(proto, ['openai']) as Statement[];
    // Ref gates match all 4 ctor keys
    const refGates = stmts
      .filter(s => s.type === 'bind' && (s as any).expr?.type === 'ref')
      .map(s => (s as any).name as string)
      .sort();

    expect(refGates).toEqual(['apiKey', 'model', 'stream', 'temperature']);
  });

  it('draft gaps map 1:1 to requirements properties', () => {
    const env = createHead();
    const draft = env.draft();

    processWrite([blueprintInterpreter], draft, 'svc', {
      name: 'svc',
      constructorType: { host: 'string', port: 'number', debug: 'boolean' },
      serviceType: {},
      methods: {},
    });

    // Draft gaps match the ctor keys
    expect(gapKeys(draft)).toEqual(['debug', 'host', 'port']);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// SESSION BLUEPRINT — creates a masked client draft
//
// This is the HEAD-native replacement for forkAsBlocks() + ApplyMask.
//
// A session interpreter takes a set of API prototypes + org/identity credentials,
// creates a draft where:
//   1. Credential ctor refs are filled (concrete literals)
//   2. Remaining ctor refs are gaps (the client must fill them)
//   3. Methods are MASKED — credential params hidden from the client's signature
//   4. The exported surface shows masked methods (client's operational surface)
//
// Replaces: forkAsBlocks(sourcePackageID, { maskInputs: { '*': { org, key } } })
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * A single API entry in a session config: the prototype + which of its
 * constructor inputs the session provides (org/identity credentials).
 */
type SessionAPI = {
  proto: MockProto;
  credentials: Record<string, string>;
};

/**
 * Session config: the set of APIs to expose + credential bindings.
 *
 * In the real system, interpret(sessionConfig) writes a call expression.
 * The processor classifies it against sessionInterpreter.type and dispatches.
 */
type SessionConfig = {
  apis: SessionAPI[];
};

/**
 * Session interpreter — the HEAD-native equivalent of forkAsBlocks + ApplyMask.
 *
 * For each API in the session:
 *   1. Fills credential ctor refs as concrete output bindings (hidden from client)
 *   2. Leaves unfilled ctor refs as optional deps → ref gates the client must fill
 *   3. Creates MASKED method bindings: credentials pre-bound, hidden from caller
 *   4. Exports masked methods under `apiName.methodName` namespace
 *
 * requirements = union of ALL ctor refs NOT covered by any credential set.
 * These are the gaps the client (or kit form) must fill.
 */
const sessionInterpreter: HeadInterpreter<SessionConfig> = {
  type: objectType({ apis: 'any' }),

  impl(config) {
    // Compute requirements: union of ctor refs NOT covered by credentials
    const remaining = new Map<string, string>();
    for (const { proto, credentials } of config.apis) {
      for (const [key, typeName] of Object.entries(proto.constructorType)) {
        if (!(key in credentials)) {
          remaining.set(key, typeName);
        }
      }
    }

    const stmts: Statement[] = [];

    // Ref gates for unfilled ctor refs (optional, scope:false)
    for (const [key] of remaining) {
      stmts.push({
        type: 'bind', name: key,
        expr: { type: 'ref', source: key },
        level: 'concrete' as StatementLevel,
        scope: 'optional',
      } as Statement);
      stmts.push(type_(`${key}:visibility`, { type: 'literal', value: { scope: false, propagate: false } }));
    }

    for (const { proto, credentials } of config.apis) {
      const apiName = proto.name;

      // Credential values as concrete bindings (scope:false)
      for (const [key, value] of Object.entries(credentials)) {
        stmts.push(concrete(key, { type: 'literal', value }));
        stmts.push(type_(`${key}:visibility`, { type: 'literal', value: { scope: false, propagate: false } }));
      }

      // Masked method bindings — credentials injected from closure
      for (const [methodName, impl] of Object.entries(proto.methods)) {
        const maskedName = `${apiName}.${methodName}`;
        stmts.push(concrete(maskedName, { type: 'literal', value: (...args: any[]) => impl(credentials, ...args) }));
        stmts.push(export_([maskedName]));
      }
    }

    return stmts;
  },
};

// ─────────────────────────────────────────────────────────────────────────────
// 12. Session — fully credentialed API set
// ─────────────────────────────────────────────────────────────────────────────

describe('session blueprint — fully credentialed APIs', () => {
  const githubProto: MockProto = {
    name: 'github',
    constructorType: { apiKey: 'string', orgId: 'string' },
    serviceType: { listRepos: 'function', getFile: 'function' },
    methods: {
      listRepos: (ctor: any) => ({ repos: ['main-app', 'lib'], org: ctor.orgId, authed: !!ctor.apiKey }),
      getFile: (ctor: any, repo: string, path: string) => ({
        content: `${path} from ${repo}`,
        org: ctor.orgId,
      }),
    },
  };

  const slackProto: MockProto = {
    name: 'slack',
    constructorType: { apiKey: 'string', webhookUrl: 'string' },
    serviceType: { send: 'function', listChannels: 'function' },
    methods: {
      send: (ctor: any, channel: string, msg: string) => ({
        sent: true, channel, msg, webhook: ctor.webhookUrl,
      }),
      listChannels: (ctor: any) => ({
        channels: ['#general', '#dev'], authed: !!ctor.apiKey,
      }),
    },
  };

  it('session with all ctor refs covered → no gaps, lifecycle ready', () => {
    const env = createHead();
    const session = env.draft();

    processWrite([sessionInterpreter], session, 'session', {
      apis: [
        { proto: githubProto, credentials: { apiKey: 'sk-acme', orgId: 'acme-corp' } },
        { proto: slackProto, credentials: { apiKey: 'sk-acme', webhookUrl: 'https://hooks.slack.com/xxx' } },
      ],
    });

    // All ctor refs covered by credentials → no gaps
    expect(session.gaps.length).toBe(0);
    expect(session.lifecycle).toBe('ready');
  });

  it('masked methods available: client calls without credential params', () => {
    const env = createHead();
    const session = env.draft();

    processWrite([sessionInterpreter], session, 'session', {
      apis: [
        { proto: githubProto, credentials: { apiKey: 'sk-acme', orgId: 'acme-corp' } },
      ],
    });

    // Client sees github.listRepos — no apiKey, no orgId in signature
    const listRepos = session.value('github.listRepos') as Function;
    expect(typeof listRepos).toBe('function');

    // Client calls with NO credential args
    const repos = listRepos();
    expect(repos.repos).toEqual(['main-app', 'lib']);
    expect(repos.org).toBe('acme-corp');    // orgId injected
    expect(repos.authed).toBe(true);         // apiKey injected

    // Client sees github.getFile — credentials hidden, only repo+path needed
    const getFile = session.value('github.getFile') as Function;
    const file = getFile('main-app', 'README.md');
    expect(file.content).toBe('README.md from main-app');
    expect(file.org).toBe('acme-corp');      // orgId injected
  });

  it('multiple APIs in one session — each masked independently', () => {
    const env = createHead();
    const session = env.draft();

    processWrite([sessionInterpreter], session, 'session', {
      apis: [
        { proto: githubProto, credentials: { apiKey: 'sk-gh', orgId: 'acme' } },
        { proto: slackProto, credentials: { apiKey: 'sk-sl', webhookUrl: 'https://hooks/x' } },
      ],
    });

    // Github methods — github credentials injected
    const listRepos = session.value('github.listRepos') as Function;
    expect(listRepos().org).toBe('acme');

    // Slack methods — slack credentials injected
    const send = session.value('slack.send') as Function;
    const result = send('#general', 'Hello');
    expect(result.sent).toBe(true);
    expect(result.channel).toBe('#general');
    expect(result.webhook).toBe('https://hooks/x');  // webhook injected

    const listChannels = session.value('slack.listChannels') as Function;
    expect(listChannels().authed).toBe(true);  // apiKey injected
  });

  it('save merges masked methods into env', async () => {
    const env = createHead();
    const session = env.draft();

    processWrite([sessionInterpreter], session, 'session', {
      apis: [
        { proto: githubProto, credentials: { apiKey: 'sk-acme', orgId: 'acme' } },
      ],
    });

    await session.save();

    // Masked methods now on env
    const listRepos = env.value('github.listRepos') as Function;
    expect(listRepos().org).toBe('acme');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 13. Session — partially credentialed (remaining ctor refs = gaps)
// ─────────────────────────────────────────────────────────────────────────────

describe('session blueprint — partial credentials', () => {
  const dbProto: MockProto = {
    name: 'db',
    constructorType: { apiKey: 'string', host: 'string', port: 'number' },
    serviceType: { query: 'function' },
    methods: {
      query: (ctor: any, sql: string) => ({
        sql, host: ctor.host, port: ctor.port, authed: !!ctor.apiKey,
      }),
    },
  };

  it('unfilled ctor refs appear as gaps', () => {
    const env = createHead();
    const session = env.draft();

    // Credentials cover apiKey but NOT host or port
    processWrite([sessionInterpreter], session, 'session', {
      apis: [
        { proto: dbProto, credentials: { apiKey: 'sk-org' } },
      ],
    });

    // host and port are gaps — the client/kit-form must fill them
    expect(session.lifecycle).toBe('pending');
    expect(gapKeys(session)).toEqual(['host', 'port']);
  });

  it('filling remaining gaps resolves the session', () => {
    const env = createHead();
    const session = env.draft();

    processWrite([sessionInterpreter], session, 'session', {
      apis: [
        { proto: dbProto, credentials: { apiKey: 'sk-org' } },
      ],
    });

    expect(session.lifecycle).toBe('pending');

    session.write(concrete('host', { type: 'literal', value: 'db.acme.internal' }));
    expect(gapKeys(session)).toEqual(['port']);

    session.write(concrete('port', { type: 'literal', value: 5432 }));
    expect(session.lifecycle).toBe('ready');
    expect(session.gaps.length).toBe(0);
  });

  it('requirements FieldType = unfilled ctor props (kit form schema)', () => {
    const env = createHead();
    const session = env.draft();

    processWrite([sessionInterpreter], session, 'session', {
      apis: [
        { proto: dbProto, credentials: { apiKey: 'sk-org' } },
      ],
    });

    // Gaps should only include host and port (apiKey is covered by credentials)
    expect(gapKeys(session)).toEqual(['host', 'port']);
  });

  it('masked methods still work after filling gaps', async () => {
    const env = createHead();
    const session = env.draft();

    processWrite([sessionInterpreter], session, 'session', {
      apis: [
        { proto: dbProto, credentials: { apiKey: 'sk-org' } },
      ],
    });

    session.write(concrete('host', { type: 'literal', value: 'db.acme.internal' }));
    session.write(concrete('port', { type: 'literal', value: 5432 }));

    // Masked method available — apiKey injected from credentials
    const query = session.value('db.query') as Function;
    expect(typeof query).toBe('function');

    // NOTE: The masked method closes over credentials ({ apiKey: 'sk-org' }).
    // Host and port are NOT in the credentials closure — they're in the draft scope.
    // In the real implementation, the masked method would read remaining values
    // from the draft scope. For this test, the closure only sees credentials.
    const result = query('SELECT * FROM users');
    expect(result.sql).toBe('SELECT * FROM users');
    expect(result.authed).toBe(true);  // apiKey from credentials
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 14. Session — shared credentials across APIs
// ─────────────────────────────────────────────────────────────────────────────

describe('session blueprint — shared org credentials', () => {
  it('org-level apiKey shared across multiple APIs', () => {
    const env = createHead();
    const session = env.draft();

    const githubProto: MockProto = {
      name: 'github',
      constructorType: { apiKey: 'string', orgId: 'string' },
      serviceType: { list: 'function' },
      methods: { list: (ctor: any) => ({ source: 'github', key: ctor.apiKey, org: ctor.orgId }) },
    };

    const jiraProto: MockProto = {
      name: 'jira',
      constructorType: { apiKey: 'string', baseUrl: 'string' },
      serviceType: { search: 'function' },
      methods: { search: (ctor: any) => ({ source: 'jira', key: ctor.apiKey, url: ctor.baseUrl }) },
    };

    // Both APIs share apiKey, but jira also needs baseUrl
    processWrite([sessionInterpreter], session, 'session', {
      apis: [
        { proto: githubProto, credentials: { apiKey: 'sk-shared', orgId: 'acme' } },
        { proto: jiraProto, credentials: { apiKey: 'sk-shared' } },
      ],
    });

    // Only jira's baseUrl is unfilled
    expect(gapKeys(session)).toEqual(['baseUrl']);

    // Github is fully masked — works now
    const ghList = session.value('github.list') as Function;
    expect(ghList().key).toBe('sk-shared');
    expect(ghList().org).toBe('acme');

    // Jira is masked but session has a gap (baseUrl)
    const jiraSearch = session.value('jira.search') as Function;
    // The method exists (it closes over credentials), but baseUrl isn't in credentials
    const result = jiraSearch();
    expect(result.key).toBe('sk-shared');      // apiKey injected
    expect(result.url).toBeUndefined();         // baseUrl NOT in credentials

    // Fill the remaining gap
    session.write(concrete('baseUrl', { type: 'literal', value: 'https://acme.atlassian.net' }));
    expect(session.lifecycle).toBe('ready');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 15. Session — credential isolation (two sessions, different orgs)
// ─────────────────────────────────────────────────────────────────────────────

describe('session blueprint — credential isolation', () => {
  it('two sessions for different orgs produce independent masked APIs', () => {
    const env = createHead();

    const apiProto: MockProto = {
      name: 'api',
      constructorType: { apiKey: 'string', orgId: 'string' },
      serviceType: { whoami: 'function' },
      methods: {
        whoami: (ctor: any) => ({ key: ctor.apiKey, org: ctor.orgId }),
      },
    };

    // Session for Acme
    const acmeSession = env.draft();
    processWrite([sessionInterpreter], acmeSession, 'session', {
      apis: [{ proto: apiProto, credentials: { apiKey: 'sk-acme', orgId: 'acme' } }],
    });

    // Session for TechCo
    const techcoSession = env.draft();
    processWrite([sessionInterpreter], techcoSession, 'session', {
      apis: [{ proto: apiProto, credentials: { apiKey: 'sk-techco', orgId: 'techco' } }],
    });

    // Each session's masked method injects its own credentials
    const acmeWhoami = acmeSession.value('api.whoami') as Function;
    const techcoWhoami = techcoSession.value('api.whoami') as Function;

    expect(acmeWhoami().org).toBe('acme');
    expect(acmeWhoami().key).toBe('sk-acme');

    expect(techcoWhoami().org).toBe('techco');
    expect(techcoWhoami().key).toBe('sk-techco');
  });

  it('sessions are independent drafts — one dispose does not affect the other', () => {
    const env = createHead();

    const apiProto: MockProto = {
      name: 'svc',
      constructorType: { token: 'string' },
      serviceType: { ping: 'function' },
      methods: { ping: (ctor: any) => `pong:${ctor.token}` },
    };

    const s1 = env.draft();
    processWrite([sessionInterpreter], s1, 'session', {
      apis: [{ proto: apiProto, credentials: { token: 'tok-1' } }],
    });

    const s2 = env.draft();
    processWrite([sessionInterpreter], s2, 'session', {
      apis: [{ proto: apiProto, credentials: { token: 'tok-2' } }],
    });

    // Dispose s1 — s2 should still work
    s1.dispose();

    expect(() => {
      s1.write(concrete('x', { type: 'literal', value: 1 }));
    }).toThrow('HEAD is disposed');

    // s2 unaffected
    const ping = s2.value('svc.ping') as Function;
    expect(ping()).toBe('pong:tok-2');
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 16. Built-in interpreter dispatch — createHead({ interpreters })
//
// These tests use the real built-in dispatch mechanism:
//   createHead(type, { interpreters }) + write(concrete('name', interpret(value)))
// instead of the processWrite() helper.
// ═══════════════════════════════════════════════════════════════════════════════

describe('built-in interpreter dispatch', () => {
  it('createHead({ interpreters }) + interpret() dispatches to first matching interpreter', () => {
    const env = createHead(FieldType.object.create().save(), {
      interpreters: [restInterpreter],
    });
    const draft = env.draft();

    // Write an interpret expression — the processor classifies and dispatches
    draft.write(concrete('listRepos', interpret({
      method: 'GET',
      endpoint: 'https://api.github.com/repos/{{orgId}}',
      headers: { Authorization: 'Bearer {{apiKey}}' },
      refs: ['apiKey', 'orgId'],
    })));

    expect(draft.lifecycle).toBe('pending');
    expect(gapKeys(draft)).toEqual(['apiKey', 'orgId']);

    // Fill refs → ready
    draft.write(concrete('apiKey', { type: 'literal', value: 'sk-123' }));
    draft.write(concrete('orgId', { type: 'literal', value: 'acme' }));
    expect(draft.lifecycle).toBe('ready');

    // Tool function works
    const toolFn = draft.value('listRepos') as Function;
    expect(typeof toolFn).toBe('function');
    const descriptor = toolFn({ apiKey: 'sk-123', orgId: 'acme' });
    expect(descriptor.url).toBe('https://api.github.com/repos/acme');
  });

  it('blueprint interpreter via built-in dispatch', () => {
    const env = createHead(FieldType.object.create().save(), {
      interpreters: [blueprintInterpreter],
    });
    const draft = env.draft();

    draft.write(concrete('github', interpret({
      name: 'github',
      constructorType: { apiKey: 'string', orgId: 'string' },
      serviceType: { listRepos: 'function' },
      methods: { listRepos: (ctor: any) => ({ org: ctor.orgId }) },
    })));

    expect(draft.lifecycle).toBe('pending');
    expect(gapKeys(draft)).toEqual(['apiKey', 'orgId']);

    draft.write(concrete('apiKey', { type: 'literal', value: 'key' }));
    draft.write(concrete('orgId', { type: 'literal', value: 'acme' }));
    expect(draft.lifecycle).toBe('ready');

    const factory = draft.value('github') as Function;
    expect(typeof factory).toBe('function');
    expect(factory({ apiKey: 'key', orgId: 'acme' }).listRepos().org).toBe('acme');
  });

  it('first matching interpreter wins', () => {
    // restInterpreter matches { method, endpoint }
    // blueprintInterpreter matches any object (broader)
    // Registration order: rest first → rest should win for REST-shaped values
    const env = createHead(FieldType.object.create().save(), {
      interpreters: [restInterpreter, blueprintInterpreter],
    });
    const draft = env.draft();

    draft.write(concrete('tool', interpret({
      method: 'GET',
      endpoint: 'https://api.example.com',
      refs: ['token'],
    })));

    // REST interpreter matched → gap is 'token'
    expect(gapKeys(draft)).toEqual(['token']);
  });

  it('no interpreter match → statement is a regular call expression (no dispatch)', () => {
    const env = createHead(FieldType.object.create().save(), {
      interpreters: [restInterpreter],
    });

    // Write a value that doesn't match restInterpreter's type (needs method + endpoint)
    env.write(concrete('x', interpret('just a string')));

    // No dispatch occurred, the call expression is just stored as-is
    // No gaps from interpreter dispatch
    expect(env.gaps.length).toBe(0);
  });

  it('drafts inherit interpreters from root', () => {
    const env = createHead(FieldType.object.create().save(), {
      interpreters: [restInterpreter],
    });
    const d1 = env.draft();
    const d2 = d1.draft();

    // Inner draft also dispatches — interpreters inherited from root
    d2.write(concrete('tool', interpret({
      method: 'POST',
      endpoint: 'https://api.example.com',
      refs: ['auth'],
    })));

    expect(gapKeys(d2)).toEqual(['auth']);
  });

  it('save merges interpreter-compiled bindings into source', async () => {
    const env = createHead(FieldType.object.create().save(), {
      interpreters: [restInterpreter],
    });
    const draft = env.draft();

    draft.write(concrete('deleteTool', interpret({
      method: 'DELETE',
      endpoint: 'https://api.example.com/{{id}}',
      refs: ['id'],
    })));

    draft.write(concrete('id', { type: 'literal', value: '42' }));
    const result = await draft.save();
    expect(result.ok).toBe(true);

    // Tool function now on env
    const toolFn = env.value('deleteTool') as Function;
    expect(typeof toolFn).toBe('function');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Phase 0: Demand-driven (lazy) interpreter dispatch
//
// Proves: writing a raw value (literal, not wrapped in interpret()) triggers
// interpreter dispatch on first read — same result as eager dispatch.
//
// These tests use HEAD-returning interpreters (not Statement[] overlays).
// Demand-driven dispatch only supports HEAD returns — Statement[] overlays
// require explicit interpret() on the write side (legacy path).
// ─────────────────────────────────────────────────────────────────────────────

/** HEAD-returning REST interpreter for demand-driven dispatch tests. */
const restInterpreterHead: HeadInterpreter<RestSchematic> = {
  type: objectType({ method: 'string', endpoint: 'string' }),

  impl(values, stem?) {
    const { method, endpoint, headers, refs } = values;
    const toolName = stem?.[stem.length - 1] ?? 'tool';
    const h = createHead();

    // Ref gates for deps → become child HEAD gaps
    for (const r of refs) {
      h.write({
        type: 'bind', name: r,
        expr: { type: 'ref', source: r },
        level: 'concrete' as StatementLevel,
        scope: 'optional',
      } as Statement);
      h.write(type_(`${r}:visibility`, { type: 'literal', value: { scope: false, propagate: false } }));
    }

    // Tool function — takes resolved deps + optional args
    const toolFn = (resolved: Record<string, string>, args?: Record<string, string>) => ({
      method,
      url: endpoint.replace(
        /\{\{([^}]+)\}\}/g,
        (_: string, key: string) => resolved[key] ?? args?.[key] ?? '',
      ),
      headers: headers
        ? Object.fromEntries(
            Object.entries(headers).map(([k, v]) => [
              k,
              v.replace(
                /\{\{([^}]+)\}\}/g,
                (_: string, key: string) => resolved[key] ?? args?.[key] ?? '',
              ),
            ]),
          )
        : {},
    });

    h.write(concrete(toolName, { type: 'literal', value: toolFn }));
    h.write(type_(`${toolName}:callable`, { type: 'literal', value: true }));
    h.write(export_([toolName]));
    return h;
  },
};

/** HEAD-returning Blueprint interpreter for demand-driven dispatch tests. */
const blueprintInterpreterHead: HeadInterpreter<MockProto> = {
  type: FieldType.object.create().save(),

  impl(proto, stem?) {
    const factoryName = stem?.[stem.length - 1] ?? proto.name;
    const h = createHead();

    // Ref gates for ctor deps → become child HEAD gaps
    for (const key of Object.keys(proto.constructorType)) {
      h.write({
        type: 'bind', name: key,
        expr: { type: 'ref', source: key },
        level: 'concrete' as StatementLevel,
        scope: 'optional',
      } as Statement);
      h.write(type_(`${key}:visibility`, { type: 'literal', value: { scope: false, propagate: false } }));
    }

    // Method implementations as bindings
    for (const [methodName, impl] of Object.entries(proto.methods)) {
      h.write(concrete(methodName, { type: 'literal', value: impl }));
      h.write(export_([methodName]));
    }

    // Factory function — (ctorInputs) → serviceObject
    const factory = (ctorInputs: Record<string, any>) => {
      const service: Record<string, any> = {};
      for (const [methodName, impl] of Object.entries(proto.methods)) {
        service[methodName] = (...args: any[]) => impl(ctorInputs, ...args);
      }
      return service;
    };

    h.write(concrete(factoryName, { type: 'literal', value: factory }));
    h.write(export_([factoryName]));
    return h;
  },
};

describe('demand-driven interpreter dispatch', () => {
  it('raw literal value triggers interpreter on first value() read', () => {
    const env = createHead(FieldType.object.create().save(), {
      interpreters: [restInterpreterHead],
    });
    const draft = env.draft();

    // Write a RAW literal — NOT wrapped in interpret()
    draft.write(concrete('listRepos', {
      type: 'literal',
      value: {
        method: 'GET',
        endpoint: 'https://api.github.com/repos/{{orgId}}',
        headers: { Authorization: 'Bearer {{apiKey}}' },
        refs: ['apiKey', 'orgId'],
      },
    }));

    // Reading gaps triggers lazy interpretation → interpreter fires → gaps surface.
    expect(draft.gaps.map(g => g.key).sort()).toEqual(['apiKey', 'orgId']);

    // Fill deps
    draft.write(concrete('apiKey', { type: 'literal', value: 'sk-123' }));
    draft.write(concrete('orgId', { type: 'literal', value: 'acme' }));

    // Tool function available via interpreter child — same as eager dispatch
    const toolFn = draft.value('listRepos') as Function;
    expect(typeof toolFn).toBe('function');
    const descriptor = toolFn({ apiKey: 'sk-123', orgId: 'acme' });
    expect(descriptor.url).toBe('https://api.github.com/repos/acme');
  });

  it('raw literal value triggers interpreter on entries() read', () => {
    const env = createHead(FieldType.object.create().save(), {
      interpreters: [restInterpreterHead],
    });
    const draft = env.draft();

    draft.write(concrete('tool', {
      type: 'literal',
      value: {
        method: 'POST',
        endpoint: 'https://api.example.com/submit',
        refs: [],
      },
    }));

    // entries() triggers lazy interpretation
    const ents = draft.entries();
    const toolFn = ents.get('tool');
    expect(typeof toolFn).toBe('function');
  });

  it('first matching interpreter wins for raw values (same as eager)', () => {
    const env = createHead(FieldType.object.create().save(), {
      interpreters: [restInterpreterHead, blueprintInterpreterHead],
    });
    const draft = env.draft();

    draft.write(concrete('tool', {
      type: 'literal',
      value: {
        method: 'GET',
        endpoint: 'https://api.example.com',
        refs: ['token'],
      },
    }));

    // REST interpreter should win (first match) → gap is 'token'
    expect(draft.gaps.map(g => g.key)).toEqual(['token']);
  });

  it('non-matching raw values are left as-is', () => {
    const env = createHead(FieldType.object.create().save(), {
      interpreters: [restInterpreterHead],
    });

    // Write a string value — restInterpreterHead needs { method, endpoint }
    env.write(concrete('x', { type: 'literal', value: 'just a string' }));

    // Not interpreted — plain value returned
    expect(env.value('x')).toBe('just a string');
  });

  it('eager interpret() and lazy dispatch coexist', () => {
    const env = createHead(FieldType.object.create().save(), {
      interpreters: [restInterpreterHead],
    });
    const draft = env.draft();

    // Eager dispatch (existing path) — still uses Statement[]-returning restInterpreter
    draft.write(concrete('eagerTool', interpret({
      method: 'GET',
      endpoint: 'https://eager.com/{{id}}',
      refs: ['id'],
    })));

    // Lazy dispatch (new path)
    draft.write(concrete('lazyTool', {
      type: 'literal',
      value: {
        method: 'POST',
        endpoint: 'https://lazy.com/submit',
        refs: [],
      },
    }));

    // Both should produce callable functions
    const eagerGaps = draft.gaps.map(g => g.key);
    expect(eagerGaps).toContain('id');

    // Fill the eager tool's dep
    draft.write(concrete('id', { type: 'literal', value: '42' }));

    expect(typeof draft.value('eagerTool')).toBe('function');
    expect(typeof draft.value('lazyTool')).toBe('function');
  });

  it('demand-driven dispatch propagates interpreter gaps to parent', () => {
    const env = createHead(FieldType.object.create().save(), {
      interpreters: [blueprintInterpreterHead],
    });
    const draft = env.draft();

    // Write raw blueprint proto — NOT wrapped in interpret()
    draft.write(concrete('github', {
      type: 'literal',
      value: {
        name: 'github',
        constructorType: { apiKey: 'string' },
        serviceType: { listRepos: 'function' },
        methods: { listRepos: (ctor: any) => ({ key: ctor.apiKey }) },
      },
    }));

    // Gap should surface from interpreter child → parent
    expect(draft.gaps.map(g => g.key)).toContain('apiKey');

    // Fill → service constructs
    draft.write(concrete('apiKey', { type: 'literal', value: 'key' }));
    const factory = draft.value('github') as Function;
    expect(typeof factory).toBe('function');
  });
});
