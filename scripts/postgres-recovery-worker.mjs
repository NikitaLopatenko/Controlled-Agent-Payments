import assert from 'node:assert/strict';
import { Pool } from 'pg';
import { createAgentPayments } from '../packages/payments/dist/index.js';
import { PostgresPaymentStore } from '../packages/payments/dist/postgres.js';
import { poolOptions } from './postgres-cluster.mjs';

const input = JSON.parse(process.env.CAP_PG_RECOVERY_INPUT);
const send = message => new Promise((resolve, reject) => process.send(message, error => error ? reject(error) : resolve()));
const pending = new Map();
let sequence = 0, pool;
const deadline = setTimeout(() => process.exit(1), 25000);
process.once('disconnect', () => process.exit(1));
process.on('message', message => {
  if (message?.kind !== 'reply' || !pending.has(message.id)) return process.exit(1);
  const { resolve, reject } = pending.get(message.id);
  pending.delete(message.id);
  if (message.ok) resolve(message.value);
  else reject(new Error('Restricted fixture bridge rejected the request.'));
});
function bridge(method, value) {
  const id = ++sequence;
  const result = new Promise((resolve, reject) => pending.set(id, { resolve, reject }));
  result.catch(() => {});
  send({ kind: 'bridge', id, method, value }).catch(error => { pending.get(id)?.reject(error); pending.delete(id); });
  return result;
}
async function gate(stage) {
  await send({ kind: 'gate', stage });
  await new Promise(() => {});
}
try {
  pool = new Pool({ ...poolOptions, max: 2, connectionString: process.env.CAP_PG_WORKER_URL });
  pool.on('error', () => process.exit(1));
  const gatedPool = {
    query: pool.query.bind(pool),
    async connect() {
      const client = await pool.connect();
      let state;
      return {
        release: client.release.bind(client),
        async query(text, values) {
          const result = await client.query(text, values);
          if (typeof text === 'string' && text.trimStart().startsWith('UPDATE cap_payments.operations')) {
            state = JSON.parse(values[4]).state;
          }
          if (text === 'COMMIT' && state === input.stage) await gate(state);
          return result;
        },
      };
    },
  };
  const store = new PostgresPaymentStore(gatedPool);
  const payer = Object.freeze({ address: input.payer, signTypedData: data => bridge('signTypedData', data) });
  const agent = createAgentPayments({
    network: input.network, store, policy: input.policy,
    resolveSigner: async () => payer,
    rpc: request => bridge('rpc', request),
    fetch: async request => {
      assert.equal(request.url, input.url);
      assert.equal(request.method, 'POST');
      assert.equal(request.redirect, 'error');
      const response = await fetch(request);
      if (input.stage === 'submitted-after-settlement' && request.headers.has('PAYMENT-SIGNATURE')) {
        assert.equal(response.status, 200);
        assert.equal(await response.text(), 'fixture-resource');
        await gate(input.stage);
      }
      return response;
    },
  });
  const response = await agent.fetch(input.context, input.url, input.init);
  await response.body?.cancel();
  throw new Error('The expected durable crash gate was not reached.');
} catch {
  if (process.connected) await send({ kind: 'fatal', code: 'postgres_recovery_worker_failed' }).catch(() => {});
  process.exitCode = 1;
} finally {
  await pool?.end();
  clearTimeout(deadline);
  if (process.connected) process.disconnect();
}
