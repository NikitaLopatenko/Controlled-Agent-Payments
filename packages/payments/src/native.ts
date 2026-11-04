import { createRequire } from 'node:module';
import { isPaymentErrorCode, runtime } from './runtime.js';
import type { PaymentErrorOptions } from './runtime.js';
import type { PaymentErrorCode } from './types.js';

declare const resolutionBrand: unique symbol;
export interface NativeResolution { readonly [resolutionBrand]: never }
export interface NativePrepared {
  terms(): string;
  authorization(): string;
  typedData(): string;
  signingHash(): string;
  allowanceRequest(): string | null;
  checkAllowance(resultJson: string): void;
  encode(signature: string): string;
}
export interface NativeBinding {
  apiVersion(): number;
  normalizeBudget(json: string): string;
  validateBudget(json: string): string;
  normalizeBudgetKey(json: string): string;
  normalizeOperationKey(json: string): string;
  normalizeContext(json: string): string;
  validatePolicy(network: string, json: string): string;
  validateOrigin(network: string, origin: string): string;
  newOperation(budgetJson: string, startJson: string): string;
  validateOperation(budgetJson: string, operationJson: string): string;
  checkStart(existingJson: string, candidateJson: string): void;
  authorizationKey(network: string, authorizationJson: string): string;
  applyAction(budgetJson: string, operationJson: string, actionJson: string): string;
  beginSigning(budgetJson: string, operationJson: string, prepared: NativePrepared): string;
  applyResolution(budgetJson: string, operationJson: string, resolution: NativeResolution): string;
  preparePayment(header: string, operationJson: string, policyJson: string): NativePrepared;
  readReceipt(header?: string): string;
  reconciliationPlan(operationJson: string): string;
  verifyEvidence(operationJson: string, evidenceJson: string): NativeResolution;
}

export function loadNative(): NativeBinding {
  try {
    if (process.platform !== 'darwin' || process.arch !== 'arm64') throw new Error();
    const binding = createRequire(import.meta.url)('../native/cap-native.darwin-arm64.node') as NativeBinding;
    if (binding.apiVersion() !== 1) throw new Error();
    return binding;
  } catch {
    const error = new Error('CAP native binding is unavailable. Install the matching macOS arm64 artifact or rebuild with the pinned toolchain.');
    Object.defineProperty(error, 'code', { value: 'native_unavailable', enumerable: true });
    throw error;
  }
}

export interface NativeCallOptions extends PaymentErrorOptions {
  fallbackCode?: PaymentErrorCode;
  forceCode?: PaymentErrorCode;
}
export function nativeCall<T>(call: () => T, options: NativeCallOptions = {}): T {
  try {
    return call();
  } catch (error) {
    const message = error instanceof Error ? error.message : undefined;
    const code = options.forceCode ?? (isPaymentErrorCode(message) ? message : options.fallbackCode ?? 'invalid_config');
    throw new runtime.PaymentError(code, options);
  }
}
