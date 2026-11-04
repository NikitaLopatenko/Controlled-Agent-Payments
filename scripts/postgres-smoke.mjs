import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { Pool } from 'pg';
import { PaymentError } from '../packages/payments/dist/errors.js';
import { PostgresPaymentStore, installPaymentSchema } from '../packages/payments/dist/postgres.js';
import { authorizationKey } from '../packages/payments/dist/internal.js';
import {
  budgetInput, getStoreHandle, prepare, startInput, successReport,
} from '../tests/postgres-fixture.mjs';
import { openPostgresProof, poolOptions, verifyUrlOwnership } from './postgres-cluster.mjs';
import { verifyRecovery } from './postgres-recovery.mjs';

const children = new Set(), cases = [], extraPools = [];
let environment, summary, failure, interrupted, activeCase;
const interrupt = signal => {
  interrupted ??= signal;
  for (const worker of children) if (worker.child.exitCode === null && worker.child.signalCode === null) worker.child.kill('SIGKILL');
};
const onInt = () => interrupt('SIGINT'), onTerm = () => interrupt('SIGTERM');
process.on('SIGINT', onInt);
process.on('SIGTERM', onTerm);
const watchdog = setTimeout(() => interrupt('deadline'), 180000);

function checkInterrupted() {
  if (interrupted) {
    const error = new Error('PostgreSQL proof was interrupted.');
    error.code = interrupted === 'deadline' ? 'postgres_deadline' : 'postgres_interrupted';
    throw error;
  }
}
async function runCase(name, action) {
  checkInterrupted();
  activeCase = name;
  await action();
  checkInterrupted();
  cases.push(name);
  activeCase = undefined;
}
function hasCode(code) {
  return error => { assert.ok(error instanceof PaymentError); assert.equal(error.code, code); return true; };
}
async function balances(store, key, heldAtomic, spentAtomic = '0') {
  const snapshot = await store.getBudget(key);
  assert.equal(snapshot.heldAtomic, heldAtomic);
  assert.equal(snapshot.spentAtomic, spentAtomic);
  return snapshot;
}
async function snapshot(store, key) {
  return { budget: await store.getBudget(key), operation: await store.getOperation(key) };
}
async function rowVersions(pool, key) {
  return (await pool.query(`SELECT b.xmin::text AS budget_version, o.xmin::text AS operation_version
    FROM cap_payments.budgets b JOIN cap_payments.operations o USING (owner_id, budget_id)
    WHERE b.owner_id=$1 AND b.budget_id=$2 AND o.operation_id=$3`,
  [key.ownerId, key.budgetId, key.operationId])).rows;
}
async function signing(store, budgetId, operationId = 'purchase') {
  const budget = budgetInput(budgetId);
  await store.createBudget(budget);
  const key = startInput(budget, operationId), handle = getStoreHandle(store);
  const operation = await handle.start(key);
  await handle.mutate(key, { kind: 'beginSigning', prepared: prepare(operation) });
  return key;
}

function worker(url, input) {
  const child = fork(new URL('./postgres-worker.mjs', import.meta.url), [], {
    env: { ...process.env, CAP_PG_WORKER_URL: url, CAP_PG_WORKER_INPUT: JSON.stringify(input) },
    stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
  });
  let readyResolve, readyReject, resultResolve, resultReject, exitResolve;
  const ready = new Promise((resolve, reject) => { readyResolve = resolve; readyReject = reject; });
  const result = new Promise((resolve, reject) => { resultResolve = resolve; resultReject = reject; });
  const exited = new Promise(resolve => { exitResolve = resolve; });
  ready.catch(() => {}); result.catch(() => {});
  const timer = setTimeout(() => { child.kill('SIGKILL'); fail(); }, 20000);
  const entry = { child, ready, result, exited };
  function fail() { readyReject(new Error('PostgreSQL worker failed.')); resultReject(new Error('PostgreSQL worker failed.')); }
  child.on('message', message => {
    if (message?.kind === 'ready') readyResolve();
    else if (message?.kind === 'result') resultResolve(message);
    else fail();
  });
  child.once('error', fail);
  child.once('close', (code, signal) => {
    clearTimeout(timer);
    if (code !== 0 || signal !== null) fail();
    readyReject(new Error('PostgreSQL worker exited before ready.'));
    resultReject(new Error('PostgreSQL worker exited before its result.'));
    exitResolve({ code, signal });
  });
  children.add(entry);
  return entry;
}

