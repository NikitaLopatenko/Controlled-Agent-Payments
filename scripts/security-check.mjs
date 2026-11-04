import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const artifacts = new URL('../.artifacts/', import.meta.url);
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const count = value => Number.isSafeInteger(value) && value >= 0;

function classify(name, run) {
  const reasons = [];
  if (run.exitCode !== 0 || run.signal || run.error) reasons.push('scanner_failed');
  let report;
  try { report = JSON.parse(run.stdout); } catch { reasons.push('malformed_report'); }
  let warnings = {};
  let rustSecRevision = null;
  if (report !== undefined) {
    if (!object(report) || report.error) reasons.push('scan_error');
    else if (name === 'npm') {
      const totals = report.metadata?.vulnerabilities;
      const levels = ['info', 'low', 'moderate', 'high', 'critical'];
      if (report.auditReportVersion !== 2 || !object(report.vulnerabilities) || !object(totals)
        || ![...levels, 'total'].every(key => count(totals[key]))
        || totals.total !== levels.reduce((sum, key) => sum + totals[key], 0)
        || Object.keys(report.vulnerabilities).length !== totals.total) reasons.push('malformed_report');
      else if (totals.total !== 0) reasons.push('vulnerabilities_found');
      warnings = report.warnings ?? {};
    } else {
      const vulnerabilities = report.vulnerabilities;
      const settings = report.settings;
      rustSecRevision = report.database?.['last-commit'] ?? null;
      if (!object(vulnerabilities) || typeof vulnerabilities.found !== 'boolean'
        || !count(vulnerabilities.count) || !Array.isArray(vulnerabilities.list)
        || vulnerabilities.count !== vulnerabilities.list.length
        || vulnerabilities.found !== (vulnerabilities.count > 0)
        || !object(report.warnings) || !Object.values(report.warnings).every(Array.isArray)
        || !count(report.database?.['advisory-count'])
        || typeof rustSecRevision !== 'string' || !/^[0-9a-f]{40}$/i.test(rustSecRevision)
        || !count(report.lockfile?.['dependency-count']) || !object(settings)) reasons.push('malformed_report');
      else {
        if (vulnerabilities.found) reasons.push('vulnerabilities_found');
        if (!Array.isArray(settings.ignore) || settings.ignore.length !== 0 || settings.severity !== null
          || !Array.isArray(settings.target_arch) || settings.target_arch.length !== 0
          || !Array.isArray(settings.target_os) || settings.target_os.length !== 0
          || !Array.isArray(settings.informational_warnings)
          || !['unmaintained', 'unsound', 'notice'].every(kind => settings.informational_warnings.includes(kind))) reasons.push('filtered_scan');
      }
      warnings = report.warnings ?? {};
    }
  }
  return { passed: reasons.length === 0, reasons: [...new Set(reasons)], warnings, rustSecRevision };
}

function selfCheck() {
  const run = { exitCode: 0, signal: null, error: null, stdout: '{}' };
  assert.equal(classify('npm', run).passed, false);
  assert.equal(classify('cargo', { ...run, stdout: '{' }).passed, false);
  const finding = { auditReportVersion: 2, vulnerabilities: { vulnerable: {} }, metadata: {
    vulnerabilities: { info: 0, low: 0, moderate: 0, high: 1, critical: 0, total: 1 },
  } };
  assert.ok(classify('npm', { ...run, stdout: JSON.stringify(finding) }).reasons.includes('vulnerabilities_found'));
  assert.ok(classify('npm', { ...run, exitCode: 1 }).reasons.includes('scanner_failed'));
  const filteredCargo = { vulnerabilities: { found: false, count: 0, list: [] }, warnings: {},
    database: { 'advisory-count': 1, 'last-commit': 'a'.repeat(40) }, lockfile: { 'dependency-count': 1 },
    settings: { ignore: [], severity: null, target_arch: [], target_os: [], informational_warnings: [] } };
  assert.ok(classify('cargo', { ...run, stdout: JSON.stringify(filteredCargo) }).reasons.includes('filtered_scan'));
}

function execute(command, args) {
  const startedAt = new Date().toISOString();
  return new Promise(resolve => {
    let stdout = '';
    let stderr = '';
    let error = null;
    const child = spawn(command, args, { cwd: root, env: process.env, stdio: ['ignore', 'pipe', 'pipe'] });
    const timer = setTimeout(() => {
      error = 'Command exceeded its 300000 ms deadline.';
      child.kill('SIGKILL');
    }, 300_000);
    child.stdout.setEncoding('utf8').on('data', chunk => { stdout += chunk; });
    child.stderr.setEncoding('utf8').on('data', chunk => { stderr += chunk; });
    child.on('error', failure => { error = failure.message; });
    child.on('close', (exitCode, signal) => {
      clearTimeout(timer);
      resolve({ command: [command, ...args], startedAt, finishedAt: new Date().toISOString(), exitCode, signal, error, stdout, stderr });
    });
  });
}

selfCheck();
await mkdir(artifacts, { recursive: true });
const startedAt = new Date().toISOString();
const [npm, cargo, npmVersion, cargoAuditVersion, cargoVersion, rustcVersion] = await Promise.all([
  execute('npm', ['audit', '--json', '--include=dev', '--include=optional', '--include=peer']),
  execute('cargo', ['audit', '--file', 'Cargo.lock', '--json']),
  execute('npm', ['--version']), execute('cargo', ['audit', '--version']),
  execute('cargo', ['--version']), execute('rustc', ['--version']),
]);
const scans = {};
for (const [name, run] of [['npm', npm], ['cargo', cargo]]) {
  const rawReport = `security-${name}.stdout.json`;
  const rawStderr = `security-${name}.stderr.txt`;
  await writeFile(new URL(rawReport, artifacts), run.stdout);
  await writeFile(new URL(rawStderr, artifacts), run.stderr);
  const { stdout, stderr, ...execution } = run;
  scans[name] = { ...execution, rawReport, rawStderr, ...classify(name, run) };
}
const tools = { node: process.version, npm: npmVersion, cargoAudit: cargoAuditVersion, cargo: cargoVersion, rustc: rustcVersion };
const versionFailures = Object.values(tools).filter(value => object(value) && (value.exitCode !== 0 || value.error || value.signal)).length;
const auditVersionMatches = cargoAuditVersion.stdout.trim().split(/\s+/).at(-1) === '0.22.2';
const evidence = { version: 1, startedAt, finishedAt: new Date().toISOString(),
  passed: scans.npm.passed && scans.cargo.passed && versionFailures === 0 && auditVersionMatches,
  environment: { platform: process.platform, arch: process.arch }, tools,
  toolVersionErrors: { commandFailures: versionFailures, cargoAuditVersionMismatch: !auditVersionMatches }, scans };
await writeFile(new URL('security.json', artifacts), `${JSON.stringify(evidence, null, 2)}\n`);
console.log(JSON.stringify({ passed: evidence.passed, evidence: '.artifacts/security.json', scans: {
  npm: scans.npm.reasons, cargo: scans.cargo.reasons,
} }));
if (!evidence.passed) process.exitCode = 1;
