import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { access, mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

const root = fileURLToPath(new URL('../', import.meta.url));
const cli = fileURLToPath(new URL('../packages/testing/dist/cli.js', import.meta.url));
const ids = ['exact-payment', 'operator-budget-recovery'];
const fixture = name => `tests/fixtures/cap-${name}.mjs`;
const eventFields = new Set(['origin', 'operationId', 'state', 'heldAtomic', 'spentAtomic', 'amountAtomic', 'httpStatus', 'transactionHash']);
const diagnostic = 'Invalid arguments, local agent module, or test configuration. Use --help.\n';
function launch(args, env = {}, nodeArgs) {
  const child = spawn(process.execPath, nodeArgs ?? [cli, ...args], {
    cwd: root, env: { ...process.env, ...env }, detached: true, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '', stderr = '';
  child.stdout.setEncoding('utf8').on('data', data => { stdout += data; });
  child.stderr.setEncoding('utf8').on('data', data => { stderr += data; });
  const completion = Promise.withResolvers();
  child.once('error', completion.reject);
  child.once('close', (code, signal) => completion.resolve({ code, signal, stdout, stderr }));
  const stop = () => {
    if (child.exitCode !== null || child.signalCode !== null || !child.pid) return;
    try { process.kill(-child.pid, 'SIGKILL'); } catch (error) { if (error.code !== 'ESRCH') throw error; }
  };
  const guard = setTimeout(stop, 25_000);
  guard.unref();
  void completion.promise.then(() => clearTimeout(guard), () => clearTimeout(guard));
  return { child, done: completion.promise, stop };
}
async function run(args, env) { return launch(args, env).done; }
function clean(result) {
  assert.doesNotMatch(result.stdout + result.stderr,
    /CAP_PRIVATE_LOG_SENTINEL|arbitrary (?:module|factory) exception|SyntaxError:|TypeError:|at file:\/\/|tests\/fixtures\/cap-/);
}
function report(result, code = 0) {
  assert.equal(result.code, code, result.stderr || result.stdout);
  assert.equal(result.signal, null);
  assert.equal(result.stderr, '');
  clean(result);
  assert.equal(result.stdout.trim().split('\n').length, 1, 'stdout is exactly one JSON report');
  const value = JSON.parse(result.stdout);
  assert.deepEqual(Object.keys(value).sort(), ['mode', 'passed', 'profile', 'scenarios', 'version']);
  assert.equal(value.version, 1);
  assert.equal(value.mode, 'simulated');
  assert.equal(value.passed, code === 0);
  for (const scenario of value.scenarios) {
    for (const event of scenario.events) assert.ok(Object.keys(event).every(key => eventFields.has(key)), 'events contain only safe fields');
  }
  return value;
}
function configuration(result) {
  assert.equal(result.code, 2, result.stdout + result.stderr);
  assert.equal(result.signal, null);
  assert.equal(result.stdout, '', 'configuration errors cannot print a cached or partial report');
  assert.equal(result.stderr, diagnostic);
  clean(result);
}
function transitions(scenario) {
  return scenario.events.filter(event => event.state).map(({ operationId, state, heldAtomic, spentAtomic }) => [operationId, state, heldAtomic, spentAtomic]);
}
function accounting(value) {
  const exact = value.scenarios.find(item => item.id === 'exact-payment');
  if (exact) {
    assert.deepEqual(exact.events.filter(event => event.state).map(({ state, heldAtomic, spentAtomic }) => [state, heldAtomic, spentAtomic]),
      [['reported', '1000', '0'], ['settled', '0', '1000']]);
  }
  const operator = value.scenarios.find(item => item.id === 'operator-budget-recovery');
  if (operator) assert.deepEqual(transitions(operator), [
    ['operator-first', 'signing', '7000', '0'], ['operator-competing', 'unpaid', '7000', '0'],
    ['operator-first', 'unknown', '7000', '0'], ['operator-first', 'settled', '0', '1200'],
    ['operator-fresh', 'reported', '7000', '1200'], ['operator-fresh', 'settled', '0', '2400'],
  ]);
}
async function temporary(action) {
  const directory = await mkdtemp(join(tmpdir(), 'cap-cli-'));
  try { return await action(directory); }
  finally { await rm(directory, { recursive: true, force: true }); }
}
async function waitReady(path, done) {
  let closed;
  void done.then(result => { closed = result; });
  const until = performance.now() + 7_000;
  while (performance.now() < until) {
    try { await access(path); return; } catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (closed) assert.fail('CLI closed before fixture readiness: ' + JSON.stringify(closed));
    await delay(20);
  }
  assert.fail('Selected module did not reach its readiness checkpoint');
}

test('CLI help describes only the two real payer scenarios and safe exit codes', async () => {
  for (const args of [['--help'], ['test', '--help']]) {
    const result = await run(args);
    assert.equal(result.code, 0);
    assert.equal(result.stderr, '');
    assert.match(result.stdout, /^Usage: cap test /);
    assert.match(result.stdout, /SIMULATED: no blockchain transactions/);
    assert.match(result.stdout, /trusted local code, not a sandbox/);
    assert.match(result.stdout, /exact-payment, operator-budget-recovery/);
    assert.match(result.stdout, /130 interrupted/);
    assert.doesNotMatch(result.stdout, /seller|--module|browser/);
  }
});

test('CLI built-in JSON runs both native integration cases and closes cleanly', async () => {
  const value = report(await run(['test', '--json']));
  assert.equal(value.profile, 'builtin');
  assert.deepEqual(value.scenarios.map(item => item.id), ids);
  assert.ok(value.scenarios.every(item => item.passed && item.assertions.length > 0 && item.assertions.every(assertion => assertion.passed)));
  accounting(value);
});

test('CLI repeated selections preserve order and deduplicate', async () => {
  const value = report(await run(['test', '--scenario', ids[1], '--scenario', ids[0], '--scenario', ids[1], '--json']));
  assert.deepEqual(value.scenarios.map(item => item.id), [ids[1], ids[0]]);
  accounting(value);
});

test('CLI explicitly imports the real local factory once per case and discards its logs', async () => {
  await temporary(async directory => {
    const imported = join(directory, 'imported'), factories = join(directory, 'factories');
    const value = report(await run(['test', '--agent-module', fixture('agent'), '--json'], {
      CAP_CLI_IMPORT_MARKER: imported, CAP_CLI_FACTORY_MARKER: factories,
    }));
    assert.equal(value.profile, 'agent-integration');
    assert.deepEqual(value.scenarios.map(item => item.id), ids);
    assert.equal(await readFile(imported, 'utf8'), 'import\n');
    assert.equal(await readFile(factories, 'utf8'), 'factory\nfactory\n');
    accounting(value);
    const absolute = fileURLToPath(new URL('./fixtures/cap-agent.mjs', import.meta.url));
    const selected = report(await run(['test', '--agent-module', absolute, '--scenario', ids[0], '--json']));
    assert.equal(selected.profile, 'agent-integration');
    assert.deepEqual(selected.scenarios.map(item => item.id), [ids[0]]);
    accounting(selected);
  });
});

test('CLI human output summarizes final balances for built-in and injected profiles', async () => {
  for (const moduleArgs of [[], ['--agent-module', fixture('agent')]]) {
    const result = await run(['test', ...moduleArgs]);
    assert.equal(result.code, 0, result.stderr || result.stdout);
    assert.equal(result.signal, null);
    assert.equal(result.stderr, '');
    clean(result);
    assert.match(result.stdout, /^SIMULATED: no blockchain transactions\n/);
    assert.match(result.stdout, new RegExp(`Profile: ${moduleArgs.length ? 'agent-integration' : 'builtin'};`));
    assert.match(result.stdout, /^PASS exact-payment heldAtomic=0 spentAtomic=1000$/m);
    assert.match(result.stdout, /^PASS operator-budget-recovery heldAtomic=0 spentAtomic=2400$/m);
    assert.match(result.stdout, /2\/2 scenarios passed; PASS\.\n$/);
    assert.doesNotMatch(result.stdout, /^  |(?:origin|operationId|transactionHash)=/m);
  }
});

test('CLI mixed results retain failed diagnostics and summarize passing scenarios', async () => {
  const result = await run(['test', '--agent-module', fixture('mixed')]);
  assert.equal(result.code, 1, result.stderr || result.stdout);
  assert.equal(result.signal, null);
  assert.equal(result.stderr, '');
  clean(result);
  const passedIndex = result.stdout.indexOf('PASS operator-budget-recovery');
  assert.ok(passedIndex >= 0);
  const failed = result.stdout.slice(0, passedIndex);
  assert.match(failed, /^FAIL exact-payment$/m);
  assert.match(failed, /^  PASS /m);
  assert.match(failed, /^  FAIL /m);
  assert.match(failed, /^  origin=https?:\/\/\S+/m);
  assert.match(failed, /^  scenario_failed:/m);
  const passed = result.stdout.slice(passedIndex);
  assert.match(passed, /^PASS operator-budget-recovery heldAtomic=0 spentAtomic=2400$/m);
  assert.doesNotMatch(passed, /^  |(?:origin|operationId|transactionHash)=/m);
  assert.match(passed, /1\/2 scenarios passed; FAIL\.\n$/);
});

test('CLI invalid flags, values, IDs and local paths fail before importing a module', async () => {
  await temporary(async directory => {
    const imported = join(directory, 'imported'), notFile = join(directory, 'directory.mjs');
    await mkdir(notFile);
    const agent = fixture('agent');
    for (const args of [
      [], ['other'], ['test', '--wat'], ['test', '--module', agent], ['test', '--scenario'],
      ['test', '--scenario', '--json'], ['test', '--scenario', 'unknown'], ['test', '--agent-module'],
      ['test', '--agent-module', '--json'], ['test', '--agent-module', 'https://example.invalid/agent.mjs'],
      ['test', '--agent-module', 'file:///tmp/agent.mjs'], ['test', '--agent-module', 'data:text/javascript,agent.mjs'],
      ['test', '--agent-module', 'agent.js'], ['test', '--agent-module', 'tests/fixtures/cap-missing.mjs'],
      ['test', '--agent-module', notFile], ['test', '--agent-module', agent, '--agent-module', agent],
      ['test', '--agent-module', agent, '--agent-module', fixture('fake')],
      ['test', '--agent-module', agent, '--scenario', 'unknown'],
      ['test', '--scenario', 'unknown', '--agent-module', agent],
      ['test', '--agent-module', agent, '--unknown'], ['test', '--json', '--json'],
    ]) configuration(await run(args, { CAP_CLI_IMPORT_MARKER: imported }));
    await assert.rejects(access(imported), { code: 'ENOENT' });
    const nodeArgs = ['--input-type=module', '--eval',
      `process.argv = [process.execPath, ${JSON.stringify(cli)}, 'test', '--agent-module', ${JSON.stringify(agent + '\0')}]; await import(${JSON.stringify(new URL('../packages/testing/dist/cli.js', import.meta.url).href)});`];
    configuration(await launch([], { CAP_CLI_IMPORT_MARKER: imported }, nodeArgs).done);
    await assert.rejects(access(imported), { code: 'ENOENT' });
  });
});

test('CLI missing/default-malformed/throwing modules and invalid factories are sanitized configuration errors', async () => {
  for (const name of ['default-missing', 'malformed', 'syntax-error', 'import-throw', 'factory-throw', 'invalid-agent']) {
    configuration(await run(['test', '--agent-module', fixture(name), '--scenario', ids[0], '--json']));
  }
});

test('CLI fake 200 payer fails owned-ledger and independent payment checks without falling back', async () => {
  const value = report(await run(['test', '--agent-module', fixture('fake'), '--json']), 1);
  assert.equal(value.profile, 'agent-integration');
  assert.deepEqual(value.scenarios.map(item => item.id), ids);
  for (const scenario of value.scenarios) {
    assert.equal(scenario.passed, false);
    assert.ok(scenario.error || scenario.assertions.some(assertion => !assertion.passed));
    assert.deepEqual(scenario.events.filter(event => event.state), [], 'a fake payer created no observed ledger transition');
  }
});

test('CLI fixed async and entire-worker deadlines apply independently without timer overrides', { concurrency: true, timeout: 24_000 }, async t => {
  await Promise.all([
    ...['factory', 'fetch', 'reconcile'].map(method => t.test(`10s never-resolving ${method}`, async () => {
      const started = performance.now();
      const value = report(await run(['test', '--agent-module', fixture(`never-${method}`), '--scenario', ids[0], '--json']), 1);
      assert.equal(value.profile, 'agent-integration');
      assert.deepEqual(value.scenarios.map(item => item.id), [ids[0]]);
      assert.deepEqual(value.scenarios[0].error, { code: 'scenario_timeout', message: 'Scenario exceeded its 10000 ms deadline.' });
      assert.ok(performance.now() - started >= 9_500, 'the real 10s deadline was not shortened');
    })),
    ...['import', 'factory', 'shutdown'].map(phase => t.test(`15s blocked ${phase}`, async () => {
      await temporary(async directory => {
        const ready = join(directory, 'ready');
        const started = performance.now();
        const selected = [ids[1], ids[0]];
        const value = report(await run(['test', '--agent-module', fixture(`block-${phase}`),
          '--scenario', selected[0], '--scenario', selected[1], '--json'], { CAP_CLI_READY: ready }), 1);
        assert.equal(value.profile, 'agent-integration');
        assert.deepEqual(value.scenarios.map(item => item.id), selected);
        for (const scenario of value.scenarios) {
          assert.equal(scenario.passed, false);
          assert.deepEqual(scenario.assertions, [], 'hard timeout discards even a cached passing report');
          assert.deepEqual(scenario.events, []);
          assert.deepEqual(scenario.error, { code: 'scenario_timeout', message: 'Test worker exceeded its 15000 ms deadline.' });
        }
        assert.ok(performance.now() - started >= 14_500, 'the real 15s deadline was not shortened');
        assert.ok(performance.now() - started < 20_000, 'blocked code cannot escape the worker deadline');
        assert.match(await readFile(ready, 'utf8'), phase === 'shutdown' ? /shutdown after report/ : new RegExp(phase));
      });
    })),
  ]);
});

test('CLI SIGINT wins over pending work and cached reports with its separate 5s shutdown bound', { concurrency: true, timeout: 14_000 }, async t => {
  await Promise.all(['pending-import', 'never-fetch', 'block-factory', 'block-shutdown'].map(name =>
    t.test(name, async () => {
      await temporary(async directory => {
        const ready = join(directory, 'ready');
        const execution = launch(['test', '--agent-module', fixture(name), '--scenario', ids[0], '--json'], { CAP_CLI_READY: ready });
        try {
          await waitReady(ready, execution.done);
          const interruptedAt = performance.now();
          execution.child.kill('SIGINT');
          const result = await execution.done;
          assert.equal(result.code, 130, result.stdout + result.stderr);
          assert.equal(result.signal, null);
          assert.equal(result.stdout, '', 'interrupt cannot leak a cached passing or timeout report');
          assert.equal(result.stderr, '');
          clean(result);
          const elapsed = performance.now() - interruptedAt;
          assert.ok(elapsed < 7_000, 'interrupt does not wait for the 15s worker deadline');
          if (name.startsWith('block-')) assert.ok(elapsed >= 4_500, 'blocked shutdown uses the actual separate 5s forced-kill deadline');
        } finally {
          execution.stop();
          await execution.done;
        }
      });
    })));
});
