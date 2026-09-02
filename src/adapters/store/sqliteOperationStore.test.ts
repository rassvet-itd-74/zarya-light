import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { IllegalTemplateTransitionError } from '../../domain/operations/issuedTemplate';
import {
  DuplicateOperationRefError,
  type NewOperationRecord,
  UnknownOperationRefError,
} from '../../domain/ports/OperationStore';
import { chainId, evmAddress, operationRef } from '../../domain/primitives';
import { type DatabaseHandle, openDatabase } from './database';
import { SqliteOperationStore } from './sqliteOperationStore';

/**
 * The trust anchor, against a real database.
 *
 * In-memory rather than a temp file for most of it — the migration runner and
 * every statement are the same code path either way, and the one thing a file
 * buys is survival across a reopen, which has its own test below.
 */

const SEPOLIA = chainId(11155111);
const CONTRACT = evmAddress('0x6b31cC58a7DC5919f460068cF68D16281F360d25');
const REF = operationRef('op_01HQ3ZS8Q0000000000000000');

const newRecord = (overrides: Partial<NewOperationRecord> = {}): NewOperationRecord => ({
  operationRef: REF,
  operationType: 'CREATE_MEMBERSHIP_VOTING',
  chainId: SEPOLIA,
  contractAddress: CONTRACT,
  boundValues: { organType: 'RegionalSoviet', regionSubjectCode: '95', organNumber: '0' },
  displayedContext: {
    'zarya.context.chainId': '11155111',
    'zarya.context.contract': CONTRACT,
    'zarya.context.organ': '95.СОВ',
  },
  ...overrides,
});

describe('recording an operation', () => {
  let handle: DatabaseHandle;
  let store: SqliteOperationStore;

  beforeEach(() => {
    handle = openDatabase(':memory:');
    store = new SqliteOperationStore(handle.db);
  });
  afterEach(() => handle.close());

  it('starts in RECORDED, which the caller cannot choose', async () => {
    // `RECORDED` precedes `EMITTED`. A store that let a caller supply the state
    // could record a form as handed over before it was.
    await store.record(newRecord());
    expect((await store.find(REF))?.state).toBe('RECORDED');
  });

  it('round-trips the bound values and the displayed context, Cyrillic included', async () => {
    await store.record(newRecord());
    const found = await store.find(REF);
    expect(found?.boundValues).toEqual(newRecord().boundValues);
    expect(found?.displayedContext['zarya.context.organ']).toBe('95.СОВ');
  });

  it('refuses a duplicate reference in the engine, not in an if', async () => {
    // Check-then-insert is a race. The primary key is what actually holds.
    await store.record(newRecord());
    await expect(store.record(newRecord())).rejects.toBeInstanceOf(DuplicateOperationRefError);
    // And a second operation type under the same ref does not overwrite the first.
    await expect(
      store.record(newRecord({ operationType: 'CAST_VOTE' })),
    ).rejects.toBeInstanceOf(DuplicateOperationRefError);
    expect((await store.find(REF))?.operationType).toBe('CREATE_MEMBERSHIP_VOTING');
  });

  it('reports an unknown reference as undefined, which is a fact and not an outage', async () => {
    // The inverse of every chain reader in this client, and deliberately: a row
    // is there or it is not, and an I/O failure throws rather than becoming a
    // third answer. A swallowed disk error would report every form as a forgery.
    expect(await store.find(operationRef('op_nothing'))).toBeUndefined();
  });

  it('stamps an audit timestamp that nothing decides on', async () => {
    const before = Date.now();
    await store.record(newRecord());
    const recordedAt = (await store.find(REF))?.recordedAt ?? 0;
    expect(recordedAt).toBeGreaterThanOrEqual(before);
    expect(recordedAt).toBeLessThanOrEqual(Date.now());
  });
});

describe('advancing through the state machine', () => {
  let handle: DatabaseHandle;
  let store: SqliteOperationStore;

  beforeEach(async () => {
    handle = openDatabase(':memory:');
    store = new SqliteOperationStore(handle.db);
    await store.record(newRecord());
  });
  afterEach(() => handle.close());

  it('walks RECORDED to EMITTED to RETURNED', async () => {
    await store.advance(REF, 'EMITTED');
    expect((await store.find(REF))?.state).toBe('EMITTED');
    await store.advance(REF, 'RETURNED');
    expect((await store.find(REF))?.state).toBe('RETURNED');
  });

  it('refuses a move the machine does not have, leaving the row untouched', async () => {
    // Inside the transaction, so a refusal is not a partial write.
    await expect(store.advance(REF, 'RETURNED')).rejects.toBeInstanceOf(
      IllegalTemplateTransitionError,
    );
    expect((await store.find(REF))?.state).toBe('RECORDED');
  });

  it('refuses to un-emit a form', async () => {
    // The old file is still out there. Reissuing is a new operationRef, never a
    // rewind of this one.
    await store.advance(REF, 'EMITTED');
    await expect(store.advance(REF, 'RECORDED')).rejects.toBeInstanceOf(
      IllegalTemplateTransitionError,
    );
  });

  it('refuses to advance a reference that resolves to nothing', async () => {
    await expect(store.advance(operationRef('op_nothing'), 'EMITTED')).rejects.toBeInstanceOf(
      UnknownOperationRefError,
    );
  });

  it('keeps the record after the operation completes', async () => {
    // So a resubmitted copy of an old form resolves to a *completed* operation
    // rather than to nothing — which is a different answer from "unknown", and
    // the difference is what stops a stale form being treated as unbound.
    await store.advance(REF, 'EMITTED');
    await store.advance(REF, 'RETURNED');
    await store.advance(REF, 'SUPERSEDED');
    expect(await store.find(REF)).toBeDefined();
  });
});

