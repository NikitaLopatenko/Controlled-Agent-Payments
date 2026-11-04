import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { Pool } from 'pg';
import { installPaymentSchema, PostgresPaymentStore } from '../packages/payments/dist/postgres.js';

const execute = promisify(execFile);
export const poolOptions = { max: 6, connectionTimeoutMillis: 5000, query_timeout: 10000, statement_timeout: 8000, idleTimeoutMillis: 1000 };

function prerequisite(message) {
  const error = new Error(message);
  error.code = 'postgres_prerequisite';
  return error;
}

async function command(file, args) {
  return execute(file, args, { env: { ...process.env, LC_ALL: 'C' }, timeout: 25000, maxBuffer: 1024 * 1024, encoding: 'utf8' });
}

async function unusedPort() {
  const server = createServer();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  assert.ok(address && typeof address === 'object');
  return address.port;
}

export async function openPostgresProof(sourceUrl = process.env.CAP_TEST_DATABASE_URL) {
  let root, bin, data, admin, startAttempted = false;
  const databases = new Map();
  let createdDatabases = 0, droppedDatabases = 0;
  let closing, idleConnectionError = false;
  const assertHealthy = () => {
    if (idleConnectionError) throw new Error('An owned PostgreSQL pool lost an idle connection.');
  };
  const close = () => closing ??= (async () => {
    const failures = [];
    let retainedOwnedDirectory;
    for (const [name, entry] of databases) {
      try { await entry.pool?.end(); } catch { failures.push('pool_close'); }
      try { await admin.query(`DROP DATABASE "${name}" WITH (FORCE)`); databases.delete(name); droppedDatabases++; }
      catch { failures.push('database_drop'); }
    }
    try { await admin?.end(); } catch { failures.push('admin_close'); }
    if (root !== undefined) {
      let stopped = !startAttempted;
      if (startAttempted) {
        try {
          await command(join(bin, 'pg_ctl'), ['-D', data, '-m', 'immediate', '-w', '-t', '15', 'stop']);
          stopped = true;
        } catch {
          try {
            await command(join(bin, 'pg_ctl'), ['-D', data, 'status']);
          } catch (status) {
            if (status.code === 3) {
              try {
                const pid = Number((await readFile(join(data, 'postmaster.pid'), 'utf8')).split('\n')[0]);
                if (Number.isSafeInteger(pid) && pid > 0) {
                  try { process.kill(pid, 0); }
                  catch (error) { if (error.code === 'ESRCH') stopped = true; }
                }
              } catch (error) { if (error.code === 'ENOENT') stopped = true; }
            }
          }
          if (!stopped) { failures.push('cluster_stop_data_retained'); retainedOwnedDirectory = root; }
        }
      }
      if (stopped) {
        try { await rm(root, { recursive: true, force: true }); }
        catch { failures.push('cluster_remove'); retainedOwnedDirectory = root; }
      }
    }
    if (failures.length) {
      const error = new Error('Owned PostgreSQL resource cleanup failed.');
      error.code = 'postgres_cleanup_failed';
      if (retainedOwnedDirectory !== undefined) error.ownedDirectory = retainedOwnedDirectory;
      throw error;
    }
    return { ownedDatabasesCreated: createdDatabases, ownedDatabasesDropped: droppedDatabases,
      ownedClusterStopped: root !== undefined, ownedDirectoryRemoved: root !== undefined };
  })();

  try {
    let source;
    if (sourceUrl) {
      try {
        source = new URL(sourceUrl);
        if (!['postgres:', 'postgresql:'].includes(source.protocol)) throw new Error();
      } catch { throw prerequisite('CAP_TEST_DATABASE_URL must be a PostgreSQL URL with CREATE/DROP DATABASE privileges.'); }
    } else {
      if (!process.env.CAP_POSTGRES_BIN) {
        throw prerequisite('Set CAP_TEST_DATABASE_URL with CREATE/DROP DATABASE privileges or CAP_POSTGRES_BIN to PostgreSQL 17 binaries.');
      }
      bin = resolve(process.env.CAP_POSTGRES_BIN);
      for (const program of ['postgres', 'initdb', 'pg_ctl']) {
        let version;
        try { version = (await command(join(bin, program), ['--version'])).stdout; }
        catch { throw prerequisite('CAP_POSTGRES_BIN must contain runnable PostgreSQL 17 postgres, initdb and pg_ctl binaries.'); }
        if (!version.startsWith(`${program} (PostgreSQL) 17.`)) throw prerequisite('CAP_POSTGRES_BIN must designate PostgreSQL major version 17.');
      }
      root = await mkdtemp('/tmp/cap-pg-');
      data = join(root, 'data');
      await command(join(bin, 'initdb'), ['-D', data, '-U', 'cap_test_admin', '-A', 'trust', '--encoding=UTF8', '--no-locale']);
      const port = await unusedPort();
      startAttempted = true;
      await command(join(bin, 'pg_ctl'), ['-D', data, '-l', join(root, 'postgres.log'), '-o', `-h 127.0.0.1 -p ${port} -k ${root} -c max_connections=40`, '-w', '-t', '20', 'start']);
      source = new URL(`postgresql://cap_test_admin@127.0.0.1:${port}/postgres`);
    }
    admin = new Pool({ ...poolOptions, max: 2, connectionString: source.href });
    admin.on('error', () => { idleConnectionError = true; });
    const version = Number((await admin.query('SHOW server_version_num')).rows[0].server_version_num);
    if (version < 170000 || version >= 180000) throw prerequisite('The designated server must run PostgreSQL major version 17.');
    return {
      route: root === undefined ? 'designated-url-owned-databases' : 'owned-local-cluster',
      assertHealthy,
      async database() {
        assertHealthy();
        const name = `cap_test_${randomBytes(12).toString('hex')}`;
        const target = new URL(source);
        target.pathname = `/${name}`;
        await admin.query(`CREATE DATABASE "${name}"`);
        createdDatabases++;
        const entry = { pool: undefined };
        databases.set(name, entry);
        const pool = new Pool({ ...poolOptions, connectionString: target.href });
        pool.on('error', () => { idleConnectionError = true; });
        entry.pool = pool;
        assert.equal((await pool.query('SELECT current_database() AS name')).rows[0].name, name,
          'Refuse to install into any database other than the newly-created owned database.');
        return {
          name, url: target.href, pool,
          async close() {
            if (!databases.has(name)) return;
            await pool.end();
            entry.pool = undefined;
            await admin.query(`DROP DATABASE "${name}" WITH (FORCE)`);
            databases.delete(name);
            droppedDatabases++;
          },
        };
      },
      close,
    };
  } catch (error) {
    try { await close(); } catch (cleanup) { throw cleanup; }
    if (error.code === 'postgres_prerequisite') throw error;
    throw prerequisite('PostgreSQL 17 setup failed; check designated-role CREATE/DROP privileges or the configured initdb/pg_ctl binaries.');
  }
}

