import { describe, expect, it } from 'vitest';
import {
  WORKER_PROTOCOL_VERSION,
  isWorkerReply,
  isWorkerRequest,
} from './workerProtocol';

/**
 * The main ↔ worker guards.
 *
 * The worker is a child of our own main process rather than untrusted input, so
 * what these catch is **version skew** — a stale build against a fresh one — and
 * the value of catching it is a clear rejection instead of a `TypeError` three
 * frames deep. That is why an unknown kind is refused rather than tolerated: a
 * message this build cannot name is one it cannot handle correctly either.
 */

const request = (overrides: Record<string, unknown> = {}) => ({
  kind: 'generateMatrixReport',
  requestId: 'req-1',
  payload: { targetPath: 'C:/report.pdf' },
  ...overrides,
});

const reply = (overrides: Record<string, unknown> = {}) => ({
  kind: 'reported',
  requestId: 'req-1',
  path: 'C:/report.pdf',
  pageCount: 3,
  blockNumber: '11642262',
  readAt: 1_756_000_000,
  rows: 12,
  degradedRows: 1,
  empty: false,
  ...overrides,
});

describe('the protocol version', () => {
  it('was bumped for the member-key request', () => {
    // Pinned so that adding a request or reply shape without bumping it fails
    // here. The status readout displays this, and it is how a stale worker is
    // recognised at a glance — which matters more now that one of the shapes
    // leads to a transaction.
    expect(WORKER_PROTOCOL_VERSION).toBe(7);
  });
});

describe('the import arms', () => {
  const imported = (overrides: Record<string, unknown> = {}) => ({
    kind: 'imported',
    requestId: 'req-1',
    operationRef: 'zar-1',
    operationType: 'CREATE_MEMBERSHIP_VOTING',
    fields: [{ label: 'member', value: '0x1111' }],
    warnings: [],
    ...overrides,
  });

  it('accepts a well-formed import request and reply', () => {
    expect(
      isWorkerRequest({
        kind: 'importForm',
        requestId: 'req-1',
        payload: { sourcePath: 'C:/filled.pdf' },
      }),
    ).toBe(true);
    expect(isWorkerReply(imported())).toBe(true);
  });

  it('requires a source path, since that is the entire payload', () => {
    for (const payload of [{}, { sourcePath: '' }, { sourcePath: 7 }, undefined]) {
      expect(isWorkerRequest({ kind: 'importForm', requestId: 'r', payload })).toBe(false);
    }
  });

  it('refuses a field whose value did not cross as a string', () => {
    // A coordinate or a scaled value arriving as a number would mean a worker
    // that skipped `describeIntent`, and a coerced bigint addresses a different
    // cell than the one the member wrote.
    expect(isWorkerReply(imported({ fields: [{ label: 'x', value: 3 }] }))).toBe(false);
    expect(isWorkerReply(imported({ fields: [{ label: 'x', value: 3n }] }))).toBe(false);
    expect(isWorkerReply(imported({ fields: [{ value: '3' }] }))).toBe(false);
    expect(isWorkerReply(imported({ fields: 'none' }))).toBe(false);
  });

  it('refuses a reply with no warnings list at all', () => {
    // Absent is not the same as empty: warnings are tamper evidence, and a
    // missing list would read as "nothing to report".
    expect(isWorkerReply(imported({ warnings: undefined }))).toBe(false);
  });
});

describe('isWorkerRequest', () => {
  it('accepts a well-formed report request', () => {
    expect(isWorkerRequest(request())).toBe(true);
  });

  it('requires a destination, since that is the entire payload', () => {
    expect(isWorkerRequest(request({ payload: {} }))).toBe(false);
    expect(isWorkerRequest(request({ payload: { targetPath: '' } }))).toBe(false);
    expect(isWorkerRequest(request({ payload: { targetPath: 7 } }))).toBe(false);
    expect(isWorkerRequest(request({ payload: undefined }))).toBe(false);
  });

  it('requires a correlation id, or there is nothing to answer against', () => {
    expect(isWorkerRequest(request({ requestId: '' }))).toBe(false);
    expect(isWorkerRequest(request({ requestId: undefined }))).toBe(false);
  });

  it('refuses a kind this build does not know', () => {
    expect(isWorkerRequest(request({ kind: 'castVote' }))).toBe(false);
    expect(isWorkerRequest(request({ kind: 'executeVoting' }))).toBe(false);
  });

  it('still accepts the kinds that came before it', () => {
    expect(isWorkerRequest({ kind: 'ping', requestId: 'r' })).toBe(true);
    expect(isWorkerRequest({ kind: 'checkNetwork', requestId: 'r' })).toBe(true);
    expect(
      isWorkerRequest({
        kind: 'issueTemplate',
        requestId: 'r',
        payload: { operationType: 'CAST_VOTE', targetPath: 'C:/f.pdf' },
      }),
    ).toBe(true);
  });
});

describe('isWorkerReply', () => {
  it('accepts a well-formed report reply', () => {
    expect(isWorkerReply(reply())).toBe(true);
  });

  it('refuses a block number that did not cross as a string', () => {
    // A `bigint` does not survive the structured clone, so one arriving here
    // would mean a worker built against a different protocol. Refused rather
    // than coerced: a block number is what the page is stamped with.
    expect(isWorkerReply(reply({ blockNumber: 11_642_262 }))).toBe(false);
    expect(isWorkerReply(reply({ blockNumber: 11_642_262n }))).toBe(false);
  });

  it('refuses a reply missing a count the UI reports', () => {
    // `degradedRows` especially: a report can be written *and* incomplete, and a
    // reply without the count would let the UI claim an unqualified success.
    expect(isWorkerReply(reply({ degradedRows: undefined }))).toBe(false);
    expect(isWorkerReply(reply({ rows: undefined }))).toBe(false);
    expect(isWorkerReply(reply({ pageCount: '3' }))).toBe(false);
    expect(isWorkerReply(reply({ empty: 'no' }))).toBe(false);
    expect(isWorkerReply(reply({ readAt: undefined }))).toBe(false);
  });

  it('refuses a kind it cannot name', () => {
    expect(isWorkerReply(reply({ kind: 'rendered' }))).toBe(false);
    expect(isWorkerReply('nonsense')).toBe(false);
    expect(isWorkerReply(null)).toBe(false);
  });
});
