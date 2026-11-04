import { loadNative } from './native.js';
import type { NativeBinding } from './native.js';
import type { StoreHandle } from './internal.js';
import type { PaymentErrorCode, PaymentState } from './types.js';

const messages: Record<PaymentErrorCode, string> = {
  invalid_config: 'Provide a valid Base network, authorized signer and explicit payment policy.',
  invalid_amount: 'Use canonical integer atomic USDC units within uint256.',
  unsupported_payment: 'The service must offer a supported v2 Base USDC authorization payment.',
  policy_rejected: 'The offer does not match the authorized merchant, scheme or per-payment limit.',
  allowance_required: 'Arrange a bounded Permit2 allowance with the owner wallet before paying.',
  request_not_replayable: 'Use a replayable request body no larger than 1 MiB.',
  payment_already_supplied: 'Remove supplied payment headers; this client creates one authorization.',
  request_aborted: 'The request was aborted before payment authorization.',
  authorization_failed: 'Wallet authorization failed; inspect the operation before trying a new payment.',
  payment_unresolved: 'Payment outcome is unknown; reconcile this operation instead of paying again.',
  budget_exceeded: 'The shared budget has insufficient available funds.',
  operation_conflict: 'This identifier is already bound to different immutable payment inputs.',
  operation_in_progress: 'This operation already exists; inspect or reconcile it instead of paying again.',
  operation_already_processed: 'This operation is closed; retrieve its recorded outcome.',
  storage_unavailable: 'Payment storage is unavailable; restore it before authorizing payment.',
};

export interface PaymentErrorOptions {
  paymentState?: PaymentState;
  operationId?: string;
  transactionHash?: `0x${string}`;
  response?: Response;
}

class RuntimePaymentError extends Error {
  readonly code: PaymentErrorCode;
  readonly paymentState: PaymentState;
  readonly operationId?: string;
  readonly transactionHash?: `0x${string}`;
  readonly response?: Response;

  constructor(code: PaymentErrorCode, options: PaymentErrorOptions = {}) {
    const safeCode = isPaymentErrorCode(code) ? code : 'invalid_config';
    super(messages[safeCode]);
    options = options !== null && typeof options === 'object' ? options : {};
    this.name = 'PaymentError';
    this.code = safeCode;
    this.paymentState = options.paymentState === 'authorization_possible' || options.paymentState === 'submitted_unknown'
      ? options.paymentState : 'not_attempted';
    if (typeof options.operationId === 'string' && options.operationId.length > 0 &&
      Buffer.byteLength(options.operationId, 'utf8') <= 256 && options.operationId === options.operationId.trim() &&
      !/[\u0000-\u001f\u007f]/.test(options.operationId)) this.operationId = options.operationId;
    if (typeof options.transactionHash === 'string' && /^0x[0-9a-fA-F]{64}$/.test(options.transactionHash)) {
      this.transactionHash = options.transactionHash.toLowerCase() as `0x${string}`;
    }
    if (options.response instanceof Response) {
      Object.defineProperty(this, 'response', { value: options.response, enumerable: false });
    }
  }

  toJSON(): Record<string, string> {
    return { code: this.code, paymentState: this.paymentState,
      ...(this.operationId === undefined ? {} : { operationId: this.operationId }),
      ...(this.transactionHash === undefined ? {} : { transactionHash: this.transactionHash }) };
  }
}

export function isPaymentErrorCode(value: unknown): value is PaymentErrorCode {
  return typeof value === 'string' && Object.hasOwn(messages, value);
}

export interface RuntimeRecord {
  readonly abiVersion: 1;
  readonly sdkVersion: '0.1.0';
  readonly binding: NativeBinding;
  readonly PaymentError: typeof RuntimePaymentError;
  readonly stores: WeakMap<object, StoreHandle>;
}

const runtimeKey = Symbol.for('@cap/payments/runtime/v1');
function initializeRuntime(): RuntimeRecord {
  const existing: unknown = Reflect.get(globalThis, runtimeKey);
  if (existing !== undefined || Object.hasOwn(globalThis, runtimeKey)) {
    if (existing === null || typeof existing !== 'object') throw new RuntimePaymentError('invalid_config');
    const record = existing as Partial<RuntimeRecord>;
    if (record.abiVersion !== 1 || record.sdkVersion !== '0.1.0' || record.binding === null ||
      typeof record.binding !== 'object' || typeof record.binding.apiVersion !== 'function' ||
      typeof record.PaymentError !== 'function' || !(record.PaymentError.prototype instanceof Error) ||
      !(record.stores instanceof WeakMap)) throw new RuntimePaymentError('invalid_config');
    try {
      if (record.binding.apiVersion() !== 1) throw new RuntimePaymentError('invalid_config');
    } catch {
      throw new RuntimePaymentError('invalid_config');
    }
    return record as RuntimeRecord;
  }
  const record: RuntimeRecord = Object.freeze({ abiVersion: 1, sdkVersion: '0.1.0', binding: loadNative(),
    PaymentError: RuntimePaymentError, stores: new WeakMap<object, StoreHandle>() });
  Object.defineProperty(globalThis, runtimeKey, { value: record, enumerable: false, writable: false, configurable: false });
  return record;
}

export const runtime = initializeRuntime();
