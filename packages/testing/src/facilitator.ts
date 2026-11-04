// Adapted from UBB packages/node/src/testing/facilitator.ts (Apache-2.0); see NOTICE.
import { x402Facilitator } from '@x402/core/facilitator';
import type { FacilitatorClient } from '@x402/core/server';
import type { PaymentPayload, PaymentRequirements, SettleResponse, SupportedResponse, VerifyResponse } from '@x402/core/types';
import {
  authorizationTypes, eip3009ABI, PERMIT2_ADDRESS, permit2WitnessTypes, uptoPermit2WitnessTypes,
  x402ExactPermit2ProxyAddress, x402UptoPermit2ProxyAddress,
} from '@x402/evm';
import type { ExactEIP3009Payload, ExactPermit2Payload, FacilitatorEvmSigner } from '@x402/evm';
import { ExactEvmScheme } from '@x402/evm/exact/facilitator';
import { UptoEvmScheme } from '@x402/evm/upto/facilitator';
import type { ReadRpc, WalletSigner } from '@cap/payments';
import {
  decodeFunctionData, encodeAbiParameters, encodeEventTopics, encodeFunctionData, erc20Abi, isAddress,
  keccak256, parseAbi, serializeSignature, toBytes, verifyTypedData,
} from 'viem';
import type { Abi, Address, Hex, Log } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';

type ContractCall = { address: Address; abi: readonly unknown[]; functionName: string; args?: readonly unknown[] };
type Block = { number: bigint; hash: Hex; timestamp: bigint; used: Set<string> };
type Transaction = { hash: Hex; from: Address; to: Address; input: Hex; blockNumber: Hex; blockHash: Hex };
type Receipt = { transactionHash: Hex; status: '0x1'; blockNumber: Hex; blockHash: Hex;
  logs: { address: Address; topics: Hex[]; data: Hex; removed: false }[] };
type Transfer = { from: Address; to: Address; amount: bigint; maximum: bigint; nonce: string; expiry: bigint; permit: boolean };
type Permit = { permitted: { token: Address; amount: bigint }; nonce: bigint; deadline: bigint };
type Witness = { to: Address; validAfter: bigint; facilitator?: Address };
const network = 'eip155:84532' as const;
const token = '0x036cbd53842c5426634e7929541ec2318f3dcf7e' as Address;
const chainId = 84532;
const nonceBitmapAbi = parseAbi(['function nonceBitmap(address owner, uint256 wordPos) view returns (uint256)']);
const equal = (a: unknown, b: string): boolean => typeof a === 'string' && a.toLowerCase() === b.toLowerCase();
const reject = (): never => { throw new Error('Modeled payment rejected.'); };
const quantity = (value: bigint): Hex => `0x${value.toString(16)}`;
function address(value: unknown): Address {
  if (typeof value !== 'string' || !isAddress(value, { strict: false })) return reject();
  return value;
}
function uint(value: unknown): bigint {
  if ((typeof value !== 'bigint' && typeof value !== 'string') || !/^(0|[1-9][0-9]{0,77})$/.test(String(value))) return reject();
  const result = BigInt(value);
  if (result > (1n << 256n) - 1n) return reject();
  return result;
}
function word(value: unknown): Hex {
  if (typeof value !== 'string' || !/^0x[0-9a-fA-F]{64}$/.test(value)) return reject();
  return value as Hex;
}
function signature(value: unknown): Hex {
  if (typeof value !== 'string' || !/^0x[0-9a-fA-F]{130}$/.test(value)) return reject();
  return value as Hex;
}

export class SimulatedFacilitator implements FacilitatorClient {
  readonly network = network;
  readonly counters = { supported: 0, verify: 0, settle: 0, signerCalls: 0, signatures: 0, settlements: 0 };
  readonly charges: string[] = [];
  readonly payer: WalletSigner;
  readonly merchant: { readonly address: Address };
  readonly rpc: ReadRpc;
  lastTransactionHash?: Hex;
  #stopped = false;
  #balance = 1_000_000_000_000n;
  #merchantBalance = 0n;
  #allowance = 1_000_000_000_000n;
  #used = new Set<string>();
  #blocks = new Map<bigint, Block>();
  #transactions = new Map<Hex, Transaction>();
  #receipts = new Map<Hex, Receipt>();
  #completed = new Map<string, { requirements: string; result: SettleResponse }>();
  #inflight = new Map<string, { requirements: string; result: Promise<SettleResponse> }>();
  #finalized: Block;
  #upstream: x402Facilitator;
  #facilitator: Address;

