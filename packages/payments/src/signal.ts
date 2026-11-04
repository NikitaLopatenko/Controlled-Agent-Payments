import { PaymentError } from './errors.js';

export function checkAbort(signal?: AbortSignal | null): void {
  if (signal?.aborted) throw new PaymentError('request_aborted');
}

export async function abortable<T>(action: () => T | Promise<T>, signal?: AbortSignal | null): Promise<T> {
  checkAbort(signal);
  if (signal == null) return await action();
  const { promise, resolve, reject } = Promise.withResolvers<T>();
  const onAbort = () => reject(new PaymentError('request_aborted'));
  try {
    signal.addEventListener('abort', onAbort, { once: true });
    try {
      checkAbort(signal);
      Promise.resolve(action()).then(resolve, reject);
    } catch (error) {
      reject(error);
    }
    const result = await promise;
    checkAbort(signal);
    return result;
  } catch (error) {
    checkAbort(signal);
    throw error;
  } finally {
    signal.removeEventListener('abort', onAbort);
  }
}
