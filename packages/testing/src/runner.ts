// Adapted from UBB's Apache-2.0 tester lifecycle; see NOTICE.
import { createAgentPayments, readPaymentReceipt } from '@cap/payments';
import type { AgentContext, OperationState, PaymentOperation } from '@cap/payments';
import { MemoryPaymentStore } from '@cap/payments/testing';
import { SimulatedFacilitator } from './facilitator.js';
import { startFixture } from './fixture.js';
import type { PaymentFixture } from './fixture.js';
import { FACTORY_ERROR, SCENARIO_TIMEOUT, selectOptions, TestConfigurationError } from './report.js';
import type { AgentTestFactory, AgentUnderTest, PaymentTestOptions, ScenarioId, ScenarioReport, TestEvent, TestReport } from './report.js';

const errorIs = (error: unknown, code: string, paymentState?: string): boolean =>
  error !== null && typeof error === 'object' && 'code' in error && error.code === code &&
  (paymentState === undefined || 'paymentState' in error && error.paymentState === paymentState);

export async function runPaymentTests(options: PaymentTestOptions = {}): Promise<TestReport> {
  const selected = selectOptions(options);
  const scenarios: ScenarioReport[] = [];
  for (const id of selected.ids) {
    const result = await runScenario(id, selected.createAgent ?? createAgentPayments);
    scenarios.push(result.report);
    if (result.interrupted) break;
  }
  return { version: 1, mode: 'simulated', profile: selected.profile,
    passed: scenarios.every(scenario => scenario.passed), scenarios };
}

