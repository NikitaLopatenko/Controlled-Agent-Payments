import { pathToFileURL } from 'node:url';
import { runPaymentTests } from './runner.js';
import { selectOptions, type AgentTestFactory, type PaymentTestOptions, type ScenarioId, type TestReport } from './report.js';

let interrupted = false;
let running = false;
const interrupt = (): void => {
  interrupted = true;
  if (!running) process.exit(130);
};
process.on('SIGINT', interrupt);
function finish(message: { kind: 'configuration' } | { kind: 'report'; report: TestReport }, code: number): void {
  process.exitCode = interrupted ? 130 : code;
  if (!process.send) { process.exitCode = 2; return; }
  process.send(message, () => {
    if (process.connected) process.disconnect();
  });
}
try {
  const { ids } = selectOptions({ scenarios: JSON.parse(process.argv[2] ?? '') as ScenarioId[] });
  let options: PaymentTestOptions = { scenarios: ids };
  const modulePath = process.argv[3];
  if (modulePath) {
    const loaded: unknown = await import(pathToFileURL(modulePath).href);
    if (loaded === null || typeof loaded !== 'object' || !('default' in loaded) || typeof loaded.default !== 'function') throw new Error();
    options = { scenarios: ids, createAgent: loaded.default as AgentTestFactory };
  }
  running = true;
  const report = await runPaymentTests(options);
  finish({ kind: 'report', report }, report.passed ? 0 : 1);
} catch {
  finish({ kind: 'configuration' }, 2);
}
