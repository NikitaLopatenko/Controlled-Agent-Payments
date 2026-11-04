import assert from 'node:assert/strict';
import test from 'node:test';
import { MemoryPaymentStore } from '../packages/payments/dist/testing.js';
import { getStoreHandle } from '../packages/payments/dist/internal.js';
import { protocolFixture, native, encodeHeader, uint256Result } from './protocol-fixture.mjs';

async function start(store, fixture, operationId) {
  const context = { ownerId: fixture.budget.ownerId, budgetId: fixture.budget.budgetId, agentId: operationId, operationId };
  const operation = await getStoreHandle(store).start({ ...context, requestFingerprint: fixture.operation.requestFingerprint, targetOrigin: fixture.operation.targetOrigin });
  const prepared = native.preparePayment(encodeHeader(fixture.challenge), JSON.stringify(operation), JSON.stringify(fixture.policy));
  prepared.checkAllowance(uint256Result('10000'));
  return { context, prepared };
}
function budgetInput(fixture) {
  const { heldAtomic, spentAtomic, ...input } = fixture.budget;
  return input;
}

test('beginSigning holds the shared maximum atomically before its asynchronous hook', { timeout: 5000 }, async () => {
  const entered = Promise.withResolvers(), gate = Promise.withResolvers();
  const fixture = protocolFixture('upto/permit2');
  const store = new MemoryPaymentStore({ afterSigningPersisted: async operation => {
    operation.authorization.permitted.amount = '1';
    entered.resolve();
    await gate.promise;
  } });
  await store.createBudget(budgetInput(fixture));
  const first = await start(store, fixture, 'first');
  const firstMutation = getStoreHandle(store).mutate(first.context, { kind: 'beginSigning', prepared: first.prepared });
  try {
    await Promise.race([entered.promise, firstMutation.then(() => { throw new Error('Signing gate was not reached.'); })]);
    assert.equal((await store.getOperation(first.context)).authorization.permitted.amount, '7000');
    assert.deepEqual(await store.createBudget(budgetInput(fixture)), { ...fixture.budget, heldAtomic: '7000', spentAtomic: '0' });
    const competitor = await start(store, fixture, 'competitor');
    await assert.rejects(getStoreHandle(store).mutate(competitor.context, { kind: 'beginSigning', prepared: competitor.prepared }), error => error.code === 'budget_exceeded');
    await getStoreHandle(store).mutate(competitor.context, { kind: 'closeUnsigned' });
    assert.equal((await store.getOperation(competitor.context)).state, 'unpaid');
    assert.equal((await store.getBudget(first.context)).heldAtomic, '7000');
  } finally { gate.resolve(); await firstMutation; }
});

test('late hook rejection keeps captured authorization and the maximum held', async () => {
  const fixture = protocolFixture('upto/permit2');
  const store = new MemoryPaymentStore({ afterSigningPersisted: async () => { throw new Error('private-hook-credential'); } });
  await store.createBudget(budgetInput(fixture));
  const { context, prepared } = await start(store, fixture, 'one');
  await assert.rejects(getStoreHandle(store).mutate(context, { kind: 'beginSigning', prepared }), error =>
    error.code === 'storage_unavailable' && error.paymentState === 'authorization_possible' && !String(error).includes('private-hook'));
  const before = await store.getOperation(context);
  assert.equal(before.state, 'signing');
  await assert.rejects(getStoreHandle(store).mutate(context, { kind: 'closeUnsigned' }), error => error.code === 'payment_unresolved');
  assert.deepEqual(await store.getOperation(context), before);
  assert.equal((await store.getBudget(context)).heldAtomic, '7000');
});

test('zero, missing and failed provider reports do not spend or release authorized funds', async () => {
  for (const report of [{ kind: 'missing' }, { kind: 'invalid' }, { kind: 'reported', receipt: { success: true, network: 'eip155:84532', transaction: '', amount: '0' } },
    { kind: 'reported', receipt: { success: false, network: 'eip155:84532', transaction: '', errorReason: 'settlement_failed' } }]) {
    const fixture = protocolFixture('upto/permit2'), store = new MemoryPaymentStore();
    await store.createBudget(budgetInput(fixture));
    const { context, prepared } = await start(store, fixture, 'one');
    const handle = getStoreHandle(store);
    await handle.mutate(context, { kind: 'beginSigning', prepared });
    await handle.mutate(context, { kind: 'submitted' });
    const operation = await handle.mutate(context, { kind: 'report', report, outcome: 'received' });
    assert.equal(operation.state, report.kind === 'reported' && report.receipt.success ? 'reported' : 'unknown');
    assert.equal((await store.getBudget(context)).heldAtomic, '7000');
    assert.equal((await store.getBudget(context)).spentAtomic, '0');
    operation.authorization.permitted.amount = '1';
    assert.equal((await store.getOperation(context)).authorization.permitted.amount, '7000');
    await assert.rejects(handle.start({ ...context, requestFingerprint: fixture.operation.requestFingerprint, targetOrigin: fixture.operation.targetOrigin }), error => error.code === 'operation_in_progress' && error.paymentState === 'submitted_unknown');
  }
});
