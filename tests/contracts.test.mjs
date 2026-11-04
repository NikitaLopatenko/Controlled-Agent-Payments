import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { cp, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { pathToFileURL } from 'node:url';
import test from 'node:test';
import { asPaymentError, PaymentError, paymentStateForOperation } from '../packages/payments/dist/errors.js';
import { getStoreHandle, normalizeContext, validateBudget, validateOperation, validatePolicy } from '../packages/payments/dist/internal.js';
import { nativeCall } from '../packages/payments/dist/native.js';
import { runtime } from '../packages/payments/dist/runtime.js';
import { MemoryPaymentStore } from '../packages/payments/dist/testing.js';

const execute = promisify(execFile);
const payer = '0x1111111111111111111111111111111111111111';
const merchant = '0x2222222222222222222222222222222222222222';
const key = { ownerId: 'owner', budgetId: 'budget' };
const budget = { ...key, network: 'eip155:84532', payer, limitAtomic: '10000' };
const start = { ...key, agentId: 'agent', operationId: 'purchase',
  requestFingerprint: 'a'.repeat(64), targetOrigin: 'https://merchant.example' };
const operationKey = { ...key, operationId: start.operationId };

function hasCode(code, state = 'not_attempted') {
  return error => {
    assert.ok(error instanceof PaymentError);
    assert.equal(error.code, code);
    assert.equal(error.paymentState, state);
    assert.equal(Object.hasOwn(error, 'cause'), false);
    return true;
  };
}

async function copySdk(t) {
  const directory = await mkdtemp(join(tmpdir(), 'cap-contract-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await cp(new URL('../packages/payments/dist/', import.meta.url), join(directory, 'dist'), { recursive: true });
  await writeFile(join(directory, 'package.json'), JSON.stringify({ type: 'module' }));
  return directory;
}

test('PaymentError keeps fixed messages and log-safe fields, never caught credentials', () => {
  const response = new Response('private response body', { headers: { 'x-private': 'credential' } });
  const hash = `0x${'AB'.repeat(32)}`;
  const error = new PaymentError('payment_unresolved', { paymentState: 'submitted_unknown',
    operationId: 'purchase', transactionHash: hash, response, cause: new Error('wallet-secret'), message: 'wallet-secret' });
  assert.equal(error.response, response);
  assert.equal(Object.getOwnPropertyDescriptor(error, 'response').enumerable, false);
  assert.equal(Object.hasOwn(error, 'cause'), false);
  assert.equal(error.message.includes('wallet-secret'), false);
  assert.deepEqual(error.toJSON(), { code: 'payment_unresolved', paymentState: 'submitted_unknown',
    operationId: 'purchase', transactionHash: hash.toLowerCase() });
  assert.equal(JSON.stringify(error).includes('private'), false);
  const callbackError = new PaymentError('authorization_failed', { paymentState: 'not_attempted' });
  callbackError.cause = new Error('signer credential');
  callbackError.secret = 'signer credential';
  const stamped = asPaymentError(callbackError, 'payment_unresolved', { paymentState: 'authorization_possible', operationId: 'purchase' });
  assert.notEqual(stamped, callbackError);
  assert.equal(stamped.paymentState, 'authorization_possible');
  assert.equal(Object.hasOwn(stamped, 'cause'), false);
  assert.equal(Object.hasOwn(stamped, 'secret'), false);
  assert.equal(asPaymentError(new Error('rpc credential')).message.includes('credential'), false);
  assert.deepEqual(new PaymentError('not_a_code', { operationId: '\nsecret', transactionHash: 'secret' }).toJSON(),
    { code: 'invalid_config', paymentState: 'not_attempted' });
});

test('native errors are whitelisted and malformed stored data maps to storage_unavailable', () => {
  assert.throws(() => nativeCall(() => { throw new Error('input-bearing secret'); }), hasCode('invalid_config'));
  assert.throws(() => nativeCall(() => { throw new Error('invalid_amount'); }), hasCode('invalid_amount'));
  assert.throws(() => nativeCall(() => { throw new Error('invalid_amount'); }, { forceCode: 'storage_unavailable' }),
    hasCode('storage_unavailable'));
  assert.throws(() => nativeCall(() => { throw new Error('input-bearing secret'); },
    { fallbackCode: 'storage_unavailable', paymentState: 'authorization_possible' }), hasCode('storage_unavailable', 'authorization_possible'));
  assert.throws(() => validateBudget({ ...budget, heldAtomic: '9000', spentAtomic: '2000' }), hasCode('storage_unavailable'));
  assert.throws(() => validateOperation({ ...budget, heldAtomic: '0', spentAtomic: '0' },
    { ...start, network: budget.network, payer, state: 'signing' }), hasCode('storage_unavailable'));
});

test('immutable budgets return detached current snapshots without resetting or widening limits', async () => {
  const store = new MemoryPaymentStore();
  const input = { ...budget, payer: '0xaAaAaAaaAaAaAaaAaAAAAAAAAaaaAaAaAaaAaaAa' };
  const created = await store.createBudget(input);
  assert.equal(created.payer, input.payer.toLowerCase());
  input.limitAtomic = '999999';
  created.limitAtomic = '1';
  created.heldAtomic = '100';
  assert.deepEqual(await store.createBudget({ ...budget, payer: input.payer.toLowerCase() }),
    { ...budget, payer: input.payer.toLowerCase(), heldAtomic: '0', spentAtomic: '0' });
  for (const changed of [{ limitAtomic: '10001' }, { payer }, { network: 'eip155:8453' }]) {
    await assert.rejects(store.createBudget({ ...budget, payer: input.payer.toLowerCase(), ...changed }), hasCode('operation_conflict'));
  }
  const snapshot = await store.getBudget(key);
  snapshot.spentAtomic = '10000';
  assert.equal((await store.getBudget(key)).spentAtomic, '0');
  assert.equal(await store.getBudget({ ...key, budgetId: 'missing' }), null);
});

test('canonical amounts and UTF-8 identities are validated natively before storage', async () => {
  const store = new MemoryPaymentStore();
  for (const limitAtomic of ['', '00', '01', '-1', '1.0', '0x10',
    '115792089237316195423570985008687907853269984665640564039457584007913129639936']) {
    await assert.rejects(store.createBudget({ ...budget, limitAtomic }), hasCode('invalid_amount'));
  }
  await assert.rejects(store.createBudget({ ...budget, ownerId: '🙂'.repeat(65) }), hasCode('invalid_config'));
  await assert.rejects(store.createBudget({ ...budget, budgetId: ' budget' }), hasCode('invalid_config'));
  const maximum = '115792089237316195423570985008687907853269984665640564039457584007913129639935';
  assert.equal((await store.createBudget({ ...budget, limitAtomic: maximum })).limitAtomic, maximum);
  assert.equal((await store.getBudget(key)).heldAtomic, '0');
});

test('context and policy snapshots cannot be widened after validation', () => {
  const context = { ...start };
  const normalized = normalizeContext(context);
  context.operationId = 'different';
  assert.deepEqual(normalized, { ...key, agentId: 'agent', operationId: 'purchase' });
  const policy = { maxPerPaymentAtomic: '7000', allowedSchemes: ['exact', 'upto'],
    merchants: [{ origin: start.targetOrigin, payTo: merchant }] };
  const snapshot = validatePolicy(budget.network, policy);
  policy.allowedSchemes.length = 0;
  policy.maxPerPaymentAtomic = '999999';
  policy.merchants[0].payTo = payer;
  assert.deepEqual(snapshot, { maxPerPaymentAtomic: '7000', allowedSchemes: ['exact', 'upto'],
    merchants: [{ origin: start.targetOrigin, payTo: merchant }] });
});

test('one start owns an operation; changed identity conflicts and duplicate reads never acquire it', async () => {
  const store = new MemoryPaymentStore();
  await store.createBudget(budget);
  const handle = getStoreHandle(store);
  const results = await Promise.allSettled(Array.from({ length: 8 }, () => handle.start({ ...start })));
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
  for (const result of results) if (result.status === 'rejected') hasCode('operation_in_progress')(result.reason);
  for (const changed of [{ agentId: 'other-agent' }, { requestFingerprint: 'b'.repeat(64) }, { targetOrigin: 'https://different.example' }]) {
    await assert.rejects(handle.start({ ...start, ...changed }), hasCode('operation_conflict'));
  }
  const detached = await store.getOperation(operationKey);
  detached.agentId = 'tampered';
  assert.equal((await store.getOperation(operationKey)).agentId, 'agent');
  assert.equal((await store.getBudget(key)).heldAtomic, '0');
  assert.equal(await store.getOperation({ ...operationKey, operationId: 'missing' }), null);
});

test('locked unsigned close is terminal and late reports or failures cannot reopen it', async () => {
  const store = new MemoryPaymentStore();
  await store.createBudget(budget);
  const handle = getStoreHandle(store);
  await handle.start(start);
  const closed = await handle.mutate(operationKey, { kind: 'closeUnsigned' });
  assert.equal(closed.state, 'unpaid');
  assert.deepEqual(closed.finalProof, { kind: 'unpaid', reason: 'no_authorization_created' });
  closed.finalProof.reason = 'tampered';
  const retained = await store.getOperation(operationKey);
  assert.equal(retained.finalProof.reason, 'no_authorization_created');
  assert.deepEqual(await handle.mutate(operationKey, { kind: 'report', report: { kind: 'missing' }, outcome: 'received' }), retained);
  assert.deepEqual(await handle.mutate(operationKey, { kind: 'failure', code: 'payment_unresolved' }), retained);
  await assert.rejects(handle.start(start), hasCode('operation_already_processed'));
  assert.deepEqual(await store.createBudget(budget), { ...budget, heldAtomic: '0', spentAtomic: '0' });
});

test('observational errors derive uncertainty from the durable operation state', () => {
  for (const [state, expected] of [['requesting', 'not_attempted'], ['signing', 'authorization_possible'],
    ['submitted', 'submitted_unknown'], ['reported', 'submitted_unknown'], ['unknown', 'submitted_unknown'],
    ['unpaid', 'not_attempted'], ['settled', 'not_attempted']]) {
    assert.equal(paymentStateForOperation({ state }), expected);
  }
});

test('public store seam has only reads/create and forged structural handles are rejected', () => {
  const store = new MemoryPaymentStore();
  assert.deepEqual(Object.getOwnPropertyNames(Object.getPrototypeOf(store)).sort(),
    ['constructor', 'createBudget', 'getBudget', 'getOperation']);
  assert.throws(() => getStoreHandle({ createBudget: store.createBudget.bind(store),
    getBudget: store.getBudget.bind(store), getOperation: store.getOperation.bind(store) }), hasCode('invalid_config'));
  assert.throws(() => getStoreHandle(Object.create(store)), hasCode('invalid_config'));
  assert.throws(() => new MemoryPaymentStore({ afterSigningPersisted: true }), hasCode('invalid_config'));
});

test('plain final proof data cannot authorize an internal ledger mutation', async () => {
  const store = new MemoryPaymentStore();
  await store.createBudget(budget);
  const handle = getStoreHandle(store);
  await handle.start(start);
  const before = await store.getOperation(operationKey);
  await assert.rejects(handle.mutate(operationKey, { kind: 'resolve', resolution: {
    kind: 'settled', transactionHash: `0x${'ab'.repeat(32)}`, amountAtomic: '1',
    finalizedBlockNumber: '1', finalizedBlockHash: `0x${'cd'.repeat(32)}`,
  } }), hasCode('invalid_config'));
  assert.deepEqual(await store.getOperation(operationKey), before);
  assert.deepEqual(await store.getBudget(key), { ...budget, heldAtomic: '0', spentAtomic: '0' });
});

test('identical physical SDK copies share constructor, binding, and registered store authority', async t => {
  const directory = await copySdk(t);
  const copiedErrors = await import(pathToFileURL(join(directory, 'dist/errors.js')).href);
  const copiedInternal = await import(pathToFileURL(join(directory, 'dist/internal.js')).href);
  const copiedRuntime = await import(pathToFileURL(join(directory, 'dist/runtime.js')).href);
  const copiedTesting = await import(pathToFileURL(join(directory, 'dist/testing.js')).href);
  assert.equal(copiedErrors.PaymentError, PaymentError);
  assert.equal(copiedRuntime.runtime, runtime);
  assert.equal(copiedRuntime.runtime.binding, runtime.binding);
  assert.notEqual(copiedTesting.MemoryPaymentStore, MemoryPaymentStore);
  const original = new MemoryPaymentStore(), copied = new copiedTesting.MemoryPaymentStore();
  assert.equal(copiedInternal.getStoreHandle(original), getStoreHandle(original));
  assert.equal(getStoreHandle(copied), copiedInternal.getStoreHandle(copied));
  await copied.createBudget(budget);
  await getStoreHandle(copied).start(start);
  assert.equal((await copied.getOperation(operationKey)).state, 'requesting');
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, Symbol.for('@cap/payments/runtime/v1'));
  assert.equal(descriptor.enumerable, false);
  assert.equal(descriptor.writable, false);
  assert.equal(descriptor.configurable, false);
  assert.equal(Object.isFrozen(runtime), true);
  assert.throws(() => copiedInternal.getStoreHandle({}), hasCode('invalid_config'));
});

test('a fresh missing local artifact fails safely and ignores native override variables', async t => {
  const directory = await copySdk(t);
  const url = pathToFileURL(join(directory, 'dist/errors.js')).href;
  const script = `import assert from 'node:assert/strict';
    try { await import(${JSON.stringify(url)}); assert.fail('missing binary loaded'); }
    catch (error) { assert.equal(error.code, 'native_unavailable');
      assert.equal(error.message, 'CAP native binding is unavailable. Install the matching macOS arm64 artifact or rebuild with the pinned toolchain.');
      assert.equal(Object.hasOwn(error, 'cause'), false); }`;
  await execute(process.execPath, ['--input-type=module', '-e', script], { env: { ...process.env,
    CAP_NATIVE_PATH: new URL('../packages/payments/native/cap-native.darwin-arm64.node', import.meta.url).pathname,
    NAPI_RS_FORCE_WASI: '1', NAPI_RS_NATIVE_LIBRARY_PATH: 'ignored-override' } });
});

test('an incompatible shared record fails before any missing-copy artifact is loaded', async t => {
  const directory = await copySdk(t);
  const url = pathToFileURL(join(directory, 'dist/errors.js')).href;
  for (const record of [{ abiVersion: 2, sdkVersion: '0.1.0' }, { abiVersion: 1, sdkVersion: '9.0.0' }]) {
    const script = `import assert from 'node:assert/strict';
      Object.defineProperty(globalThis, Symbol.for('@cap/payments/runtime/v1'), { value: ${JSON.stringify(record)} });
      try { await import(${JSON.stringify(url)}); assert.fail('incompatible runtime accepted'); }
      catch (error) { assert.equal(error.code, 'invalid_config'); assert.equal(error.name, 'PaymentError');
        assert.deepEqual(error.toJSON(), { code: 'invalid_config', paymentState: 'not_attempted' }); }`;
    await execute(process.execPath, ['--input-type=module', '-e', script]);
  }
});
