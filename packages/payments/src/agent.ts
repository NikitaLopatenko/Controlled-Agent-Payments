import { asPaymentError, PaymentError } from './errors.js';
import { getStoreHandle, normalizeContext, normalizeOperationKey, validateBudget, validatePolicy } from './internal.js';
import { nativeCall } from './native.js';
import { encodeAuthorization, prepareAuthorization, readPaymentReceipt, validateAllowance } from './protocol.js';
import { prepareRequest } from './request.js';
import { reconcilePayment } from './reconcile.js';
import { abortable, checkAbort } from './signal.js';
import type {
  AgentContext, AgentPayments, AgentPaymentsOptions, OperationKey, PaymentErrorCode, PaymentOperation,
  PaymentState, RpcRequest, TypedDataRequest,
} from './types.js';

function host<T>(action: () => T | Promise<T>, code: PaymentErrorCode): Promise<T> {
  try {
    return Promise.resolve(action()).catch(() => {
      throw new PaymentError(code);
    });
  } catch {
    throw new PaymentError(code);
  }
}

function stored<T>(action: () => T | Promise<T>): Promise<T> {
  try {
    return Promise.resolve(action()).catch(error => {
      throw asPaymentError(error, 'storage_unavailable');
    });
  } catch (error) {
    throw asPaymentError(error, 'storage_unavailable');
  }
}

function discardResponse(response: Response): void {
  try {
    void response.body?.cancel().catch(() => {});
  } catch {}
}

function fetchResponse(action: () => Promise<Response>, signal: AbortSignal): Promise<Response> {
  let abandoned = false;
  let received: Response | undefined;
  return abortable(() => host(action, 'payment_unresolved').then(result => {
    if (!(result instanceof Response)) {
      throw new PaymentError('payment_unresolved');
    }
    if (abandoned) {
      discardResponse(result);
    } else {
      received = result;
    }
    return result;
  }), signal).catch(error => {
    abandoned = true;
    if (received !== undefined) {
      discardResponse(received);
    }
    throw error;
  });
}

