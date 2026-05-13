import assert from 'node:assert/strict';

import { createHead, type HEAD } from '../head.js';
import { validate } from '../validate.js';
import { types, type FieldType } from '../builders.js';
import { concrete, literal, type Statement } from '../statement.js';

type TopicAddress = {
  server?: string;
  uri: string;
  as: string;
};

type CapabilityAdvertisedEvent = {
  eventtype: 'capability-advertised';
  sessionID: string;
  userID: string;
  capabilities: string[];
  leaseUntil: number;
  ts: number;
};

type JobCreatedEvent = {
  eventtype: 'job-created';
  jobID: string;
  capability: string;
  inputs: TopicAddress[];
  output: TopicAddress;
  deadline: number;
  budget?: unknown;
  createdBy: string;
  ts: number;
};

type JobClaimedEvent = {
  eventtype: 'job-claimed';
  jobID: string;
  procID: string;
  sessionID: string;
  leaseUntil: number;
  ts: number;
};

type JobResultEvent = {
  eventtype: 'job-result';
  jobID: string;
  procID: string;
  outputAddress: TopicAddress;
  metrics?: Record<string, unknown>;
  ts: number;
};

type JobAcceptedEvent = {
  eventtype: 'job-accepted';
  jobID: string;
  procID: string;
  ts: number;
};

type OrchestrationEvent =
  | CapabilityAdvertisedEvent
  | JobCreatedEvent
  | JobClaimedEvent
  | JobResultEvent
  | JobAcceptedEvent;

type Receipt = {
  eventID: string;
  topicSeq: number;
  author?: string;
  status: 'applied' | 'rejected' | 'suspended' | 'duplicate';
  reason?: string;
};

type Pending = {
  event: OrchestrationEvent;
  receipt: Receipt;
};

const lit = (value: string): FieldType => types.string().literal(value).save();

const TopicAddressFieldType = types
  .object()
  .property('server', types.string(), { optional: true })
  .property('uri', types.string())
  .property('as', types.string())
  .save();

const CapabilityAdvertisedEventFieldType = types
  .object()
  .property('eventtype', lit('capability-advertised'))
  .property('sessionID', types.string())
  .property('userID', types.string())
  .property('capabilities', types.array(TopicAddressFieldType).save())
  .property('leaseUntil', types.number())
  .property('ts', types.number())
  .save();

const JobCreatedEventFieldType = types
  .object()
  .property('eventtype', lit('job-created'))
  .property('jobID', types.string())
  .property('capability', types.string())
  .property('inputs', types.array(TopicAddressFieldType).save())
  .property('output', TopicAddressFieldType)
  .property('deadline', types.number())
  .property('budget', types.any(), { optional: true })
  .property('createdBy', types.string())
  .property('ts', types.number())
  .save();

const JobClaimedEventFieldType = types
  .object()
  .property('eventtype', lit('job-claimed'))
  .property('jobID', types.string())
  .property('procID', types.string())
  .property('sessionID', types.string())
  .property('leaseUntil', types.number())
  .property('ts', types.number())
  .save();

const JobResultEventFieldType = types
  .object()
  .property('eventtype', lit('job-result'))
  .property('jobID', types.string())
  .property('procID', types.string())
  .property('outputAddress', TopicAddressFieldType)
  .property('metrics', types.any(), { optional: true })
  .property('ts', types.number())
  .save();

const JobAcceptedEventFieldType = types
  .object()
  .property('eventtype', lit('job-accepted'))
  .property('jobID', types.string())
  .property('procID', types.string())
  .property('ts', types.number())
  .save();

function fieldTypeForEvent(event: OrchestrationEvent): FieldType {
  switch (event.eventtype) {
    case 'capability-advertised':
      return CapabilityAdvertisedEventFieldType;
    case 'job-created':
      return JobCreatedEventFieldType;
    case 'job-claimed':
      return JobClaimedEventFieldType;
    case 'job-result':
      return JobResultEventFieldType;
    case 'job-accepted':
      return JobAcceptedEventFieldType;
  }
}

class SharedTopicHeadKernel {
  readonly head: HEAD;
  readonly receipts: Receipt[] = [];

  private readonly seen = new Set<string>();
  private readonly pending: Pending[] = [];

  constructor(head: HEAD = createHead({ onMerge: null })) {
    this.head = head;
  }

