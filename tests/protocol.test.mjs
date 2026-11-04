import assert from 'node:assert/strict';
import test from 'node:test';
import { hashTypedData, verifyTypedData } from 'viem';
import { PERMIT2_ADDRESS, x402ExactPermit2ProxyAddress, x402UptoPermit2ProxyAddress } from '@x402/evm';
import {
  native, modes, networks, payer, merchant, facilitator, fixtureSigner,
  protocolFixture, createNativeOperation, encodeHeader, decodeHeader,
  uint256Result, expectNativeCode, independentTypedData, assertAllowanceRequest, facilitatorVerifier,
} from './protocol-fixture.mjs';

const begin = (fixture, prepared, budget = fixture.budget, operation = fixture.operation) =>
  JSON.parse(native.beginSigning(JSON.stringify(budget), JSON.stringify(operation), prepared));
const clone = value => structuredClone(value);

for (const network of Object.keys(networks)) {
  for (const mode of modes) {
    test(`${network} ${mode}: native Alloy digest and payload interoperate with viem and upstream facilitator`, async () => {
      const fixture = protocolFixture(mode, network);
      const prepared = fixture.prepare();
      const terms = JSON.parse(prepared.terms());
      const authorization = JSON.parse(prepared.authorization());
      const typedData = JSON.parse(prepared.typedData());
      const before = Math.floor(Date.now() / 1000);
      assert.equal(terms.maximumAtomic, fixture.requirements.amount);
      assert.equal(terms.requestFingerprint, fixture.operation.requestFingerprint);
      assert.equal(terms.payer, payer);
      assert.equal(terms.network, network);
      assert.equal(terms.asset, fixture.config.asset);
      assert.equal(terms.payTo, merchant);
      assert.equal(terms.requirements.amount, fixture.requirements.amount);
      assert.equal(Object.hasOwn(terms.requirements, 'sellerExtension'), false);
      assert.equal(Object.hasOwn(terms.requirements.extra, 'sellerReference'), false);
      assert.equal(authorization.from, payer);
      assert.equal(authorization.token, fixture.config.asset);
      assert.equal(authorization.chainId, String(fixture.config.chainId));
      assert.equal(typedData.domain.chainId, fixture.config.chainId);
      assert.equal(typeof typedData.domain.chainId, 'number');
      if (mode === 'exact/eip3009') {
        assert.equal(authorization.kind, 'eip3009');
        assert.equal(authorization.value, fixture.requirements.amount);
        assert.equal(authorization.to, merchant);
        assert.equal(authorization.validAfter, '0');
        assert.match(authorization.nonce, /^0x[0-9a-f]{64}$/);
        assert.equal(prepared.allowanceRequest(), null);
      } else {
        assert.equal(authorization.kind, 'permit2');
        assert.equal(authorization.scheme, fixture.requirements.scheme);
        assert.equal(authorization.permitted.amount, fixture.requirements.amount);
        assert.equal(authorization.permitted.token, fixture.config.asset);
        assert.equal(authorization.witness.to, merchant);
        assert.equal(authorization.witness.validAfter, '0');
        assert.match(authorization.nonce, /^(0|[1-9][0-9]*)$/);
        assert.ok(BigInt(authorization.nonce) < 2n ** 256n);
        const upto = mode === 'upto/permit2';
        assert.equal(authorization.spender, (upto ? x402UptoPermit2ProxyAddress : x402ExactPermit2ProxyAddress).toLowerCase());
        assert.equal(authorization.witness.facilitator, upto ? facilitator : undefined);
        assertAllowanceRequest(prepared, fixture);
      }
      const expiry = authorization.validBefore ?? authorization.deadline;
      assert.match(expiry, /^(0|[1-9][0-9]*)$/);
      assert.ok(BigInt(expiry) >= BigInt(before + 295));
      assert.ok(BigInt(expiry) <= BigInt(before + 300));

      const persisted = begin(fixture, prepared);
      assert.equal(persisted.operation.state, 'signing');
      assert.equal(persisted.budget.heldAtomic, fixture.requirements.amount);
      assert.equal(persisted.budget.spentAtomic, '0');
      const signature = await fixtureSigner.signTypedData(typedData);
      const header = prepared.encode(signature);
      assert.ok(Buffer.byteLength(header) <= 16 * 1024);
      const payload = decodeHeader(header);
      assert.equal(payload.x402Version, 2);
      assert.deepEqual(payload.resource, fixture.challenge.resource);
      assert.deepEqual(payload.accepted, fixture.requirements);
      assert.equal(typeof payload.accepted.amount, 'string');
      assert.equal(payload.accepted.extra.sellerReference.decimal, '123456789012345678901234567890');
      assert.equal(Object.hasOwn(payload, 'extensions'), false);
      assert.equal(payload.payload.signature, signature);
      const independent = independentTypedData(payload, fixture.requirements);
      assert.equal(hashTypedData(typedData), prepared.signingHash());
      assert.equal(hashTypedData(independent), prepared.signingHash());
      assert.equal(await verifyTypedData({ ...independent, address: payer, signature }), true);
      assert.equal(await verifyTypedData({ ...independent, domain: { ...independent.domain, chainId: 1 }, address: payer, signature }), false);
      const verifier = facilitatorVerifier(fixture);
      const verified = await verifier.verify(payload);
      assert.equal(verified.isValid, true);
      assert.equal(verified.payer.toLowerCase(), payer);
      assert.equal(verifier.simulations, 1);
      const wrongPayee = clone(payload);
      if (mode === 'exact/eip3009') wrongPayee.payload.authorization.to = facilitator;
      else wrongPayee.payload.permit2Authorization.witness.to = facilitator;
      assert.equal((await verifier.verify(wrongPayee)).isValid, false);
      const wrongSignature = clone(payload);
      wrongSignature.payload.signature = `0x${'11'.repeat(65)}`;
      assert.equal((await verifier.verify(wrongSignature)).isValid, false);
      assert.equal((await verifier.verify(payload, { ...fixture.requirements, amount: '999' })).isValid, false);
      if (mode === 'upto/permit2') {
        const wrongFacilitator = clone(payload);
        wrongFacilitator.payload.permit2Authorization.witness.facilitator = merchant;
        assert.equal((await verifier.verify(wrongFacilitator)).isValid, false);
      }
      assert.equal(verifier.simulations, 1);
      assert.equal(JSON.stringify(persisted).includes(signature), false);
    });
  }
}

