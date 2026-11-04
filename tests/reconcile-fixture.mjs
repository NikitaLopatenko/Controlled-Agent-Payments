import assert from 'node:assert/strict';
import {
  decodeFunctionData, encodeAbiParameters, encodeEventTopics, encodeFunctionData,
  erc20Abi, parseAbi, parseSignature,
} from 'viem';
import { eip3009ABI, PERMIT2_ADDRESS, x402ExactPermit2ProxyABI, x402UptoPermit2ProxyABI } from '@x402/evm';
import { createAgentPayments } from '../packages/payments/dist/agent.js';
import { paymentFixture } from './payment-fixture.mjs';
import { decodeHeader, facilitator } from './protocol-fixture.mjs';

export const hash = byte => `0x${byte.repeat(32)}`;
export const hexQuantity = value => `0x${BigInt(value).toString(16)}`;
const nonceBitmapAbi = parseAbi(['function nonceBitmap(address owner, uint256 wordPos) view returns (uint256)']);

export function rawRpcModel(operation, signature, transactionHash, options = {}) {
  const authorization = operation.authorization;
  assert.ok(authorization);
  const expiry = BigInt(authorization.kind === 'eip3009' ? authorization.validBefore : authorization.deadline);
  const amount = options.amount ?? (authorization.kind === 'permit2' && authorization.scheme === 'upto' ? '1200' : operation.terms.maximumAtomic);
  let input, to;
  if (authorization.kind === 'eip3009') {
    const args = [authorization.from, authorization.to, BigInt(authorization.value), BigInt(authorization.validAfter),
      BigInt(authorization.validBefore), authorization.nonce];
    if (options.overload === 'vrs') {
      const { v, r, s } = parseSignature(signature);
      args.push(Number(v), r, s);
    } else args.push(signature);
    input = encodeFunctionData({ abi: eip3009ABI, functionName: 'transferWithAuthorization', args });
    to = authorization.token;
  } else {
    const permit = { permitted: { token: authorization.permitted.token, amount: BigInt(authorization.permitted.amount) },
      nonce: BigInt(authorization.nonce), deadline: BigInt(authorization.deadline) };
    const witness = { ...authorization.witness, validAfter: BigInt(authorization.witness.validAfter) };
    const upto = authorization.scheme === 'upto';
    input = encodeFunctionData({ abi: upto ? x402UptoPermit2ProxyABI : x402ExactPermit2ProxyABI,
      functionName: 'settle', args: upto ? [permit, BigInt(amount), authorization.from, witness, signature]
        : [permit, authorization.from, witness, signature] });
    to = authorization.spender;
  }
  const block = { number: '0x64', hash: hash('64'), timestamp: hexQuantity(expiry - 10n) };
  const finalized = { number: '0x66', hash: hash('66'), timestamp: hexQuantity(expiry + (options.expired ? 1n : -1n)) };
  const transfer = {
    address: authorization.token,
    topics: encodeEventTopics({ abi: erc20Abi, eventName: 'Transfer', args: { from: authorization.from, to: operation.terms.payTo } }),
    data: encodeAbiParameters([{ type: 'uint256' }], [BigInt(amount)]), removed: false,
  };
  const unusedCall = authorization.kind === 'eip3009'
    ? { to: authorization.token, data: encodeFunctionData({ abi: eip3009ABI, functionName: 'authorizationState', args: [authorization.from, authorization.nonce] }) }
    : { to: PERMIT2_ADDRESS.toLowerCase(), data: encodeFunctionData({ abi: nonceBitmapAbi, functionName: 'nonceBitmap',
      args: [authorization.from, BigInt(authorization.nonce) >> 8n] }) };
  const model = {
    operation, signature, amount, expiry, unusedCall, calls: [], finalizedReads: 0, anchorReads: 0,
    chainId: hexQuantity(authorization.chainId), finalized, canonicalFinalized: structuredClone(finalized),
    recheckedFinalized: structuredClone(finalized), canonicalBlock: block,
    transaction: { hash: transactionHash, from: facilitator, to, input, blockNumber: block.number, blockHash: block.hash },
    receipt: { transactionHash, blockNumber: block.number, blockHash: block.hash, status: '0x1', logs: [transfer] },
    unusedResult: authorization.kind === 'eip3009' ? encodeAbiParameters([{ type: 'bool' }], [false])
      : encodeAbiParameters([{ type: 'uint256' }], [0n]),
    candidateError: false, pinError: false,
    async rpc(request) {
      assert.ok(Object.isFrozen(request));
      assert.ok(Object.isFrozen(request.params));
      for (const param of request.params) if (param !== null && typeof param === 'object') assert.ok(Object.isFrozen(param));
      model.calls.push(structuredClone(request));
      const [first, second] = request.params;
      switch (request.method) {
        case 'eth_chainId': assert.deepEqual(request.params, []); return model.chainId;
        case 'eth_getBlockByNumber':
          assert.equal(second, false);
          if (first === 'finalized') { model.finalizedReads++; return model.finalized; }
          if (first === finalized.number) return ++model.anchorReads === 1 ? model.canonicalFinalized : model.recheckedFinalized;
          assert.equal(first, block.number);
          return model.canonicalBlock;
        case 'eth_getTransactionByHash':
          assert.equal(first, transactionHash);
          if (model.candidateError) throw new Error('private-candidate-rpc');
          return model.transaction;
        case 'eth_getTransactionReceipt': assert.equal(first, transactionHash); return model.receipt;
        case 'eth_call': {
          assert.deepEqual(first, unusedCall);
          assert.deepEqual(second, { blockHash: finalized.hash, requireCanonical: true });
          const decoded = decodeFunctionData({ abi: authorization.kind === 'eip3009' ? eip3009ABI : nonceBitmapAbi, data: first.data });
          assert.equal(decoded.functionName, authorization.kind === 'eip3009' ? 'authorizationState' : 'nonceBitmap');
          assert.equal(decoded.args[0].toLowerCase(), authorization.from);
          assert.equal(decoded.args[1], authorization.kind === 'eip3009' ? authorization.nonce : BigInt(authorization.nonce) >> 8n);
          if (model.pinError) throw new Error('RPC does not support requireCanonical blockHash.');
          return model.unusedResult;
        }
        default: assert.fail('Recovery must never use a wallet or mutating RPC method.');
      }
    },
    evidence() {
      return structuredClone({ chainId: model.chainId, finalized: model.finalized,
        canonicalFinalized: model.canonicalFinalized, recheckedFinalized: model.recheckedFinalized,
        settlement: { candidate: transactionHash, transaction: model.transaction, receipt: model.receipt, canonicalBlock: model.canonicalBlock } });
    },
  };
  return model;
}

export async function reconcileFixture(t, options = {}) {
  const fixture = await paymentFixture(t, options);
  let paymentError;
  try {
    const response = await createAgentPayments(fixture.config).fetch(fixture.key, fixture.url,
      { method: 'POST', body: 'fixture-input', headers: { 'content-type': 'text/plain' } });
    assert.equal(await response.text(), 'fixture-resource');
  } catch (error) { paymentError = error; }
  assert.equal(fixture.state.signatures, 1);
  assert.equal(fixture.state.verified, 1);
  const operation = await fixture.store.getOperation(fixture.key);
  const payload = decodeHeader(fixture.state.requests.find(request => request.paid).headers['payment-signature']);
  const model = rawRpcModel(operation, payload.payload.signature, fixture.transaction, options);
  return { ...fixture, operation, model, paymentError,
    recovery: { network: fixture.protocol.network, store: fixture.store, rpc: model.rpc } };
}
