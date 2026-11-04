import assert from 'node:assert/strict';
import test from 'node:test';
import { encodeAbiParameters, encodeFunctionData, erc20Abi } from 'viem';
import { createAgentPayments } from '../packages/payments/dist/agent.js';
import { PaymentError } from '../packages/payments/dist/errors.js';
import { getStoreHandle } from '../packages/payments/dist/internal.js';
import { prepareAuthorization } from '../packages/payments/dist/protocol.js';
import { reconcilePayment } from '../packages/payments/dist/reconcile.js';
import { runtime } from '../packages/payments/dist/runtime.js';
import { paymentFixture } from './payment-fixture.mjs';
import { encodeHeader, facilitator, fixtureSigner } from './protocol-fixture.mjs';
import { hash, hexQuantity, rawRpcModel, reconcileFixture } from './reconcile-fixture.mjs';

const post = { method: 'POST', body: 'fixture-input', headers: { 'content-type': 'text/plain' } };
const errorIs = (code, state) => error => {
  assert.ok(error instanceof PaymentError);
  assert.equal(error.code, code);
  if (state !== undefined) assert.equal(error.paymentState, state);
  assert.equal(Object.hasOwn(error, 'cause'), false);
  assert.equal(JSON.stringify(error).includes('private-'), false);
  return true;
};

async function unchanged(fixture, action, state = 'submitted_unknown') {
  const operation = await fixture.store.getOperation(fixture.key), budget = await fixture.store.getBudget(fixture.key);
  const signatures = fixture.state.signatures, requests = fixture.state.requests.length;
  const handle = getStoreHandle(fixture.store), mutate = handle.mutate, mutations = [];
  handle.mutate = async (key, change) => { mutations.push(change.kind); return mutate.call(handle, key, change); };
  try { await assert.rejects(action(), errorIs('payment_unresolved', state)); }
  finally { handle.mutate = mutate; }
  assert.deepEqual(mutations, []);
  assert.deepEqual(await fixture.store.getOperation(fixture.key), operation);
  assert.deepEqual(await fixture.store.getBudget(fixture.key), budget);
  assert.equal(fixture.state.signatures, signatures);
  assert.equal(fixture.state.requests.length, requests);
}

for (const mode of ['exact/eip3009', 'exact/permit2', 'upto/permit2']) {
  test(`${mode}: raw canonical calldata and Transfer proof replaces a real HTTP hold exactly once`, async t => {
    const f = await reconcileFixture(t, { mode });
    assert.equal(f.paymentError, undefined);
    assert.equal(f.operation.state, 'reported');
    const settled = await reconcilePayment(f.recovery, f.key);
    assert.equal(settled.state, 'settled');
    assert.equal(settled.finalAmountAtomic, mode === 'upto/permit2' ? '1200' : '1000');
    assert.deepEqual(settled.finalProof, { kind: 'settled', transactionHash: f.transaction,
      amountAtomic: f.model.amount, finalizedBlockNumber: '100', finalizedBlockHash: f.model.canonicalBlock.hash });
    const budget = await f.store.getBudget(f.key);
    assert.equal(budget.heldAtomic, '0'); assert.equal(budget.spentAtomic, f.model.amount);
    const rpcCalls = f.model.calls.length;
    assert.deepEqual(await reconcilePayment(f.recovery, f.key, hash('de')), settled);
    assert.equal(f.model.calls.length, rpcCalls);
    assert.equal(f.state.signatures, 1); assert.equal(f.state.verified, 1);
    assert.equal(f.model.calls.some(call => call.method === 'eth_call'), false);
  });
}

test('EIP3009 v/r/s transferWithAuthorization overload is independently ABI encoded', async t => {
  const f = await reconcileFixture(t, { overload: 'vrs' });
  assert.equal((await reconcilePayment(f.recovery, f.key)).state, 'settled');
  assert.equal((await f.store.getBudget(f.key)).spentAtomic, '1000');
});

test('an advancing finalized head does not replace the captured canonical anchor or settlement block', async t => {
  const f = await reconcileFixture(t);
  const read = f.model.rpc;
  f.recovery.rpc = async request => {
    const value = await read(request);
    if (request.method === 'eth_getBlockByNumber' && request.params[0] === 'finalized') {
      f.model.finalized = { number: '0x67', hash: hash('67'), timestamp: hexQuantity(f.model.expiry + 10n) };
    }
    return value;
  };
  const settled = await reconcilePayment(f.recovery, f.key);
  assert.equal(settled.finalProof.finalizedBlockNumber, '100');
  assert.equal(f.model.finalizedReads, 1);
  assert.deepEqual(f.model.calls.filter(call => call.method === 'eth_getBlockByNumber').map(call => call.params[0]),
    ['finalized', '0x66', '0x64', '0x66']);
});