export function createAgentPayments(options: AgentPaymentsOptions): AgentPayments {
  try {
    if (options === null || typeof options !== 'object' || Array.isArray(options)) {
      throw new PaymentError('invalid_config');
    }
    const network = options.network;
    const store = options.store;
    const resolveSigner = options.resolveSigner;
    const rpc = options.rpc;
    const suppliedFetch = options.fetch;
    const transport = suppliedFetch === undefined ? globalThis.fetch : suppliedFetch;
    if ((network !== 'eip155:8453' && network !== 'eip155:84532') ||
      typeof resolveSigner !== 'function' || typeof rpc !== 'function' || typeof transport !== 'function') {
      throw new PaymentError('invalid_config');
    }
    const handle = getStoreHandle(store);
    if (typeof store.createBudget !== 'function' || typeof store.getBudget !== 'function' ||
      typeof store.getOperation !== 'function') {
      throw new PaymentError('invalid_config');
    }
    const getBudget = store.getBudget.bind(store);
    const start = handle.start.bind(handle);
    const mutate = handle.mutate.bind(handle);
    const getOperation = store.getOperation.bind(store);
    const policy = validatePolicy(network, options.policy);

    return {
      fetch: async (context, input, init) => {
        let captured: Readonly<AgentContext> | undefined;
        let key: OperationKey | undefined;
        let signal: AbortSignal | undefined;
        let response: Response | undefined;
        let transactionHash: `0x${string}` | undefined;
        let phase: PaymentState = 'not_attempted';
        let acquired = false;
        let signingAcknowledged = false;
        let closeAttempted = false;
        let reportRecorded = false;

        try {
          captured = Object.freeze(normalizeContext(context));
          key = Object.freeze({ ownerId: captured.ownerId, budgetId: captured.budgetId, operationId: captured.operationId });
          const { request, targetOrigin, requestFingerprint } = await abortable(() => prepareRequest(input, init, network));
          signal = request.signal;
          const signer = await abortable(() => host(() => resolveSigner(captured!), 'authorization_failed'), signal);
          let payer: string;
          let signTypedData: (request: TypedDataRequest) => Promise<`0x${string}`>;
          try {
            if (signer === null || typeof signer !== 'object') {
              throw new Error();
            }
            const address = signer.address;
            const sign = signer.signTypedData;
            if (typeof address !== 'string' || !/^0x[0-9a-fA-F]{40}$/.test(address) || /^0x0{40}$/.test(address) ||
              typeof sign !== 'function') {
              throw new Error();
            }
            payer = address.toLowerCase();
            signTypedData = sign.bind(signer);
          } catch {
            throw new PaymentError('invalid_config');
          }
          const rawBudget = await abortable(() => stored(() => getBudget(key!)), signal);
          if (rawBudget === null) {
            throw new PaymentError('operation_conflict');
          }
          const budget = validateBudget(rawBudget);
          if (budget.ownerId !== key.ownerId || budget.budgetId !== key.budgetId || budget.network !== network || budget.payer !== payer) {
            throw new PaymentError('operation_conflict');
          }

          let operation: PaymentOperation;
          try {
            operation = await abortable(() => stored(() => start({ ...captured!, targetOrigin, requestFingerprint })), signal);
          } catch (error) {
            if (error instanceof PaymentError && (error.code === 'operation_conflict' || error.code === 'operation_in_progress' ||
              error.code === 'operation_already_processed')) {
              phase = error.paymentState;
              transactionHash = error.transactionHash;
            }
            throw error;
          }
          // An unacknowledged start does not give this invocation cleanup ownership.
          acquired = true;
          response = await fetchResponse(() => transport(request.clone()), signal);
          if (response.status !== 402) {
            await abortable(() => {
              closeAttempted = true;
              return stored(() => mutate(key!, { kind: 'closeUnsigned' }));
            }, signal);
            return response;
          }

          checkAbort(signal);
          const prepared = prepareAuthorization(response.headers.get('PAYMENT-REQUIRED'), operation, policy);
          const allowanceJson = nativeCall(() => prepared.allowanceRequest());
          if (allowanceJson !== null) {
            const allowance = nativeCall(() => JSON.parse(allowanceJson) as RpcRequest);
            Object.freeze(allowance.params);
            Object.freeze(allowance);
            const result = await abortable(() => host(() => rpc(allowance, signal), 'allowance_required'), signal);
            validateAllowance(prepared, result);
          }
          await abortable(() => {
            // A rejected commit acknowledgement can still leave the authorization and hold durable.
            phase = 'authorization_possible';
            return stored(() => mutate(key!, { kind: 'beginSigning', prepared }));
          }, signal);
          signingAcknowledged = true;
          const typedData = nativeCall(() => JSON.parse(prepared.typedData()) as TypedDataRequest);
          const signature = await abortable(() => host(() => signTypedData(typedData), 'authorization_failed'), signal);
          checkAbort(signal);
          const authorization = encodeAuthorization(prepared, signature);
          const headers = new Headers(request.headers);
          headers.set('PAYMENT-SIGNATURE', authorization);
          const paidRequest = new Request(request, { headers, redirect: 'error' });

          await abortable(() => {
            phase = 'submitted_unknown';
            return stored(() => mutate(key!, { kind: 'submitted' }));
          }, signal);
          response = await fetchResponse(() => {
            const discarded = response;
            response = undefined;
            if (discarded !== undefined) {
              discardResponse(discarded);
            }
            return transport(paidRequest);
          }, signal);
          checkAbort(signal);
          const report = readPaymentReceipt(response);
          if (report.kind === 'reported' && report.receipt.transaction !== '') {
            transactionHash = report.receipt.transaction;
          }
          const outcome = response.status === 402 ? 'transport_failed' : 'received';
          const recorded = await abortable(() => stored(() => mutate(key!, { kind: 'report', report, outcome })), signal);
          reportRecorded = true;
          if (recorded.state !== 'reported') {
            throw new PaymentError('payment_unresolved');
          }
          return response;
        } catch (cause) {
          let code = cause instanceof PaymentError ? cause.code : 'invalid_config';
          if (acquired && key !== undefined && !reportRecorded) {
            let recordFailure = signingAcknowledged || closeAttempted;
            if (!recordFailure) {
              try {
                closeAttempted = true;
                // Cleanup must finish even when the caller has already aborted.
                await abortable(() => stored(() => mutate(key!, { kind: 'closeUnsigned' })));
                phase = 'not_attempted';
              } catch (error) {
                if (error instanceof PaymentError && error.paymentState === 'submitted_unknown') {
                  phase = 'submitted_unknown';
                } else if (phase === 'not_attempted' && error instanceof PaymentError &&
                  error.paymentState === 'authorization_possible') {
                  phase = 'authorization_possible';
                }
                if (error instanceof PaymentError && error.code === 'storage_unavailable') {
                  code = error.code;
                }
                recordFailure = true;
              }
            }
            if (recordFailure) {
              try {
                await abortable(() => stored(() => mutate(key!, { kind: 'failure', code })));
              } catch (error) {
                code = asPaymentError(error, 'storage_unavailable').code;
              }
            }
          }
          if (signal?.aborted && code !== 'storage_unavailable') {
            code = phase === 'not_attempted' ? 'request_aborted' : 'payment_unresolved';
          } else if (code === 'request_aborted' && phase !== 'not_attempted') {
            code = 'payment_unresolved';
          }
          throw new PaymentError(code, { paymentState: phase, operationId: captured?.operationId, transactionHash, response });
        }
      },
      async getOperation(input) {
        const key = normalizeOperationKey(input);
        return stored(() => getOperation(key));
      },
      reconcile: (key, transactionHash) => reconcilePayment({ network, store, rpc }, key, transactionHash),
    };
  } catch {
    throw new PaymentError('invalid_config');
  }
}