  applyEvent(
    eventID: string,
    topicSeq: number,
    event: OrchestrationEvent,
    author?: string,
  ): Receipt {
    if (this.seen.has(eventID)) {
      return this.record({ eventID, topicSeq, author, status: 'duplicate' });
    }

    const validity = validate(fieldTypeForEvent(event), event);
    if (!validity.ok) {
      return this.record({
        eventID,
        topicSeq,
        author,
        status: 'rejected',
        reason: validity.faults.map(f => f.path.join('.') || '<root>').join(', '),
      });
    }

    const receipt: Receipt = { eventID, topicSeq, author, status: 'applied' };
    if (!this.canApply(event)) {
      receipt.status = 'suspended';
      receipt.reason = 'where-gate';
      this.pending.push({ event, receipt });
      this.seen.add(eventID);
      this.receipts.push(receipt);
      return receipt;
    }

    this.seen.add(eventID);
    this.writeEvent(eventID, event);
    this.project(event, topicSeq);
    this.receipts.push(receipt);
    this.retryPending();
    return receipt;
  }

  value(path: string): unknown {
    return this.head.value(path);
  }

  private record(receipt: Receipt): Receipt {
    this.receipts.push(receipt);
    return receipt;
  }

  private canApply(event: OrchestrationEvent): boolean {
    if (event.eventtype === 'job-claimed') {
      return this.head.value(`req.${event.jobID}.status`) === 'pending';
    }
    if (event.eventtype === 'job-result') {
      return this.head.value(`proc.${event.procID}.status`) === 'active';
    }
    if (event.eventtype === 'job-accepted') {
      return this.head.value(`req.${event.jobID}.results.${event.procID}.outputAddress`) !== undefined;
    }
    return true;
  }

  private retryPending(): void {
    let progressed = true;
    while (progressed) {
      progressed = false;
      for (let i = 0; i < this.pending.length; i++) {
        const item = this.pending[i];
        if (!this.canApply(item.event)) continue;
        item.receipt.status = 'applied';
        item.receipt.reason = undefined;
        this.writeEvent(item.receipt.eventID, item.event);
        this.project(item.event, item.receipt.topicSeq);
        this.pending.splice(i, 1);
        i--;
        progressed = true;
      }
    }
  }

  private writeEvent(eventID: string, event: OrchestrationEvent): void {
    this.write(concrete(`events.${eventID}`, literal(event)));
  }

  private project(event: OrchestrationEvent, topicSeq: number): void {
    switch (event.eventtype) {
      case 'capability-advertised': {
        const base = `sessions.${event.sessionID}`;
        this.write(concrete(`${base}.user`, literal(event.userID)));
        this.write(concrete(`${base}.capabilities`, literal(event.capabilities)));
        this.write(concrete(`${base}.leaseUntil`, literal(event.leaseUntil)));
        this.write(concrete(`${base}.heartbeat`, literal(event.ts)));
        return;
      }
      case 'job-created': {
        const base = `req.${event.jobID}`;
        this.write(concrete(`${base}.capability`, literal(event.capability)));
        this.write(concrete(`${base}.inputs`, literal(event.inputs)));
        this.write(concrete(`${base}.output`, literal(event.output)));
        this.write(concrete(`${base}.deadline`, literal(event.deadline)));
        if (event.budget !== undefined) {
          this.write(concrete(`${base}.budget`, literal(event.budget)));
        }
        this.write(concrete(`${base}.createdBy`, literal(event.createdBy)));
        this.write(concrete(`${base}.createdAt`, literal(event.ts)));
        this.write(concrete(`${base}.status`, literal('pending')));
        return;
      }
      case 'job-claimed': {
        const procBase = `proc.${event.procID}`;
        this.write(concrete(`${procBase}.req`, literal(event.jobID)));
        this.write(concrete(`${procBase}.holder`, literal(event.sessionID)));
        this.write(concrete(`${procBase}.leaseExpiry`, literal(event.leaseUntil)));
        this.write(concrete(`${procBase}.status`, literal('active')));
        this.write(concrete(`${procBase}.startedAt`, literal(event.ts)));

        const claimBase = `req.${event.jobID}.claims.${event.procID}`;
        this.write(concrete(`${claimBase}.sessionID`, literal(event.sessionID)));
        this.write(concrete(`${claimBase}.topicSeq`, literal(topicSeq)));
        this.write(concrete(`${claimBase}.leaseUntil`, literal(event.leaseUntil)));

        this.projectClaimWinner(event.jobID);
        return;
      }
      case 'job-result': {
        this.write(concrete(`proc.${event.procID}.status`, literal('released')));
        const resultBase = `req.${event.jobID}.results.${event.procID}`;
        this.write(concrete(`${resultBase}.outputAddress`, literal(event.outputAddress)));
        if (event.metrics !== undefined) {
          this.write(concrete(`${resultBase}.metrics`, literal(event.metrics)));
        }
        return;
      }
      case 'job-accepted': {
        this.write(concrete(`req.${event.jobID}.acceptedProc`, literal(event.procID)));
        this.write(concrete(`req.${event.jobID}.status`, literal('fulfilled')));
        this.write(concrete(`req.${event.jobID}.acceptedAt`, literal(event.ts)));
        const acceptedOutput = this.head.value(
          `req.${event.jobID}.results.${event.procID}.outputAddress`,
        );
        if (acceptedOutput !== undefined) {
          this.write(concrete(`req.${event.jobID}.outputAddress`, literal(acceptedOutput)));
        }
        return;
      }
    }
  }

