import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir, platform, arch, release, cpus } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { performance } from 'node:perf_hooks';
import { packPackages } from './packed-consumer.mjs';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const exec = promisify(execFile);
const report = {
  version: 1, mode: 'simulated', passed: false,
  scope: 'Local native SDK and upstream fixture end-to-end costs; not chain latency, PostgreSQL capacity, or a speedup comparison.',
  startedAt: new Date().toISOString(), environment: {}, artifacts: {}, imports: [], cells: [], errors: [],
};
const started = performance.now();
const safeError = error => ({ code: typeof error?.code === 'string' ? error.code : 'measurement_failed' });
const summary = values => {
  assert(values.length > 0 && values.every(value => Number.isFinite(value) && value >= 0));
  const sorted = [...values].sort((a, b) => a - b);
  return { count: values.length, minMs: sorted[0], medianMs: sorted[Math.ceil(sorted.length / 2) - 1],
    p95Ms: sorted[Math.ceil(sorted.length * 0.95) - 1], maxMs: sorted.at(-1),
    meanMs: values.reduce((sum, value) => sum + value, 0) / values.length };
};
assert.deepEqual(summary([9, 1, 5, 3]), { count: 4, minMs: 1, medianMs: 3, p95Ms: 9, maxMs: 9, meanMs: 4.5 });
assert.throws(() => summary([NaN]));
const fingerprint = async path => {
  const bytes = await readFile(path);
  return { bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') };
};
const version = async (command, args) => (await exec(command, args, { cwd: root })).stdout.trim();

async function measureCell(scheme, concurrency, run, dependencies) {
  const { SimulatedFacilitator, startFixture, MemoryPaymentStore, createAgentPayments } = dependencies;
  const cell = { scheme, concurrency, run, passed: false, warmups: [], purchases: [], errors: [] };
  report.cells.push(cell);
  const entered = performance.now();
  const model = new SimulatedFacilitator();
  let fixture;
  try {
    fixture = await startFixture(model);
    const initialBlock = await model.rpc({ method: 'eth_getBlockByNumber', params: ['finalized', false] });
    cell.modelTimestamp = initialBlock.timestamp;
    const store = new MemoryPaymentStore();
    const key = { ownerId: 'measurement-owner', budgetId: 'measurement-budget' };
    await store.createBudget({ ...key, network: model.network, payer: model.payer.address, limitAtomic: '10000000' });
    const agent = createAgentPayments({ network: model.network, store, resolveSigner: async () => model.payer,
      rpc: model.rpc, policy: { maxPerPaymentAtomic: '7000', allowedSchemes: ['exact', 'upto'],
        merchants: [{ origin: fixture.origin, payTo: model.merchant.address }] } });
    const amount = scheme === 'exact' ? '1000' : '1200';
    const purchase = async index => {
      const sample = { operationId: `purchase-${index}` };
      const begin = performance.now();
      try {
        const context = { ...key, agentId: 'measurement-agent', operationId: sample.operationId };
        const response = await agent.fetch(context, scheme === 'exact' ? fixture.exactUrl : fixture.uptoUrl,
          scheme === 'exact' ? undefined : fixture.uptoInit);
        assert.equal(response.status, 200);
        assert.equal(await response.text(), 'fixture-resource');
        const operation = await agent.reconcile(context);
        assert.equal(operation.state, 'settled');
        assert.equal(operation.finalAmountAtomic, amount);
        sample.passed = true;
      } catch (error) {
        sample.passed = false;
        sample.error = safeError(error);
        cell.errors.push({ operationId: sample.operationId, ...sample.error });
      } finally {
        sample.durationMs = performance.now() - begin;
      }
      return sample;
    };
    const batch = async (offset, count, destination) => {
      for (let i = 0; i < count; i += concurrency) {
        const samples = await Promise.all(Array.from({ length: Math.min(concurrency, count - i) },
          (_, j) => purchase(offset + i + j)));
        destination.push(...samples);
        assert(samples.every(sample => sample.passed), 'A purchase failed; see retained samples.');
      }
    };
    await batch(0, 20, cell.warmups);
    const measuredStart = performance.now();
    await batch(20, 100, cell.purchases);
    cell.measuredWallMs = performance.now() - measuredStart;
    assert.equal(new Set([...cell.warmups, ...cell.purchases].map(sample => sample.operationId)).size, 120);
    assert.equal(cell.warmups.length, 20);
    assert.equal(cell.purchases.length, 100);
    cell.budget = await store.getBudget(key);
    cell.counters = { ...model.counters };
    cell.charges = [...model.charges];
    assert.equal(cell.budget.heldAtomic, '0');
    assert.equal(cell.budget.spentAtomic, (120n * BigInt(amount)).toString());
    assert.equal(model.counters.signerCalls, 120);
    assert.equal(model.counters.signatures, 120);
    assert.equal(model.counters.settlements, 120);
    assert.equal(model.charges.length, 120);
    assert(model.charges.every(charge => charge === amount));
    assert.equal(fixture.controls.work, 120);
    if (scheme === 'upto') assert.equal(fixture.controls.input, 'fixture-input');
    const finalBlock = await model.rpc({ method: 'eth_getBlockByNumber', params: ['finalized', false] });
    assert.equal(finalBlock.timestamp, initialBlock.timestamp);
    cell.statistics = summary(cell.purchases.map(sample => sample.durationMs));
    cell.passed = true;
  } catch (error) {
    cell.errors.push(safeError(error));
    throw error;
  } finally {
    model.stop();
    if (fixture) await fixture.close();
    cell.wallMs = performance.now() - entered;
  }
}

let temporary;
try {
  report.environment = { platform: platform(), arch: arch(), osRelease: release(), node: process.version,
    v8: process.versions.v8, cpu: cpus()[0]?.model, logicalCpus: cpus().length,
    rust: await version('rustc', ['--version']), cargo: await version('cargo', ['--version']),
    npm: await version('npm', ['--version']) };
  for (const path of ['Cargo.lock', 'package-lock.json', 'packages/payments/package.json', 'packages/testing/package.json']) {
    report.artifacts[path] = await fingerprint(join(root, path));
  }
  report.artifacts.native = await fingerprint(join(root, 'packages/payments/native/cap-native.darwin-arm64.node'));
  temporary = await mkdtemp(join(tmpdir(), 'cap-measure-'));
  const packed = await packPackages(temporary);
  for (const name of ['payments', 'testing']) {
    const { metadata, path } = packed[name];
    report.artifacts[name] = { ...await fingerprint(path), filename: metadata.filename,
      packedBytes: metadata.size, unpackedBytes: metadata.unpackedSize,
      shasum: metadata.shasum, integrity: metadata.integrity };
  }
  const payerUrl = pathToFileURL(join(root, 'packages/payments/dist/index.js')).href;
  for (let i = 0; i < 10; i++) {
    const begin = performance.now();
    const child = await exec(process.execPath, ['--input-type=module', '-e',
      `const begin=performance.now();await import(${JSON.stringify(payerUrl)});process.stdout.write(JSON.stringify({durationMs:performance.now()-begin}));`],
    { cwd: root, timeout: 30000 });
    const sample = JSON.parse(child.stdout);
    assert(Number.isFinite(sample.durationMs) && sample.durationMs >= 0);
    report.imports.push({ ...sample, wallMs: performance.now() - begin });
  }
  report.importStatistics = summary(report.imports.map(sample => sample.durationMs));
  report.environment.packages = {};
  for (const name of ['payments', 'testing']) {
    const manifest = JSON.parse(await readFile(join(root, `packages/${name}/package.json`), 'utf8'));
    report.environment.packages[manifest.name] = manifest.version;
  }
  const [{ createAgentPayments }, { MemoryPaymentStore }, { SimulatedFacilitator }, { startFixture }] = await Promise.all([
    import('../packages/payments/dist/index.js'), import('../packages/payments/dist/testing.js'),
    import('../packages/testing/dist/facilitator.js'), import('../packages/testing/dist/fixture.js'),
  ]);
  for (const scheme of ['exact', 'upto']) {
    for (const concurrency of [1, 16]) {
      for (let run = 1; run <= 3; run++) {
        await measureCell(scheme, concurrency, run, { createAgentPayments, MemoryPaymentStore, SimulatedFacilitator, startFixture });
      }
    }
  }
  assert.equal(report.cells.length, 12);
  report.passed = report.cells.every(cell => cell.passed);
} catch (error) {
  report.errors.push(safeError(error));
  process.exitCode = 1;
} finally {
  try { if (temporary) await rm(temporary, { recursive: true, force: true }); }
  catch (error) { report.errors.push(safeError(error)); report.passed = false; process.exitCode = 1; }
  report.finishedAt = new Date().toISOString();
  report.wallMs = performance.now() - started;
  await mkdir(join(root, '.artifacts'), { recursive: true });
  await writeFile(join(root, '.artifacts/measure.json'), `${JSON.stringify(report, null, 2)}\n`);
}
console.log(JSON.stringify({ passed: report.passed, report: '.artifacts/measure.json', cells: report.cells.length, wallMs: report.wallMs }));
