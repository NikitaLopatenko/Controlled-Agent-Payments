#!/usr/bin/env node
// Supervision follows the Apache-2.0 UBB CLI; CAP keeps all payment code in its worker.
import { fork } from 'node:child_process';
import { stat } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  SCENARIO_IDS, SCENARIO_TIMEOUT, WORKER_TIMEOUT,
  type ScenarioId, type TestEvent, type TestReport,
} from './report.js';

const help = `Usage: cap test [--scenario <id>]... [--json] [--agent-module <local.mjs>]
       cap --help

SIMULATED: no blockchain transactions
Runs local Base Sepolia/USDC fixtures; no wallet or network credentials required.
Amounts are integer USDC atomic units (1 USDC = 1000000 atomic units).
--agent-module loads trusted local code, not a sandbox. Never supply production wallet credentials.
Scenarios: ${SCENARIO_IDS.join(', ')}
Exit codes: 0 all passed; 1 assertion/deadline failure; 2 invalid arguments/module/configuration; 130 interrupted.
`;
interface Arguments { json: boolean; scenarios: ScenarioId[]; agentModule?: string }
function parse(args: string[]): Arguments | 'help' {
  if (args.length === 1 && args[0] === '--help' ||
    args.length === 2 && args[0] === 'test' && args[1] === '--help') return 'help';
  if (args[0] !== 'test') throw new Error();
  const result: Arguments = { json: false, scenarios: [] };
  for (let index = 1; index < args.length; index++) {
    const flag = args[index];
    if (flag === '--json') {
      if (result.json) throw new Error();
      result.json = true;
      continue;
    }
    if (flag !== '--scenario' && flag !== '--agent-module') throw new Error();
    const value = args[++index];
    if (!value || value.startsWith('-') || value.includes('\0')) throw new Error();
    if (flag === '--agent-module') {
      if (result.agentModule || !value.endsWith('.mjs') || /^[a-z][a-z\d+.-]*:/i.test(value)) throw new Error();
      result.agentModule = resolve(value);
    } else {
      if (!SCENARIO_IDS.includes(value as ScenarioId)) throw new Error();
      if (!result.scenarios.includes(value as ScenarioId)) result.scenarios.push(value as ScenarioId);
    }
  }
  if (result.scenarios.length === 0) result.scenarios.push(...SCENARIO_IDS);
  return result;
}
function diagnostic(): void {
  process.stderr.write('Invalid arguments, local agent module, or test configuration. Use --help.\n');
}
const eventFields = ['origin', 'operationId', 'state', 'heldAtomic', 'spentAtomic', 'amountAtomic', 'httpStatus', 'transactionHash'] as const;
function human(report: TestReport): string {
  const lines = ['SIMULATED: no blockchain transactions', `Profile: ${report.profile}; amounts in USDC atomic units (1000000 = 1 USDC).`];
  for (const scenario of report.scenarios) {
    if (scenario.passed) {
      let summary = `PASS ${scenario.id}`;
      for (let index = scenario.events.length - 1; index >= 0; index--) {
        const event = scenario.events[index]!;
        if (event.heldAtomic !== undefined || event.spentAtomic !== undefined) {
          if (event.heldAtomic !== undefined && event.spentAtomic !== undefined) {
            summary += ` heldAtomic=${event.heldAtomic} spentAtomic=${event.spentAtomic}`;
          }
          break;
        }
      }
      lines.push(summary);
      continue;
    }
    lines.push(`FAIL ${scenario.id}`);
    for (const assertion of scenario.assertions) lines.push(`  ${assertion.passed ? 'PASS' : 'FAIL'} ${assertion.name}`);
    for (const event of scenario.events) {
      const details = eventFields.filter(key => event[key] !== undefined).map(key => `${key}=${event[key]}`);
      if (details.length) lines.push(`  ${details.join(' ')}`);
    }
    if (scenario.error) lines.push(`  ${scenario.error.code}: ${scenario.error.message}`);
  }
  lines.push(`${report.scenarios.filter(item => item.passed).length}/${report.scenarios.length} scenarios passed; ${report.passed ? 'PASS' : 'FAIL'}.`);
  return lines.join('\n') + '\n';
}
function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function safeEvent(value: unknown): TestEvent {
  if (!object(value)) throw new Error();
  const result: Record<string, string | number> = {};
  for (const key of eventFields) {
    const field = value[key];
    if (field === undefined) continue;
    let valid = false;
    if (key === 'httpStatus') valid = Number.isInteger(field) && Number(field) >= 100 && Number(field) <= 599;
    else if (typeof field === 'string') {
      if (key === 'origin') {
        const url = new URL(field);
        valid = url.origin === field && (url.protocol === 'http:' || url.protocol === 'https:');
      } else if (key === 'operationId') valid = /^[a-zA-Z0-9_-]{1,256}$/.test(field);
      else if (key === 'state') valid = ['requesting', 'signing', 'submitted', 'reported', 'unknown', 'settled', 'unpaid'].includes(field);
      else if (key === 'transactionHash') valid = /^0x[\da-fA-F]{64}$/.test(field);
      else valid = /^(0|[1-9]\d{0,77})$/.test(field);
    }
    if (!valid) throw new Error();
    result[key] = field as string | number;
  }
  return result;
}
function safeReport(value: unknown, args: Arguments): TestReport | undefined {
  try {
    const profile = args.agentModule ? 'agent-integration' : 'builtin';
    if (!object(value) || value.version !== 1 || value.mode !== 'simulated' || value.profile !== profile ||
      typeof value.passed !== 'boolean' || !Array.isArray(value.scenarios) || value.scenarios.length !== args.scenarios.length) throw new Error();
    const scenarios = value.scenarios.map((item: unknown, index) => {
      if (!object(item) || item.id !== args.scenarios[index] || typeof item.passed !== 'boolean' ||
        !Array.isArray(item.assertions) || !Array.isArray(item.events)) throw new Error();
      const assertions = item.assertions.map((assertion: unknown) => {
        if (!object(assertion) || typeof assertion.name !== 'string' || !/^[\x20-\x7e]{1,256}$/.test(assertion.name) ||
          typeof assertion.passed !== 'boolean') throw new Error();
        return { name: assertion.name, passed: assertion.passed };
      });
      let error: { code: 'scenario_timeout' | 'scenario_failed'; message: string } | undefined;
      if (item.error !== undefined) {
        if (!object(item.error) || item.error.code !== 'scenario_timeout' && item.error.code !== 'scenario_failed') throw new Error();
        error = { code: item.error.code, message: item.error.code === 'scenario_timeout' ? SCENARIO_TIMEOUT : 'Scenario assertions failed.' };
      }
      return { id: args.scenarios[index]!, passed: item.passed, assertions,
        events: item.events.map(safeEvent), ...(error ? { error } : {}) };
    });
    if (value.passed !== scenarios.every(item => item.passed)) throw new Error();
    return { version: 1, mode: 'simulated', profile, passed: value.passed, scenarios };
  } catch { return undefined; }
}
function timeoutReport(args: Arguments): TestReport {
  return { version: 1, mode: 'simulated', profile: args.agentModule ? 'agent-integration' : 'builtin', passed: false,
    scenarios: args.scenarios.map(id => ({ id, passed: false, assertions: [], events: [],
      error: { code: 'scenario_timeout', message: WORKER_TIMEOUT } })) };
}
async function main(): Promise<void> {
  let args: Arguments | 'help';
  try {
    args = parse(process.argv.slice(2));
    if (args !== 'help' && args.agentModule && !(await stat(args.agentModule)).isFile()) throw new Error();
  } catch { diagnostic(); process.exitCode = 2; return; }
  if (args === 'help') { process.stdout.write(help); return; }
  const selected = args;
  const expiresAt = performance.now() + 15_000;
  const child = fork(fileURLToPath(new URL('./worker.js', import.meta.url)),
    [JSON.stringify(selected.scenarios), ...(selected.agentModule ? [selected.agentModule] : [])],
    { stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
  let report: TestReport | undefined;
  let configuration = false;
  let interrupted = false;
  let expired = false;
  let shutdownDeadline: NodeJS.Timeout | undefined;
  const workerDeadline = setTimeout(() => { expired = true; child.kill('SIGKILL'); }, Math.max(0, expiresAt - performance.now()));
  const interrupt = (): void => {
    if (interrupted) return;
    interrupted = true;
    clearTimeout(workerDeadline);
    child.kill('SIGINT');
    shutdownDeadline = setTimeout(() => child.kill('SIGKILL'), 5_000);
  };
  process.on('SIGINT', interrupt);
  child.on('message', (message: unknown) => {
    if (report || configuration || !object(message)) return;
    if (message.kind === 'configuration') configuration = true;
    else if (message.kind === 'report') {
      report = safeReport(message.report, selected);
      if (!report) configuration = true;
    }
  });
  child.on('error', () => { configuration = true; });
  child.once('close', (code, signal) => {
    process.removeListener('SIGINT', interrupt);
    clearTimeout(workerDeadline);
    clearTimeout(shutdownDeadline);
    if (interrupted || code === 130 || signal === 'SIGINT') { process.exitCode = 130; return; }
    if (expired || performance.now() >= expiresAt) report = timeoutReport(selected);
    else if (configuration || !report || code !== (report.passed ? 0 : 1)) {
      diagnostic(); process.exitCode = 2; return;
    }
    process.stdout.write(selected.json ? JSON.stringify(report) + '\n' : human(report));
    process.exitCode = report.passed ? 0 : 1;
  });
}
await main();
