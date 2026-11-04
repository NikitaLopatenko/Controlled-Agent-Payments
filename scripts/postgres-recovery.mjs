import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { createAgentPayments, PaymentError } from '../packages/payments/dist/index.js';
import { PostgresPaymentStore } from '../packages/payments/dist/postgres.js';
import { SimulatedFacilitator } from '../packages/testing/dist/facilitator.js';
import { startFixture } from '../packages/testing/dist/fixture.js';

const rpcMethods = new Set(['eth_chainId', 'eth_getBlockByNumber', 'eth_getTransactionByHash', 'eth_getTransactionReceipt', 'eth_call']);
const secret = 'private-final-commit-driver-message';

function commitFault(pool, state, point) {
  const counts = { hits: 0, committed: 0, rollbacks: 0 };
  let armed = true;
  return {
    counts,
    pool: {
      query: pool.query.bind(pool),
      async connect() {
        const client = await pool.connect();
        let pending;
        return {
          release: client.release.bind(client),
          async query(text, values) {
            if (text === 'ROLLBACK') counts.rollbacks++;
            if (text === 'COMMIT' && armed && pending === state) {
              armed = false;
              counts.hits++;
              if (point === 'after') { await client.query(text, values); counts.committed++; }
              const error = new PaymentError('operation_conflict', { operationId: secret, response: new Response(secret) });
              error.message = secret;
              error.cause = new Error(secret);
              throw error;
            }
            const result = await client.query(text, values);
            if (typeof text === 'string' && text.trimStart().startsWith('UPDATE cap_payments.operations')) {
              pending = JSON.parse(values[4]).state;
            } else if (typeof text === 'string' && text.trimStart().startsWith('INSERT INTO cap_payments.operations')) {
              pending = JSON.parse(values[9]).state;
            }
            return result;
          },
        };
      },
    },
  };
}
function paymentFailure(code, paymentState, operationId) {
  return error => {
    assert.ok(error instanceof PaymentError);
    assert.equal(error.code, code);
    assert.equal(error.paymentState, paymentState);
    assert.equal(error.operationId, operationId);
    assert.equal(error.cause, undefined);
    assert.equal(JSON.stringify({ ...error, message: error.message, stack: error.stack }).includes(secret), false);
    return true;
  };
}
async function snapshot(store, context, state, heldAtomic, spentAtomic = '0') {
  const operation = await store.getOperation(context), budget = await store.getBudget(context);
  assert.equal(operation?.state ?? null, state);
  assert.equal(budget.heldAtomic, heldAtomic);
  assert.equal(budget.spentAtomic, spentAtomic);
  return { operation, budget };
}
function counts(model) {
  return { signerCalls: model.counters.signerCalls, signatures: model.counters.signatures,
    settlements: model.counters.settlements, charges: [...model.charges] };
}
function agentFor(fixture, store = fixture.store) {
  return createAgentPayments({ network: fixture.model.network, store, policy: fixture.policy,
    resolveSigner: async () => fixture.model.payer, rpc: fixture.rpc });
}
async function openFixture(database, label) {
  const model = new SimulatedFacilitator();
  let http;
  try {
    http = await startFixture(model);
    const store = new PostgresPaymentStore(database.pool);
    const context = { ownerId: 'sdk-recovery-owner', budgetId: label, agentId: 'crashed-agent', operationId: 'purchase' };
    await store.createBudget({ ownerId: context.ownerId, budgetId: context.budgetId,
      network: model.network, payer: model.payer.address, limitAtomic: '10000' });
    const policy = { maxPerPaymentAtomic: '7000', allowedSchemes: ['exact', 'upto'],
      merchants: [{ origin: http.origin, payTo: model.merchant.address }] };
    const reads = [];
    const rpc = async request => { reads.push(structuredClone(request)); return model.rpc(request); };
    const fixture = { model, http, store, context, policy, rpc, reads };
    fixture.agent = agentFor(fixture);
    return fixture;
  } catch (error) { model.stop(); await http?.close(); throw error; }
}
function advanceUnused(fixture, operation) {
  const expiry = operation.authorization.kind === 'eip3009' ? operation.authorization.validBefore : operation.authorization.deadline;
  fixture.model.setFinalizedTimestamp(BigInt(expiry) + 1n);
}
function assertPinnedUnused(fixture) {
  const calls = fixture.reads.filter(request => request.method === 'eth_call' && request.params[1] !== 'latest');
  assert.ok(calls.length > 0, 'Recovery must obtain actual hash-pinned nonce evidence.');
  for (const request of calls) {
    assert.equal(request.params[1].requireCanonical, true);
    assert.match(request.params[1].blockHash, /^0x[0-9a-f]{64}$/);
  }
}
function crashWorker(database, fixture, stage, children) {
  const child = fork(new URL('./postgres-recovery-worker.mjs', import.meta.url), [], {
    env: { ...process.env, CAP_PG_WORKER_URL: database.url,
      CAP_PG_RECOVERY_INPUT: JSON.stringify({ stage, context: fixture.context, policy: fixture.policy,
        payer: fixture.model.payer.address, network: fixture.model.network, url: fixture.http.uptoUrl, init: fixture.http.uptoInit }) },
    stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
  });
  let resolveGate, rejectGate, resolveExit, gated = false, signCalls = 0;
  const gate = new Promise((resolve, reject) => { resolveGate = resolve; rejectGate = reject; });
  const exited = new Promise(resolve => { resolveExit = resolve; });
  gate.catch(() => {});
  const fail = () => { rejectGate(new Error('Signed PostgreSQL crash worker failed.')); child.kill('SIGKILL'); };
  const timer = setTimeout(fail, 20000);
  const entry = { child, exited };
  children.add(entry);
  child.on('message', message => {
    if (message?.kind === 'gate') {
      if (gated || message.stage !== stage) return fail();
      gated = true;
      resolveGate();
      return;
    }
    if (message?.kind !== 'bridge') return fail();
    void (async () => {
      assert.equal(gated, false);
      assert.ok(Number.isSafeInteger(message.id) && message.id > 0);
      let value;
      if (message.method === 'signTypedData') {
        assert.equal(++signCalls, 1, 'The child may request only one signature.');
        const operation = await fixture.store.getOperation(fixture.context);
        assert.equal(operation.state, 'signing', 'Signing must follow durable unsigned authorization and hold.');
        assert.equal(message.value.primaryType, 'PermitWitnessTransferFrom');
        assert.equal(message.value.domain.chainId, 84532);
        assert.equal(message.value.domain.name, 'Permit2');
        value = await fixture.model.payer.signTypedData(message.value);
      } else {
        assert.equal(message.method, 'rpc');
        assert.ok(rpcMethods.has(message.value?.method));
        assert.ok(Array.isArray(message.value.params));
        assert.ok(Buffer.byteLength(JSON.stringify(message.value)) <= 1024 * 1024);
        value = await fixture.rpc(message.value);
      }
      if (child.connected) child.send({ kind: 'reply', id: message.id, ok: true, value }, error => { if (error && !gated) fail(); });
    })().catch(fail);
  });
  child.once('error', fail);
  child.once('close', (code, signal) => {
    clearTimeout(timer);
    rejectGate(new Error('Crash worker exited before the durable gate.'));
    resolveExit({ code, signal });
    children.delete(entry);
  });
  return { child, gate, exited };
}
async function forbidReplacement(fixture, state, held = '7000') {
  const before = await snapshot(fixture.store, fixture.context, state, held), observed = counts(fixture.model);
  await assert.rejects(fixture.agent.fetch(fixture.context, fixture.http.uptoUrl, fixture.http.uptoInit),
    paymentFailure('operation_in_progress', state === 'signing' ? 'authorization_possible'
      : state === 'requesting' ? 'not_attempted' : 'submitted_unknown', fixture.context.operationId));
  assert.deepEqual(await snapshot(fixture.store, fixture.context, state, held), before);
  assert.deepEqual(counts(fixture.model), observed);
}
async function denyCompetingProcess(fixture, state) {
  const before = await snapshot(fixture.store, fixture.context, state, '7000'), observed = counts(fixture.model);
  const context = { ...fixture.context, agentId: 'competing-parent-agent', operationId: 'competing-purchase' };
  await assert.rejects(fixture.agent.fetch(context, fixture.http.uptoUrl, fixture.http.uptoInit),
    paymentFailure('budget_exceeded', 'not_attempted', context.operationId));
  const denied = await fixture.store.getOperation(context);
  assert.equal(denied.state, 'unpaid');
  assert.equal(denied.authorization, undefined);
  assert.deepEqual(denied.finalProof, { kind: 'unpaid', reason: 'no_authorization_created' });
  assert.deepEqual(await snapshot(fixture.store, fixture.context, state, '7000'), before);
  assert.deepEqual(counts(fixture.model), observed);
  return context;
}
async function recoverTwice(fixture, finalState, hash) {
  const before = counts(fixture.model);
  const first = await fixture.agent.reconcile(fixture.context, hash);
  const second = await fixture.agent.reconcile(fixture.context, hash);
  assert.deepEqual(second, first);
  await assert.rejects(fixture.agent.fetch(fixture.context, fixture.http.uptoUrl, fixture.http.uptoInit),
    paymentFailure('operation_already_processed', 'not_attempted', fixture.context.operationId));
  const result = await snapshot(fixture.store, fixture.context, finalState, '0', finalState === 'settled' ? '1200' : '0');
  assert.equal(result.operation.finalProof.kind, finalState);
  if (finalState === 'settled') {
    assert.equal(result.operation.finalProof.transactionHash, hash);
    assert.equal(result.operation.finalAmountAtomic, '1200');
  } else {
    assert.equal(result.operation.finalProof.reason, result.operation.authorization ? 'expired_nonce_unspent' : 'no_authorization_created');
    if (result.operation.authorization) assertPinnedUnused(fixture);
  }
  assert.deepEqual(counts(fixture.model), before, 'Recovery must never sign or settle another payment.');
  return result;
}