for (const mode of modes) {
  test(`${mode}: returned typed data and caller-owned challenge/policy cannot mutate captured authorization`, async () => {
    const fixture = protocolFixture(mode);
    const originalChallenge = clone(fixture.challenge);
    const prepared = fixture.prepare();
    if (mode !== 'exact/eip3009') assertAllowanceRequest(prepared, fixture);
    const typed = JSON.parse(prepared.typedData());
    const captured = clone(typed);
    const authorization = JSON.parse(prepared.authorization());
    const terms = JSON.parse(prepared.terms());
    fixture.challenge.accepts[0].amount = '1';
    fixture.challenge.accepts[0].payTo = facilitator;
    fixture.challenge.accepts[0].extra.name = 'untrusted-domain';
    fixture.policy.maxPerPaymentAtomic = '999999';
    fixture.policy.merchants[0].payTo = facilitator;
    fixture.operation.requestFingerprint = 'b'.repeat(64);
    typed.domain.chainId = 1;
    typed.domain.name = 'untrusted-domain';
    typed.types[typed.primaryType][0].type = 'bytes32';
    if (mode === 'exact/eip3009') typed.message.value = '1';
    else {
      typed.message.permitted.amount = '1';
      typed.message.witness.to = facilitator;
    }
    assert.deepEqual(JSON.parse(prepared.typedData()), captured);
    assert.deepEqual(JSON.parse(prepared.authorization()), authorization);
    assert.deepEqual(JSON.parse(prepared.terms()), terms);
    const signature = await fixtureSigner.signTypedData(captured);
    const payload = decodeHeader(prepared.encode(signature));
    assert.deepEqual(payload.accepted, originalChallenge.accepts[0]);
    assert.equal(hashTypedData(independentTypedData(payload, originalChallenge.accepts[0])), prepared.signingHash());
    assert.equal(await verifyTypedData({ ...independentTypedData(payload, originalChallenge.accepts[0]), address: payer, signature }), true);
    assert.throws(() => begin(fixture, prepared), expectNativeCode('operation_conflict'));
  });
}

