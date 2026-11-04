import assert from 'node:assert/strict';
import test from 'node:test';
import { setImmediate as tick } from 'node:timers/promises';
import { createAgentPayments } from '../packages/payments/dist/agent.js';
import { PaymentError } from '../packages/payments/dist/errors.js';
import { getStoreHandle } from '../packages/payments/dist/internal.js';
import { readPaymentReceipt } from '../packages/payments/dist/protocol.js';
import { paymentFixture } from './payment-fixture.mjs';

const errorIs = (code, state) => error => {
  assert.ok(error instanceof PaymentError);
  assert.equal(error.code, code);
  if (state !== undefined) assert.equal(error.paymentState, state);
  assert.equal(Object.hasOwn(error, 'cause'), false);
  assert.equal(String(error).includes('private-'), false);
  return true;
};
const outcome = promise => promise.then(value => ({ value }), error => ({ error }));
const post = { method: 'POST', body: 'fixture-input', headers: { 'content-type': 'text/plain', 'x-identity': 'exact bytes' } };

for (const mode of ['exact/eip3009', 'exact/permit2', 'upto/permit2']) {
  test(`${mode} pays through real HTTP and independent signature verification, holding the maximum`, async t => {
    const f = await paymentFixture(t, { mode });
    const returned = [];
    f.config.fetch = async (...args) => { const response = await fetch(...args); returned.push(response); return response; };
    const pay = createAgentPayments(f.config).fetch;
    const response = await pay(f.key, f.url, post);
    assert.equal(response, returned[1]);
    assert.equal(response.bodyUsed, false);
    assert.equal(await response.text(), 'fixture-resource');
    assert.equal(f.state.requests.length, 2);
    assert.equal(f.state.requests[0].paid, false);
    assert.equal(f.state.requests[1].paid, true);
    assert.deepEqual(f.state.requests.map(request => [request.method, request.url, request.body, request.headers['x-identity']]),
      [['POST', '/purchase', 'fixture-input', 'exact bytes'], ['POST', '/purchase', 'fixture-input', 'exact bytes']]);
    assert.equal(f.state.signerCalls, 1); assert.equal(f.state.signatures, 1); assert.equal(f.state.verified, 1);
    const operation = await f.store.getOperation(f.key), budget = await f.store.getBudget(f.key);
    assert.equal(operation.state, 'reported');
    assert.equal(budget.heldAtomic, mode === 'upto/permit2' ? '7000' : '1000');
    assert.equal(budget.spentAtomic, '0');
    assert.equal(operation.report.receipt.amount, mode === 'upto/permit2' ? '1200' : '1000');
    const persisted = JSON.stringify(operation);
    assert.equal(persisted.includes('private-provider'), false);
    assert.equal(persisted.includes(f.state.requests[1].headers['payment-signature']), false);
    assert.equal(persisted.includes('fixture-input'), false);
    assert.equal(persisted.includes('sellerExtension'), false);
    assert.equal(f.state.rpcCalls.length, mode === 'exact/eip3009' ? 0 : 1);
    await assert.rejects(pay(f.key, f.url, post), errorIs('operation_in_progress', 'submitted_unknown'));
    await assert.rejects(pay(f.key, f.url, { ...post, body: 'different-bytes' }), errorIs('operation_conflict', 'submitted_unknown'));
    assert.equal(f.state.signerCalls, 1); assert.equal(f.state.requests.length, 2);
  });
}

test('ordinary unpaid response is original and closes the acquired row without wallet use', async t => {
  const f = await paymentFixture(t, { initialStatus: 200 });
  const response = await createAgentPayments(f.config).fetch(f.key, f.url);
  assert.equal(await response.text(), 'ordinary-body');
  assert.equal((await f.store.getOperation(f.key)).state, 'unpaid');
  assert.equal((await f.store.getBudget(f.key)).heldAtomic, '0');
  assert.equal(f.state.signerCalls, 0);
  await assert.rejects(createAgentPayments(f.config).fetch(f.key, f.url), errorIs('operation_already_processed'));
  assert.equal(f.state.requests.length, 1);
});

test('initial redirects are not followed and cannot reach a wallet', async t => {
  const f = await paymentFixture(t, { initialStatus: 302 });
  await assert.rejects(createAgentPayments(f.config).fetch(f.key, f.url), errorIs('payment_unresolved', 'not_attempted'));
  assert.equal(f.state.destinationCalls, 0); assert.equal(f.state.signerCalls, 0);
  assert.equal((await f.store.getOperation(f.key)).state, 'unpaid');
});

