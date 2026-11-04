export type BaseNetwork = 'eip155:8453' | 'eip155:84532';
export type Address = `0x${string}`;
export type AtomicAmount = string;
export type PaymentScheme = 'exact' | 'upto';

export interface BudgetKey { ownerId: string; budgetId: string }
export interface AgentContext extends BudgetKey { agentId: string; operationId: string }
export interface OperationKey extends BudgetKey { operationId: string }
export interface BudgetInput extends BudgetKey {
  network: BaseNetwork;
  payer: Address;
  limitAtomic: AtomicAmount;
}
export interface BudgetSnapshot extends BudgetInput { heldAtomic: AtomicAmount; spentAtomic: AtomicAmount }

export interface MerchantRule { origin: string; payTo: Address }
export interface PaymentPolicy {
  maxPerPaymentAtomic: AtomicAmount;
  allowedSchemes: readonly PaymentScheme[];
  merchants: readonly MerchantRule[];
}

export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };
export interface TypedDataRequest {
  domain: { name: string; chainId: number; verifyingContract: Address; version?: string };
  types: Record<string, { name: string; type: string }[]>;
  primaryType: string;
  message: { [key: string]: JsonValue };
}
export interface WalletSigner {
  readonly address: Address;
  signTypedData(request: TypedDataRequest): Promise<`0x${string}`>;
}
export interface RpcRequest {
  readonly method: 'eth_chainId' | 'eth_getBlockByNumber' | 'eth_getTransactionByHash' |
    'eth_getTransactionReceipt' | 'eth_call';
  readonly params: readonly unknown[];
}
export type ReadRpc = (request: Readonly<RpcRequest>, signal?: AbortSignal) => Promise<unknown>;

export type PaymentErrorCode =
  | 'invalid_config' | 'invalid_amount' | 'unsupported_payment' | 'policy_rejected'
  | 'allowance_required' | 'request_not_replayable' | 'payment_already_supplied'
  | 'request_aborted' | 'authorization_failed' | 'payment_unresolved' | 'budget_exceeded'
  | 'operation_conflict' | 'operation_in_progress' | 'operation_already_processed'
  | 'storage_unavailable';
export type PaymentState = 'not_attempted' | 'authorization_possible' | 'submitted_unknown';
export type OperationState = 'requesting' | 'signing' | 'submitted' | 'reported' | 'unknown' | 'settled' | 'unpaid';
export type ReceiptErrorReason =
  | 'provider_failure' | 'settlement_pending' | 'settlement_failed' | 'settlement_rejected'
  | 'settlement_timeout' | 'transaction_failed' | 'transaction_reverted' | 'transaction_not_found'
  | 'insufficient_funds' | 'insufficient_allowance' | 'invalid_signature' | 'invalid_nonce'
  | 'invalid_authorization' | 'authorization_expired' | 'payment_expired' | 'payment_required'
  | 'unsupported_network' | 'unsupported_scheme';
export interface SafeReceipt {
  success: boolean;
  network: string;
  transaction: '' | `0x${string}`;
  payer?: Address;
  amount?: AtomicAmount;
  errorReason?: ReceiptErrorReason;
}
export type ReceiptRead = { kind: 'missing' } | { kind: 'invalid' } | { kind: 'reported'; receipt: SafeReceipt };

export interface PaymentRequirements {
  scheme: PaymentScheme;
  network: BaseNetwork;
  asset: Address;
  amount: AtomicAmount;
  payTo: Address;
  maxTimeoutSeconds: number;
  extra: {
    assetTransferMethod: 'eip3009' | 'permit2';
    paymentFlow: 'authorization';
    name?: string;
    version?: string;
    facilitatorAddress?: Address;
  };
}
export interface PaymentTerms {
  maximumAtomic: AtomicAmount;
  requestFingerprint: string;
  payer: Address;
  network: BaseNetwork;
  asset: Address;
  payTo: Address;
  requirements: PaymentRequirements;
}
export type UnsignedAuthorization = {
  kind: 'eip3009';
  from: Address;
  to: Address;
  value: AtomicAmount;
  validAfter: string;
  validBefore: string;
  nonce: `0x${string}`;
  token: Address;
  chainId: string;
} | {
  kind: 'permit2';
  scheme: PaymentScheme;
  from: Address;
  permitted: { token: Address; amount: AtomicAmount };
  spender: Address;
  nonce: string;
  deadline: string;
  witness: { to: Address; validAfter: string; facilitator?: Address };
  token: Address;
  chainId: string;
};
export type FinalProof = {
  kind: 'settled';
  transactionHash: `0x${string}`;
  amountAtomic: AtomicAmount;
  finalizedBlockNumber: string;
  finalizedBlockHash: `0x${string}`;
} | {
  kind: 'unpaid';
  reason: 'no_authorization_created';
} | {
  kind: 'unpaid';
  reason: 'expired_nonce_unspent';
  finalizedBlockNumber: string;
  finalizedBlockHash: `0x${string}`;
};
export interface PaymentOperation extends AgentContext {
  requestFingerprint: string;
  targetOrigin: string;
  network: BaseNetwork;
  payer: Address;
  state: OperationState;
  terms?: PaymentTerms;
  authorization?: UnsignedAuthorization;
  report?: ReceiptRead;
  transactionHash?: `0x${string}`;
  finalAmountAtomic?: AtomicAmount;
  finalProof?: FinalProof;
  lastErrorCode?: PaymentErrorCode;
}

export interface BudgetStore {
  createBudget(input: BudgetInput): Promise<BudgetSnapshot>;
  getBudget(key: BudgetKey): Promise<BudgetSnapshot | null>;
  getOperation(key: OperationKey): Promise<PaymentOperation | null>;
}
export interface AgentPaymentsOptions {
  network: BaseNetwork;
  store: BudgetStore;
  policy: PaymentPolicy;
  resolveSigner(context: Readonly<AgentContext>): Promise<WalletSigner>;
  rpc: ReadRpc;
  fetch?: typeof globalThis.fetch;
}
export interface AgentPayments {
  fetch(context: AgentContext, input: RequestInfo | URL, init?: RequestInit): Promise<Response>;
  getOperation(key: OperationKey): Promise<PaymentOperation | null>;
  reconcile(key: OperationKey, transactionHash?: `0x${string}`): Promise<PaymentOperation>;
}