for (const mode of ['exact/permit2', 'upto/permit2']) {
  test(`${mode}: native allowance consumes ABI bytes, rejects low/error/malformed reads`, () => {
    const fixture = protocolFixture(mode);
    const prepared = fixture.prepare();
    assert.throws(() => begin(fixture, prepared), expectNativeCode('allowance_required'));
    assertAllowanceRequest(prepared, fixture);
    assert.equal(prepared.checkAllowance(uint256Result(2n ** 256n - 1n)), undefined);
    for (const raw of [uint256Result(BigInt(fixture.requirements.amount) - 1n), uint256Result(0),
      JSON.stringify(null), JSON.stringify(7000), JSON.stringify('7000'), JSON.stringify('0x'),
      JSON.stringify('0x01'), JSON.stringify(`0x${'00'.repeat(33)}`),
      JSON.stringify(`0x${'gg'.repeat(32)}`), JSON.stringify({ error: { message: 'rpc-credential' } }),
      '{', '['.repeat(150) + ']'.repeat(150), ' '.repeat(1024 * 1024 + 1)]) {
      assert.throws(() => prepared.checkAllowance(raw), expectNativeCode('allowance_required', 'rpc-credential'));
      assert.throws(() => begin(fixture, prepared), expectNativeCode('allowance_required'));
    }
    assert.equal(fixture.operation.state, 'requesting');
    assert.equal(fixture.budget.heldAtomic, '0');
  });
}

test('native selection preserves server order and accepted unknown fields without persisting them', () => {
  const fixture = protocolFixture();
  const second = { ...clone(fixture.requirements), amount: '1' };
  fixture.challenge.accepts.push(second);
  const first = fixture.prepare();
  assert.equal(JSON.parse(first.terms()).maximumAtomic, '1000');
  assert.deepEqual(decodeHeader(first.encode('0x01')).accepted, fixture.requirements);
  fixture.challenge.accepts[0].amount = '7001';
  const next = fixture.prepare();
  assert.equal(JSON.parse(next.terms()).maximumAtomic, '1');
  assert.deepEqual(decodeHeader(next.encode('0x01')).accepted, second);
});

test('native rejects unsupported terms, domains, facilitator, network and malformed decimal prices', () => {
  const mutations = [
    challenge => { challenge.x402Version = 1; },
    challenge => { challenge.resource.url = 'https://other.example/purchase'; },
    challenge => { challenge.accepts[0].network = 'eip155:8453'; },
    challenge => { challenge.accepts[0].network = 'eip155:1'; },
    challenge => { challenge.accepts[0].asset = merchant; },
    challenge => { challenge.accepts[0].scheme = 'unknown'; },
    challenge => { challenge.accepts[0].extra.name = 'USDC impostor'; },
    challenge => { challenge.accepts[0].extra.version = '1'; },
    challenge => { challenge.accepts[0].extra.paymentFlow = 'upfront'; },
    challenge => { challenge.accepts[0].extra.assetTransferMethod = 'eip2612'; },
    challenge => { challenge.accepts[0].maxTimeoutSeconds = 0; },
    challenge => { challenge.accepts[0].maxTimeoutSeconds = 301; },
    challenge => { challenge.accepts[0].maxTimeoutSeconds = 1.5; },
    challenge => { challenge.accepts[0].maxTimeoutSeconds = '300'; },
  ];
  for (const mode of modes) {
    const fixture = protocolFixture(mode);
    for (const mutate of mutations) {
      const challenge = clone(fixture.challenge);
      mutate(challenge);
      assert.throws(() => fixture.prepare(challenge), expectNativeCode('unsupported_payment'));
    }
    for (const amount of [1000, 0, null, '', '0', '00', '01', '+1', '-1', '1.0', '1e3', '0x10', ' 1000',
      '9'.repeat(79), (2n ** 256n).toString()]) {
      const challenge = clone(fixture.challenge);
      challenge.accepts[0].amount = amount;
      assert.throws(() => fixture.prepare(challenge), expectNativeCode('unsupported_payment'));
    }
  }
  const fixture = protocolFixture('upto/permit2');
  for (const facilitatorAddress of [undefined, '', merchant.slice(0, -1), '0x' + '0'.repeat(40), 1]) {
    const challenge = clone(fixture.challenge);
    challenge.accepts[0].extra.facilitatorAddress = facilitatorAddress;
    assert.throws(() => fixture.prepare(challenge), expectNativeCode('unsupported_payment'));
  }
  const wrongMethod = clone(fixture.challenge);
  wrongMethod.accepts[0].extra.assetTransferMethod = 'eip3009';
  assert.throws(() => fixture.prepare(wrongMethod), expectNativeCode('unsupported_payment'));
});