for (const receipt of ['missing', 'invalid', 'failed', 'pending', 'wrong-payer', 'wrong-network', 'over-maximum', 'zero']) {
  test(`${receipt} report retains the maximum and never becomes spend evidence`, async t => {
    const f = await paymentFixture(t, { mode: 'upto/permit2', receipt });
    let error;
    try { await createAgentPayments(f.config).fetch(f.key, f.url, post); } catch (caught) { error = caught; }
    if (receipt === 'zero') {
      assert.equal(error, undefined);
      assert.equal((await f.store.getOperation(f.key)).state, 'reported');
    } else {
      errorIs('payment_unresolved', 'submitted_unknown')(error);
      assert.ok(error.response instanceof Response);
      assert.equal(await error.response.text(), 'fixture-resource');
      assert.equal((await f.store.getOperation(f.key)).state, 'unknown');
    }
    assert.equal((await f.store.getBudget(f.key)).heldAtomic, '7000');
    assert.equal((await f.store.getBudget(f.key)).spentAtomic, '0');
    assert.equal(f.state.signatures, 1); assert.equal(f.state.verified, 1);
  });
}

test('second 402 overrides a success receipt; a non402 service error does not imply a refund', async t => {
  for (const status of [402, 503]) {
    const f = await paymentFixture(t, { paidStatus: status });
    const pay = createAgentPayments(f.config).fetch;
    if (status === 402) await assert.rejects(pay(f.key, f.url), errorIs('payment_unresolved', 'submitted_unknown'));
    else { const response = await pay(f.key, f.url); assert.equal(response.status, 503); assert.equal(await response.text(), 'fixture-resource'); }
    assert.equal((await f.store.getOperation(f.key)).state, status === 402 ? 'unknown' : 'reported');
    assert.equal((await f.store.getBudget(f.key)).heldAtomic, '1000');
    assert.equal((await f.store.getBudget(f.key)).spentAtomic, '0');
  }
});

test('lost paid response is unresolved, and the same operation cannot sign or transmit again', async t => {
  const f = await paymentFixture(t, { dropPaidResponse: true });
  const pay = createAgentPayments(f.config).fetch;
  await assert.rejects(pay(f.key, f.url), errorIs('payment_unresolved', 'submitted_unknown'));
  await assert.rejects(pay(f.key, f.url), errorIs('operation_in_progress', 'submitted_unknown'));
  assert.equal(f.state.signatures, 1); assert.equal(f.state.verified, 1); assert.equal(f.state.requests.length, 2);
  const operation = await f.store.getOperation(f.key);
  assert.equal(operation.state, 'unknown'); assert.equal(operation.report, undefined);
  assert.equal((await f.store.getBudget(f.key)).heldAtomic, '1000');
});

test('a shared hold blocks a second agent before wallet access without disturbing the first', { timeout: 5000 }, async t => {
  const entered = Promise.withResolvers(), gate = Promise.withResolvers();
  const f = await paymentFixture(t, { mode: 'upto/permit2', memoryOptions: { afterSigningPersisted: async operation => {
    if (operation.operationId === 'purchase-one') { entered.resolve(); await gate.promise; }
  } } });
  const pay = createAgentPayments(f.config).fetch, first = outcome(pay(f.key, f.url, post));
  try {
    await Promise.race([entered.promise, first.then(() => { throw new Error('Signing gate was not reached.'); })]);
    assert.equal((await f.store.getBudget(f.key)).heldAtomic, '7000');
    assert.equal(f.state.signerCalls, 0);
    const competitor = { ...f.key, agentId: 'agent-b', operationId: 'competing' };
    await assert.rejects(pay(competitor, f.url, post), errorIs('budget_exceeded', 'not_attempted'));
    assert.equal((await f.store.getOperation(competitor)).state, 'unpaid');
    assert.equal((await f.store.getOperation(f.key)).state, 'signing');
  } finally { gate.resolve(); }
  const result = await first;
  assert.equal(result.error, undefined); assert.equal(await result.value.text(), 'fixture-resource');
  assert.equal(f.state.signatures, 1); assert.equal(f.state.verified, 1);
});

test('failed signing acknowledgement cannot release the committed authorization or call the wallet', async t => {
  const f = await paymentFixture(t, { memoryOptions: { afterSigningPersisted: async () => { throw new Error('private-signing-ack'); } } });
  await assert.rejects(createAgentPayments(f.config).fetch(f.key, f.url), errorIs('storage_unavailable', 'authorization_possible'));
  assert.equal((await f.store.getOperation(f.key)).state, 'unknown');
  assert.equal((await f.store.getBudget(f.key)).heldAtomic, '1000');
  assert.equal(f.state.signerCalls, 0); assert.equal(f.state.requests.length, 1);
});

test('lost start acknowledgement never acquires or closes its durable row', async t => {
  const f = await paymentFixture(t), handle = getStoreHandle(f.store), start = handle.start.bind(handle);
  handle.start = async input => { await start(input); throw new Error('private-start-ack'); };
  const pay = createAgentPayments(f.config).fetch;
  await assert.rejects(pay(f.key, f.url), errorIs('storage_unavailable', 'not_attempted'));
  assert.equal((await f.store.getOperation(f.key)).state, 'requesting');
  assert.equal(f.state.requests.length, 0); assert.equal(f.state.signerCalls, 0);
  await assert.rejects(pay(f.key, f.url), errorIs('operation_in_progress', 'not_attempted'));
});