for (const mode of ['exact/eip3009', 'exact/permit2', 'upto/permit2']) {
  test(`${mode}: unavailable candidate cannot block an independent expired-unused hash-pinned proof`, async t => {
    const f = await reconcileFixture(t, { mode, expired: true });
    f.model.candidateError = true;
    const closed = await reconcilePayment(f.recovery, f.key);
    assert.equal(closed.state, 'unpaid');
    assert.deepEqual(closed.finalProof, { kind: 'unpaid', reason: 'expired_nonce_unspent',
      finalizedBlockNumber: '102', finalizedBlockHash: f.model.finalized.hash });
    assert.equal((await f.store.getBudget(f.key)).heldAtomic, '0');
    assert.equal((await f.store.getBudget(f.key)).spentAtomic, '0');
    assert.equal(f.state.signatures, 1); assert.equal(f.state.verified, 1);
    const pinned = f.model.calls.filter(call => call.method === 'eth_call');
    assert.equal(pinned.length, 1);
    assert.deepEqual(pinned[0].params, [f.model.unusedCall, { blockHash: f.model.finalized.hash, requireCanonical: true }]);
    assert.deepEqual(await reconcilePayment(f.recovery, f.key), closed);
  });
}

test('a failed settlement verification is independent of valid expired-unused evidence', async t => {
  const f = await reconcileFixture(t, { expired: true });
  f.model.receipt.status = '0x0';
  assert.equal((await reconcilePayment(f.recovery, f.key)).state, 'unpaid');
  assert.equal(f.model.calls.filter(call => call.method === 'eth_call').length, 1);
  assert.equal(f.model.anchorReads, 3);
});

for (const failure of ['receipt throws', 'receipt pending', 'receipt header throws', 'candidate JSON malformed']) {
  test(`${failure} does not suppress the independent expired-unused branch`, async t => {
    const f = await reconcileFixture(t, { expired: true }), read = f.model.rpc;
    f.recovery.rpc = async request => {
      if (request.method === 'eth_getTransactionReceipt') {
        if (failure === 'receipt throws') throw new Error('private-candidate-receipt');
        if (failure === 'receipt pending') return null;
      }
      if (failure === 'receipt header throws' && request.method === 'eth_getBlockByNumber' && request.params[0] === '0x64') {
        throw new Error('private-candidate-header');
      }
      if (failure === 'candidate JSON malformed' && request.method === 'eth_getTransactionByHash') return { hash: 1n };
      return read(request);
    };
    assert.equal((await reconcilePayment(f.recovery, f.key)).state, 'unpaid');
    assert.equal((await f.store.getBudget(f.key)).heldAtomic, '0');
    assert.equal(f.model.calls.filter(call => call.method === 'eth_call').length, 1);
    assert.equal(f.state.signatures, 1);
  });
}

const mutations = {
  'wrong chain': model => { model.chainId = '0x1'; },
  'wrong transaction hash': model => { model.transaction.hash = hash('01'); },
  'wrong receipt candidate': model => { model.receipt.transactionHash = hash('02'); },
  'reverted receipt': model => { model.receipt.status = '0x0'; },
  'pending transaction': model => { model.transaction.blockHash = null; model.transaction.blockNumber = null; },
  'unsupported call': model => { model.transaction.input = encodeFunctionData({ abi: erc20Abi, functionName: 'transfer',
    args: [model.operation.terms.payTo, 1000n] }); },
  'wrong transaction target': model => { model.transaction.to = facilitator; },
  'receipt block mismatch': model => { model.receipt.blockHash = hash('03'); },
  'noncanonical settlement block': model => { model.canonicalBlock.hash = hash('04'); },
  'settlement after finalized': model => { model.finalized.number = '0x63'; model.canonicalFinalized.number = '0x63'; model.recheckedFinalized.number = '0x63'; },
  'initial canonical mapping changed': model => { model.canonicalFinalized.hash = hash('05'); },
  'final canonical mapping changed': model => { model.recheckedFinalized.hash = hash('06'); },
  'final canonical timestamp changed': model => { model.recheckedFinalized.timestamp = hexQuantity(model.expiry); },
  'removed transfer': model => { model.receipt.logs[0].removed = true; },
  'missing transfer': model => { model.receipt.logs = []; },
  'duplicate transfer': model => { model.receipt.logs.push(structuredClone(model.receipt.logs[0])); },
  'wrong token log': model => { model.receipt.logs[0].address = facilitator; },
  'wrong transfer recipient': model => { model.receipt.logs[0].topics[2] = `0x${'0'.repeat(24)}${facilitator.slice(2)}`; },
  'wrong transfer amount': model => { model.receipt.logs[0].data = encodeAbiParameters([{ type: 'uint256' }], [999n]); },
  'noncanonical block quantity': model => { model.finalized.number = '0x066'; },
};
for (const [name, mutate] of Object.entries(mutations)) {
  test(`${name} leaves the operation, hold and lastError metadata byte-for-byte unchanged`, async t => {
    const f = await reconcileFixture(t);
    mutate(f.model);
    await unchanged(f, () => reconcilePayment(f.recovery, f.key));
  });
}

