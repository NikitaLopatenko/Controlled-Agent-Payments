import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { decodeFunctionData, encodeAbiParameters, serializeSignature, verifyTypedData } from 'viem';
import { privateKeyToAddress, signTypedData } from 'viem/accounts';
import {
  authorizationTypes, permit2WitnessTypes, uptoPermit2WitnessTypes,
  PERMIT2_ADDRESS, x402ExactPermit2ProxyAddress, x402UptoPermit2ProxyAddress,
} from '@x402/evm';
import { ExactEvmScheme } from '@x402/evm/exact/facilitator';
import { UptoEvmScheme } from '@x402/evm/upto/facilitator';

export const native = createRequire(import.meta.url)('../packages/payments/native/cap-native.darwin-arm64.node');
const fixturePrivateKey = `0x${'0'.repeat(63)}1`;
export const payer = privateKeyToAddress(fixturePrivateKey).toLowerCase();
export const merchant = '0x2222222222222222222222222222222222222222';
export const facilitator = '0x3333333333333333333333333333333333333333';
export const origin = 'https://merchant.example';
export const modes = ['exact/eip3009', 'exact/permit2', 'upto/permit2'];
export const networks = {
  'eip155:8453': { chainId: 8453, asset: '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913', name: 'USD Coin', version: '2' },
  'eip155:84532': { chainId: 84532, asset: '0x036cbd53842c5426634e7929541ec2318f3dcf7e', name: 'USDC', version: '2' },
};
export const fixtureSigner = Object.freeze({
  address: payer,
  signTypedData: request => signTypedData({ ...request, privateKey: fixturePrivateKey }),
});
export const uint256Result = amount => JSON.stringify(encodeAbiParameters([{ type: 'uint256' }], [BigInt(amount)]));
export const encodeHeader = value => Buffer.from(JSON.stringify(value), 'utf8').toString('base64');
export const decodeHeader = header => JSON.parse(Buffer.from(header, 'base64').toString('utf8'));

export function expectNativeCode(code, ...forbidden) {
  return error => {
    assert.ok(error instanceof Error);
    assert.equal(error.message, code);
    assert.equal(Object.hasOwn(error, 'cause'), false);
    const captured = JSON.stringify({ ...error, message: error.message });
    for (const secret of [fixturePrivateKey, ...forbidden]) assert.equal(captured.includes(secret), false);
    return true;
  };
}

export function createNativeOperation({ budget: budgetOverrides = {}, start: startOverrides = {} } = {}) {
  const budget = JSON.parse(native.normalizeBudget(JSON.stringify({
    ownerId: 'protocol-owner', budgetId: 'protocol-budget', network: 'eip155:84532', payer,
    limitAtomic: '10000', ...budgetOverrides,
  })));
  const operation = JSON.parse(native.newOperation(JSON.stringify(budget), JSON.stringify({
    ownerId: budget.ownerId, budgetId: budget.budgetId, agentId: 'protocol-agent', operationId: 'protocol-purchase',
    requestFingerprint: 'a'.repeat(64), targetOrigin: origin, ...startOverrides,
  })));
  return { budget, operation };
}

export function protocolFixture(mode = 'exact/eip3009', network = 'eip155:84532') {
  assert.ok(modes.includes(mode));
  const [scheme, assetTransferMethod] = mode.split('/');
  const config = networks[network];
  const { budget, operation } = createNativeOperation({ budget: { network } });
  const requirements = {
    scheme, network, asset: config.asset, amount: scheme === 'upto' ? '7000' : '1000', payTo: merchant,
    maxTimeoutSeconds: 300,
    extra: {
      assetTransferMethod, paymentFlow: 'authorization', name: config.name, version: config.version,
      ...(scheme === 'upto' ? { facilitatorAddress: facilitator } : {}),
      sellerReference: { invoice: 'fixture-invoice', decimal: '123456789012345678901234567890' },
    },
    sellerExtension: { opaque: ['retained', { amount: '1000000000000000000000000000001' }] },
  };
  const challenge = {
    x402Version: 2,
    resource: { url: `${origin}/purchase?item=fixture`, description: 'Protocol interoperability fixture', mimeType: 'application/json' },
    accepts: [requirements],
    extensions: { 'advertised-only': { info: { enabled: true } } },
  };
  const policy = { maxPerPaymentAtomic: '7000', allowedSchemes: ['exact', 'upto'], merchants: [{ origin, payTo: merchant }] };
  const prepare = (value = challenge, selectedPolicy = policy, selectedOperation = operation) =>
    native.preparePayment(encodeHeader(value), JSON.stringify(selectedOperation), JSON.stringify(selectedPolicy));
  return { mode, network, config, budget, operation, requirements, challenge, policy, prepare };
}

