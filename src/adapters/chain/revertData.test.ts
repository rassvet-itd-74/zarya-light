import { describe, expect, it } from 'vitest';
import { readRevert } from './revertData';

/**
 * The distinction under test is the one that decides whether an RPC hiccup gets
 * reported as a wrong deployment. Both shapes arrive at the same catch site.
 */
describe('readRevert', () => {
  it('reads revert data from a nested cause chain', () => {
    const error = Object.assign(new Error('outer'), {
      name: 'ContractFunctionExecutionError',
      cause: Object.assign(new Error('inner'), {
        name: 'RawContractError',
        data: '0xabc123',
      }),
    });
    expect(readRevert(error)).toEqual({ data: '0xabc123' });
  });

  it('treats 0x as an empty revert', () => {
    const error = Object.assign(new Error('reverted'), {
      name: 'RawContractError',
      data: '0x',
    });
    // Normalized away so callers test one thing: no data at all.
    expect(readRevert(error)).toEqual({});
  });

  it('recognises a revert with no data field at all', () => {
    const error = Object.assign(new Error('boom'), {
      name: 'CallExecutionError',
      shortMessage: 'Execution reverted for an unknown reason.',
    });
    expect(readRevert(error)).toEqual({});
  });

  it('recognises a revert only described in prose', () => {
    const error = Object.assign(new Error('boom'), {
      details: 'execution reverted',
    });
    expect(readRevert(error)).toEqual({});
  });

  // The safety-critical direction: a transport failure must NOT look like an
  // empty revert, or an outage is reported as a wrong deployment.
  it.each([
    ['a timeout', { name: 'TimeoutError', shortMessage: 'The request took too long.' }],
    ['an HTTP failure', { name: 'HttpRequestError', shortMessage: 'HTTP request failed. 502' }],
    ['a plain error', {}],
  ])('returns undefined for %s', (_name, shape) => {
    expect(readRevert(Object.assign(new Error('nope'), shape))).toBeUndefined();
  });

  it('returns undefined for null and undefined', () => {
    expect(readRevert(null)).toBeUndefined();
    expect(readRevert(undefined)).toBeUndefined();
  });

  it('does not loop forever on a self-referencing cause', () => {
    const error: { name: string; cause?: unknown } = { name: 'RawContractError' };
    error.cause = error;
    expect(readRevert(error)).toEqual({});
  });

  it('ignores a non-hex data field rather than trusting it', () => {
    const error = { name: 'RawContractError', data: 'not-hex' };
    expect(readRevert(error)).toEqual({});
  });
});
