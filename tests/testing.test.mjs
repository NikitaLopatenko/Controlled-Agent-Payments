import assert from 'node:assert/strict';
import test from 'node:test';
import { setImmediate as tick } from 'node:timers/promises';
import { createAgentPayments } from '../packages/payments/dist/index.js';
import { MemoryPaymentStore as PaymentMemoryStore } from '../packages/payments/dist/testing.js';
import { MemoryPaymentStore, runPaymentTests } from '../packages/testing/dist/index.js';
import { FACTORY_ERROR, SCENARIO_TIMEOUT } from '../packages/testing/dist/report.js';
import { SimulatedFacilitator } from '../packages/testing/dist/facilitator.js';
import { startFixture } from '../packages/testing/dist/fixture.js';
import { decodeFunctionData, encodeFunctionData } from 'viem';
import { eip3009ABI } from '@x402/evm';

const base = { ownerId: 'fixture-owner', budgetId: 'fixture-budget' };
const eventKeys = new Set(['origin', 'operationId', 'state', 'heldAtomic', 'spentAtomic', 'amountAtomic', 'httpStatus', 'transactionHash']);
function safeReport(report) {
  assert.deepEqual(Object.keys(report).sort(), ['mode', 'passed', 'profile', 'scenarios', 'version']);
  assert.equal(report.version, 1);
  assert.equal(report.mode, 'simulated');
  for (const scenario of report.scenarios) {
    assert.ok(['exact-payment', 'operator-budget-recovery'].includes(scenario.id));
    assert.ok(scenario.assertions.every(assertion => Object.keys(assertion).sort().join(',') === 'name,passed'));
    for (const event of scenario.events) {
      assert.ok(Object.keys(event).every(key => eventKeys.has(key)));
      if (event.origin) assert.match(event.origin, /^http:\/\/127\.0\.0\.1:\d+$/);
    }
    if (scenario.error) assert.ok([SCENARIO_TIMEOUT, 'Scenario assertions failed.'].includes(scenario.error.message));
  }
  const serialized = JSON.stringify(report);
  for (const secret of ['private-', 'payment-signature', 'fixture-input', 'fixture-resource',
    `0x${'1'.padStart(64, '0')}`, `0x${'2'.padStart(64, '0')}`, `0x${'3'.padStart(64, '0')}`]) {
    assert.equal(serialized.toLowerCase().includes(secret), false, secret);
  }
}
function successfulCases(report) {
  safeReport(report);
  assert.equal(report.passed, true);
  assert.ok(report.scenarios.every(scenario => scenario.passed && scenario.assertions.length > 0 && scenario.assertions.every(item => item.passed)));
  for (const scenario of report.scenarios) {
    const transitions = scenario.events.filter(event => event.state).map(({ operationId, state, heldAtomic, spentAtomic }) =>
      [operationId, state, heldAtomic, spentAtomic]);
    assert.deepEqual(transitions, scenario.id === 'exact-payment' ? [
      ['exact-payment', 'reported', '1000', '0'], ['exact-payment', 'settled', '0', '1000'],
    ] : [
      ['operator-first', 'signing', '7000', '0'], ['operator-competing', 'unpaid', '7000', '0'],
      ['operator-first', 'unknown', '7000', '0'], ['operator-first', 'settled', '0', '1200'],
      ['operator-fresh', 'reported', '7000', '1200'], ['operator-fresh', 'settled', '0', '2400'],
    ]);
  }
}
const configurationError = message => error => {
  assert.equal(error.code, 'invalid_test_config');
  assert.equal(error.message, message);
  assert.equal('cause' in error, false);
  assert.equal(String(error).includes('private-'), false);
  return true;
};

test('builtin runner executes both real native payment cases through upstream middleware', async () => {
  assert.equal(MemoryPaymentStore, PaymentMemoryStore);
  const listeners = process.listenerCount('SIGINT');
  const report = await runPaymentTests();
  assert.equal(report.profile, 'builtin');
  assert.deepEqual(report.scenarios.map(scenario => scenario.id), ['exact-payment', 'operator-budget-recovery']);
  successfulCases(report);
  assert.equal(process.listenerCount('SIGINT'), listeners);
});

test('injected real factory is called once per fresh case in selected deduplicated order', async () => {
  const configs = [];
  const report = await runPaymentTests({ scenarios: ['operator-budget-recovery', 'exact-payment', 'operator-budget-recovery'],
    createAgent: options => { configs.push(options); return createAgentPayments(options); } });
  successfulCases(report);
  assert.equal(report.profile, 'agent-integration');
  assert.deepEqual(report.scenarios.map(scenario => scenario.id), ['operator-budget-recovery', 'exact-payment']);
  assert.equal(configs.length, 2);
  assert.notEqual(configs[0].store, configs[1].store);
  assert.notEqual(configs[0].policy.merchants[0].origin, configs[1].policy.merchants[0].origin);
  assert.deepEqual(await configs[0].store.getBudget(base), { ...base, network: 'eip155:84532',
    payer: (await configs[0].store.getOperation({ ...base, operationId: 'operator-first' })).payer,
    limitAtomic: '10000', heldAtomic: '0', spentAtomic: '2400' });
});

