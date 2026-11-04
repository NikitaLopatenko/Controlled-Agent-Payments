import { asPaymentError, PaymentError, paymentStateForOperation } from './errors.js';
import {
  authorizationKey, checkStart, nativeTransition, newOperation, normalizeBudget, normalizeBudgetKey,
  normalizeOperationKey, registerStore,
} from './internal.js';
import type { StartInput, StoreAction } from './internal.js';
import type { BudgetInput, BudgetKey, BudgetSnapshot, BudgetStore, OperationKey, PaymentOperation } from './types.js';

export interface MemoryPaymentStoreOptions {
  afterSigningPersisted?: (operation: Readonly<PaymentOperation>) => Promise<void>;
}

function budgetId(key: BudgetKey): string { return JSON.stringify([key.ownerId, key.budgetId]); }
function operationId(key: OperationKey): string { return JSON.stringify([key.ownerId, key.budgetId, key.operationId]); }

export class MemoryPaymentStore implements BudgetStore {
  #budgets = new Map<string, BudgetSnapshot>();
  #operations = new Map<string, PaymentOperation>();
  #nonces = new Set<string>();

  constructor(options: MemoryPaymentStoreOptions = {}) {
    if (options === null || typeof options !== 'object' || Array.isArray(options) ||
      (options.afterSigningPersisted !== undefined && typeof options.afterSigningPersisted !== 'function')) {
      throw new PaymentError('invalid_config');
    }
    const afterSigningPersisted = options.afterSigningPersisted;
    registerStore(this, {
      start: async (input: StartInput) => {
        const key = normalizeBudgetKey(input);
        const budget = this.#budgets.get(budgetId(key));
        if (budget === undefined) throw new PaymentError('operation_conflict');
        const candidate = newOperation(budget, input);
        const id = operationId(candidate), existing = this.#operations.get(id);
        if (existing !== undefined) {
          checkStart(existing, candidate);
          throw new PaymentError('operation_in_progress', { operationId: existing.operationId,
            paymentState: paymentStateForOperation(existing), transactionHash: existing.transactionHash });
        }
        this.#operations.set(id, candidate);
        return structuredClone(candidate);
      },
      mutate: async (input: OperationKey, action: StoreAction) => {
        const key = normalizeOperationKey(input), id = operationId(key);
        const existing = this.#operations.get(id), budget = this.#budgets.get(budgetId(key));
        if (existing === undefined || budget === undefined) throw new PaymentError('operation_conflict');
        const result = nativeTransition(budget, existing, action);
        let nonce: string | undefined;
        if (action.kind === 'beginSigning' && result.operation.authorization !== undefined) {
          const authorization = authorizationKey(result.operation.network, result.operation.authorization);
          nonce = JSON.stringify([result.operation.network, authorization.contract, authorization.payer, authorization.nonce]);
          if (this.#nonces.has(nonce)) throw new PaymentError('operation_conflict', { operationId: existing.operationId,
            paymentState: paymentStateForOperation(existing), transactionHash: existing.transactionHash });
        }
        this.#budgets.set(budgetId(key), result.budget);
        this.#operations.set(id, result.operation);
        if (nonce !== undefined) this.#nonces.add(nonce);
        if (action.kind === 'beginSigning' && afterSigningPersisted !== undefined) {
          try {
            await afterSigningPersisted(structuredClone(result.operation));
          } catch (error) {
            throw asPaymentError(error, 'storage_unavailable', { operationId: result.operation.operationId,
              paymentState: paymentStateForOperation(result.operation), transactionHash: result.operation.transactionHash });
          }
        }
        return structuredClone(result.operation);
      },
    });
  }

  async createBudget(input: BudgetInput): Promise<BudgetSnapshot> {
    const candidate = normalizeBudget(input), id = budgetId(candidate), existing = this.#budgets.get(id);
    if (existing !== undefined) {
      if (candidate.network !== existing.network || candidate.payer !== existing.payer || candidate.limitAtomic !== existing.limitAtomic) {
        throw new PaymentError('operation_conflict');
      }
      return structuredClone(existing);
    }
    this.#budgets.set(id, candidate);
    return structuredClone(candidate);
  }

  async getBudget(input: BudgetKey): Promise<BudgetSnapshot | null> {
    const budget = this.#budgets.get(budgetId(normalizeBudgetKey(input)));
    return budget === undefined ? null : structuredClone(budget);
  }

  async getOperation(input: OperationKey): Promise<PaymentOperation | null> {
    const operation = this.#operations.get(operationId(normalizeOperationKey(input)));
    return operation === undefined ? null : structuredClone(operation);
  }
}
