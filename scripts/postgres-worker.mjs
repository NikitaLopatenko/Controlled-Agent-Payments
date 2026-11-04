import assert from 'node:assert/strict';
import { once } from 'node:events';
import { Pool } from 'pg';
import { PostgresPaymentStore } from '../packages/payments/dist/postgres.js';
import { getStoreHandle, prepare } from '../tests/postgres-fixture.mjs';
import { poolOptions } from './postgres-cluster.mjs';

const deadline = setTimeout(() => process.exit(1), 15000);
const disconnected = () => process.exit(1);
process.once('disconnect', disconnected);
let pool, poolFailed = false;
const send = value => new Promise((resolve, reject) => process.send(value, error => error ? reject(error) : resolve()));
try {
  const input = JSON.parse(process.env.CAP_PG_WORKER_INPUT);
  pool = new Pool({ ...poolOptions, max: 2, connectionString: process.env.CAP_PG_WORKER_URL });
  pool.on('error', () => { poolFailed = true; });
  const store = new PostgresPaymentStore(pool), handle = getStoreHandle(store);
  const go = once(process, 'message');
  await send({ kind: 'ready' });
  assert.equal((await go)[0], 'go');
  const operation = await handle.start(input);
  let beganSigning = false, deniedCode, originalNonce;
  try {
    const signing = await handle.mutate(input, { kind: 'beginSigning', prepared: prepare(operation) });
    assert.equal(signing.state, 'signing');
    beganSigning = true;
    originalNonce = signing.authorization.nonce;
    signing.authorization.nonce = '0';
    signing.state = 'unpaid';
  } catch (error) {
    assert.equal(error.code, 'budget_exceeded');
    deniedCode = error.code;
    assert.equal((await store.getOperation(input)).state, 'requesting');
    assert.equal((await handle.mutate(input, { kind: 'closeUnsigned' })).state, 'unpaid');
  }
  const retained = await store.getOperation(input), budget = await store.getBudget(input);
  assert.equal(retained.state, beganSigning ? 'signing' : 'unpaid');
  if (beganSigning) assert.equal(retained.authorization.nonce, originalNonce);
  assert.equal(poolFailed, false);
  await send({ kind: 'result', operationId: input.operationId, beganSigning, deniedCode,
    state: retained.state, heldAtomic: budget.heldAtomic, spentAtomic: budget.spentAtomic });
} catch {
  process.exitCode = 1;
  if (process.connected) await send({ kind: 'fatal', code: 'postgres_worker_failed' }).catch(() => {});
} finally {
  await pool?.end();
  clearTimeout(deadline);
  process.removeListener('disconnect', disconnected);
  if (process.connected) process.disconnect();
}
