import test from 'node:test';
import assert from 'node:assert/strict';
import { prepareAuthorization, encodeAuthorization, rpcResultText, readPaymentReceipt, validateAllowance } from '../packages/payments/dist/protocol.js';
import { runtime } from '../packages/payments/dist/runtime.js';
import { MemoryPaymentStore } from '../packages/payments/dist/testing.js';
import { getStoreHandle } from '../packages/payments/dist/internal.js';

const payer = '0x1111111111111111111111111111111111111111';
const payTo = '0x2222222222222222222222222222222222222222';
const policy = { maxPerPaymentAtomic: '7000', allowedSchemes: ['exact', 'upto'], merchants: [{ origin: 'https://merchant.example', payTo }] };
async function preparation(permit = false) {
  const store = new MemoryPaymentStore();
  const key = { ownerId: 'boundary', budgetId: 'budget', agentId: 'agent', operationId: 'one' };
  await store.createBudget({ ownerId: key.ownerId, budgetId: key.budgetId, network: 'eip155:84532', payer, limitAtomic: '10000' });
  const operation = await getStoreHandle(store).start({ ...key, requestFingerprint: 'a'.repeat(64), targetOrigin: policy.merchants[0].origin });
  const challenge = { x402Version: 2, resource: { url: 'https://merchant.example/item' }, accepts: [{ scheme: 'exact', network: 'eip155:84532', asset: '0x036cbd53842c5426634e7929541ec2318f3dcf7e', amount: '1000', payTo, maxTimeoutSeconds: 300, extra: { name: 'USDC', version: '2', ...(permit ? { assetTransferMethod: 'permit2' } : {}) } }] };
  return { store, key, prepared: prepareAuthorization(Buffer.from(JSON.stringify(challenge)).toString('base64'), operation, policy) };
}

test('over-limit headers are rejected by Node before any native conversion', () => {
  const original = runtime.binding.preparePayment;
  let entered = 0;
  runtime.binding.preparePayment = (...args) => { entered++; return original(...args); };
  try {
    for (const header of ['x'.repeat(16385), '🙂'.repeat(5000)]) {
      assert.throws(() => prepareAuthorization(header, {}, policy), error => error.code === 'unsupported_payment');
    }
    assert.equal(entered, 0);
  } finally { runtime.binding.preparePayment = original; }
});

test('oversized wallet signatures never cross the native method or claim a submission', async () => {
  const { prepared, store, key } = await preparation();
  await getStoreHandle(store).mutate(key, { kind: 'beginSigning', prepared });
  const original = prepared.encode.bind(prepared);
  let entered = 0;
  prepared.encode = signature => { entered++; return original(signature); };
  for (const signature of ['0x' + 'aa'.repeat(4097), '0x', '0x1', '0xzz', { toString() { throw new Error('secret'); } }]) {
    assert.throws(() => encodeAuthorization(prepared, signature), error => error.code === 'authorization_failed' && error.paymentState === 'authorization_possible');
  }
  assert.equal(entered, 0);
  assert.equal((await store.getOperation(key)).state, 'signing');
  assert.equal((await store.getBudget(key)).heldAtomic, '1000');
});

test('RPC JSON has a byte limit and rejects cyclic, non-JSON and BigInt values', async () => {
  for (const value of ['x'.repeat(1048576), '🙂'.repeat(300000), 1n, undefined, NaN, Infinity, new Map(), new Date(),
    { nested: undefined }, { nested: new Date() }, { nested: () => 'not JSON' }, (() => { const x = {}; x.self = x; return x; })()]) {
    assert.throws(() => rpcResultText(value), error => error.code === 'payment_unresolved');
  }
  const { prepared } = await preparation(true);
  const original = prepared.checkAllowance.bind(prepared);
  let entered = 0;
  prepared.checkAllowance = text => { entered++; return original(text); };
  assert.throws(() => validateAllowance(prepared, 'x'.repeat(1048576)), error => error.code === 'allowance_required');
  assert.equal(entered, 0);
});

test('receipt parsing leaves the original response body untouched and drops provider text', async () => {
  const response = new Response('useful body', { headers: { 'PAYMENT-RESPONSE': Buffer.from(JSON.stringify({ success: false, network: 'eip155:84532', transaction: '', errorReason: 'private-provider-token', errorMessage: 'private-message', extra: { credential: 'private-key' } })).toString('base64') } });
  assert.deepEqual(readPaymentReceipt(response), { kind: 'reported', receipt: { success: false, network: 'eip155:84532', transaction: '', errorReason: 'provider_failure' } });
  assert.equal(response.bodyUsed, false);
  assert.equal(await response.text(), 'useful body');
  assert.deepEqual(readPaymentReceipt(new Response('', { headers: { 'PAYMENT-RESPONSE': 'x'.repeat(16385) } })), { kind: 'invalid' });
});