for (const mode of ['exact/eip3009', 'exact/permit2', 'upto/permit2']) {
  test(`${mode}: every captured calldata field is checked rather than accepting its receipt alone`, async t => {
    const f = await reconcileFixture(t, { mode });
    const original = f.model.transaction.input, authorization = f.operation.authorization;
    const variants = authorization.kind === 'eip3009'
      ? [{ from: facilitator }, { to: facilitator }, { value: '999' }, { validAfter: '1' },
        { validBefore: String(BigInt(authorization.validBefore) + 1n) }, { nonce: hash('9a') }]
      : [{ permitted: { ...authorization.permitted, token: facilitator } },
        { permitted: { ...authorization.permitted, amount: '6999' } }, { from: facilitator },
        { nonce: String(BigInt(authorization.nonce) ^ 1n) }, { deadline: String(BigInt(authorization.deadline) + 1n) },
        { witness: { ...authorization.witness, to: facilitator } },
        { witness: { ...authorization.witness, validAfter: '1' } },
        ...(authorization.scheme === 'upto' ? [{ witness: { ...authorization.witness, facilitator: fixtureSigner.address } }] : [])];
    for (const variant of variants) {
      const changed = structuredClone(f.operation);
      changed.authorization = { ...authorization, ...variant };
      const model = rawRpcModel(changed, f.model.signature, f.transaction);
      f.model.transaction.input = model.transaction.input;
      await unchanged(f, () => reconcilePayment(f.recovery, f.key));
    }
    f.model.transaction.input = original;
    if (mode === 'upto/permit2') {
      f.model.transaction.from = fixtureSigner.address;
      await unchanged(f, () => reconcilePayment(f.recovery, f.key));
      f.model.transaction.from = facilitator;
    }
    assert.equal((await reconcilePayment(f.recovery, f.key)).state, 'settled');
    assert.equal(f.state.signatures, 1);
  });
}

for (const mode of ['exact/eip3009', 'exact/permit2', 'upto/permit2']) {
  test(`${mode}: a used nonce cannot release an expired authorization`, async t => {
    const f = await reconcileFixture(t, { mode, expired: true });
    f.model.candidateError = true;
    const authorization = f.operation.authorization;
    f.model.unusedResult = authorization.kind === 'eip3009' ? encodeAbiParameters([{ type: 'bool' }], [true])
      : encodeAbiParameters([{ type: 'uint256' }], [1n << (BigInt(authorization.nonce) & 255n)]);
    await unchanged(f, () => reconcilePayment(f.recovery, f.key));
    assert.equal(f.model.calls.filter(call => call.method === 'eth_call').length, 1);
  });
}

for (const reason of ['pin unsupported', 'anchor changed', 'timestamp equals expiry', 'invalid bool', 'missing result']) {
  test(`expired-unused ${reason} releases nothing and has no latest/number fallback`, async t => {
    const f = await reconcileFixture(t, { expired: true });
    f.model.candidateError = true;
    if (reason === 'pin unsupported') f.model.pinError = true;
    if (reason === 'anchor changed') f.model.recheckedFinalized.hash = hash('d0');
    if (reason === 'timestamp equals expiry') {
      for (const block of [f.model.finalized, f.model.canonicalFinalized, f.model.recheckedFinalized]) block.timestamp = hexQuantity(f.model.expiry);
    }
    if (reason === 'invalid bool') f.model.unusedResult = encodeAbiParameters([{ type: 'uint256' }], [2n]);
    if (reason === 'missing result') f.model.unusedResult = '0x';
    await unchanged(f, () => reconcilePayment(f.recovery, f.key));
    const calls = f.model.calls.filter(call => call.method === 'eth_call');
    assert.equal(calls.length, reason === 'timestamp equals expiry' ? 0 : 1);
    for (const call of calls) assert.deepEqual(call.params[1], { blockHash: f.model.finalized.hash, requireCanonical: true });
  });
}

