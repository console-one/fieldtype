import assert from 'node:assert/strict';

import { createHead } from '../head.js';
import {
  applyHeadRules,
  canApplyHeadRules,
  ctx,
  eq,
  head,
  lit,
  write,
  type HeadRule,
} from '../headRules.js';
import { concrete, literal } from '../statement.js';

type TestContext = {
  event: {
    eventtype: 'job-claimed';
    jobID: string;
    procID: string;
    sessionID: string;
  };
};

const claimRule: HeadRule<TestContext> = {
  id: 'test.job-claimed',
  where: [
    eq(head('req.{event.jobID}.status'), lit('pending')),
  ],
  body: [
    write('proc.{event.procID}.req', ctx('event.jobID')),
    write('proc.{event.procID}.holder', ctx('event.sessionID')),
    write('proc.{event.procID}.status', lit('active')),
  ],
};

const headState = createHead({ onMerge: null });
const context: TestContext = {
  event: {
    eventtype: 'job-claimed',
    jobID: 'daily',
    procID: 'proc-a',
    sessionID: 'session-a',
  },
};

const blocked = canApplyHeadRules(headState, [claimRule], context);
assert.notEqual(blocked, true);

const suspended = applyHeadRules(headState, [claimRule], context);
assert.equal(suspended.status, 'suspended');
assert.equal(headState.value('proc.proc-a.status'), undefined);

headState.write(concrete('req.daily.status', literal('pending')));

const ready = canApplyHeadRules(headState, [claimRule], context);
assert.equal(ready, true);

const applied = applyHeadRules(headState, [claimRule], context);
assert.equal(applied.status, 'applied');
assert.equal(headState.value('proc.proc-a.req'), 'daily');
assert.equal(headState.value('proc.proc-a.holder'), 'session-a');
assert.equal(headState.value('proc.proc-a.status'), 'active');

console.log('head-rules.verify: ok');
