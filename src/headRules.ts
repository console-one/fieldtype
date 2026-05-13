import { concrete, literal, type Statement } from './statement.js';
import type { HEAD } from './head.js';

export type RuleContext = Record<string, unknown>;

export type RuleValue =
  | { readonly kind: 'literal'; readonly value: unknown }
  | { readonly kind: 'context'; readonly path: string }
  | { readonly kind: 'head'; readonly path: string };

export type RuleWhere =
  | { readonly op: 'eq'; readonly left: RuleValue; readonly right: RuleValue }
  | { readonly op: 'exists'; readonly value: RuleValue }
  | { readonly op: 'includes'; readonly haystack: RuleValue; readonly needle: RuleValue };

export type RuleWrite = {
  readonly path: string;
  readonly value: RuleValue;
  /** Skip this write when the value resolves to undefined. */
  readonly optional?: boolean;
};

export type HeadRule<C extends RuleContext = RuleContext> = {
  readonly id: string;
  readonly where?: readonly RuleWhere[];
  readonly body?: readonly RuleWrite[];
  readonly after?: (head: HEAD, ctx: C) => void;
};

export type HeadRuleResult =
  | { readonly status: 'applied'; readonly statements: readonly Statement[] }
  | { readonly status: 'suspended'; readonly ruleID: string; readonly where: RuleWhere };

export function lit(value: unknown): RuleValue {
  return { kind: 'literal', value };
}

export function ctx(path: string): RuleValue {
  return { kind: 'context', path };
}

export function head(path: string): RuleValue {
  return { kind: 'head', path };
}

export function eq(left: RuleValue, right: RuleValue): RuleWhere {
  return { op: 'eq', left, right };
}

export function exists(value: RuleValue): RuleWhere {
  return { op: 'exists', value };
}

/** Membership predicate: passes when the resolved haystack is an array
 *  containing needle (Object.is comparison). For RBAC capability-match
 *  and similar set-membership where-gates. */
export function includes(haystack: RuleValue, needle: RuleValue): RuleWhere {
  return { op: 'includes', haystack, needle };
}

export function write(path: string, value: RuleValue, opts: { optional?: boolean } = {}): RuleWrite {
  return { path, value, optional: opts.optional };
}

export function canApplyHeadRule<C extends RuleContext>(
  target: HEAD,
  rule: HeadRule<C>,
  context: C,
): true | { ruleID: string; where: RuleWhere } {
  for (const where of rule.where ?? []) {
    if (!evaluateWhere(target, context, where)) {
      return { ruleID: rule.id, where };
    }
  }
  return true;
}

export function canApplyHeadRules<C extends RuleContext>(
  target: HEAD,
  rules: readonly HeadRule<C>[],
  context: C,
): true | { ruleID: string; where: RuleWhere } {
  for (const rule of rules) {
    const result = canApplyHeadRule(target, rule, context);
    if (result !== true) return result;
  }
  return true;
}

export function applyHeadRule<C extends RuleContext>(
  target: HEAD,
  rule: HeadRule<C>,
  context: C,
): HeadRuleResult {
  const canApply = canApplyHeadRule(target, rule, context);
  if (canApply !== true) {
    return { status: 'suspended', ruleID: canApply.ruleID, where: canApply.where };
  }

  const statements: Statement[] = [];
  for (const item of rule.body ?? []) {
    const value = resolveRuleValue(target, context, item.value);
    if (value === undefined && item.optional) continue;
    const statement = concrete(renderTemplate(item.path, context), literal(value));
    target.write(statement);
    statements.push(statement);
  }
  rule.after?.(target, context);
  return { status: 'applied', statements };
}

export function applyHeadRules<C extends RuleContext>(
  target: HEAD,
  rules: readonly HeadRule<C>[],
  context: C,
): HeadRuleResult {
  for (const rule of rules) {
    const result = applyHeadRule(target, rule, context);
    if (result.status === 'suspended') return result;
  }
  return { status: 'applied', statements: [] };
}

export function resolveRuleValue<C extends RuleContext>(
  target: HEAD,
  context: C,
  value: RuleValue,
): unknown {
  switch (value.kind) {
    case 'literal':
      return value.value;
    case 'context':
      return getPath(context, value.path);
    case 'head':
      return target.value(renderTemplate(value.path, context));
  }
}

export function renderTemplate<C extends RuleContext>(template: string, context: C): string {
  return template.replace(/\{([^}]+)\}/g, (_, rawPath: string) => {
    const value = getPath(context, rawPath.trim());
    return value === undefined || value === null ? '' : String(value);
  });
}

function evaluateWhere<C extends RuleContext>(
  target: HEAD,
  context: C,
  where: RuleWhere,
): boolean {
  switch (where.op) {
    case 'eq':
      return Object.is(
        resolveRuleValue(target, context, where.left),
        resolveRuleValue(target, context, where.right),
      );
    case 'exists':
      return resolveRuleValue(target, context, where.value) !== undefined;
    case 'includes': {
      const haystack = resolveRuleValue(target, context, where.haystack);
      if (!Array.isArray(haystack)) return false;
      const needle = resolveRuleValue(target, context, where.needle);
      return haystack.some((item) => Object.is(item, needle));
    }
  }
}

function getPath(source: unknown, path: string): unknown {
  let current = source;
  for (const segment of path.split('.')) {
    if (current == null || typeof current !== 'object') return undefined;
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
}