test('supported but disallowed price, merchant and scheme reject with policy_rejected', () => {
  for (const mode of modes) {
    const fixture = protocolFixture(mode);
    for (const policy of [
      { ...fixture.policy, maxPerPaymentAtomic: '1' },
      { ...fixture.policy, allowedSchemes: [fixture.requirements.scheme === 'exact' ? 'upto' : 'exact'] },
      { ...fixture.policy, merchants: [{ origin: 'https://other.example', payTo: merchant }] },
      { ...fixture.policy, merchants: [{ origin: fixture.operation.targetOrigin, payTo: facilitator }] },
    ]) assert.throws(() => fixture.prepare(fixture.challenge, policy), expectNativeCode('policy_rejected'));
  }
});

test('missing assetTransferMethod uses exact EIP3009 and upto Permit2 defaults', () => {
  for (const mode of ['exact/eip3009', 'upto/permit2']) {
    const fixture = protocolFixture(mode);
    delete fixture.requirements.extra.assetTransferMethod;
    const prepared = fixture.prepare();
    assert.equal(JSON.parse(prepared.authorization()).kind, mode === 'exact/eip3009' ? 'eip3009' : 'permit2');
    assert.equal(JSON.parse(prepared.terms()).requirements.extra.assetTransferMethod, mode.split('/')[1]);
    assert.deepEqual(decodeHeader(prepared.encode('0x01')).accepted, fixture.requirements);
  }
});

test('native challenge and receipt reject oversized, malformed and recursively nested headers safely', () => {
  const fixture = protocolFixture();
  const deep = '{"x402Version":2,"accepts":[],"private":' + '['.repeat(150) + '0' + ']'.repeat(150) + '}';
  const nested = clone(fixture.challenge);
  nested.accepts[0].extra.sellerReference = JSON.parse('['.repeat(150) + '0' + ']'.repeat(150));
  for (const header of ['', '%%%not-base64-credential%%%', 'A'.repeat(16 * 1024 + 1),
    Buffer.from('{"credential":"wallet-secret"').toString('base64'),
    Buffer.from(deep).toString('base64'), encodeHeader(nested)]) {
    assert.throws(() => native.preparePayment(header, JSON.stringify(fixture.operation), JSON.stringify(fixture.policy)),
      expectNativeCode('unsupported_payment', 'wallet-secret', 'not-base64-credential'));
    assert.deepEqual(JSON.parse(native.readReceipt(header)), { kind: 'invalid' });
  }
  assert.deepEqual(JSON.parse(native.readReceipt()), { kind: 'missing' });
});

for (const mode of modes) {
  test(`${mode}: bounded non-65-byte signature bytes survive encoding unchanged; invalid sizes fail closed`, () => {
    const fixture = protocolFixture(mode);
    const prepared = fixture.prepare();
    if (mode !== 'exact/eip3009') assertAllowanceRequest(prepared, fixture);
    for (const bytes of [1, 64, 66, 4096]) {
      const signature = '0x' + 'ab'.repeat(bytes);
      const encoded = prepared.encode(signature);
      assert.deepEqual(Buffer.from(decodeHeader(encoded).payload.signature.slice(2), 'hex'), Buffer.from(signature.slice(2), 'hex'));
      assert.ok(Buffer.byteLength(encoded) <= 16 * 1024);
    }
    const persisted = begin(fixture, prepared);
    for (const signature of ['', '0x', '01', '0X01', '0x0', '0xgg', '0xwallet-secret', '0x' + 'ab'.repeat(4097)]) {
      assert.throws(() => prepared.encode(signature), expectNativeCode('authorization_failed', 'wallet-secret'));
    }
    assert.equal(persisted.operation.state, 'signing');
    assert.equal(persisted.budget.heldAtomic, fixture.requirements.amount);
    assert.equal(persisted.budget.spentAtomic, '0');
    const bulky = clone(fixture.challenge);
    bulky.accepts[0].extra.sellerReference.padding = 'x'.repeat(7000);
    assert.ok(Buffer.byteLength(encodeHeader(bulky)) < 16 * 1024);
    const bulkyPrepared = fixture.prepare(bulky);
    assert.throws(() => bulkyPrepared.encode('0x' + 'ab'.repeat(4096)), expectNativeCode('authorization_failed'));
  });
}