test('direct public factory injection runs the same two cases without an adapter', async () => {
  const report = await runPaymentTests({ createAgent: createAgentPayments });
  successfulCases(report);
  assert.equal(report.profile, 'agent-integration');
});

test('invalid options fail before creating a fixture or calling a factory', async () => {
  const invalid = [null, true, 1, 'exact-payment', [], () => {}, new Date(), Object.create({}),
    { createService: () => {} }, { createService: undefined }, { createAgnet: () => {} }, { [Symbol('option')]: 1 },
    { createAgent: undefined }, { createAgent: null }, { createAgent: 1 }, { createAgent: {} },
    { scenarios: [] }, { scenarios: ['unknown'] }, { scenarios: [undefined] }, { scenarios: new Array(1) },
    { scenarios: ['exact-payment', , 'operator-budget-recovery'] }, { scenarios: 'exact-payment' },
    { scenarios: null }, { scenarios: new Set(['exact-payment']) },
    { get scenarios() { throw new Error('private-getter'); } },
    { get createAgent() { throw new Error('private-getter'); } }];
  const original = globalThis.fetch;
  let effects = 0;
  const listeners = process.listenerCount('SIGINT');
  globalThis.fetch = async () => { effects++; throw new Error('private-unexpected-effect'); };
  try {
    for (const options of invalid) await assert.rejects(runPaymentTests(options), configurationError('Invalid payment test options.'));
  } finally { globalThis.fetch = original; }
  assert.equal(effects, 0);
  assert.equal(process.listenerCount('SIGINT'), listeners);
});

test('throwing and malformed factories are sanitized configuration errors after cleanup', async () => {
  const invalid = [() => { throw new Error('private-factory-key'); }, async () => { throw new Error('private-async-key'); },
    () => undefined, () => null, () => ({}), () => ({ fetch() {} }), () => ({ fetch: 1, reconcile() {} }),
    () => ({ get fetch() { throw new Error('private-method-getter'); }, reconcile() {} })];
  for (const createAgent of invalid) {
    const listeners = process.listenerCount('SIGINT');
    await assert.rejects(runPaymentTests({ scenarios: ['exact-payment'], createAgent }), configurationError(FACTORY_ERROR));
    assert.equal(process.listenerCount('SIGINT'), listeners);
  }
});

for (const id of ['exact-payment', 'operator-budget-recovery']) {
  test(`${id}: a well-shaped fake 200 payer fails owned ledger and independent payment checks`, async () => {
    let fetches = 0, reconciles = 0;
    const report = await runPaymentTests({ scenarios: [id], createAgent: () => ({
      fetch: async () => { fetches++; return new Response('fixture-resource'); },
      reconcile: async () => { reconciles++; return { state: 'settled' }; },
    }) });
    safeReport(report);
    assert.equal(report.passed, false);
    assert.equal(report.scenarios[0].error.code, 'scenario_failed');
    assert.ok(report.scenarios[0].assertions.some(assertion => !assertion.passed));
    assert.equal(fetches, 1);
    assert.equal(reconciles, 0);
  });
}

test('arbitrary behavior errors never enter reports', async () => {
  const report = await runPaymentTests({ scenarios: ['exact-payment'], createAgent: () => ({
    fetch: async () => { throw new Error('private-raw-wallet-key'); }, reconcile: async () => { throw new Error('private-rpc'); },
  }) });
  safeReport(report);
  assert.equal(report.passed, false);
  assert.deepEqual(report.scenarios[0].error, { code: 'scenario_failed', message: 'Scenario assertions failed.' });
});

for (const phase of ['factory', 'fetch', 'reconcile']) {
  test(`10000 ms ${phase} watchdog cleans up and a deferred late continuation cannot resume the scenario`, { timeout: 15000 }, async () => {
    const delayed = Promise.withResolvers();
    let config, real, fetches = 0, reconciles = 0;
    const started = performance.now(), listeners = process.listenerCount('SIGINT');
    const report = await runPaymentTests({ scenarios: ['exact-payment'], createAgent: options => {
      config = options;
      real = createAgentPayments(options);
      if (phase === 'factory') return delayed.promise;
      return {
        fetch: (...args) => { fetches++; return phase === 'fetch' ? delayed.promise : real.fetch(...args); },
        reconcile: (...args) => { reconciles++; return delayed.promise; },
      };
    } });
    assert.ok(performance.now() - started >= 9900);
    safeReport(report);
    assert.equal(report.passed, false);
    assert.deepEqual(report.scenarios[0].error, { code: 'scenario_timeout', message: SCENARIO_TIMEOUT });
    assert.equal(process.listenerCount('SIGINT'), listeners);
    const serialized = JSON.stringify(report);
    const key = { ...base, operationId: 'exact-payment' };
    const before = await config.store.getBudget(base);
    const operation = await config.store.getOperation(key);
    if (phase === 'factory') delayed.resolve({
      fetch: async () => { fetches++; return new Response('fixture-resource'); },
      reconcile: async () => { reconciles++; return operation; },
    });
    else if (phase === 'fetch') delayed.resolve(new Response('fixture-resource'));
    else delayed.resolve({ ...operation, state: 'settled', finalAmountAtomic: '1000' });
    await tick(); await tick();
    assert.equal(JSON.stringify(report), serialized);
    assert.deepEqual(await config.store.getBudget(base), before);
    assert.equal(fetches, phase === 'factory' ? 0 : 1);
    assert.equal(reconciles, phase === 'reconcile' ? 1 : 0);
    await assert.rejects(config.resolveSigner({ ...base, agentId: 'agent-a', operationId: 'late' }));
    await assert.rejects(config.fetch('http://127.0.0.1:1/exact'));
    assert.throws(() => config.rpc({ method: 'eth_chainId', params: [] }));
    const origin = report.scenarios[0].events[0].origin;
    await assert.rejects(fetch(`${origin}/exact`));
  });
}