export async function verifyUrlOwnership(environment) {
  let source, designated, target;
  try {
    source = await environment.database();
    await source.pool.query('CREATE SCHEMA ownership_sentinel; CREATE TABLE ownership_sentinel.data (id integer PRIMARY KEY, value text NOT NULL)');
    await source.pool.query('INSERT INTO ownership_sentinel.data VALUES (1, $1), (2, $2)', ['source-data-must-survive', 'second-row']);
    const snapshot = async () => ({
      database: (await source.pool.query('SELECT oid::text, datname FROM pg_database WHERE datname=current_database()')).rows,
      objects: (await source.pool.query(`SELECT n.nspname, c.relname, c.relkind, c.oid::text,
        pg_get_userbyid(c.relowner) AS owner, c.relacl::text
        FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
        WHERE n.nspname NOT IN ('pg_catalog', 'information_schema') AND n.nspname NOT LIKE 'pg_toast%'
        ORDER BY n.nspname, c.relname`)).rows,
      schemas: (await source.pool.query('SELECT oid::text, nspname, nspowner::text, nspacl::text FROM pg_namespace ORDER BY nspname')).rows,
      data: (await source.pool.query('SELECT id, value, xmin::text FROM ownership_sentinel.data ORDER BY id')).rows,
    });
    const before = await snapshot();
    designated = await openPostgresProof(source.url);
    assert.equal(designated.route, 'designated-url-owned-databases');
    target = await designated.database();
    assert.notEqual(target.name, source.name);
    await installPaymentSchema(target.pool);
    const store = new PostgresPaymentStore(target.pool);
    await store.createBudget({ ownerId: 'url-proof-owner', budgetId: 'url-proof-budget', network: 'eip155:84532',
      payer: '0x1111111111111111111111111111111111111111', limitAtomic: '10000' });
    assert.equal((await store.getBudget({ ownerId: 'url-proof-owner', budgetId: 'url-proof-budget' })).heldAtomic, '0');
    const targetName = target.name;
    await target.close();
    target = undefined;
    assert.equal((await source.pool.query('SELECT count(*)::text AS n FROM pg_database WHERE datname=$1', [targetName])).rows[0].n, '0');
    const cleanup = await designated.close();
    assert.equal(cleanup.ownedDatabasesCreated, 1);
    assert.equal(cleanup.ownedDatabasesDropped, 1);
    designated.assertHealthy();
    designated = undefined;
    assert.deepEqual(await snapshot(), before, 'The source database, schema objects, row versions and data must remain untouched.');
    assert.equal((await source.pool.query("SELECT count(*)::text AS n FROM pg_namespace WHERE nspname='cap_payments'")).rows[0].n, '0');
    environment.assertHealthy();
    return { sourceRoute: environment.route, urlRoute: 'designated-url-owned-databases',
      sourceDatabasePreserved: true, sourceSchemasPreserved: true, sourceRowsPreserved: before.data.length,
      createdTargetDatabases: cleanup.ownedDatabasesCreated, droppedTargetDatabases: cleanup.ownedDatabasesDropped };
  } finally {
    try { await designated?.close(); }
    finally { await source?.close(); }
  }
}