  private projectClaimWinner(jobID: string): void {
    let winner: { procID: string; topicSeq: number } | null = null;
    for (const [path, value] of this.head.entries()) {
      const match = path.match(new RegExp(`^req\\.${escapeRegExp(jobID)}\\.claims\\.([^.]+)\\.topicSeq$`));
      if (!match || typeof value !== 'number') continue;
      if (!winner || value < winner.topicSeq) {
        winner = { procID: match[1], topicSeq: value };
      }
    }
    if (winner) {
      this.write(concrete(`req.${jobID}.winnerProc`, literal(winner.procID)));
      this.write(concrete(`req.${jobID}.winnerTopicSeq`, literal(winner.topicSeq)));
    }
  }

  private write(statement: Statement): void {
    this.head.write(statement);
  }
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function run(): void {
  const topicA: TopicAddress = { uri: 'topic:narratives', as: 'topic' };
  const topicB: TopicAddress = { uri: 'topic:daily-summary', as: 'topic' };
  const kernel = new SharedTopicHeadKernel();

  const claimBeforeJob = kernel.applyEvent('e-claim-before-job', 1, {
    eventtype: 'job-claimed',
    jobID: 'daily',
    procID: 'proc_early',
    sessionID: 'session-a',
    leaseUntil: 2_000,
    ts: 1_000,
  });
  assert.equal(claimBeforeJob.status, 'suspended');

  const malformed = kernel.applyEvent('e-bad-job', 2, {
    eventtype: 'job-created',
    capability: 'summarize.daily',
    inputs: [topicA],
    output: topicB,
    deadline: 5_000,
    createdBy: 'session-a',
    ts: 1_100,
  } as JobCreatedEvent);
  assert.equal(malformed.status, 'rejected');
  assert.equal(kernel.value('req.undefined.status'), undefined);

  const created = kernel.applyEvent('e-job', 3, {
    eventtype: 'job-created',
    jobID: 'daily',
    capability: 'summarize.daily',
    inputs: [topicA],
    output: topicB,
    deadline: 5_000,
    createdBy: 'session-a',
    ts: 1_200,
  });
  assert.equal(created.status, 'applied');
  assert.equal(kernel.value('req.daily.status'), 'pending');
  assert.equal(claimBeforeJob.status, 'applied');
  assert.equal(kernel.value('proc.proc_early.status'), 'active');

  const duplicate = kernel.applyEvent('e-job', 3, {
    eventtype: 'job-created',
    jobID: 'daily',
    capability: 'summarize.daily',
    inputs: [topicA],
    output: topicB,
    deadline: 5_000,
    createdBy: 'session-a',
    ts: 1_200,
  });
  assert.equal(duplicate.status, 'duplicate');

  kernel.applyEvent('e-claim-later', 4, {
    eventtype: 'job-claimed',
    jobID: 'daily',
    procID: 'proc_later',
    sessionID: 'session-b',
    leaseUntil: 2_500,
    ts: 1_300,
  });
  assert.equal(kernel.value('req.daily.winnerProc'), 'proc_early');
  assert.equal(kernel.value('req.daily.winnerTopicSeq'), 1);

  kernel.applyEvent('e-losing-result', 5, {
    eventtype: 'job-result',
    jobID: 'daily',
    procID: 'proc_later',
    outputAddress: { uri: 'topic:wrong-output', as: 'topic' },
    ts: 1_400,
  });
  assert.equal(
    (kernel.value('req.daily.results.proc_later.outputAddress') as TopicAddress).uri,
    'topic:wrong-output',
  );
  assert.equal(kernel.value('req.daily.outputAddress'), undefined);

  kernel.applyEvent('e-winning-result', 6, {
    eventtype: 'job-result',
    jobID: 'daily',
    procID: 'proc_early',
    outputAddress: { uri: 'topic:right-output', as: 'topic' },
    ts: 1_500,
  });
  kernel.applyEvent('e-accept', 7, {
    eventtype: 'job-accepted',
    jobID: 'daily',
    procID: 'proc_early',
    ts: 1_600,
  });
  assert.equal(kernel.value('req.daily.status'), 'fulfilled');
  assert.equal(kernel.value('req.daily.acceptedProc'), 'proc_early');
  assert.equal(
    (kernel.value('req.daily.outputAddress') as TopicAddress).uri,
    'topic:right-output',
  );

  console.log('head-shared-kernel.verify: ok');
}

run();