describe('listing what was in flight', () => {
  let handle: DatabaseHandle;
  let store: SqliteOperationStore;

  beforeEach(() => {
    handle = openDatabase(':memory:');
    store = new SqliteOperationStore(handle.db);
  });
  afterEach(() => handle.close());

  it('returns only this deployment’s operations', async () => {
    // Carrying work across a chain or address change would resume against a
    // history that never happened.
    await store.record(newRecord({ operationRef: operationRef('op_a') }));
    await store.record(
      newRecord({ operationRef: operationRef('op_b'), chainId: chainId(1) }),
    );
    await store.record(
      newRecord({
        operationRef: operationRef('op_c'),
        contractAddress: evmAddress('0x57eb63d0aab5822EFCd7A9B56775F772D3e03CfD'),
      }),
    );

    const found = await store.listByState(
      { chainId: SEPOLIA, contractAddress: CONTRACT },
      'RECORDED',
    );
    expect(found.map((record) => record.operationRef)).toEqual(['op_a']);
  });

  it('matches a contract address whatever its checksum casing', async () => {
    await store.record(newRecord());
    const found = await store.listByState(
      { chainId: SEPOLIA, contractAddress: evmAddress(CONTRACT.toLowerCase()) },
      'RECORDED',
    );
    expect(found).toHaveLength(1);
  });

  it('separates states', async () => {
    await store.record(newRecord({ operationRef: operationRef('op_a') }));
    await store.record(newRecord({ operationRef: operationRef('op_b') }));
    await store.advance(operationRef('op_b'), 'EMITTED');

    const scope = { chainId: SEPOLIA, contractAddress: CONTRACT };
    expect((await store.listByState(scope, 'RECORDED')).map((r) => r.operationRef)).toEqual([
      'op_a',
    ]);
    expect((await store.listByState(scope, 'EMITTED')).map((r) => r.operationRef)).toEqual(['op_b']);
  });
});

describe('surviving a restart', () => {
  let directory: string;

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'zarya-store-'));
  });
  afterEach(() => rmSync(directory, { recursive: true, force: true }));

  it('finds an operation recorded by a previous process', async () => {
    // The whole point of the store: a form emitted before a crash still has its
    // context when the application comes back.
    const path = join(directory, 'zarya.db');

    const first = openDatabase(path);
    await new SqliteOperationStore(first.db).record(newRecord());
    await new SqliteOperationStore(first.db).advance(REF, 'EMITTED');
    first.close();

    const second = openDatabase(path);
    const found = await new SqliteOperationStore(second.db).find(REF);
    second.close();

    expect(found?.state).toBe('EMITTED');
    expect(found?.displayedContext['zarya.context.organ']).toBe('95.СОВ');
  });

  it('migrates a fresh file once and reopens it without migrating again', async () => {
    const path = join(directory, 'zarya.db');
    const first = openDatabase(path);
    const version = first.version;
    first.close();

    const second = openDatabase(path);
    expect(second.version).toBe(version);
    second.close();
    expect(version).toBeGreaterThan(0);
  });
});

describe('a row that should not be there', () => {
  it('is refused rather than handed on', async () => {
    // A database is a file on a disk the user owns: editable, restorable from an
    // old backup, corruptible. A row read back unchecked is untrusted input.
    const handle = openDatabase(':memory:');
    const store = new SqliteOperationStore(handle.db);
    await store.record(newRecord());

    handle.db
      .prepare('UPDATE operations SET operation_type = ? WHERE operation_ref = ?')
      .run('DRAIN_TREASURY', REF);
    await expect(store.find(REF)).rejects.toThrow(/unknown operation type/);

    handle.db
      .prepare('UPDATE operations SET operation_type = ?, bound_values = ? WHERE operation_ref = ?')
      .run('CAST_VOTE', '{"votingId":7}', REF);
    await expect(store.find(REF)).rejects.toThrow(/non-text value/);

    handle.db
      .prepare('UPDATE operations SET bound_values = ? WHERE operation_ref = ?')
      .run('not json', REF);
    await expect(store.find(REF)).rejects.toThrow(/unreadable/);

    handle.close();
  });
});
