import { PaymentError } from './errors.js';
import { validateOrigin } from './internal.js';
import { abortable, checkAbort } from './signal.js';
import type { BaseNetwork } from './types.js';

export const MAX_BODY_BYTES = 1024 * 1024;

function rejectPaymentHeaders(headers: Headers): void {
  if (headers.has('PAYMENT-SIGNATURE') || headers.has('X-PAYMENT')) {
    throw new PaymentError('payment_already_supplied');
  }
}

async function readBody(body: ReadableStream<Uint8Array>, signal: AbortSignal): Promise<Uint8Array<ArrayBuffer>> {
  checkAbort(signal);
  const reader = body.getReader();
  const chunks: Uint8Array<ArrayBuffer>[] = [];
  let size = 0;
  try {
    for (;;) {
      const done = await abortable(() => reader.read().then(result => {
        checkAbort(signal);
        if (result.done) return true;
        const value = result.value;
        if (!(value instanceof Uint8Array) || value.byteLength > MAX_BODY_BYTES - size) {
          throw new PaymentError('request_not_replayable');
        }
        if (value.byteLength !== 0) chunks.push(new Uint8Array(value));
        size += value.byteLength;
        return false;
      }), signal);
      if (done) break;
    }
  } catch {
    void reader.cancel().catch(() => {});
    checkAbort(signal);
    throw new PaymentError('request_not_replayable');
  } finally {
    reader.releaseLock();
  }
  if (chunks.length === 1) return chunks[0]!;
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

async function sha256(bytes: Uint8Array<ArrayBuffer>, signal: AbortSignal): Promise<string> {
  const digest = await abortable(() => globalThis.crypto.subtle.digest('SHA-256', bytes), signal);
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
}

export async function prepareRequest(
  input: RequestInfo | URL,
  init: RequestInit | undefined,
  network: BaseNetwork,
): Promise<{ request: Request; targetOrigin: string; requestFingerprint: string }> {
  let url: URL;
  let targetOrigin: string;
  try {
    url = new URL(input instanceof Request ? input.url : String(input));
    if (url.username || url.password || url.href.includes('#')) throw new PaymentError('invalid_config');
    targetOrigin = validateOrigin(network, url.origin);
  } catch {
    throw new PaymentError('invalid_config');
  }

  let request: Request;
  let headers: [string, string][];
  let bytes: Uint8Array<ArrayBuffer>;
  try {
    if (input instanceof Request) {
      rejectPaymentHeaders(input.headers);
      if (input.bodyUsed || input.body?.locked) throw new PaymentError('request_not_replayable');
    }
    const options = init === undefined ? undefined : { ...init };
    if (options?.headers !== undefined) rejectPaymentHeaders(new Headers(options.headers));
    const body = options?.body;
    if (body !== null && (typeof body === 'object' || typeof body === 'function') &&
      (('getReader' in body && typeof body.getReader === 'function') ||
        (Symbol.asyncIterator in body && typeof body[Symbol.asyncIterator] === 'function'))) {
      throw new PaymentError('request_not_replayable');
    }
    const inheritedBody = input instanceof Request && body == null ? input.body : null;
    request = new Request(input instanceof Request ? input : url.href, {
      ...options, ...(inheritedBody === null ? {} : { body: new Uint8Array(0) }), redirect: 'error',
    });
    rejectPaymentHeaders(request.headers);
    checkAbort(request.signal);
    headers = Array.from(request.headers.entries()).sort(([a, av], [b, bv]) =>
      a < b ? -1 : a > b ? 1 : av < bv ? -1 : av > bv ? 1 : 0);
    const source = inheritedBody ?? request.body;
    bytes = source === null ? new Uint8Array(0) : await readBody(source, request.signal);
    checkAbort(request.signal);
    if (source !== null) request = new Request(request, { body: bytes, redirect: 'error' });
  } catch (error) {
    if (error instanceof PaymentError &&
      (error.code === 'payment_already_supplied' || error.code === 'request_aborted')) {
      throw new PaymentError(error.code);
    }
    throw new PaymentError('request_not_replayable');
  }

  const bodyHash = await sha256(bytes, request.signal);
  const requestFingerprint = await sha256(new TextEncoder().encode(JSON.stringify([
    request.method, request.url, headers, bodyHash,
  ])), request.signal);
  checkAbort(request.signal);
  return { request, targetOrigin, requestFingerprint };
}