test('a zero provider report is not an unpaid proof or a discoverable transaction', async t => {
  const f = await reconcileFixture(t, { mode: 'upto/permit2', receipt: 'zero' });
  assert.equal(f.operation.state, 'reported');
  assert.equal(f.operation.transactionHash, undefined);
  await unchanged(f, () => reconcilePayment(f.recovery, f.key));
  assert.equal(f.model.calls.some(call => call.method === 'eth_getTransactionByHash' || call.method === 'eth_call'), false);
  assert.equal((await f.store.getBudget(f.key)).heldAtomic, '7000');
});

test('an explicit candidate can reconcile a real lost-response unknown operation without signing again', async t => {
  const f = await reconcileFixture(t, { mode: 'upto/permit2', dropPaidResponse: true });
  assert.equal(f.operation.state, 'unknown');
  assert.equal(f.operation.lastErrorCode, 'payment_unresolved');
  assert.equal(f.operation.transactionHash, undefined);
  const settled = await reconcilePayment(f.recovery, f.key, f.transaction.toUpperCase().replace('0X', '0x'));
  assert.equal(settled.state, 'settled');
  assert.equal((await f.store.getBudget(f.key)).spentAtomic, '1200');
  assert.equal(f.state.signatures, 1); assert.equal(f.state.requests.length, 2);
});

test('failed reconciliation preserves an owning fetch error and its existing unknown state', async t => {
  const f = await reconcileFixture(t, { receipt: 'pending' });
  assert.equal(f.operation.state, 'unknown');
  assert.equal(f.operation.lastErrorCode, 'payment_unresolved');
  f.model.chainId = '0x1';
  await unchanged(f, () => reconcilePayment(f.recovery, f.key));
});

test('opaque native proof cannot be forged or applied to another operation under the real store lock', async t => {
  const f = await reconcileFixture(t);
  const resolution = runtime.binding.verifyEvidence(JSON.stringify(f.operation), JSON.stringify(f.model.evidence()));
  const handle = getStoreHandle(f.store);
  const fake = { ...f.model.evidence(), kind: 'settled', transactionHash: f.transaction, amountAtomic: '1000' };
  const before = await f.store.getBudget(f.key);
  await assert.rejects(handle.mutate(f.key, { kind: 'resolve', resolution: fake }), errorIs('invalid_config', 'submitted_unknown'));
  assert.deepEqual(await f.store.getBudget(f.key), before);
  assert.deepEqual(await f.store.getOperation(f.key), f.operation);
  const other = { ...f.key, operationId: 'different-authorization' };
  const response = await createAgentPayments(f.config).fetch(other, f.url, post);
  await response.text();
  const otherOperation = await f.store.getOperation(other), otherBudget = await f.store.getBudget(other);
  await assert.rejects(handle.mutate(other, { kind: 'resolve', resolution }), errorIs('operation_conflict', 'submitted_unknown'));
  assert.deepEqual(await f.store.getOperation(other), otherOperation);
  assert.deepEqual(await f.store.getBudget(other), otherBudget);
  assert.equal((await handle.mutate(f.key, { kind: 'resolve', resolution })).state, 'settled');
  assert.equal((await f.store.getBudget(f.key)).heldAtomic, '1000');
  assert.equal((await f.store.getBudget(f.key)).spentAtomic, '1000');
});

test('unsigned requesting closes under no-authorization CAS with no RPC, and terminal reads stay unchanged', async t => {
  const f = await paymentFixture(t), handle = getStoreHandle(f.store);
  await handle.start({ ...f.key, targetOrigin: f.origin, requestFingerprint: 'a'.repeat(64) });
  let calls = 0;
  const options = { network: f.protocol.network, store: f.store, rpc: async () => { calls++; throw new Error('Must not call RPC.'); } };
  const closed = await reconcilePayment(options, f.key);
  assert.equal(closed.state, 'unpaid');
  assert.deepEqual(closed.finalProof, { kind: 'unpaid', reason: 'no_authorization_created' });
  assert.deepEqual(await reconcilePayment(options, f.key), closed);
  assert.equal(calls, 0); assert.equal(f.state.signatures, 0);
  await assert.rejects(reconcilePayment(options, { ...f.key, operationId: 'missing' }), errorIs('operation_conflict'));
  assert.equal(calls, 0);
});

