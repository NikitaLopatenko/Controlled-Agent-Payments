import { PaymentError, paymentStateForOperation } from './errors.js';
import { getStoreHandle, normalizeOperationKey } from './internal.js';
import type { StoreHandle } from './internal.js';
import { nativeCall } from './native.js';
import type { NativeResolution } from './native.js';
import { rpcResultText } from './protocol.js';
import { runtime } from './runtime.js';
import type { BaseNetwork, BudgetStore, OperationKey, PaymentOperation, ReadRpc, RpcRequest } from './types.js';

interface ReconcileOptions { network: BaseNetwork; store: BudgetStore; rpc: ReadRpc }
interface ReconciliationPlan { chainId: number; expiry: string; unusedCall: { to: string; data: string } }

function stored<T>(action: () => T | Promise<T>, operation?: PaymentOperation): Promise<T> {
  const failed = (error: unknown): never => {
    const failure = error instanceof PaymentError ? error : undefined;
    const known = paymentStateForOperation(operation), supplied = failure?.paymentState;
    const paymentState = known === 'submitted_unknown' || supplied === 'submitted_unknown' ? 'submitted_unknown'
      : known === 'authorization_possible' || supplied === 'authorization_possible' ? 'authorization_possible' : 'not_attempted';
    throw new PaymentError(failure?.code ?? 'storage_unavailable', {
      paymentState, operationId: operation?.operationId ?? failure?.operationId,
      transactionHash: failure?.transactionHash ?? operation?.transactionHash,
    });
  };
  try { return Promise.resolve(action()).catch(failed); }
  catch (error) { return failed(error); }
}

function field(value: unknown, name: string): unknown {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)[name] : undefined;
}

function quantity(value: unknown): string {
  if (typeof value !== 'string' || !/^0x(?:0|[1-9a-f][0-9a-f]{0,63})$/.test(value)) throw new Error();
  return value;
}


export async function reconcilePayment(options: ReconcileOptions, input: OperationKey,
  transactionHash?: `0x${string}`): Promise<PaymentOperation> {
  let network: BaseNetwork, key: Readonly<OperationKey>, rpc: ReadRpc;
  let getOperation: BudgetStore['getOperation'], mutate: StoreHandle['mutate'];
  try {
    if (options === null || typeof options !== 'object' || Array.isArray(options)) throw new Error();
    const store = options.store;
    network = options.network;
    rpc = options.rpc;
    if ((network !== 'eip155:8453' && network !== 'eip155:84532') || typeof rpc !== 'function' ||
      typeof store?.getOperation !== 'function' || (transactionHash !== undefined &&
        (typeof transactionHash !== 'string' || !/^0x[0-9a-fA-F]{64}$/.test(transactionHash)))) throw new Error();
    const handle = getStoreHandle(store);
    getOperation = store.getOperation.bind(store);
    mutate = handle.mutate.bind(handle);
    key = Object.freeze(normalizeOperationKey(input));
    transactionHash = transactionHash?.toLowerCase() as `0x${string}` | undefined;
  } catch { throw new PaymentError('invalid_config'); }
  let observed: PaymentOperation | undefined;

  const current = async (): Promise<PaymentOperation> => {
    const operation = await stored(() => getOperation(key), observed);
    if (operation === null || operation.network !== network) throw new PaymentError('operation_conflict');
    observed = operation;
    return operation;
  };
  const unresolved = async (): Promise<PaymentOperation> => {
    const operation = await current();
    if (operation.state === 'settled' || operation.state === 'unpaid') return operation;
    throw new PaymentError('payment_unresolved', { operationId: operation.operationId,
      transactionHash: operation.transactionHash, paymentState: paymentStateForOperation(operation) });
  };
  const operation = await current();
  if (operation.state === 'settled' || operation.state === 'unpaid') return operation;
  if (operation.authorization === undefined) {
    try { await stored(() => mutate(key, { kind: 'closeUnsigned' }), operation); }
    catch (error) {
      if (!(error instanceof PaymentError) || error.code !== 'payment_unresolved') throw error;
      return unresolved();
    }
    return current();
  }

  const read = async (method: RpcRequest['method'], params: unknown[]): Promise<unknown> => {
    for (const param of params) if (param !== null && typeof param === 'object') Object.freeze(param);
    const request: Readonly<RpcRequest> = Object.freeze({ method, params: Object.freeze(params) });
    return JSON.parse(rpcResultText(await rpc(request))) as unknown;
  };
  const operationJson = JSON.stringify(operation);
  let resolution: NativeResolution | undefined;
  try {
    const plan = nativeCall(() => JSON.parse(runtime.binding.reconciliationPlan(operationJson)) as ReconciliationPlan);
    const chainId = await read('eth_chainId', []);
    const finalized = await read('eth_getBlockByNumber', ['finalized', false]);
    const number = quantity(field(finalized, 'number'));
    const canonicalFinalized = await read('eth_getBlockByNumber', [number, false]);
    const candidate = transactionHash ?? operation.transactionHash;
    const verify = (evidence: Record<string, unknown>): NativeResolution =>
      nativeCall(() => runtime.binding.verifyEvidence(operationJson, rpcResultText(evidence)));
    if (candidate !== undefined) {
      try {
        const transaction = await read('eth_getTransactionByHash', [candidate]);
        const receipt = await read('eth_getTransactionReceipt', [candidate]);
        const canonicalBlock = await read('eth_getBlockByNumber', [quantity(field(receipt, 'blockNumber')), false]);
        const recheckedFinalized = await read('eth_getBlockByNumber', [number, false]);
        resolution = verify({ chainId, finalized, canonicalFinalized, recheckedFinalized,
          settlement: { candidate, transaction, receipt, canonicalBlock } });
      } catch {}
    }
    if (resolution === undefined && BigInt(quantity(field(finalized, 'timestamp'))) > BigInt(plan.expiry)) {
      const blockHash = field(finalized, 'hash');
      if (typeof blockHash !== 'string' || !/^0x[0-9a-fA-F]{64}$/.test(blockHash)) throw new Error();
      const unusedResult = await read('eth_call', [
        { to: plan.unusedCall.to, data: plan.unusedCall.data }, { blockHash, requireCanonical: true },
      ]);
      const recheckedFinalized = await read('eth_getBlockByNumber', [number, false]);
      resolution = verify({ chainId, finalized, canonicalFinalized, recheckedFinalized, unusedResult });
    }
  } catch {}
  if (resolution === undefined) return unresolved();
  const verified = resolution;
  await stored(() => mutate(key, { kind: 'resolve', resolution: verified }), operation);
  return current();
}