async function runScenario(id: ScenarioId, factory: AgentTestFactory): Promise<{ report: ScenarioReport; interrupted: boolean }> {
  const report: ScenarioReport = { id, passed: true, assertions: [], events: [] };
  const abort = new AbortController();
  const stopped = Promise.withResolvers<never>();
  const entered = Promise.withResolvers<void>(), gate = Promise.withResolvers<void>();
  const deadline = new Error('Scenario deadline.');
  let terminal = false;
  let wasInterrupted = false;
  let simulator: SimulatedFacilitator | undefined;
  let fixture: PaymentFixture | undefined;
  let signingEntered = false;
  const active = () => { if (terminal) throw new Error('Scenario stopped.'); };
  const wait = async <T>(action: () => T | Promise<T>): Promise<T> => {
    active();
    const value = await action();
    active();
    return value;
  };
  const stop = (reason: Error) => {
    if (terminal) return;
    terminal = true;
    abort.abort();
    gate.resolve();
    simulator?.stop();
    stopped.reject(reason);
  };
  const timer = setTimeout(() => stop(deadline), 10000);
  const interrupted = () => { wasInterrupted = true; stop(new Error('Scenario interrupted.')); };
  process.once('SIGINT', interrupted);
  const check = (name: string, passed: boolean) => {
    active();
    report.assertions.push({ name, passed });
    if (!passed) throw new Error('Scenario assertion failed.');
  };
  const capture = async (action: () => Promise<unknown>): Promise<{ value?: unknown; error?: unknown }> => {
    active();
    try { return { value: await action() }; } catch (error) { return { error }; }
  };
  const workflow = async () => {
    active();
    const model = simulator = new SimulatedFacilitator();
    const starting = startFixture(model).then(async value => {
      if (terminal) { await value.close(); active(); }
      fixture = value;
      return value;
    });
    const server = await wait(() => starting);
    report.events.push({ origin: server.origin });
    const base = { ownerId: 'fixture-owner', budgetId: 'fixture-budget' };
    const exact = { ...base, agentId: 'agent-a', operationId: 'exact-payment' };
    const first = { ...base, agentId: 'agent-a', operationId: 'operator-first' };
    const competing = { ...base, agentId: 'agent-b', operationId: 'operator-competing' };
    const fresh = { ...base, agentId: 'agent-b', operationId: 'operator-fresh' };
    const store = new MemoryPaymentStore({ afterSigningPersisted: async operation => {
      active();
      if (id === 'operator-budget-recovery' && operation.operationId === first.operationId) {
        signingEntered = true;
        entered.resolve();
        await wait(() => gate.promise);
      }
      active();
    } });
    await wait(() => store.createBudget({ ...base, network: model.network, payer: model.payer.address, limitAtomic: '10000' }));
    let dropped = false;
    const transport: typeof fetch = async (input, init) => {
      active();
      const signal = init?.signal ?? (input instanceof Request ? input.signal : undefined);
      const ownedSignal = signal ? AbortSignal.any([abort.signal, signal]) : abort.signal;
      const response = await wait(() => fetch(input, { ...init, signal: ownedSignal }));
      const paid = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined)).has('payment-signature');
      if (id === 'operator-budget-recovery' && paid && !dropped) {
        dropped = true;
        await wait(() => response.arrayBuffer());
        check('the dropped response follows an actual modeled settlement', model.counters.settlements === 1 && model.lastTransactionHash !== undefined);
        throw new TypeError('Modeled response lost.');
      }
      return response;
    };
    let agent: AgentUnderTest;
    try {
      agent = await wait(() => factory({ network: model.network, store,
        resolveSigner: async () => { active(); return model.payer; },
        rpc: (request, signal) => { active(); return model.rpc(request, signal); },
        policy: { maxPerPaymentAtomic: '10000', allowedSchemes: ['exact', 'upto'],
          merchants: [{ origin: server.origin, payTo: model.merchant.address }] }, fetch: transport }));
      if (!agent || typeof agent.fetch !== 'function' || typeof agent.reconcile !== 'function') throw new Error('Invalid factory result.');
    } catch {
      active();
      throw new TestConfigurationError(FACTORY_ERROR);
    }
    const snapshot = async (key: AgentContext, state: OperationState, held: string, spent: string, extra: TestEvent = {}): Promise<PaymentOperation> => {
      const operation = await wait(() => store.getOperation(key)), budget = await wait(() => store.getBudget(key));
      check(`${key.operationId} ${state}: held=${held}, spent=${spent}`,
        operation?.state === state && budget?.heldAtomic === held && budget.spentAtomic === spent);
      report.events.push({ operationId: key.operationId, state: operation!.state,
        heldAtomic: budget!.heldAtomic, spentAtomic: budget!.spentAtomic, ...extra });
      return operation!;
    };
    const accounting = (name: string, signatures: number, settlements: number, charges: string[]) => check(name,
      model.counters.signerCalls === signatures && model.counters.signatures === signatures &&
      model.counters.settlements === settlements && model.charges.length === charges.length &&
      model.charges.every((amount, index) => amount === charges[index]));
    const reconcileTwice = async (key: AgentContext, hash: `0x${string}`, amount: string, spent: string) => {
      const resolved = await wait(() => agent.reconcile(key, hash));
      check(`${key.operationId} reconciliation returns the actual settled amount`,
        resolved.state === 'settled' && resolved.transactionHash === hash && resolved.finalAmountAtomic === amount);
      const operation = await snapshot(key, 'settled', '0', spent, { transactionHash: hash, amountAtomic: amount });
      const repeated = await wait(() => agent.reconcile(key, hash));
      const persisted = await wait(() => store.getOperation(key)), budget = await wait(() => store.getBudget(key));
      check(`${key.operationId} repeated reconciliation is idempotent`,
        repeated.state === 'settled' && JSON.stringify(repeated) === JSON.stringify(operation) &&
        JSON.stringify(persisted) === JSON.stringify(operation) && budget?.heldAtomic === '0' && budget.spentAtomic === spent);
    };
    const usefulResponse = async (response: Response, amount: string) => {
      const text = await wait(() => response.text());
      check('payment returns useful fixture content', response.ok && text === 'fixture-resource');
      const receipt = readPaymentReceipt(response);
      check('response reports the observed modeled charge', receipt.kind === 'reported' && receipt.receipt.success &&
        receipt.receipt.amount === amount && receipt.receipt.transaction === model.lastTransactionHash &&
        receipt.receipt.network === model.network && receipt.receipt.payer?.toLowerCase() === model.payer.address.toLowerCase());
      const hash = receipt.kind === 'reported' ? receipt.receipt.transaction : '';
      check('receipt identifies an actual modeled transaction', /^0x[0-9a-fA-F]{64}$/.test(hash));
      return hash as `0x${string}`;
    };
    if (id === 'exact-payment') {
      const response = await wait(() => agent.fetch(exact, server.exactUrl, { signal: abort.signal }));
      const hash = await usefulResponse(response, '1000');
      const operation = await snapshot(exact, 'reported', '1000', '0', { transactionHash: hash, amountAtomic: '1000', httpStatus: response.status });
      check('exact payment captures EIP-3009 authorization and a useful handler result',
        operation.authorization?.kind === 'eip3009' && operation.report?.kind === 'reported' && server.controls.work === 1);
      accounting('exact purchase signs and settles exactly once', 1, 1, ['1000']);
      await reconcileTwice(exact, hash, '1000', '1000');
      accounting('exact reconciliation creates no additional payment', 1, 1, ['1000']);
      return;
    }

    const init = { ...server.uptoInit, signal: abort.signal };
    const firstCall = capture(() => agent.fetch(first, server.uptoUrl, init));
    await wait(() => Promise.race([entered.promise, firstCall.then(() => {
      check('first request reaches its persisted signing gate before completing', signingEntered);
    })]));
    const signing = await snapshot(first, 'signing', '7000', '0');
    check('signing gate contains the captured upto maximum', signing.authorization?.kind === 'permit2' &&
      signing.authorization.scheme === 'upto' && signing.authorization.permitted.amount === '7000');
    accounting('persisted signing precedes any wallet signature or settlement', 0, 0, []);
    const denied = await wait(() => capture(() => agent.fetch(competing, server.uptoUrl, init)));
    check('competing agent is budget rejected before signing', errorIs(denied.error, 'budget_exceeded', 'not_attempted'));
    await snapshot(competing, 'unpaid', '7000', '0');
    accounting('competing agent leaves the first hold and counters unchanged', 0, 0, []);
    active();
    gate.resolve();
    const lost = await wait(() => firstCall);
    check('lost paid response retains submitted uncertainty', errorIs(lost.error, 'payment_unresolved', 'submitted_unknown'));
    const firstHash = model.lastTransactionHash;
    check('lost response has an observed transaction hash', firstHash !== undefined);
    await snapshot(first, 'unknown', '7000', '0', { transactionHash: firstHash });
    accounting('lost response charges only the actual partial amount', 1, 1, ['1200']);
    check('first POST preserves bytes and performs useful work once', server.controls.input === 'fixture-input' && server.controls.work === 1);
    const duplicate = await wait(() => capture(() => agent.fetch(first, server.uptoUrl, init)));
    check('duplicate operation is blocked without replacement authorization', errorIs(duplicate.error, 'operation_in_progress', 'submitted_unknown'));
    const duplicateOperation = await wait(() => store.getOperation(first)), duplicateBudget = await wait(() => store.getBudget(first));
    check('duplicate preserves the unknown operation and maximum hold', duplicateOperation?.state === 'unknown' &&
      duplicateBudget?.heldAtomic === '7000' && duplicateBudget.spentAtomic === '0');
    accounting('duplicate cannot sign or settle again', 1, 1, ['1200']);
    await reconcileTwice(first, firstHash!, '1200', '1200');
    accounting('first recovery does not create another payment', 1, 1, ['1200']);
    const response = await wait(() => agent.fetch(fresh, server.uptoUrl, init));
    const freshHash = await usefulResponse(response, '1200');
    check('fresh agent preserves POST bytes and receives a distinct purchase', server.controls.input === 'fixture-input' &&
      server.controls.work === 2 && freshHash !== firstHash);
    await snapshot(fresh, 'reported', '7000', '1200', { transactionHash: freshHash, amountAtomic: '1200', httpStatus: response.status });
    accounting('released capacity permits one fresh partial purchase', 2, 2, ['1200', '1200']);
    await reconcileTwice(fresh, freshHash, '1200', '2400');
    accounting('final ledger accounts for exactly two partial charges', 2, 2, ['1200', '1200']);
    check('denied operation remains terminal unpaid', (await wait(() => store.getOperation(competing)))?.state === 'unpaid');
  };
  try {
    await Promise.race([workflow(), stopped.promise]);
  } catch (error) {
    if (error instanceof TestConfigurationError) throw error;
    report.passed = false;
    report.error = error === deadline ? { code: 'scenario_timeout', message: SCENARIO_TIMEOUT } :
      { code: 'scenario_failed', message: 'Scenario assertions failed.' };
  } finally {
    terminal = true;
    clearTimeout(timer);
    process.removeListener('SIGINT', interrupted);
    abort.abort();
    gate.resolve();
    simulator?.stop();
    await fixture?.close();
  }
  return { report, interrupted: wasInterrupted };
}