test('unsigned-close CAS losing to beginSigning retains the signer hold and never writes failure metadata', async t => {
  const f = await paymentFixture(t), handle = getStoreHandle(f.store);
  const requesting = await handle.start({ ...f.key, targetOrigin: f.origin, requestFingerprint: 'a'.repeat(64) });
  const prepared = prepareAuthorization(encodeHeader(f.protocol.challenge), requesting, f.config.policy);
  const getOperation = f.store.getOperation.bind(f.store);
  let first = true, signing;
  f.store.getOperation = async key => {
    const snapshot = await getOperation(key);
    if (first) { first = false; signing = await handle.mutate(key, { kind: 'beginSigning', prepared }); }
    return snapshot;
  };
  await assert.rejects(reconcilePayment({ network: f.protocol.network, store: f.store,
    rpc: async () => { assert.fail('Unsigned recovery must not use RPC.'); } }, f.key), errorIs('payment_unresolved', 'authorization_possible'));
  assert.deepEqual(await getOperation(f.key), signing);
  assert.equal((await f.store.getBudget(f.key)).heldAtomic, '1000');
  assert.equal(signing.lastErrorCode, undefined);
  assert.equal(f.state.signatures, 0);
});

test('unsuccessful reconciliation during real persisted signing cannot stop the original HTTP payment', { timeout: 5000 }, async t => {
  const entered = Promise.withResolvers(), gate = Promise.withResolvers();
  const f = await paymentFixture(t, { mode: 'upto/permit2', memoryOptions: { afterSigningPersisted: async () => {
    entered.resolve(); await gate.promise;
  } } });
  const payment = createAgentPayments(f.config).fetch(f.key, f.url, post).then(value => ({ value }), error => ({ error }));
  try {
    await Promise.race([entered.promise, payment.then(() => { throw new Error('Signing gate was not reached.'); })]);
    const signing = await f.store.getOperation(f.key);
    assert.equal(signing.state, 'signing'); assert.equal(signing.lastErrorCode, undefined);
    const model = rawRpcModel(signing, '0x', f.transaction);
    await unchanged(f, () => reconcilePayment({ network: f.protocol.network, store: f.store, rpc: model.rpc }, f.key), 'authorization_possible');
    assert.equal((await f.store.getOperation(f.key)).state, 'signing');
    assert.equal((await f.store.getBudget(f.key)).heldAtomic, '7000');
    assert.equal(f.state.signatures, 0); assert.equal(f.state.requests.length, 1);
  } finally { gate.resolve(); }
  const result = await payment;
  assert.equal(result.error, undefined);
  assert.equal(await result.value.text(), 'fixture-resource');
  assert.equal((await f.store.getOperation(f.key)).state, 'reported');
  assert.equal(f.state.signatures, 1); assert.equal(f.state.verified, 1);
  assert.equal(f.state.requests.filter(request => request.paid).length, 1);
});

test('options, callback methods and operation keys are captured before the first await', async t => {
  const f = await reconcileFixture(t), key = { ...f.key }, options = { ...f.recovery };
  const entered = Promise.withResolvers(), release = Promise.withResolvers();
  const getOperation = f.store.getOperation.bind(f.store);
  let first = true;
  f.store.getOperation = async input => {
    assert.ok(Object.isFrozen(input));
    if (first) { first = false; entered.resolve(); await release.promise; }
    return getOperation(input);
  };
  const recovery = reconcilePayment(options, key);
  await entered.promise;
  key.operationId = 'mutated'; options.network = 'eip155:8453';
  options.rpc = async () => { assert.fail('Mutated callback must not run.'); };
  options.store = {};
  f.store.getOperation = async () => { assert.fail('Mutated store callback must not run.'); };
  const handle = getStoreHandle(f.store), mutate = handle.mutate;
  handle.mutate = async () => { assert.fail('Mutated store handle must not run.'); };
  release.resolve();
  try { assert.equal((await recovery).state, 'settled'); }
  finally { f.store.getOperation = getOperation; handle.mutate = mutate; }
  assert.equal((await getOperation(f.key)).state, 'settled');
});