test('beginSigning rejects opaque prepared reuse across captured identities and insufficient capacity atomically', () => {
  const fixture = protocolFixture('upto/permit2');
  const prepared = fixture.prepare();
  assertAllowanceRequest(prepared, fixture);
  for (const changes of [
    { start: { operationId: 'other-operation' } },
    { start: { agentId: 'other-agent' } },
    { start: { requestFingerprint: 'b'.repeat(64) } },
    { start: { targetOrigin: 'https://other.example' } },
    { budget: { budgetId: 'other-budget' } },
    { budget: { ownerId: 'other-owner' } },
    { budget: { payer: merchant } },
    { budget: { network: 'eip155:8453' } },
  ]) {
    const other = createNativeOperation(changes);
    const before = clone(other);
    assert.throws(() => begin(other, prepared), expectNativeCode('operation_conflict'));
    assert.deepEqual(other, before);
  }
  const tooSmall = { ...fixture.budget, limitAtomic: '6999' };
  assert.throws(() => begin(fixture, prepared, tooSmall), expectNativeCode('budget_exceeded'));
  assert.equal(tooSmall.heldAtomic, '0');
  assert.equal(fixture.operation.state, 'requesting');
  const persisted = begin(fixture, prepared);
  assert.equal(persisted.budget.heldAtomic, '7000');
  assert.equal(persisted.operation.state, 'signing');
  assert.throws(() => begin(fixture, prepared, persisted.budget, persisted.operation), expectNativeCode('operation_conflict'));
  const second = createNativeOperation({ start: { operationId: 'competing-operation' } });
  const secondPrepared = native.preparePayment(encodeHeader(fixture.challenge), JSON.stringify(second.operation), JSON.stringify(fixture.policy));
  assertAllowanceRequest(secondPrepared, fixture);
  assert.throws(() => begin(second, secondPrepared, persisted.budget), expectNativeCode('budget_exceeded'));
  assert.equal(persisted.budget.heldAtomic, '7000');
  assert.equal(persisted.budget.spentAtomic, '0');
});

test('Permit2 authorization nonce key is shared across schemes and budgets, not scoped to proxy', () => {
  const fixture = protocolFixture('exact/permit2');
  const prepared = fixture.prepare();
  const exact = JSON.parse(prepared.authorization());
  const upto = {
    ...clone(exact), scheme: 'upto', spender: x402UptoPermit2ProxyAddress.toLowerCase(),
    witness: { ...exact.witness, facilitator },
  };
  const exactKey = JSON.parse(native.authorizationKey(fixture.network, JSON.stringify(exact)));
  const uptoKey = JSON.parse(native.authorizationKey(fixture.network, JSON.stringify(upto)));
  assert.deepEqual(exactKey, { contract: PERMIT2_ADDRESS.toLowerCase(), payer, nonce: exact.nonce });
  assert.deepEqual(uptoKey, exactKey);
  const other = createNativeOperation({ budget: { budgetId: 'nonce-collision-budget' } });
  assert.throws(() => begin(other, prepared), expectNativeCode('operation_conflict'));
  assert.equal(other.budget.heldAtomic, '0');
  assert.equal(other.operation.state, 'requesting');
});

test('full-width uint256 prices retain canonical decimal strings in typed data and accepted/payload JSON', async () => {
  for (const mode of modes) {
    for (const amount of ['9007199254740993', (2n ** 256n - 1n).toString()]) {
      const fixture = protocolFixture(mode);
      fixture.requirements.amount = amount;
      fixture.policy.maxPerPaymentAtomic = amount;
      const prepared = fixture.prepare();
      if (mode !== 'exact/eip3009') assertAllowanceRequest(prepared, fixture);
      const typed = JSON.parse(prepared.typedData());
      assert.equal(JSON.parse(prepared.terms()).maximumAtomic, amount);
      assert.equal(mode === 'exact/eip3009' ? typed.message.value : typed.message.permitted.amount, amount);
      const signature = await fixtureSigner.signTypedData(typed);
      const payload = decodeHeader(prepared.encode(signature));
      assert.equal(payload.accepted.amount, amount);
      assert.equal(mode === 'exact/eip3009' ? payload.payload.authorization.value : payload.payload.permit2Authorization.permitted.amount, amount);
      const independent = independentTypedData(payload, fixture.requirements);
      assert.equal(hashTypedData(independent), prepared.signingHash());
      assert.equal(await verifyTypedData({ ...independent, address: payer, signature }), true);
    }
  }
});