test('internal model stops late signing and retains historical hash-pinned nonce snapshots', async t => {
  const simulator = new SimulatedFacilitator();
  const fixture = await startFixture(simulator);
  t.after(() => fixture.close());
  const store = new MemoryPaymentStore();
  await store.createBudget({ ...base, network: simulator.network, payer: simulator.payer.address, limitAtomic: '10000' });
  const key = { ...base, agentId: 'agent-a', operationId: 'history' };
  const agent = createAgentPayments({ network: simulator.network, store, resolveSigner: async () => simulator.payer,
    rpc: simulator.rpc, policy: { maxPerPaymentAtomic: '10000', allowedSchemes: ['exact'],
      merchants: [{ origin: fixture.origin, payTo: simulator.merchant.address }] } });
  const before = await simulator.rpc({ method: 'eth_getBlockByNumber', params: ['finalized', false] });
  const response = await agent.fetch(key, fixture.exactUrl);
  await response.text();
  const operation = await store.getOperation(key);
  const after = await simulator.rpc({ method: 'eth_getBlockByNumber', params: ['finalized', false] });
  const call = { to: operation.authorization.token, data: encodeFunctionData({ abi: eip3009ABI,
    functionName: 'authorizationState', args: [operation.authorization.from, operation.authorization.nonce] }) };
  const old = await simulator.rpc({ method: 'eth_call', params: [call, { blockHash: before.hash, requireCanonical: true }] });
  const used = await simulator.rpc({ method: 'eth_call', params: [call, { blockHash: after.hash, requireCanonical: true }] });
  assert.equal(BigInt(old), 0n);
  assert.equal(BigInt(used), 1n);
  await assert.rejects(simulator.rpc({ method: 'eth_call', params: [call, after.number] }));
  await assert.rejects(simulator.rpc({ method: 'eth_call', params: [call, { blockHash: before.hash, requireCanonical: false }] }));
  const transaction = await simulator.rpc({ method: 'eth_getTransactionByHash', params: [simulator.lastTransactionHash] });
  assert.equal(decodeFunctionData({ abi: eip3009ABI, data: transaction.input }).functionName, 'transferWithAuthorization');
  assert.doesNotThrow(() => JSON.stringify(transaction));
  await agent.reconcile(key, simulator.lastTransactionHash);
  const late = simulator.payer.signTypedData({ domain: { name: 'USDC', version: '2', chainId: 84532, verifyingContract: operation.authorization.token },
    primaryType: 'Fixture', types: { Fixture: [{ name: 'value', type: 'uint256' }] }, message: { value: '1' } });
  simulator.stop();
  const counters = structuredClone(simulator.counters), charges = [...simulator.charges];
  await assert.rejects(late);
  assert.deepEqual(simulator.counters, counters);
  assert.deepEqual(simulator.charges, charges);
  await fixture.close(); await fixture.close();
  await assert.rejects(simulator.rpc({ method: 'eth_chainId', params: [] }));
});

test('SIGINT cleans the active scenario and never starts another selected factory', async () => {
  const entered = Promise.withResolvers(), late = Promise.withResolvers();
  let factories = 0;
  const listeners = process.listenerCount('SIGINT');
  const running = runPaymentTests({ createAgent: () => { factories++; entered.resolve(); return late.promise; } });
  await entered.promise;
  process.emit('SIGINT');
  const report = await running;
  assert.equal(report.passed, false);
  assert.equal(factories, 1);
  assert.equal(report.scenarios.length, 1);
  safeReport(report);
  assert.equal(process.listenerCount('SIGINT'), listeners);
  const serialized = JSON.stringify(report);
  late.resolve({ fetch: async () => { throw new Error('Unexpected late fetch.'); }, reconcile: async () => ({}) });
  await tick();
  assert.equal(JSON.stringify(report), serialized);
});