function faultPool(pool) {
  let armed, rollbackError;
  const control = { hits: 0, committed: 0, rollbackAttempts: 0,
    arm(fault) { assert.equal(armed, undefined); armed = fault; this.hits = 0; this.committed = 0; this.rollbackAttempts = 0; },
  };
  control.pool = {
    query: pool.query.bind(pool),
    async connect() {
      const client = await pool.connect();
      return {
        release: client.release.bind(client),
        async query(text, values) {
          if (text === 'ROLLBACK') {
            control.rollbackAttempts++;
            if (rollbackError !== undefined) { const error = rollbackError; rollbackError = undefined; throw error; }
          }
          if (text === 'COMMIT' && armed?.point) {
            const fault = armed; armed = undefined; control.hits++;
            if (fault.point === 'after') { await client.query(text, values); control.committed++; }
            throw fault.error;
          }
          const result = await client.query(text, values);
          if (armed?.table && typeof text === 'string' && text.trimStart().startsWith(`UPDATE cap_payments.${armed.table}`)) {
            rollbackError = armed.rollbackError; armed = undefined; control.hits++;
            return { ...result, rowCount: 0 };
          }
          return result;
        },
      };
    },
  };
  return control;
}

try {
  environment = await openPostgresProof();
  checkInterrupted();
  const primary = await environment.database(), pool = primary.pool;
  const store = new PostgresPaymentStore(pool), handle = getStoreHandle(store);
  await runCase('transactional-idempotent-concurrent-install', async () => {
    await Promise.all([installPaymentSchema(pool), installPaymentSchema(pool)]);
    await installPaymentSchema(pool);
    assert.equal((await pool.query("SELECT count(*)::text AS n FROM pg_namespace WHERE nspname = 'ubb_payments'")).rows[0].n, '0');
    assert.deepEqual(Object.getOwnPropertyNames(PostgresPaymentStore.prototype).sort(),
      ['constructor', 'createBudget', 'getBudget', 'getOperation'].sort());
  });

  const shared = budgetInput();
  await runCase('cross-process-7000-of-10000-contention', async () => {
    await store.createBudget(shared);
    const workers = ['worker-a', 'worker-b'].map(id => worker(primary.url, startInput(shared, id)));
    await Promise.all(workers.map(item => item.ready));
    for (const item of workers) item.child.send('go');
    const results = await Promise.all(workers.map(item => item.result));
    const exits = await Promise.all(workers.map(item => item.exited));
    for (const exit of exits) assert.deepEqual(exit, { code: 0, signal: null });
    assert.equal(results.filter(result => result.beganSigning).length, 1);
    const winner = results.find(result => result.beganSigning), loser = results.find(result => !result.beganSigning);
    assert.equal(winner.state, 'signing');
    assert.equal(loser.deniedCode, 'budget_exceeded');
    assert.equal(loser.state, 'unpaid');
    for (const result of results) { assert.equal(result.heldAtomic, '7000'); assert.equal(result.spentAtomic, '0'); }
    await balances(store, shared, '7000');
    const key = startInput(shared, winner.operationId), before = await snapshot(store, key);
    const versions = await rowVersions(pool, key);
    await assert.rejects(handle.start(key), hasCode('operation_in_progress'));
    for (const changes of [{ agentId: 'different' }, { requestFingerprint: 'c'.repeat(64) }, { targetOrigin: 'https://other.example' }]) {
      await assert.rejects(handle.start({ ...key, ...changes }), hasCode('operation_conflict'));
    }
    assert.deepEqual(await snapshot(store, key), before, 'losing duplicates must not write');
    assert.deepEqual(await rowVersions(pool, key), versions, 'duplicates must not rewrite even identical row values');
    await assert.rejects(handle.start(startInput(shared, loser.operationId)), hasCode('operation_already_processed'));
  });

  await runCase('immutable-budget-returns-current-detached-snapshot', async () => {
    const current = await store.createBudget(shared);
    assert.equal(current.heldAtomic, '7000');
    current.heldAtomic = '0'; current.limitAtomic = '1';
    await balances(store, shared, '7000');
    for (const changes of [{ limitAtomic: '10001' }, { network: 'eip155:8453' }, { payer: '0x4444444444444444444444444444444444444444' }]) {
      await assert.rejects(store.createBudget({ ...shared, ...changes }), hasCode('operation_conflict'));
    }
    assert.equal((await store.getBudget(shared)).limitAtomic, '10000');
    assert.equal(await store.getBudget(budgetInput('absent')), null);
    assert.equal(await store.getOperation(startInput(shared, 'absent')), null);
  });

  await runCase('unrelated-budgets-and-pools-proceed-under-lock', async () => {
    const otherPool = new Pool({ ...poolOptions, max: 2, connectionString: primary.url }); extraPools.push(otherPool);
    otherPool.on('error', () => interrupt('database-error'));
    const otherStore = new PostgresPaymentStore(otherPool), other = budgetInput('independent', 'another-owner');
    await otherStore.createBudget(other);
    const blocker = await pool.connect();
    try {
      await blocker.query('BEGIN');
      await blocker.query('SELECT owner_id FROM cap_payments.budgets WHERE owner_id=$1 AND budget_id=$2 FOR UPDATE', [shared.ownerId, shared.budgetId]);
      const key = startInput(other), independent = getStoreHandle(otherStore);
      const operation = await independent.start(key);
      await independent.mutate(key, { kind: 'beginSigning', prepared: prepare(operation) });
      await balances(otherStore, other, '7000');
    } finally { await blocker.query('ROLLBACK'); blocker.release(); }
    await balances(store, shared, '7000');
  });

  await runCase('plain-input-snapshots-and-unsigned-terminal-idempotence', async () => {
    const budget = budgetInput('snapshot'), budgetPending = store.createBudget(budget);
    budget.limitAtomic = '1'; await budgetPending;
    const original = startInput(budget), mutable = { ...original }, pending = handle.start(mutable);
    mutable.agentId = 'mutated'; mutable.requestFingerprint = 'd'.repeat(64);
    const started = await pending;
    assert.equal(started.agentId, original.agentId); assert.equal(started.requestFingerprint, original.requestFingerprint);
    await handle.mutate(original, { kind: 'beginSigning', prepared: prepare(started) });
    await handle.mutate(original, { kind: 'submitted' });
    const action = { kind: 'report', report: successReport(), outcome: 'received' };
    const reporting = handle.mutate(original, action);
    action.report.receipt.amount = '6999'; action.outcome = 'transport_failed';
    const reported = await reporting;
    assert.equal(reported.state, 'reported'); assert.equal(reported.report.receipt.amount, '1200');
    reported.report.receipt.amount = '1'; reported.authorization.permitted.amount = '1';
    assert.equal((await store.getOperation(original)).report.receipt.amount, '1200');
    assert.equal((await store.getOperation(original)).authorization.permitted.amount, '7000');
    const unsigned = startInput(budget, 'unsigned'); await handle.start(unsigned);
    const closed = await handle.mutate(unsigned, { kind: 'closeUnsigned' });
    assert.equal(closed.state, 'unpaid'); assert.deepEqual(closed.finalProof, { kind: 'unpaid', reason: 'no_authorization_created' });
    assert.deepEqual(await handle.mutate(unsigned, { kind: 'closeUnsigned' }), closed);
    assert.deepEqual(await handle.mutate(unsigned, { kind: 'failure', code: 'payment_unresolved' }), closed);
    assert.deepEqual(await handle.mutate(unsigned, { kind: 'report', report: { kind: 'missing' }, outcome: 'received' }), closed);
    await balances(store, budget, '7000');
  });

  for (const state of ['signing', 'submitted', 'reported', 'unknown', 'zero-report']) {
    await runCase(`hold-preservation-${state}`, async () => {
      const key = await signing(store, `hold-${state}`);
      if (state !== 'signing') await handle.mutate(key, { kind: 'submitted' });
      if (state === 'reported' || state === 'zero-report') await handle.mutate(key, { kind: 'report', report: successReport(state === 'zero-report' ? '0' : '1200'), outcome: 'received' });
      if (state === 'unknown') await handle.mutate(key, { kind: 'report', report: { kind: 'missing' }, outcome: 'received' });
      const before = await snapshot(store, key);
      await assert.rejects(handle.mutate(key, { kind: 'closeUnsigned' }), hasCode('payment_unresolved'));
      await assert.rejects(handle.start(key), hasCode('operation_in_progress'));
      assert.deepEqual(await snapshot(store, key), before);
      const failed = await handle.mutate(key, { kind: 'failure', code: 'authorization_failed' });
      assert.equal(failed.state, 'unknown');
      await balances(store, key, '7000');
    });
  }

  for (const phase of ['start', 'beginSigning', 'submitted', 'report']) {
    for (const point of ['before', 'after']) {
      await runCase(`${phase}-${point}-commit-acknowledgement`, async () => {
        const budget = budgetInput(`fault-${phase}-${point}`), key = startInput(budget);
        await store.createBudget(budget);
        let prepared;
        if (phase !== 'start') {
          const operation = await handle.start(key); prepared = prepare(operation);
          if (phase !== 'beginSigning') await handle.mutate(key, { kind: 'beginSigning', prepared });
          if (phase === 'report') await handle.mutate(key, { kind: 'submitted' });
        }
        const before = await snapshot(store, key), faults = faultPool(pool);
        const faultyStore = new PostgresPaymentStore(faults.pool), faulty = getStoreHandle(faultyStore);
        const secret = 'pg-secret-header-body-signature';
        const hostError = point === 'after' ? new PaymentError('operation_conflict', { operationId: secret, response: new Response(secret) }) : new Error(secret);
        hostError.message = secret; hostError.cause = new Error(secret); hostError.detail = secret;
        faults.arm({ point, error: hostError });
        let caught;
        try {
          if (phase === 'start') await faulty.start(key);
          else await faulty.mutate(key, phase === 'beginSigning' ? { kind: phase, prepared }
            : phase === 'report' ? { kind: 'report', report: successReport(), outcome: 'received' } : { kind: 'submitted' });
        } catch (error) { caught = error; }
        hasCode('storage_unavailable')(caught);
        assert.notEqual(caught, hostError);
        assert.equal(caught.cause, undefined); assert.equal(caught.response, undefined);
        assert.equal(JSON.stringify({ ...caught, message: caught.message, stack: caught.stack }).includes(secret), false);
        assert.equal(faults.hits, 1); assert.equal(faults.committed, point === 'after' ? 1 : 0); assert.equal(faults.rollbackAttempts, 1);
        if (point === 'before') assert.deepEqual(await snapshot(store, key), before);
        else {
          const retained = await store.getOperation(key);
          assert.equal(retained.state, { start: 'requesting', beginSigning: 'signing', submitted: 'submitted', report: 'reported' }[phase]);
          await balances(store, key, phase === 'start' ? '0' : '7000');
          const durable = await snapshot(store, key);
          await assert.rejects(faulty.start(key), hasCode('operation_in_progress'));
          assert.deepEqual(await snapshot(store, key), durable, 'lost acknowledgement never grants duplicate ownership');
          if (phase !== 'start') await assert.rejects(faulty.mutate(key, { kind: 'closeUnsigned' }), hasCode('payment_unresolved'));
        }
      });
    }
  }

  for (const table of ['budgets', 'operations']) {
    await runCase(`prior-state-cas-rowcount-${table}`, async () => {
      const budget = budgetInput(`cas-${table}`); await store.createBudget(budget);
      const key = startInput(budget), operation = await handle.start(key), before = await snapshot(store, key);
      const faults = faultPool(pool), faulty = getStoreHandle(new PostgresPaymentStore(faults.pool));
      faults.arm({ table });
      await assert.rejects(faulty.mutate(key, { kind: 'beginSigning', prepared: prepare(operation) }), hasCode('operation_conflict'));
      assert.equal(faults.hits, 1);
      assert.deepEqual(await snapshot(store, key), before, 'both real row updates must roll back after a failed CAS');
    });
  }
  await runCase('rollback-failure-discards-client', async () => {
    const database = await environment.database();
    let single;
    try {
      single = new Pool({ ...poolOptions, connectionString: database.url, max: 1, idleTimeoutMillis: 0 });
      single.on('error', () => interrupt('database-error'));
      await installPaymentSchema(single);
      const durable = new PostgresPaymentStore(single), internal = getStoreHandle(durable);
      const budget = budgetInput('rollback-original'); await durable.createBudget(budget);
      const key = startInput(budget), operation = await internal.start(key), before = await snapshot(durable, key);
      const originalPid = (await single.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
      const faults = faultPool(single), faulty = getStoreHandle(new PostgresPaymentStore(faults.pool));
      const secret = 'rollback-fault-private';
      faults.arm({ table: 'budgets', rollbackError: new Error(secret) });
      await assert.rejects(faulty.mutate(key, { kind: 'beginSigning', prepared: prepare(operation) }), error => {
        hasCode('operation_conflict')(error);
        assert.equal(error.cause, undefined); assert.equal(error.response, undefined);
        assert.equal(JSON.stringify({ ...error, message: error.message, stack: error.stack }).includes(secret), false);
        return true;
      });
      assert.equal(faults.hits, 1); assert.equal(faults.rollbackAttempts, 1);
      await durable.createBudget(budgetInput('rollback-unrelated'));
      assert.deepEqual(await snapshot(durable, key), before, 'a later transaction must not commit the failed reservation');
      assert.notEqual((await single.query('SELECT pg_backend_pid() AS pid')).rows[0].pid, originalPid);
    } finally {
      try { await single?.end(); }
      finally { await database.close(); }
    }
  });
  await runCase('malformed-client-never-falls-back-and-releases', async () => {
    let released = 0, fallbackQueries = 0;
    const malformed = new PostgresPaymentStore({
      query() { fallbackQueries++; throw new Error('must-not-fall-back'); },
      async connect() { return { query: undefined, release() { released++; } }; },
    });
    const budget = budgetInput('malformed-client');
    await assert.rejects(malformed.createBudget(budget), hasCode('storage_unavailable'));
    assert.equal(released, 1); assert.equal(fallbackQueries, 0);
    assert.equal(await store.getBudget(budget), null);
  });

  await runCase('release-error-after-real-commit-is-sanitized-not-rolled-back', async () => {
    const secret = 'release-private-driver-message';
    const malicious = new PaymentError('operation_conflict', { operationId: secret, response: new Response(secret) });
    malicious.message = secret; malicious.cause = new Error(secret); malicious.detail = secret;
    let released = 0;
    const releaseFault = new PostgresPaymentStore({
      query: pool.query.bind(pool),
      async connect() {
        const client = await pool.connect();
        return { query: client.query.bind(client), release() { client.release(); released++; throw malicious; } };
      },
    });
    const budget = budgetInput('release-after-commit');
    await assert.rejects(releaseFault.createBudget(budget), error => {
      hasCode('storage_unavailable')(error);
      assert.notEqual(error, malicious); assert.equal(error.cause, undefined); assert.equal(error.response, undefined);
      assert.equal(JSON.stringify({ ...error, message: error.message, stack: error.stack }).includes(secret), false);
      return true;
    });
    assert.equal(released, 1);
    await balances(store, budget, '0');
  });

  const guards = [
    ['partial-schema', 'CREATE SCHEMA cap_payments', false],
    ['partial-tables', 'DROP TABLE cap_payments.operations', true],
    ['altered-check', 'ALTER TABLE cap_payments.budgets DROP CONSTRAINT cap_budgets_available_check; ALTER TABLE cap_payments.budgets ADD CONSTRAINT cap_budgets_available_check CHECK (spent_atomic + held_atomic <= limit_atomic OR held_atomic = 0)', true],
    ['altered-index-order', 'ALTER TABLE cap_payments.operations DROP CONSTRAINT cap_operations_authorization_namespace_key; ALTER TABLE cap_payments.operations ADD CONSTRAINT cap_operations_authorization_namespace_key UNIQUE (payer, network, authorization_contract, authorization_nonce)', true],
    ['altered-column-default', 'ALTER TABLE cap_payments.budgets ALTER COLUMN held_atomic SET DEFAULT 0', true],
    ['altered-rls', 'ALTER TABLE cap_payments.operations ENABLE ROW LEVEL SECURITY', true],
    ['extra-object', 'CREATE VIEW cap_payments.unexpected AS SELECT 1 AS n', true],
    ['newer-schema-version', 'ALTER TABLE cap_payments.schema_version DROP CONSTRAINT cap_schema_version_version_check; UPDATE cap_payments.schema_version SET version = 2', true],
  ];
  for (const [name, mutation, installed] of guards) {
    await runCase(`schema-guard-${name}`, async () => {
      const database = await environment.database();
      try {
        if (installed) await installPaymentSchema(database.pool);
        await database.pool.query(mutation);
        const before = (await database.pool.query("SELECT c.relname, c.relkind FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='cap_payments' ORDER BY c.relname")).rows;
        await assert.rejects(installPaymentSchema(database.pool), hasCode('storage_unavailable'));
        assert.deepEqual((await database.pool.query("SELECT c.relname, c.relkind FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='cap_payments' ORDER BY c.relname")).rows, before);
      } finally { await database.close(); }
    });
  }

  await runCase('malformed-stored-identities-and-amounts-fail-closed', async () => {
    const database = await environment.database();
    try {
      await installPaymentSchema(database.pool);
      const corrupt = new PostgresPaymentStore(database.pool), internal = getStoreHandle(corrupt);
      const mismatched = await signing(corrupt, 'mismatched-identity');
      await database.pool.query('ALTER TABLE cap_payments.operations DROP CONSTRAINT cap_operations_payload_identity_check');
      await database.pool.query("UPDATE cap_payments.operations SET payload=jsonb_set(payload, '{agentId}', '\"different\"'::jsonb) WHERE budget_id=$1", [mismatched.budgetId]);
      await assert.rejects(corrupt.getOperation(mismatched), hasCode('storage_unavailable'));
      await assert.rejects(internal.mutate(mismatched, { kind: 'failure', code: 'payment_unresolved' }), hasCode('storage_unavailable'));
      const invalidId = await signing(corrupt, 'invalid-indexed-identity');
      await database.pool.query("UPDATE cap_payments.operations SET agent_id='', payload=jsonb_set(payload, '{agentId}', '\"\"'::jsonb) WHERE budget_id=$1", [invalidId.budgetId]);
      await assert.rejects(corrupt.getOperation(invalidId), hasCode('storage_unavailable'));
      const amount = await signing(corrupt, 'invalid-authorization-amount');
      await database.pool.query("UPDATE cap_payments.operations SET payload=jsonb_set(payload, '{authorization,permitted,amount}', '\"1.5\"'::jsonb) WHERE budget_id=$1", [amount.budgetId]);
      await assert.rejects(corrupt.getOperation(amount), hasCode('storage_unavailable'));
      const number = await signing(corrupt, 'numeric-json-amount');
      await database.pool.query("UPDATE cap_payments.operations SET payload=jsonb_set(payload, '{authorization,permitted,amount}', '7000'::jsonb) WHERE budget_id=$1", [number.budgetId]);
      await assert.rejects(corrupt.getOperation(number), hasCode('storage_unavailable'));
      const overflow = await signing(corrupt, 'uint256-overflow');
      await database.pool.query('ALTER TABLE cap_payments.budgets DROP CONSTRAINT cap_budgets_limit_atomic_check');
      await database.pool.query('UPDATE cap_payments.budgets SET limit_atomic=$1 WHERE budget_id=$2', ['115792089237316195423570985008687907853269984665640564039457584007913129639936', overflow.budgetId]);
      await assert.rejects(corrupt.getBudget(overflow), hasCode('storage_unavailable'));
      await assert.rejects(corrupt.getOperation(overflow), hasCode('storage_unavailable'));
    } finally { await database.close(); }
  });

  await runCase('sql-only-permanent-cross-budget-cross-scheme-nonce-constraint', async () => {
    const database = await environment.database();
    try {
      await installPaymentSchema(database.pool);
      const durable = new PostgresPaymentStore(database.pool), internal = getStoreHandle(durable);
      const sourceKey = await signing(durable, 'nonce-source'), source = await durable.getOperation(sourceKey);
      const namespace = authorizationKey(source.network, source.authorization);
      for (const finalState of ['settled', 'unpaid']) {
        await database.pool.query("UPDATE cap_payments.operations SET state=$1, payload=jsonb_set(payload, '{state}', to_jsonb($1::text)) WHERE budget_id=$2", [finalState, sourceKey.budgetId]);
        for (const [index, scheme] of ['upto', 'exact'].entries()) {
          const budget = budgetInput(`nonce-${finalState}-${scheme}`, `different-owner-${index}`);
          await durable.createBudget(budget);
          const key = startInput(budget), requesting = await internal.start(key), prepared = prepare(requesting, scheme);
          const unsigned = JSON.parse(prepared.authorization()); unsigned.nonce = source.authorization.nonce;
          const payload = { ...requesting, state: 'signing', terms: JSON.parse(prepared.terms()), authorization: unsigned };
          await assert.rejects(database.pool.query(`UPDATE cap_payments.operations
            SET state='signing', payload=$1::jsonb, authorization_contract=$2, authorization_nonce=$3
            WHERE owner_id=$4 AND budget_id=$5 AND operation_id=$6`,
          [JSON.stringify(payload), namespace.contract, namespace.nonce, key.ownerId, key.budgetId, key.operationId]),
          error => { assert.equal(error.code, '23505'); assert.equal(error.constraint, 'cap_operations_authorization_namespace_key'); return true; });
          assert.equal((await durable.getOperation(key)).state, 'requesting');
          await balances(durable, key, '0');
        }
      }
    } finally { await database.close(); }
  });

  let recovery, urlOwnership, urlOnlyOwnership;
  await runCase('public-sdk-signed-crash-and-final-commit-matrix', async () => {
    recovery = await verifyRecovery(primary);
  });
  await runCase('designated-url-source-database-isolation', async () => {
    urlOwnership = await verifyUrlOwnership(environment);
  });
  await runCase('designated-url-only-ownership-without-local-binaries', async () => {
    const source = await environment.database();
    const previousBin = process.env.CAP_POSTGRES_BIN;
    let urlEnvironment;
    try {
      urlEnvironment = await openPostgresProof(source.url);
      delete process.env.CAP_POSTGRES_BIN;
      urlOnlyOwnership = await verifyUrlOwnership(urlEnvironment);
      assert.deepEqual(urlOnlyOwnership, {
        sourceRoute: 'designated-url-owned-databases', urlRoute: 'designated-url-owned-databases',
        sourceDatabasePreserved: true, sourceSchemasPreserved: true, sourceRowsPreserved: 2,
        createdTargetDatabases: 1, droppedTargetDatabases: 1,
      });
    } finally {
      if (previousBin === undefined) delete process.env.CAP_POSTGRES_BIN;
      else process.env.CAP_POSTGRES_BIN = previousBin;
      try { await urlEnvironment?.close(); }
      finally { await source.close(); }
    }
  });

  const final = await balances(store, shared, '7000');
  environment.assertHealthy();
  checkInterrupted();
  const transitionCommitFaultCases = cases.filter(name => name.endsWith('-commit-acknowledgement')).length;
  summary = { postgres: 17, route: environment.route, mode: 'native-transitions-and-public-sdk-real-postgres-simulated-http-chain',
    passed: true, cases: cases.length, transitionCommitFaultCases,
    finalResolutionCommitFaultCases: recovery.finalCommitFaults.length, publicFetchCommitFaultCases: recovery.fetchCommitFaults.length,
    commitFaultCases: transitionCommitFaultCases + recovery.finalCommitFaults.length + recovery.fetchCommitFaults.length,
    schemaGuardCases: guards.length, crossProcessBeginSigning: 1, crossProcessDenied: 1,
    sharedHeldAtomic: final.heldAtomic, sharedSpentAtomic: final.spentAtomic,
    walletSignatures: recovery.walletSignatures, modeledSettlements: recovery.modeledSettlements,
    recovery, urlOwnership, urlOnlyOwnership, sqlConstraintFinalStates: ['settled', 'unpaid'] };
} catch (error) {
  failure = { code: error?.code === 'postgres_prerequisite' ? 'postgres_prerequisite'
    : error?.code === 'postgres_interrupted' ? 'postgres_interrupted'
    : error?.code === 'postgres_deadline' ? 'postgres_deadline'
    : error?.code === 'postgres_cleanup_failed' ? 'postgres_cleanup_failed' : 'postgres_smoke_failed',
  message: error?.code === 'postgres_prerequisite' ? error.message : 'PostgreSQL durable verification failed.',
  completedCases: cases.length, failedCase: activeCase ?? null,
  ...(error?.recoveryCase ? { recoveryCase: error.recoveryCase, completedCrashCases: error.completedCrashCases,
    completedFetchFaultCases: error.completedFetchFaultCases } : {}),
  ...(error?.ownedDirectory ? { retainedOwnedDirectory: error.ownedDirectory } : {}) };
} finally {
  for (const entry of children) if (entry.child.exitCode === null && entry.child.signalCode === null) entry.child.kill('SIGKILL');
  await Promise.allSettled([...children].map(entry => entry.exited));
  const closedPools = await Promise.allSettled(extraPools.map(pool => pool.end()));
  try {
    const cleanup = await environment?.close();
    environment?.assertHealthy();
    if (summary) summary.cleanup = cleanup;
  } catch (error) {
    failure = { code: 'postgres_cleanup_failed', message: 'Owned PostgreSQL resource cleanup failed.', completedCases: cases.length,
      ...(error.ownedDirectory ? { retainedOwnedDirectory: error.ownedDirectory } : {}) };
  }
  if (closedPools.some(result => result.status === 'rejected')) failure = { code: 'postgres_cleanup_failed', message: 'Proof pool cleanup failed.', completedCases: cases.length };
  clearTimeout(watchdog);
  process.removeListener('SIGINT', onInt); process.removeListener('SIGTERM', onTerm);
}
if (!failure && interrupted) failure = {
  code: interrupted === 'deadline' ? 'postgres_deadline' : 'postgres_interrupted',
  message: 'PostgreSQL proof was interrupted.', completedCases: cases.length,
};
if (failure) {
  console.error(JSON.stringify(failure));
  process.exitCode = interrupted === 'SIGINT' ? 130 : failure.code === 'postgres_prerequisite' ? 2 : 1;
} else console.log(JSON.stringify(summary));
