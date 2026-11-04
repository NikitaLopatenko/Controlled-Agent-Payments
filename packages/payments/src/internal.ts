import { PaymentError, paymentStateForOperation } from './errors.js';
import { nativeCall } from './native.js';
import type { NativeCallOptions, NativePrepared, NativeResolution } from './native.js';
import { runtime } from './runtime.js';
import type {
  Address, AgentContext, BaseNetwork, BudgetInput, BudgetKey, BudgetSnapshot, BudgetStore,
  OperationKey, PaymentErrorCode, PaymentOperation, PaymentPolicy, ReceiptRead, UnsignedAuthorization,
} from './types.js';

export interface StartInput extends AgentContext { requestFingerprint: string; targetOrigin: string }
export type StoreAction =
  | { kind: 'beginSigning'; prepared: NativePrepared }
  | { kind: 'submitted' }
  | { kind: 'report'; report: ReceiptRead; outcome: 'received' | 'transport_failed' }
  | { kind: 'failure'; code: PaymentErrorCode }
  | { kind: 'closeUnsigned' }
  | { kind: 'resolve'; resolution: NativeResolution };
export interface StoreHandle {
  start(input: StartInput): Promise<PaymentOperation>;
  mutate(key: OperationKey, action: StoreAction): Promise<PaymentOperation>;
}
export interface NativeTransition { budget: BudgetSnapshot; operation: PaymentOperation }
export interface AuthorizationKey { contract: Address; payer: Address; nonce: string }

export function registerStore(store: BudgetStore, handle: StoreHandle): void {
  if (store === null || typeof store !== 'object' || runtime.stores.has(store) ||
    typeof handle?.start !== 'function' || typeof handle?.mutate !== 'function') throw new PaymentError('invalid_config');
  runtime.stores.set(store, handle);
}
export function getStoreHandle(store: BudgetStore): StoreHandle {
  if (store === null || typeof store !== 'object') throw new PaymentError('invalid_config');
  const handle = runtime.stores.get(store);
  if (handle === undefined) throw new PaymentError('invalid_config');
  return handle;
}

export function normalizeBudget(input: BudgetInput): BudgetSnapshot {
  return nativeCall(() => JSON.parse(runtime.binding.normalizeBudget(JSON.stringify(input))) as BudgetSnapshot);
}
export function validateBudget(input: unknown): BudgetSnapshot {
  return nativeCall(() => JSON.parse(runtime.binding.validateBudget(JSON.stringify(input))) as BudgetSnapshot,
    { forceCode: 'storage_unavailable' });
}
export function normalizeBudgetKey(input: BudgetKey): BudgetKey {
  return nativeCall(() => JSON.parse(runtime.binding.normalizeBudgetKey(
    JSON.stringify({ ownerId: input.ownerId, budgetId: input.budgetId }))) as BudgetKey);
}
export function normalizeOperationKey(input: OperationKey): OperationKey {
  return nativeCall(() => JSON.parse(runtime.binding.normalizeOperationKey(
    JSON.stringify({ ownerId: input.ownerId, budgetId: input.budgetId, operationId: input.operationId }))) as OperationKey);
}
export function normalizeContext(input: AgentContext): AgentContext {
  return nativeCall(() => JSON.parse(runtime.binding.normalizeContext(
    JSON.stringify({ ownerId: input.ownerId, budgetId: input.budgetId, agentId: input.agentId, operationId: input.operationId }))) as AgentContext);
}
export function validatePolicy(network: BaseNetwork, input: PaymentPolicy): PaymentPolicy {
  return nativeCall(() => JSON.parse(runtime.binding.validatePolicy(network, JSON.stringify(input))) as PaymentPolicy);
}
export function validateOrigin(network: BaseNetwork, origin: string): string {
  return nativeCall(() => runtime.binding.validateOrigin(network, origin));
}
export function newOperation(budget: BudgetSnapshot, input: StartInput): PaymentOperation {
  return nativeCall(() => JSON.parse(runtime.binding.newOperation(JSON.stringify(budget), JSON.stringify(input))) as PaymentOperation);
}
export function validateOperation(budget: BudgetSnapshot, input: unknown): PaymentOperation {
  return nativeCall(() => JSON.parse(runtime.binding.validateOperation(JSON.stringify(budget), JSON.stringify(input))) as PaymentOperation,
    { forceCode: 'storage_unavailable' });
}
export function checkStart(existing: PaymentOperation, candidate: PaymentOperation): void {
  nativeCall(() => runtime.binding.checkStart(JSON.stringify(existing), JSON.stringify(candidate)), {
    paymentState: paymentStateForOperation(existing), operationId: existing.operationId, transactionHash: existing.transactionHash,
  });
}
export function authorizationKey(network: BaseNetwork, authorization: UnsignedAuthorization): AuthorizationKey {
  return nativeCall(() => JSON.parse(runtime.binding.authorizationKey(network, JSON.stringify(authorization))) as AuthorizationKey);
}
export function nativeTransition(budget: BudgetSnapshot, operation: PaymentOperation, action: StoreAction,
  options: NativeCallOptions = {}): NativeTransition {
  return nativeCall(() => {
    const budgetJson = JSON.stringify(budget), operationJson = JSON.stringify(operation);
    const result = action.kind === 'beginSigning' ? runtime.binding.beginSigning(budgetJson, operationJson, action.prepared)
      : action.kind === 'resolve' ? runtime.binding.applyResolution(budgetJson, operationJson, action.resolution)
      : runtime.binding.applyAction(budgetJson, operationJson, JSON.stringify(action));
    return JSON.parse(result) as NativeTransition;
  }, { paymentState: paymentStateForOperation(operation), operationId: operation.operationId,
    transactionHash: operation.transactionHash, ...options });
}
