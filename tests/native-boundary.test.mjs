import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const native = createRequire(import.meta.url)('../packages/payments/native/cap-native.darwin-arm64.node');
const input = { ownerId: 'owner', budgetId: 'budget', network: 'eip155:84532', payer: '0x1111111111111111111111111111111111111111', limitAtomic: '10000' };

test('native money boundary rejects noncanonical and overflowing amounts without echoing input', () => {
  for (const amount of ['00', '+1', '-1', '0x10', '1.0', '1e3', 1, '9'.repeat(79), (2n ** 256n).toString()]) {
    assert.throws(() => native.normalizeBudget(JSON.stringify({ ...input, limitAtomic: amount })), error =>
      error.message === (typeof amount === 'string' ? 'invalid_amount' : 'invalid_config'));
  }
  const maximum = (2n ** 256n - 1n).toString();
  assert.equal(JSON.parse(native.normalizeBudget(JSON.stringify({ ...input, limitAtomic: maximum }))).limitAtomic, maximum);
});

test('native model boundary rejects deep, oversized, invalid and unknown JSON', () => {
  for (const json of ['{"secret":"credential"', '['.repeat(200) + ']'.repeat(200), ' '.repeat(65537), JSON.stringify({ ...input, signature: 'secret-signature' })]) {
    assert.throws(() => native.normalizeBudget(json), error => error.message === 'invalid_config');
  }
});