export async function verifyRecovery(database) {
  const crashes = [], finalCommitFaults = [], fetchCommitFaults = [], children = new Set();
  let interrupted = false, activeCase;
  const stop = () => { interrupted = true; for (const entry of children) entry.child.kill('SIGKILL'); };
  process.on('SIGINT', stop); process.on('SIGTERM', stop);
  try {
    const matrix = [
      { stage: 'signing', signatures: 0, settlements: 0, point: 'before' },
      { stage: 'submitted', signatures: 1, settlements: 0, point: 'after' },
      { stage: 'reported', signatures: 1, settlements: 1, point: 'before' },
      { stage: 'submitted-after-settlement', signatures: 1, settlements: 1, point: 'after' },
    ];
    for (const test of matrix) {
      activeCase = `crash-${test.stage}`;
      assert.equal(interrupted, false);
      const fixture = await openFixture(database, `crash-${test.stage}`);
      try {
        const worker = crashWorker(database, fixture, test.stage, children);
        await worker.gate;
        const durableState = test.stage === 'submitted-after-settlement' ? 'submitted' : test.stage;
        const before = await snapshot(fixture.store, fixture.context, durableState, '7000');
        assert.deepEqual(counts(fixture.model), { signerCalls: test.signatures, signatures: test.signatures,
          settlements: test.settlements, charges: test.settlements ? ['1200'] : [] });
        if (test.settlements) {
          assert.match(fixture.model.lastTransactionHash, /^0x[0-9a-f]{64}$/);
          assert.equal(fixture.http.controls.input, 'fixture-input');
          assert.equal(fixture.http.controls.work, 1);
          if (durableState === 'reported') assert.equal(before.operation.transactionHash, fixture.model.lastTransactionHash);
          else assert.equal(before.operation.transactionHash, undefined, 'Lost response must not fabricate a stored transaction.');
        }
        const competing = await denyCompetingProcess(fixture, durableState);
        assert.equal(worker.child.kill('SIGKILL'), true);
        assert.deepEqual(await worker.exited, { code: null, signal: 'SIGKILL' });
        assert.deepEqual(await snapshot(fixture.store, fixture.context, durableState, '7000'), before);
        await forbidReplacement(fixture, durableState);
        const finalState = test.settlements ? 'settled' : 'unpaid';
        const hash = fixture.model.lastTransactionHash;
        if (!test.settlements) advanceUnused(fixture, before.operation);
        const fault = commitFault(database.pool, finalState, test.point);
        const faultyAgent = agentFor(fixture, new PostgresPaymentStore(fault.pool));
        await assert.rejects(faultyAgent.reconcile(fixture.context, hash),
          paymentFailure('storage_unavailable', durableState === 'signing' ? 'authorization_possible' : 'submitted_unknown', fixture.context.operationId));
        assert.deepEqual(fault.counts, { hits: 1, committed: test.point === 'after' ? 1 : 0, rollbacks: 1 });
        if (test.point === 'before') assert.deepEqual(await snapshot(fixture.store, fixture.context, durableState, '7000'), before);
        else await snapshot(fixture.store, fixture.context, finalState, '0', test.settlements ? '1200' : '0');
        await recoverTwice(fixture, finalState, hash);
        assert.equal((await fixture.store.getOperation(competing)).state, 'unpaid');
        const evidence = { stage: test.stage, signal: 'SIGKILL', durableState, heldBeforeAtomic: '7000', spentBeforeAtomic: '0',
          finalState, heldAfterAtomic: '0', spentAfterAtomic: test.settlements ? '1200' : '0',
          crossProcessDeniedCode: 'budget_exceeded', competingState: 'unpaid', ...counts(fixture.model) };
        if (hash) evidence.transactionHash = hash;
        crashes.push(evidence);
        finalCommitFaults.push({ resolution: finalState, point: test.point, ...fault.counts,
          errorCode: 'storage_unavailable', paymentState: durableState === 'signing' ? 'authorization_possible' : 'submitted_unknown' });
      } finally { await fixture.http.close(); }
    }

    for (const phase of ['requesting', 'signing', 'submitted', 'reported']) for (const point of ['before', 'after']) {
      activeCase = `fetch-${phase}-${point}`;
      assert.equal(interrupted, false);
      const fixture = await openFixture(database, `fetch-fault-${phase}-${point}`);
      try {
        const fault = commitFault(database.pool, phase, point);
        const agent = agentFor(fixture, new PostgresPaymentStore(fault.pool));
        const paymentState = phase === 'requesting' || (phase === 'signing' && point === 'before') ? 'not_attempted'
          : phase === 'signing' ? 'authorization_possible' : 'submitted_unknown';
        let caught;
        await assert.rejects(agent.fetch(fixture.context, fixture.http.uptoUrl, fixture.http.uptoInit), error => {
          caught = error;
          return paymentFailure('storage_unavailable', paymentState, fixture.context.operationId)(error);
        });
        if (phase === 'reported') {
          assert.equal(caught.response?.status, 200);
          assert.equal(await caught.response.text(), 'fixture-resource');
        } else await caught.response?.body?.cancel();
        assert.deepEqual(fault.counts, { hits: 1, committed: point === 'after' ? 1 : 0,
          rollbacks: phase === 'signing' && point === 'after' ? 2 : 1 });
        const state = phase === 'requesting' ? (point === 'before' ? null : 'requesting')
          : phase === 'signing' && point === 'before' ? 'unpaid' : 'unknown';
        const authorized = state === 'unknown';
        const persisted = await snapshot(fixture.store, fixture.context, state, authorized ? '7000' : '0');
        const signed = phase === 'submitted' || phase === 'reported' ? 1 : 0;
        const settled = phase === 'reported' ? 1 : 0;
        assert.deepEqual(counts(fixture.model), { signerCalls: signed, signatures: signed,
          settlements: settled, charges: settled ? ['1200'] : [] });
        if (state === 'requesting' || state === 'unknown') await forbidReplacement(fixture, state, authorized ? '7000' : '0');
        if (authorized && !settled) advanceUnused(fixture, persisted.operation);
        if (state !== null) await recoverTwice(fixture, settled ? 'settled' : 'unpaid', fixture.model.lastTransactionHash);
        fetchCommitFaults.push({ phase, point, ...fault.counts, paymentState, durableState: state,
          ...counts(fixture.model), recovered: state !== null });
      } finally { await fixture.http.close(); }
    }
    assert.equal(interrupted, false);
    assert.equal(crashes.length, 4);
    assert.equal(finalCommitFaults.length, 4);
    assert.equal(fetchCommitFaults.length, 8);
    return { mode: 'public-sdk-real-postgres-parent-http-model', crashes, finalCommitFaults, fetchCommitFaults,
      walletSignatures: [...crashes, ...fetchCommitFaults].reduce((sum, result) => sum + result.signatures, 0),
      modeledSettlements: [...crashes, ...fetchCommitFaults].reduce((sum, result) => sum + result.settlements, 0) };
  } catch (error) {
    error.recoveryCase = activeCase;
    error.completedCrashCases = crashes.length;
    error.completedFetchFaultCases = fetchCommitFaults.length;
    throw error;
  } finally {
    stop();
    await Promise.allSettled([...children].map(entry => entry.exited));
    process.removeListener('SIGINT', stop); process.removeListener('SIGTERM', stop);
  }
}