  constructor() {
    const payer = privateKeyToAccount(`0x${'1'.padStart(64, '0')}`);
    this.merchant = Object.freeze({ address: privateKeyToAccount(`0x${'2'.padStart(64, '0')}`).address });
    this.#facilitator = privateKeyToAccount(`0x${'3'.padStart(64, '0')}`).address;
    this.payer = Object.freeze({
      address: payer.address,
      signTypedData: async (data: Parameters<WalletSigner['signTypedData']>[0]) => {
        this.#active();
        this.counters.signerCalls++;
        const result = await payer.signTypedData(data as Parameters<typeof payer.signTypedData>[0]);
        this.#active();
        this.counters.signatures++;
        return result;
      },
    });
    this.#finalized = this.#mine(BigInt(Math.floor(Date.now() / 1000)));
    this.rpc = async (request, signal) => {
      this.#active();
      if (signal?.aborted) return reject();
      const [first, second] = request.params;
      switch (request.method) {
        case 'eth_chainId':
          if (request.params.length !== 0) return reject();
          return quantity(BigInt(chainId));
        case 'eth_getBlockByNumber': {
          if (second !== false || request.params.length !== 2) return reject();
          const block = first === 'finalized' ? this.#finalized :
            typeof first === 'string' && /^0x(?:0|[1-9a-f][0-9a-f]*)$/.test(first) ? this.#blocks.get(BigInt(first)) : undefined;
          return block ? { number: quantity(block.number), hash: block.hash, timestamp: quantity(block.timestamp) } : null;
        }
        case 'eth_getTransactionByHash': return structuredClone(this.#transactions.get(word(first)) ?? null);
        case 'eth_getTransactionReceipt': return structuredClone(this.#receipts.get(word(first)) ?? null);
        case 'eth_call': {
          if (!first || typeof first !== 'object' || request.params.length !== 2) return reject();
          const call = first as { to?: unknown; data?: unknown };
          const target = address(call.to);
          if (typeof call.data !== 'string' || !/^0x(?:[0-9a-fA-F]{2})+$/.test(call.data)) return reject();
          let block: Block | undefined;
          if (second !== 'latest') {
            if (!second || typeof second !== 'object' || !('blockHash' in second) ||
              !('requireCanonical' in second) || second.requireCanonical !== true) return reject();
            block = [...this.#blocks.values()].find(candidate => candidate.hash === second.blockHash);
            if (!block || this.#blocks.get(block.number)?.hash !== block.hash) return reject();
          }
          const abi = equal(target, PERMIT2_ADDRESS) ? nonceBitmapAbi : equal(target, token) ? [...erc20Abi, ...eip3009ABI] : reject();
          const decoded = decodeFunctionData({ abi, data: call.data as Hex });
          if (!['allowance', 'authorizationState', 'nonceBitmap'].includes(decoded.functionName)) return reject();
          if (decoded.functionName !== 'allowance' && !block) return reject();
          const value = await this.#read({ address: target, abi, functionName: decoded.functionName, args: decoded.args }, block);
          this.#active();
          if (signal?.aborted) return reject();
          return typeof value === 'boolean' ? encodeAbiParameters([{ type: 'bool' }], [value]) :
            typeof value === 'bigint' ? encodeAbiParameters([{ type: 'uint256' }], [value]) : reject();
        }
        default: return reject();
      }
    };
    const facade: FacilitatorEvmSigner = {
      getAddresses: () => { this.#active(); return [this.#facilitator]; },
      getCode: async ({ address: target }) => {
        this.#active();
        return [token, PERMIT2_ADDRESS, x402ExactPermit2ProxyAddress, x402UptoPermit2ProxyAddress]
          .some(candidate => equal(target, candidate)) ? '0x01' : '0x';
      },
      verifyTypedData: async args => {
        this.#active();
        const result = await verifyTypedData(args as Parameters<typeof verifyTypedData>[0]);
        this.#active();
        return result;
      },
      readContract: args => this.#read(args),
      writeContract: args => this.#write(args),
      sendTransaction: async () => reject(),
      waitForTransactionReceipt: async ({ hash }) => {
        this.#active();
        const receipt = this.#receipts.get(hash);
        if (!receipt) return reject();
        const logs: Log[] = receipt.logs.map((log, logIndex) => ({ ...log, logIndex,
          blockHash: receipt.blockHash, blockNumber: BigInt(receipt.blockNumber), transactionHash: hash,
          transactionIndex: 0, topics: [...log.topics] as [Hex, ...Hex[]] }));
        return { status: 'success', logs };
      },
    };
    this.#upstream = new x402Facilitator().register(network, new ExactEvmScheme(facade, { simulateInSettle: true }))
      .register(network, new UptoEvmScheme(facade));
  }

  stop(): void { this.#stopped = true; }
  #active(): void { if (this.#stopped) reject(); }
  setFinalizedTimestamp(timestamp: bigint): void {
    this.#active();
    if (typeof timestamp !== 'bigint' || timestamp < this.#finalized.timestamp || timestamp > (1n << 64n) - 1n) reject();
    this.#finalized = this.#mine(timestamp);
  }
  async getSupported(): Promise<SupportedResponse> {
    this.#active();
    this.counters.supported++;
    const supported = this.#upstream.getSupported();
    return { ...supported, kinds: supported.kinds.map(kind => ({ ...kind, network })) };
  }
  async verify(payload: PaymentPayload, requirements: PaymentRequirements): Promise<VerifyResponse> {
    this.#active();
    this.counters.verify++;
    try {
      this.#validate(payload, requirements, false);
      const result = await this.#upstream.verify(payload, requirements);
      this.#active();
      return { isValid: result.isValid, ...(result.payer ? { payer: result.payer } : {}),
        ...(!result.isValid ? { invalidReason: 'modeled_payment_rejected' } : {}) };
    } catch { return { isValid: false, invalidReason: 'modeled_payment_rejected' }; }
  }
  async settle(payload: PaymentPayload, requirements: PaymentRequirements): Promise<SettleResponse> {
    this.#active();
    this.counters.settle++;
    const failed = (): SettleResponse => ({ success: false, transaction: '', network, errorReason: 'modeled_payment_rejected' });
    try {
      this.#validate(payload, requirements, true);
      const key = keccak256(toBytes(JSON.stringify(payload))), terms = JSON.stringify(requirements);
      const completed = this.#completed.get(key);
      if (completed) return completed.requirements === terms ? structuredClone(completed.result) : failed();
      const pending = this.#inflight.get(key);
      if (pending) return pending.requirements === terms ? structuredClone(await pending.result) : failed();
      const work = this.#upstream.settle(payload, requirements).then(result => {
        this.#active();
        const safe: SettleResponse = { success: result.success, transaction: result.transaction, network,
          ...(result.payer ? { payer: result.payer } : {}),
          ...(result.amount !== undefined ? { amount: result.amount } : result.success ? { amount: requirements.amount } : {}),
          ...(!result.success ? { errorReason: 'modeled_payment_rejected' } : {}) };
        if (safe.success) this.#completed.set(key, { requirements: terms, result: structuredClone(safe) });
        return safe;
      });
      this.#inflight.set(key, { requirements: terms, result: work });
      try { return await work; } finally { this.#inflight.delete(key); }
    } catch { return failed(); }
  }

  #validate(payload: PaymentPayload, requirements: PaymentRequirements, settling: boolean): void {
    if (payload.x402Version !== 2 || requirements.network !== network || payload.accepted.network !== network ||
      !['exact', 'upto'].includes(requirements.scheme) || payload.accepted.scheme !== requirements.scheme ||
      !equal(requirements.asset, token) || !equal(payload.accepted.asset, token) ||
      !equal(payload.accepted.payTo, requirements.payTo) || !equal(requirements.payTo, this.merchant.address) ||
      !Number.isInteger(requirements.maxTimeoutSeconds) || requirements.maxTimeoutSeconds < 1 || requirements.maxTimeoutSeconds > 300 ||
      (requirements.extra.paymentFlow !== undefined && requirements.extra.paymentFlow !== 'authorization') ||
      Object.keys(payload.extensions ?? {}).length > 0) reject();
    if (payload.accepted.maxTimeoutSeconds !== requirements.maxTimeoutSeconds ||
      ['paymentFlow', 'assetTransferMethod', 'name', 'version', 'facilitatorAddress'].some(
        field => payload.accepted.extra[field] !== requirements.extra[field])) reject();
    const method = requirements.extra.assetTransferMethod ?? (requirements.scheme === 'upto' ? 'permit2' : 'eip3009');
    if ((method !== 'eip3009' && method !== 'permit2') || (requirements.scheme === 'upto' && method !== 'permit2')) reject();
    const offered = uint(payload.accepted.amount), actual = uint(requirements.amount);
    if (offered === 0n || actual === 0n || (settling && requirements.scheme === 'upto' ? actual > offered : actual !== offered)) reject();
    const signedAmount = method === 'permit2' ? (payload.payload as ExactPermit2Payload).permit2Authorization.permitted.amount :
      (payload.payload as ExactEIP3009Payload).authorization.value;
    if (uint(signedAmount) !== offered) reject();
    if (method === 'eip3009' && (requirements.extra.name !== 'USDC' || requirements.extra.version !== '2')) reject();
    if (requirements.scheme === 'upto' && !equal(requirements.extra.facilitatorAddress, this.#facilitator)) reject();
  }
  #mine(timestamp: bigint): Block {
    const number = BigInt(this.#blocks.size + 1);
    const block = { number, hash: keccak256(toBytes(`cap-modeled-block-${number}-${timestamp}`)), timestamp, used: new Set(this.#used) };
    this.#blocks.set(number, block);
    return block;
  }
  #nonce(permit: boolean, from: Address, nonce: string): string {
    return `${permit ? 'permit2' : 'eip3009'}:${from.toLowerCase()}:${nonce.toLowerCase()}`;
  }
  #available(transfer: Transfer): void {
    this.#active();
    if (!equal(transfer.from, this.payer.address) || !equal(transfer.to, this.merchant.address) ||
      transfer.amount > transfer.maximum || this.#balance < transfer.amount ||
      (transfer.permit && this.#allowance < transfer.amount) ||
      this.#used.has(this.#nonce(transfer.permit, transfer.from, transfer.nonce)) ||
      transfer.expiry <= this.#finalized.timestamp) reject();
    uint(this.#merchantBalance + transfer.amount);
  }
  async #transfer(call: ContractCall): Promise<Transfer> {
    this.#active();
    const args = call.args ?? [], now = this.#finalized.timestamp;
    if (call.functionName === 'transferWithAuthorization' && equal(call.address, token)) {
      if (args.length !== 7 && args.length !== 9) return reject();
      const from = address(args[0]), to = address(args[1]), amount = uint(args[2]);
      const validAfter = uint(args[3]), expiry = uint(args[4]), nonce = word(args[5]);
      const sig = args.length === 7 ? signature(args[6]) : serializeSignature({
        v: BigInt(args[6] as number), r: word(args[7]), s: word(args[8]),
      });
      if (validAfter > now || expiry <= now || !await verifyTypedData({ address: from, types: authorizationTypes,
        primaryType: 'TransferWithAuthorization', domain: { name: 'USDC', version: '2', chainId, verifyingContract: token },
        message: { from, to, value: amount, validAfter, validBefore: expiry, nonce }, signature: sig })) reject();
      const transfer = { from, to, amount, maximum: amount, nonce, expiry, permit: false };
      this.#available(transfer);
      return transfer;
    }
    const upto = equal(call.address, x402UptoPermit2ProxyAddress);
    if (call.functionName !== 'settle' || (!upto && !equal(call.address, x402ExactPermit2ProxyAddress)) ||
      args.length !== (upto ? 5 : 4)) return reject();
    const permit = args[0] as Permit, owner = address(args[upto ? 2 : 1]), witness = args[upto ? 3 : 2] as Witness;
    const sig = signature(args[upto ? 4 : 3]);
    const maximum = uint(permit.permitted.amount), amount = upto ? uint(args[1]) : maximum;
    const nonce = uint(permit.nonce), expiry = uint(permit.deadline), to = address(witness.to), validAfter = uint(witness.validAfter);
    if (!equal(permit.permitted.token, token) || validAfter > now || expiry <= now ||
      (upto && !equal(witness.facilitator, this.#facilitator))) reject();
    const message = { permitted: { token, amount: maximum }, spender: call.address, nonce, deadline: expiry,
      witness: upto ? { to, validAfter, facilitator: address(witness.facilitator) } : { to, validAfter } };
    if (!await verifyTypedData({ address: owner, types: upto ? uptoPermit2WitnessTypes : permit2WitnessTypes,
      primaryType: 'PermitWitnessTransferFrom', domain: { name: 'Permit2', chainId, verifyingContract: PERMIT2_ADDRESS },
      message, signature: sig } as Parameters<typeof verifyTypedData>[0])) reject();
    const transfer = { from: owner, to, amount, maximum, nonce: nonce.toString(), expiry, permit: true };
    this.#available(transfer);
    return transfer;
  }
  async #read(call: ContractCall, block?: Block): Promise<unknown> {
    this.#active();
    const args = call.args ?? [], used = block?.used ?? this.#used;
    if (equal(call.address, token)) {
      if (call.functionName === 'balanceOf') return equal(args[0], this.payer.address) ? this.#balance :
        equal(args[0], this.merchant.address) ? this.#merchantBalance : 0n;
      if (call.functionName === 'allowance') return equal(args[0], this.payer.address) && equal(args[1], PERMIT2_ADDRESS) ? this.#allowance : 0n;
      if (call.functionName === 'authorizationState') return used.has(this.#nonce(false, address(args[0]), word(args[1])));
    }
    if (equal(call.address, PERMIT2_ADDRESS) && call.functionName === 'nonceBitmap') {
      const owner = address(args[0]), wordPos = uint(args[1]);
      let bitmap = 0n;
      for (let bit = 0n; bit < 256n; bit++) {
        if (used.has(this.#nonce(true, owner, ((wordPos << 8n) + bit).toString()))) bitmap |= 1n << bit;
      }
      return bitmap;
    }
    if (call.functionName === 'PERMIT2' && [x402ExactPermit2ProxyAddress, x402UptoPermit2ProxyAddress].some(a => equal(call.address, a))) return PERMIT2_ADDRESS;
    if (block) return reject();
    await this.#transfer(call);
    this.#active();
    return undefined;
  }
  async #write(call: ContractCall & { args: readonly unknown[] }): Promise<Hex> {
    const transfer = await this.#transfer(call);
    this.#available(transfer);
    const input = encodeFunctionData({ abi: call.abi as Abi, functionName: call.functionName, args: call.args });
    const hash = keccak256(toBytes(`cap-modeled-transaction-${this.counters.settlements + 1}-${input}`));
    const topics = encodeEventTopics({ abi: erc20Abi, eventName: 'Transfer', args: { from: transfer.from, to: transfer.to } }) as Hex[];
    const data = encodeAbiParameters([{ type: 'uint256' }], [transfer.amount]);
    this.#balance -= transfer.amount;
    this.#merchantBalance += transfer.amount;
    if (transfer.permit) this.#allowance -= transfer.amount;
    this.#used.add(this.#nonce(transfer.permit, transfer.from, transfer.nonce));
    this.#finalized = this.#mine(this.#finalized.timestamp);
    const { number, hash: blockHash } = this.#finalized, blockNumber = quantity(number);
    this.#transactions.set(hash, { hash, from: this.#facilitator, to: call.address, input, blockNumber, blockHash });
    this.#receipts.set(hash, { transactionHash: hash, status: '0x1', blockNumber, blockHash,
      logs: [{ address: token, topics, data, removed: false }] });
    this.counters.settlements++;
    this.charges.push(transfer.amount.toString());
    this.lastTransactionHash = hash;
    return hash;
  }
}