export function independentTypedData(payload, requirements) {
  const config = networks[requirements.network];
  if (requirements.extra.assetTransferMethod === 'eip3009') {
    const authorization = payload.payload.authorization;
    return {
      domain: { name: config.name, version: config.version, chainId: config.chainId, verifyingContract: config.asset },
      types: authorizationTypes, primaryType: 'TransferWithAuthorization',
      message: {
        from: authorization.from, to: authorization.to, value: authorization.value,
        validAfter: authorization.validAfter, validBefore: authorization.validBefore, nonce: authorization.nonce,
      },
    };
  }
  const authorization = payload.payload.permit2Authorization;
  const upto = requirements.scheme === 'upto';
  return {
    domain: { name: 'Permit2', chainId: config.chainId, verifyingContract: PERMIT2_ADDRESS.toLowerCase() },
    types: upto ? uptoPermit2WitnessTypes : permit2WitnessTypes, primaryType: 'PermitWitnessTransferFrom',
    message: {
      permitted: { token: authorization.permitted.token, amount: authorization.permitted.amount },
      spender: (upto ? x402UptoPermit2ProxyAddress : x402ExactPermit2ProxyAddress).toLowerCase(),
      nonce: authorization.nonce, deadline: authorization.deadline,
      witness: {
        to: authorization.witness.to,
        ...(upto ? { facilitator: authorization.witness.facilitator } : {}),
        validAfter: authorization.witness.validAfter,
      },
    },
  };
}

export function assertAllowanceRequest(prepared, fixture) {
  const request = JSON.parse(prepared.allowanceRequest());
  assert.equal(request.method, 'eth_call');
  assert.equal(request.params.length, 2);
  assert.equal(request.params[0].to.toLowerCase(), fixture.config.asset);
  assert.equal(request.params[1], 'latest');
  const call = decodeFunctionData({
    abi: [{ type: 'function', name: 'allowance', stateMutability: 'view', inputs: [{ type: 'address' }, { type: 'address' }], outputs: [{ type: 'uint256' }] }],
    data: request.params[0].data,
  });
  assert.equal(call.functionName, 'allowance');
  assert.deepEqual(call.args.map(address => address.toLowerCase()), [payer, PERMIT2_ADDRESS.toLowerCase()]);
  assert.equal(prepared.checkAllowance(uint256Result(fixture.requirements.amount)), undefined);
}

export function facilitatorVerifier(fixture) {
  let simulations = 0;
  const { config, requirements } = fixture;
  const equal = (a, b) => typeof a === 'string' && typeof b === 'string' && a.toLowerCase() === b.toLowerCase();
  const facade = {
    getAddresses: () => [facilitator],
    async getCode({ address }) {
      if (equal(address, payer)) return '0x';
      assert.ok([config.asset, PERMIT2_ADDRESS, x402ExactPermit2ProxyAddress, x402UptoPermit2ProxyAddress].some(known => equal(address, known)));
      return '0x01';
    },
    verifyTypedData: request => verifyTypedData(request),
    async readContract(call) {
      const args = call.args;
      let typed, signature, from, to, maximum, validAfter, expiry;
      if (equal(call.address, config.asset) && call.functionName === 'transferWithAuthorization') {
        assert.ok(args.length === 7 || args.length === 9);
        [from, to, maximum, validAfter, expiry] = args;
        signature = args.length === 7 ? args[6] : serializeSignature({ v: BigInt(args[6]), r: args[7], s: args[8] });
        typed = {
          domain: { name: config.name, version: config.version, chainId: config.chainId, verifyingContract: config.asset },
          types: authorizationTypes, primaryType: 'TransferWithAuthorization',
          message: { from, to, value: maximum, validAfter, validBefore: expiry, nonce: args[5] },
        };
      } else {
        const upto = requirements.scheme === 'upto';
        const proxy = upto ? x402UptoPermit2ProxyAddress : x402ExactPermit2ProxyAddress;
        assert.ok(equal(call.address, proxy));
        assert.equal(call.functionName, 'settle');
        assert.equal(args.length, upto ? 5 : 4);
        const permit = args[0];
        const witness = args[upto ? 3 : 2];
        from = args[upto ? 2 : 1];
        signature = args[upto ? 4 : 3];
        to = witness.to;
        maximum = permit.permitted.amount;
        validAfter = witness.validAfter;
        expiry = permit.deadline;
        assert.ok(equal(permit.permitted.token, config.asset));
        if (upto) {
          assert.ok(equal(witness.facilitator, facilitator));
          assert.equal(BigInt(args[1]), BigInt(requirements.amount));
        }
        typed = {
          domain: { name: 'Permit2', chainId: config.chainId, verifyingContract: PERMIT2_ADDRESS },
          types: upto ? uptoPermit2WitnessTypes : permit2WitnessTypes, primaryType: 'PermitWitnessTransferFrom',
          message: { permitted: permit.permitted, spender: proxy, nonce: permit.nonce, deadline: expiry, witness },
        };
      }
      assert.ok(equal(from, payer));
      assert.ok(equal(to, requirements.payTo));
      assert.equal(BigInt(maximum), BigInt(requirements.amount));
      const now = BigInt(Math.floor(Date.now() / 1000));
      assert.ok(BigInt(validAfter) <= now && BigInt(expiry) > now);
      assert.equal(await verifyTypedData({ ...typed, address: payer, signature }), true);
      simulations += 1;
      return undefined;
    },
  };
  const scheme = requirements.scheme === 'upto' ? new UptoEvmScheme(facade) : new ExactEvmScheme(facade);
  return { verify: (payload, selected = requirements) => scheme.verify(payload, selected), get simulations() { return simulations; } };
}
