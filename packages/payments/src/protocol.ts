import { PaymentError } from './errors.js';
import { nativeCall } from './native.js';
import type { NativePrepared } from './native.js';
import { runtime } from './runtime.js';
import type { PaymentOperation, PaymentPolicy, ReceiptRead } from './types.js';

export const MAX_HEADER_BYTES = 16 * 1024;
export const MAX_RPC_BYTES = 1024 * 1024;
export const MAX_SIGNATURE_BYTES = 4096;

function boundedHeader(header: unknown): header is string {
  return typeof header === 'string' && header.length <= MAX_HEADER_BYTES &&
    Buffer.byteLength(header, 'utf8') <= MAX_HEADER_BYTES;
}

export function prepareAuthorization(header: unknown, operation: PaymentOperation, policy: PaymentPolicy): NativePrepared {
  if (!boundedHeader(header)) throw new PaymentError('unsupported_payment');
  return nativeCall(() => runtime.binding.preparePayment(header, JSON.stringify(operation), JSON.stringify(policy)));
}

export function encodeAuthorization(prepared: NativePrepared, signature: unknown): string {
  if (typeof signature !== 'string' || signature.length > 2 + MAX_SIGNATURE_BYTES * 2 ||
    !/^0x(?:[0-9a-fA-F]{2})+$/.test(signature)) {
    throw new PaymentError('authorization_failed', { paymentState: 'authorization_possible' });
  }
  const header = nativeCall(() => prepared.encode(signature), { paymentState: 'authorization_possible' });
  if (!boundedHeader(header)) throw new PaymentError('authorization_failed', { paymentState: 'authorization_possible' });
  return header;
}

export function rpcResultText(value: unknown): string {
  try {
    const text = JSON.stringify(value, function (key: string, current: unknown): unknown {
      const property = Object.getOwnPropertyDescriptor(this, key);
      if (property?.get || property?.set) throw new Error();
      const original: unknown = property?.value;
      if (original !== null && typeof original === 'object') {
        const prototype: unknown = Object.getPrototypeOf(original);
        if (!Array.isArray(original) && prototype !== Object.prototype && prototype !== null) throw new Error();
      }
      if (current === undefined || typeof current === 'function' || typeof current === 'symbol' ||
        typeof current === 'bigint' || (typeof current === 'number' && !Number.isFinite(current))) throw new Error();
      return current;
    });
    if (typeof text !== 'string' || text.length > MAX_RPC_BYTES || Buffer.byteLength(text, 'utf8') > MAX_RPC_BYTES) {
      throw new Error();
    }
    return text;
  } catch {
    throw new PaymentError('payment_unresolved');
  }
}

export function validateAllowance(prepared: NativePrepared, value: unknown): void {
  try { nativeCall(() => prepared.checkAllowance(rpcResultText(value))); }
  catch { throw new PaymentError('allowance_required'); }
}

export function readPaymentReceipt(response: Response): ReceiptRead {
  if (!(response instanceof Response)) throw new PaymentError('invalid_config');
  const header = response.headers.get('PAYMENT-RESPONSE');
  if (header !== null && !boundedHeader(header)) return { kind: 'invalid' };
  return nativeCall(() => JSON.parse(runtime.binding.readReceipt(header ?? undefined)) as ReceiptRead);
}
