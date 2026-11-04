import { runtime } from './runtime.js';
import type { PaymentErrorOptions, RuntimeRecord } from './runtime.js';
import type { PaymentErrorCode, PaymentOperation, PaymentState } from './types.js';

export const PaymentError: RuntimeRecord['PaymentError'] = runtime.PaymentError;
export type PaymentError = InstanceType<typeof PaymentError>;
export type { PaymentErrorOptions } from './runtime.js';
export type { PaymentErrorCode, PaymentState } from './types.js';

export function paymentStateForOperation(operation?: Pick<PaymentOperation, 'state'> | null): PaymentState {
  switch (operation?.state) {
    case 'signing': return 'authorization_possible';
    case 'submitted':
    case 'reported':
    case 'unknown': return 'submitted_unknown';
    default: return 'not_attempted';
  }
}

export function asPaymentError(error: unknown, fallbackCode: PaymentErrorCode = 'payment_unresolved',
  options: PaymentErrorOptions = {}): PaymentError {
  if (error instanceof PaymentError) {
    return new PaymentError(error.code, {
      paymentState: error.paymentState,
      operationId: error.operationId,
      transactionHash: error.transactionHash,
      response: error.response,
      ...options,
    });
  }
  return new PaymentError(fallbackCode, options);
}
