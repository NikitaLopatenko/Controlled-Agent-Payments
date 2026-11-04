import type { AgentPayments, AgentPaymentsOptions, OperationState } from '@cap/payments';

export const SCENARIO_IDS = ['exact-payment', 'operator-budget-recovery'] as const;
export type ScenarioId = typeof SCENARIO_IDS[number];
export type AgentUnderTest = Pick<AgentPayments, 'fetch' | 'reconcile'>;
export type AgentTestFactory = (options: AgentPaymentsOptions) => AgentUnderTest | Promise<AgentUnderTest>;
export type PaymentTestOptions = {
  scenarios?: readonly ScenarioId[];
  createAgent?: never;
} | {
  scenarios?: readonly ScenarioId[];
  createAgent: AgentTestFactory;
};
export interface TestAssertion { name: string; passed: boolean }
export interface TestEvent {
  origin?: string;
  operationId?: string;
  state?: OperationState;
  heldAtomic?: string;
  spentAtomic?: string;
  amountAtomic?: string;
  httpStatus?: number;
  transactionHash?: `0x${string}`;
}
export interface ScenarioReport {
  id: ScenarioId;
  passed: boolean;
  assertions: TestAssertion[];
  events: TestEvent[];
  error?: { code: 'scenario_timeout' | 'scenario_failed'; message: string };
}
export interface TestReport {
  version: 1;
  mode: 'simulated';
  profile: 'builtin' | 'agent-integration';
  passed: boolean;
  scenarios: ScenarioReport[];
}
export const FACTORY_ERROR = 'Agent factory must return fetch and reconcile methods.';
export const SCENARIO_TIMEOUT = 'Scenario exceeded its 10000 ms deadline.';
export const WORKER_TIMEOUT = 'Test worker exceeded its 15000 ms deadline.';

export class TestConfigurationError extends Error {
  readonly code = 'invalid_test_config';
  constructor(message: 'Invalid payment test options.' | typeof FACTORY_ERROR = 'Invalid payment test options.') {
    super(message);
    this.name = 'TestConfigurationError';
  }
}

export function selectOptions(input: PaymentTestOptions): {
  ids: ScenarioId[]; profile: TestReport['profile']; createAgent?: AgentTestFactory;
} {
  try {
    if (input === null || typeof input !== 'object' || Array.isArray(input) ||
      (Object.getPrototypeOf(input) !== Object.prototype && Object.getPrototypeOf(input) !== null) ||
      Reflect.ownKeys(input).some(key => key !== 'scenarios' && key !== 'createAgent')) throw new Error();
    const factoryPresent = Object.hasOwn(input, 'createAgent'), createAgent = input.createAgent;
    if (factoryPresent && typeof createAgent !== 'function') throw new Error();
    const scenarios = input.scenarios;
    if (scenarios !== undefined && (!Array.isArray(scenarios) || scenarios.length === 0)) throw new Error();
    const ids = [...new Set(scenarios ?? SCENARIO_IDS)];
    if (ids.some(id => !SCENARIO_IDS.includes(id))) throw new Error();
    return { ids, profile: factoryPresent ? 'agent-integration' : 'builtin',
      ...(factoryPresent ? { createAgent: createAgent as AgentTestFactory } : {}) };
  } catch { throw new TestConfigurationError(); }
}