test('failed report persistence carries the original response and safe candidate, not fabricated storage', async t => {
  const f = await paymentFixture(t), handle = getStoreHandle(f.store), mutate = handle.mutate.bind(handle);
  handle.mutate = async (key, action) => { if (action.kind === 'report') throw new Error('private-report-write'); return mutate(key, action); };
  let error;
  try { await createAgentPayments(f.config).fetch(f.key, f.url); } catch (caught) { error = caught; }
  errorIs('storage_unavailable', 'submitted_unknown')(error);
  assert.equal(error.transactionHash, f.transaction);
  assert.equal(await error.response.text(), 'fixture-resource');
  const operation = await f.store.getOperation(f.key);
  assert.equal(operation.state, 'unknown'); assert.equal(operation.report, undefined); assert.equal(operation.transactionHash, undefined);
  assert.equal((await f.store.getBudget(f.key)).heldAtomic, '1000');
  assert.equal(JSON.stringify(error).includes('private-'), false);
});

test('aborted wallet wait cannot submit after a late signature or let a host error lie about uncertainty', { timeout: 5000 }, async t => {
  const f = await paymentFixture(t), entered = Promise.withResolvers(), late = Promise.withResolvers(), controller = new AbortController();
  let typed;
  f.config.resolveSigner = async () => ({ address: f.fixtureSigner.address, signTypedData: request => { typed = request; entered.resolve(); return late.promise; } });
  const result = outcome(createAgentPayments(f.config).fetch(f.key, f.url, { signal: controller.signal }));
  await Promise.race([entered.promise, result.then(() => { throw new Error('Wallet was not reached.'); })]);
  controller.abort();
  const stopped = await result;
  errorIs('payment_unresolved', 'authorization_possible')(stopped.error);
  late.resolve(await f.fixtureSigner.signTypedData(typed));
  await tick(); await tick();
  assert.equal(f.state.requests.filter(request => request.paid).length, 0);
  assert.equal((await f.store.getOperation(f.key)).state, 'unknown');
  assert.equal((await f.store.getBudget(f.key)).heldAtomic, '1000');
  const second = await paymentFixture(t);
  second.config.resolveSigner = async () => ({ address: second.fixtureSigner.address, signTypedData: async () => {
    throw new PaymentError('invalid_config', { paymentState: 'not_attempted', response: new Response('private-wallet-response') });
  } });
  await assert.rejects(createAgentPayments(second.config).fetch(second.key, second.url), error => {
    errorIs('authorization_failed', 'authorization_possible')(error);
    assert.notEqual(error.response?.status, 200);
    return true;
  });
});

test('constructor and frozen policy reject a forged store and later policy widening', async t => {
  const f = await paymentFixture(t);
  assert.throws(() => createAgentPayments({ ...f.config, store: { createBudget() {}, getBudget() {}, getOperation() {} } }).fetch, errorIs('invalid_config'));
  f.config.policy.merchants[0].payTo = '0x4444444444444444444444444444444444444444';
  const pay = createAgentPayments(f.config).fetch;
  f.config.policy.merchants[0].payTo = f.protocol.requirements.payTo;
  await assert.rejects(pay(f.key, f.url), errorIs('policy_rejected', 'not_attempted'));
  assert.equal(f.state.signerCalls, 0); assert.equal((await f.store.getOperation(f.key)).state, 'unpaid');
});

test('unusable allowance reads close unpaid before either Permit2 wallet callback', async t => {
  for (const rpc of [async () => `0x${'00'.repeat(32)}`, async () => 1n, async () => {
    throw new PaymentError('invalid_config', { paymentState: 'submitted_unknown' });
  }]) {
    const f = await paymentFixture(t, { mode: 'upto/permit2' });
    f.config.rpc = rpc;
    await assert.rejects(createAgentPayments(f.config).fetch(f.key, f.url, post), errorIs('allowance_required', 'not_attempted'));
    assert.equal(f.state.signerCalls, 0);
    assert.equal((await f.store.getOperation(f.key)).state, 'unpaid');
    assert.equal((await f.store.getBudget(f.key)).heldAtomic, '0');
    assert.equal(f.state.requests.length, 1);
  }
});

test('invalid and oversized wallet bytes retain the committed hold without paid Fetch', async t => {
  for (const signature of ['0x', `0x${'ab'.repeat(4097)}`]) {
    const f = await paymentFixture(t);
    f.config.resolveSigner = async () => ({ address: f.fixtureSigner.address, signTypedData: async () => signature });
    await assert.rejects(createAgentPayments(f.config).fetch(f.key, f.url), errorIs('authorization_failed', 'authorization_possible'));
    assert.equal((await f.store.getOperation(f.key)).state, 'unknown');
    assert.equal((await f.store.getBudget(f.key)).heldAtomic, '1000');
    assert.equal(f.state.requests.length, 1);
    assert.equal(f.state.verified, 0);
  }
});