test('host mutation of a previously returned raw RPC object cannot rewrite captured evidence', async t => {
  const f = await reconcileFixture(t), read = f.model.rpc;
  f.recovery.rpc = async request => {
    if (request.method === 'eth_getBlockByNumber' && request.params[0] === '0x66') f.model.finalized.hash = hash('ef');
    return read(request);
  };
  assert.equal((await reconcilePayment(f.recovery, f.key)).state, 'settled');
});

for (const [name, invalid] of [
  ['oversized RPC JSON', () => ({ value: 'x'.repeat(1024 * 1024 + 1) })],
  ['decoded bigint', () => ({ number: 102n })],
  ['cyclic RPC result', () => { const value = {}; value.self = value; return value; }],
  ['undefined RPC result', () => undefined],
  ['deep JSON', () => { let value = {}; for (let i = 0; i < 140; i++) value = { nested: value }; return value; }],
]) {
  test(`${name} fails closed without native recursive conversion or ledger mutation`, async t => {
    const f = await reconcileFixture(t);
    f.recovery.rpc = async () => invalid();
    await unchanged(f, () => reconcilePayment(f.recovery, f.key));
  });
}

test('the complete evidence document is bounded even when each individual RPC result fits', async t => {
  const f = await reconcileFixture(t);
  f.model.transaction.unusedExtension = 'x'.repeat(600 * 1024);
  f.model.receipt.unusedExtension = 'x'.repeat(600 * 1024);
  await unchanged(f, () => reconcilePayment(f.recovery, f.key));
});

test('unregistered stores fail before their public methods or RPC can run', async () => {
  let reads = 0;
  const store = { getOperation: async () => { reads++; return null; }, getBudget: async () => null, createBudget: async () => {} };
  await assert.rejects(reconcilePayment({ network: 'eip155:84532', store, rpc: async () => { reads++; } },
    { ownerId: 'owner', budgetId: 'budget', operationId: 'operation' }), errorIs('invalid_config'));
  assert.equal(reads, 0);
});

test('malformed keys, networks and explicit candidates fail before registered storage or RPC effects', async t => {
  const f = await reconcileFixture(t);
  let effects = 0;
  f.store.getOperation = async () => { effects++; throw new Error('Must reject before reading.'); };
  const options = { ...f.recovery, rpc: async () => { effects++; throw new Error('Must reject before RPC.'); } };
  for (const key of [null, { ...f.key, operationId: ' trimmed ' }, { ...f.key, ownerId: '' }]) {
    await assert.rejects(reconcilePayment(options, key), errorIs('invalid_config'));
  }
  for (const candidate of ['', '0x1234', null, 123]) {
    await assert.rejects(reconcilePayment(options, f.key, candidate), errorIs('invalid_config'));
  }
  await assert.rejects(reconcilePayment({ ...options, network: 'eip155:1' }, f.key), errorIs('invalid_config'));
  assert.equal(effects, 0);
});

test('storage read, close and proof-application failures remain visible and never fall back to failure writes', async t => {
  const f = await reconcileFixture(t), getOperation = f.store.getOperation.bind(f.store), handle = getStoreHandle(f.store);
  f.store.getOperation = async () => { throw new Error('private-storage-read'); };
  await assert.rejects(reconcilePayment(f.recovery, f.key), errorIs('storage_unavailable'));
  f.store.getOperation = getOperation;
  const mutate = handle.mutate.bind(handle), actions = [];
  handle.mutate = async (key, action) => { actions.push(action.kind); throw new PaymentError('storage_unavailable'); };
  await assert.rejects(reconcilePayment(f.recovery, f.key), errorIs('storage_unavailable', 'submitted_unknown'));
  assert.deepEqual(actions, ['resolve']);
  assert.deepEqual(await getOperation(f.key), f.operation);
  handle.mutate = mutate;
  const unsigned = { ...f.key, operationId: 'unsigned-storage-failure' };
  await handle.start({ ...unsigned, targetOrigin: f.origin, requestFingerprint: 'b'.repeat(64) });
  handle.mutate = async (key, action) => { actions.push(action.kind); throw new Error('private-storage-close'); };
  await assert.rejects(reconcilePayment(f.recovery, unsigned), errorIs('storage_unavailable'));
  assert.deepEqual(actions, ['resolve', 'closeUnsigned']);
  assert.equal((await getOperation(unsigned)).state, 'requesting');
  handle.mutate = mutate;
});
