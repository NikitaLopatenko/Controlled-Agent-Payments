// Packed-artifact isolation follows UBB's Apache-2.0 consumer proof, without its browser/seller profiles.
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { access, cp, mkdir, mkdtemp, readFile, readdir, realpath, rename, rm, writeFile } from 'node:fs/promises';
import { arch, release, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { npmCliPath, packPackages } from './packed-consumer.mjs';

const exec = promisify(execFile);
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const directory = await realpath(await mkdtemp(join(tmpdir(), 'cap-consumer-')));
const app = join(directory, 'app'), tester = join(directory, 'tester'), types = join(directory, 'types');
const evidence = { version: 1, passed: false, startedAt: new Date().toISOString(),
  environment: { platform: process.platform, arch: arch(), osRelease: release(), node: process.version,
    consumerPath: `${dirname(process.execPath)}:/usr/bin:/bin:/usr/sbin:/sbin`, rustCompilerExecuted: false }, checks: [] };
const env = { ...process.env, PATH: evidence.environment.consumerPath };
for (const key of Object.keys(env)) {
  if (/^(?:CARGO|RUST|RUSTUP)(?:_|$)/i.test(key) || /^NODE_(?:PATH|OPTIONS)$/.test(key) ||
    /^(?:LD_|DYLD_)/.test(key) || /^npm_config_(?:prefix|workspace|workspaces|userconfig|globalconfig|ignore_scripts)$/i.test(key)) delete env[key];
}
env.npm_config_ignore_scripts = 'true';
env.npm_config_audit = 'false';
env.npm_config_fund = 'false';
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const json = async path => JSON.parse(await readFile(path, 'utf8'));
const save = async (path, value) => writeFile(path, JSON.stringify(value, null, 2) + '\n');
const check = name => evidence.checks.push(name);
async function run(command, args, cwd, extraEnv = {}) {
  try {
    return await exec(command, args, { cwd, env: { ...env, ...extraEnv }, encoding: 'utf8',
      timeout: 120_000, maxBuffer: 32 * 1024 * 1024 });
  } catch (error) {
    throw new Error(`Packed consumer command failed: ${command}\n${error.stdout ?? ''}\n${error.stderr ?? ''}`, { cause: error });
  }
}
async function install(cwd, dependencies, devDependencies = {}) {
  await mkdir(cwd, { recursive: true });
  await save(join(cwd, 'package.json'), { private: true, type: 'module', dependencies, devDependencies,
    overrides: { '@cap/payments': `file:${tarballs.payments.path}`,
      ...(devDependencies['@types/node'] ? { '@types/node': devDependencies['@types/node'] } : {}) } });
  await run(process.execPath, [npmCliPath, 'install', '--install-strategy=nested', '--ignore-scripts', '--include=dev', '--no-audit', '--no-fund'], cwd);
  await run(process.execPath, [npmCliPath, 'ls', '--all', '--json'], cwd);
  const lock = await json(join(cwd, 'package-lock.json'));
  for (const [path, entry] of Object.entries(lock.packages)) {
    const name = path.endsWith('node_modules/@cap/payments') ? 'payments' :
      path.endsWith('node_modules/@cap/testing') ? 'testing' : undefined;
    if (!name) continue;
    assert.equal(entry.link, undefined, 'CAP must not be a workspace symlink');
    assert.equal(entry.version, '0.1.0');
    assert.ok(entry.resolved?.startsWith('file:'), 'CAP must never resolve from a registry');
    assert.equal(resolve(cwd, entry.resolved.slice(5)), tarballs[name].path);
  }
  return sha256(await readFile(join(cwd, 'package-lock.json')));
}
async function installedPackages(cwd) {
  const result = [];
  async function modules(path) {
    let entries;
    try { entries = await readdir(path, { withFileTypes: true }); }
    catch (error) { if (error.code === 'ENOENT') return; throw error; }
    for (const entry of entries) {
      if (entry.name.startsWith('.')) continue;
      const target = join(path, entry.name);
      if (entry.name.startsWith('@')) {
        for (const scoped of await readdir(target)) await pkg(join(target, scoped));
      } else await pkg(target);
    }
  }
  async function pkg(path) {
    const actual = await realpath(path);
    assert.ok(actual.startsWith(directory + '/'), 'Installed dependency escaped owned consumer');
    const manifest = await json(join(path, 'package.json'));
    result.push({ name: manifest.name, version: manifest.version });
    await modules(join(path, 'node_modules'));
  }
  await modules(join(cwd, 'node_modules'));
  return result;
}
function assertReport(report, profile) {
  assert.equal(report.version, 1);
  assert.equal(report.mode, 'simulated');
  assert.equal(report.profile, profile);
  assert.equal(report.passed, true, JSON.stringify(report));
  assert.deepEqual(report.scenarios.map(item => item.id), ['exact-payment', 'operator-budget-recovery']);
  const safe = new Set(['origin', 'operationId', 'state', 'heldAtomic', 'spentAtomic', 'amountAtomic', 'httpStatus', 'transactionHash']);
  for (const scenario of report.scenarios) {
    assert.equal(scenario.passed, true);
    assert.ok(scenario.assertions.length > 0 && scenario.assertions.every(item => item.passed));
    for (const event of scenario.events) assert.ok(Object.keys(event).every(key => safe.has(key)));
  }
  const transitions = scenario => scenario.events.filter(event => event.operationId)
    .map(({ operationId, state, heldAtomic, spentAtomic }) => [operationId, state, heldAtomic, spentAtomic]);
  assert.deepEqual(transitions(report.scenarios[0]), [
    ['exact-payment', 'reported', '1000', '0'], ['exact-payment', 'settled', '0', '1000'],
  ]);
  assert.deepEqual(transitions(report.scenarios[1]), [
    ['operator-first', 'signing', '7000', '0'], ['operator-competing', 'unpaid', '7000', '0'],
    ['operator-first', 'unknown', '7000', '0'], ['operator-first', 'settled', '0', '1200'],
    ['operator-fresh', 'reported', '7000', '1200'], ['operator-fresh', 'settled', '0', '2400'],
  ]);
  const transactions = report.scenarios[1].events.filter(item => item.transactionHash);
  assert.equal(transactions.length, 4);
  for (const event of transactions) assert.match(event.transactionHash, /^0x[0-9a-f]{64}$/);
  assert.equal(transactions[0].transactionHash, transactions[1].transactionHash);
  assert.equal(transactions[2].transactionHash, transactions[3].transactionHash);
  assert.notEqual(transactions[0].transactionHash, transactions[2].transactionHash);
}
let tarballs;
try {
  assert.equal(process.platform, 'darwin', 'Only the macOS arm64 developer artifact is supported');
  assert.equal(process.arch, 'arm64');
  assert.equal(process.version, 'v24.22.2', 'Use the pinned release Node version');
  evidence.sourceLocks = {};
  for (const name of ['Cargo.lock', 'package-lock.json', 'rust-toolchain.toml']) {
    evidence.sourceLocks[name] = sha256(await readFile(join(root, name)));
  }
  evidence.rustToolchainPin = await readFile(join(root, 'rust-toolchain.toml'), 'utf8');
  const compilerLocations = [];
  for (const bin of env.PATH.split(':')) {
    for (const name of ['cargo', 'rustc']) {
      try { await access(join(bin, name)); compilerLocations.push(join(bin, name)); }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
  }
  assert.deepEqual(compilerLocations, [], 'Consumer PATH must not contain Rust tools');
  tarballs = await packPackages(join(directory, 'tarballs'));
  evidence.packages = {};
  for (const [name, packed] of Object.entries(tarballs)) {
    const files = new Set(packed.metadata.files.map(file => file.path));
    for (const path of ['package.json', 'README.md', 'LICENSE', 'NOTICE', 'dist/index.js', 'dist/index.d.ts']) {
      assert.ok(files.has(path), `${name}: missing packed ${path}; build/stage the release first`);
    }
    for (const path of files) {
      assert.ok(path === 'package.json' || path === 'README.md' || path === 'LICENSE' || path === 'NOTICE' ||
        path.startsWith('dist/') || name === 'payments' && (path.startsWith('native/') || path.startsWith('sql/')),
      `Unexpected packed source/cache: ${path}`);
      assert.ok(!/(?:^|\/)(?:node_modules|src|target|\.toolchain)(?:\/|$)/.test(path));
    }
    if (name === 'payments') {
      for (const path of ['dist/postgres.js', 'dist/postgres.d.ts', 'dist/testing.js', 'dist/testing.d.ts',
        'sql/001-payments.sql', 'native/cap-native.darwin-arm64.node']) assert.ok(files.has(path), `Missing ${path}`);
      assert.deepEqual([...files].filter(path => path.endsWith('.node')), ['native/cap-native.darwin-arm64.node']);
      assert.ok(![...files].some(path => /(?:facilitator|fixture|runner|cli)\./.test(path)));
    } else assert.ok(files.has('dist/cli.js'));
    evidence.packages[name] = { ...packed.metadata, sha256: sha256(await readFile(packed.path)) };
  }
  check('Both actual tarballs contain public exports, native/SQL, READMEs and legal notices, not source/cache');

  evidence.consumerLocks = {};
  evidence.consumerLocks.app = await install(app, { '@cap/payments': `file:${tarballs.payments.path}` });
  const payerGraph = await installedPackages(app);
  assert.deepEqual(payerGraph.map(item => item.name), ['@cap/payments']);
  evidence.paymentsOnlyDependencies = payerGraph;
  const guard = join(directory, 'guard.mjs');
  await writeFile(guard, `import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
const owned = ${JSON.stringify(directory + '/')};
registerHooks({ resolve(specifier, context, next) {
  const result = next(specifier, context);
  if (result.url.startsWith('node:')) return result;
  assert.ok(result.url.startsWith('file:'), 'Only owned files and Node builtins may load: ' + result.url);
  assert.ok(realpathSync(fileURLToPath(result.url)).startsWith(owned), 'Runtime import escaped isolated consumer: ' + result.url);
  return result;
} });\n`);
  const node = (script, cwd, extraEnv = {}) => run(process.execPath, ['--import', guard, script], cwd, extraEnv);
  await writeFile(join(app, 'payer-only.mjs'), `import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { createAgentPayments, PaymentError, readPaymentReceipt } from '@cap/payments';
import { MemoryPaymentStore } from '@cap/payments/testing';
const require = createRequire(import.meta.url);
for (const name of ['pg', '@cap/testing', 'hono', '@x402/core', 'viem']) {
  assert.throws(() => require.resolve(name), { code: 'MODULE_NOT_FOUND' });
}
const store = new MemoryPaymentStore();
await assert.rejects(store.createBudget({ownerId:'owner', budgetId:'budget', network:'eip155:84532',
  payer:'0x1111111111111111111111111111111111111111', limitAtomic:'01'}),
  error => error instanceof PaymentError && error.code === 'invalid_amount');
assert.equal(readPaymentReceipt(new Response('not read')).kind, 'missing');
assert.equal(typeof createAgentPayments, 'function');
console.log(JSON.stringify({ passed: true }));\n`);
  assert.equal(JSON.parse((await node('payer-only.mjs', app)).stdout).passed, true);
  check('Fresh payments-only install imports root and memory seam without pg, tester or JavaScript payment/fixture engine');

  evidence.consumerLocks.tester = await install(tester, { '@cap/testing': `file:${tarballs.testing.path}` });
  const testerGraph = await installedPackages(tester);
  assert.ok(testerGraph.some(item => item.name === '@cap/payments'));
  assert.ok(!testerGraph.some(item => /^(?:@x402\/fetch|@cap\/browser|@wagmi\/|wagmi$|react$|playwright|puppeteer)/.test(item.name)));
  evidence.testingDependencies = testerGraph;
  const directSdk = join(app, 'node_modules/@cap/payments');
  const testingPackage = join(tester, 'node_modules/@cap/testing');
  const nestedSdk = join(testingPackage, 'node_modules/@cap/payments');
  const directPath = await realpath(directSdk), nestedPath = await realpath(nestedSdk);
  assert.notEqual(directPath, nestedPath, 'Proof needs two physical SDK copies, not a deduplicated install');
  assert.ok(directPath.startsWith(app + '/') && nestedPath.startsWith(tester + '/'));
  evidence.native = { filename: 'cap-native.darwin-arm64.node',
    sha256: sha256(await readFile(join(directSdk, 'native/cap-native.darwin-arm64.node'))) };
  assert.equal(sha256(await readFile(join(nestedSdk, 'native/cap-native.darwin-arm64.node'))), evidence.native.sha256);
  await cp(join(root, 'examples/agent.mjs'), join(app, 'agent.mjs'));
  const nestedResolver = join(testingPackage, 'consumer-exports.mjs');
  await writeFile(nestedResolver, `export const testingEntry = import.meta.resolve('@cap/testing');
export const nestedEntry = import.meta.resolve('@cap/payments');
export const seamEntry = import.meta.resolve('@cap/payments/testing');
export const privateImport = () => import('@cap/testing/facilitator');\n`);
  const runtime = join(app, 'runtime.mjs');
  await writeFile(runtime, `import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
const direct = await import('@cap/payments');
const { default: createAgent } = await import('./agent.mjs');
assert.equal(createAgent, direct.createAgentPayments, 'Example must export the actual factory directly');
const before = globalThis[Symbol.for('@cap/payments/runtime/v1')];
const { testingEntry, nestedEntry, seamEntry, privateImport } = await import(pathToFileURL(${JSON.stringify(nestedResolver)}));
assert.notEqual(nestedEntry, import.meta.resolve('@cap/payments'));
const nested = await import(nestedEntry);
const testing = await import(testingEntry);
assert.equal(direct.PaymentError, nested.PaymentError);
assert.equal(globalThis[Symbol.for('@cap/payments/runtime/v1')], before);
assert.ok(Object.isFrozen(before));
const descriptor = Object.getOwnPropertyDescriptor(globalThis, Symbol.for('@cap/payments/runtime/v1'));
assert.equal(descriptor.enumerable, false); assert.equal(descriptor.writable, false); assert.equal(descriptor.configurable, false);
const seam = await import(seamEntry);
assert.equal(testing.MemoryPaymentStore, seam.MemoryPaymentStore);
const store = new testing.MemoryPaymentStore();
const budget = { ownerId:'consumer', budgetId:'budget', network:'eip155:84532',
  payer:'0x1111111111111111111111111111111111111111', limitAtomic:'10000' };
await store.createBudget(budget);
await assert.rejects(store.createBudget({...budget, limitAtomic:'01'}), error =>
  error instanceof direct.PaymentError && error instanceof nested.PaymentError && error.code === 'invalid_amount');
const options = { network: budget.network, store, policy: {maxPerPaymentAtomic:'1000', allowedSchemes:['exact'],
  merchants:[{origin:'https://merchant.example', payTo:budget.payer}]},
  resolveSigner: async () => { throw new Error('HOST_SECRET_SHOULD_NOT_ESCAPE'); }, rpc: async () => { throw new Error('RPC_SECRET'); } };
const payer = createAgent(options);
const operation = {ownerId:budget.ownerId,budgetId:budget.budgetId,agentId:'agent',operationId:'redaction'};
await assert.rejects(payer.fetch(operation, 'https://merchant.example/resource'), error => {
  assert.ok(error instanceof nested.PaymentError); assert.equal(error.code,'authorization_failed');
  assert.equal(error.paymentState,'not_attempted'); assert.equal(error.cause, undefined);
  assert.deepEqual(error.toJSON(), {code:'authorization_failed',paymentState:'not_attempted',operationId:'redaction'});
  assert.ok(!String(error).includes('HOST_SECRET')); assert.ok(!JSON.stringify(error).includes('HOST_SECRET')); return true;
});
const forged = {createBudget: store.createBudget.bind(store), getBudget: store.getBudget.bind(store), getOperation: store.getOperation.bind(store)};
assert.throws(() => createAgent({...options, store:forged}), error => error instanceof nested.PaymentError && error.code === 'invalid_config');
const response = new Response('PRIVATE_BODY', {headers:{authorization:'PRIVATE_HEADER'}});
const error = new nested.PaymentError('payment_unresolved', {paymentState:'submitted_unknown',operationId:'safe',response});
assert.equal(error.response,response); assert.ok(!JSON.stringify(error).includes('PRIVATE'));
assert.deepEqual(error.toJSON(), {code:'payment_unresolved',paymentState:'submitted_unknown',operationId:'safe'});
for (const name of ['@cap/payments/dist/internal.js', '@cap/payments/native', '@cap/payments/types']) {
  await assert.rejects(import(name), {code:'ERR_PACKAGE_PATH_NOT_EXPORTED'});
}
await assert.rejects(privateImport(), {code:'ERR_PACKAGE_PATH_NOT_EXPORTED'});
${assertReport.toString()}
const report = await testing.runPaymentTests({createAgent});
assertReport(report, 'agent-integration');
console.log(JSON.stringify({passed:true, report, sharedPaymentError:true, distinctPhysicalCopies:true, forgedStoreRejected:true}));\n`);
  const nestedBinary = join(nestedSdk, 'native/cap-native.darwin-arm64.node');
  await rename(nestedBinary, nestedBinary + '.held');
  try { evidence.integration = JSON.parse((await node(runtime, app)).stdout); }
  finally { await rename(nestedBinary + '.held', nestedBinary); }
  check('Distinct SDK copies share one binding, PaymentError and store authority; direct real example passes both scenarios; forged handles fail');

  const cli = join(tester, 'node_modules/.bin/cap');
  const cliEnv = { NODE_OPTIONS: `--import=${guard}` };
  assert.match((await run(cli, ['--help'], tester, cliEnv)).stdout, /Usage: cap test/);
  const builtin = JSON.parse((await run(cli, ['test', '--json'], tester, cliEnv)).stdout);
  assertReport(builtin, 'builtin');
  const injected = JSON.parse((await run(cli, ['test', '--agent-module', join(app, 'agent.mjs'), '--json'], tester, cliEnv)).stdout);
  assertReport(injected, 'agent-integration');
  evidence.cli = { builtin, injected };
  check('Installed executable CLI runs builtin and public direct example profiles with isolated guarded runtime imports');

  evidence.consumerLocks.types = await install(types, {
    '@cap/payments': `file:${tarballs.payments.path}`, '@cap/testing': `file:${tarballs.testing.path}`,
  }, { typescript: '6.0.3', '@types/node': '24.19.2', '@types/pg': '8.23.1', pg: '8.23.1' });
  await writeFile(join(types, 'types.ts'), `import {createAgentPayments, readPaymentReceipt, PaymentError} from '@cap/payments';
import type {AgentPayments, AgentPaymentsOptions, AgentContext, OperationKey, BudgetKey, BudgetInput, BudgetSnapshot,
 BudgetStore, PaymentPolicy, WalletSigner, TypedDataRequest, ReadRpc, RpcRequest, PaymentOperation,
 ReceiptRead, SafeReceipt, FinalProof, UnsignedAuthorization, PaymentTerms, OperationState, PaymentState} from '@cap/payments';
import {MemoryPaymentStore} from '@cap/payments/testing';
import {PostgresPaymentStore, installPaymentSchema} from '@cap/payments/postgres';
import {runPaymentTests, MemoryPaymentStore as TesterStore} from '@cap/testing';
import type {AgentUnderTest, AgentTestFactory, PaymentTestOptions, ScenarioId, TestReport} from '@cap/testing';
import {Pool} from 'pg';
const address = '0x1111111111111111111111111111111111111111' as const;
const key: BudgetKey = {ownerId:'owner',budgetId:'budget'};
const operation: AgentContext = {...key,agentId:'agent',operationId:'purchase'};
const opKey: OperationKey = operation;
const budget: BudgetInput = {...key,network:'eip155:84532',payer:address,limitAtomic:'10000'};
const memory: BudgetStore = new MemoryPaymentStore({afterSigningPersisted:async op => { const state: OperationState = op.state; void state; }});
const structural: BudgetStore = {createBudget: input => memory.createBudget(input),getBudget: input => memory.getBudget(input),getOperation: input => memory.getOperation(input)};
const snapshot: Promise<BudgetSnapshot> = structural.createBudget(budget);
const policy: PaymentPolicy = {maxPerPaymentAtomic:'7000',allowedSchemes:['exact','upto'],merchants:[{origin:'https://merchant.example',payTo:address}]};
const typed: TypedDataRequest = {domain:{name:'USDC',chainId:84532,verifyingContract:address,version:'2'},types:{Transfer:[{name:'value',type:'uint256'}]},primaryType:'Transfer',message:{value:'1000',nested:{values:['0',true,null]}}};
const signer: WalletSigner = {address,signTypedData:async request => { const amount = request.message['value']; void amount; return '0xab'; }};
const rpc: ReadRpc = async (request, signal) => { const method: RpcRequest['method'] = request.method; void [method,signal]; return '0x14a34'; };
const options: AgentPaymentsOptions = {network:budget.network,store:memory,policy,resolveSigner:async context => {void context.agentId; return signer;},rpc,fetch:globalThis.fetch};
const agent: AgentPayments = createAgentPayments(options);
const underTest: AgentUnderTest = agent;
const factory: AgentTestFactory = createAgentPayments;
const scenario: ScenarioId = 'operator-budget-recovery';
const selection: PaymentTestOptions = {createAgent:factory,scenarios:['exact-payment',scenario]};
const report: Promise<TestReport> = runPaymentTests(selection);
const pool = new Pool();
const pg: BudgetStore = new PostgresPaymentStore(pool);
const schema: Promise<void> = installPaymentSchema(pool);
const result: Promise<PaymentOperation> = agent.reconcile(opKey,'0xabc');
const receipt: ReceiptRead = readPaymentReceipt(new Response());
const safe: SafeReceipt = {success:true,network:budget.network,transaction:'0xabc',payer:address,amount:'1000'};
const unsigned: UnsignedAuthorization = {kind:'eip3009',from:address,to:address,value:'1000',validAfter:'0',validBefore:'1',nonce:'0xabc',token:address,chainId:'84532'};
const proof: FinalProof = {kind:'unpaid',reason:'no_authorization_created'};
const terms: PaymentTerms = {maximumAtomic:'1000',requestFingerprint:'digest',payer:address,network:budget.network,asset:address,payTo:address,requirements:{scheme:'exact',network:budget.network,asset:address,amount:'1000',payTo:address,maxTimeoutSeconds:30,extra:{assetTransferMethod:'eip3009',paymentFlow:'authorization'}}};
const state: PaymentState = new PaymentError('payment_unresolved',{paymentState:'authorization_possible'}).paymentState;
void [snapshot,typed,underTest,report,pg,schema,result,receipt,safe,unsigned,proof,terms,state,TesterStore];
// @ts-expect-error
const badBudget: BudgetInput = {...budget,limitAtomic:1000};
// @ts-expect-error
const badNetwork: AgentPaymentsOptions = {...options,network:'eip155:1'};
// @ts-expect-error
const badRpc: RpcRequest = {method:'eth_sendTransaction',params:[]};
// @ts-expect-error
const badTyped: TypedDataRequest = {...typed,message:{amount:1000n}};
// @ts-expect-error
const badSigner: WalletSigner = {address,signTypedData:async () => 65};
// @ts-expect-error
const badState: OperationState = 'reserved';
// @ts-expect-error
const badProof: FinalProof = {kind:'settled',transactionHash:'0xabc',amountAtomic:'1000'};
// @ts-expect-error
void agent.reconcile(opKey,proof);
// @ts-expect-error
void memory.resolve(opKey,proof);
// @ts-expect-error
void runPaymentTests({createAgent:() => ({fetch:async () => new Response()})});
// @ts-expect-error
void runPaymentTests({createService:factory});
// @ts-expect-error
void runPaymentTests({createAgent:factory,scenarios:['exact-success']});
// @ts-expect-error
void runPaymentTests({createAgent:undefined});
// @ts-expect-error
const badPolicy: PaymentPolicy = {...policy,maxPerPaymentAtomic:7000};
// @ts-expect-error
const badStore: BudgetStore = {getBudget:async () => null,getOperation:async () => null};
`);
  const compiler = join(types, 'node_modules/typescript/bin/tsc');
  await writeFile(join(app, 'ordinary.ts'), `import {createAgentPayments, readPaymentReceipt} from '@cap/payments';
import type {BudgetStore, WalletSigner} from '@cap/payments';
import {MemoryPaymentStore} from '@cap/payments/testing';
const store: BudgetStore = new MemoryPaymentStore();
declare const signer: WalletSigner;
void [store, signer, createAgentPayments, readPaymentReceipt];\n`);
  for (const [module, moduleResolution] of [['NodeNext', 'NodeNext'], ['ESNext', 'Bundler']]) {
    await save(join(app, 'tsconfig.json'), {compilerOptions:{noEmit:true,strict:true,target:'ES2022',
      module,moduleResolution,types:[],lib:['ES2022','DOM','DOM.Iterable']},files:['ordinary.ts']});
    await run(process.execPath, [compiler, '--project', 'tsconfig.json'], app);
  }
  check('Ordinary and memory declarations need no installed pg or pg type peer in NodeNext/Bundler');
  for (const [module, resolution] of [['NodeNext', 'NodeNext'], ['ESNext', 'Bundler']]) {
    await run(process.execPath, [compiler, '--noEmit', '--strict', '--exactOptionalPropertyTypes',
      '--noUncheckedIndexedAccess', '--verbatimModuleSyntax', '--target', 'ES2022', '--module', module,
      '--moduleResolution', resolution, '--lib', 'ES2022,DOM,DOM.Iterable', '--types', 'node', 'types.ts'], types);
  }
  check('All public/subpath declarations compile under strict NodeNext and Bundler with explicit pg type peer and rejected invalid shapes');
  await writeFile(join(types, 'postgres.mjs'), `import assert from 'node:assert/strict';
import {Pool} from 'pg';
import {PostgresPaymentStore, installPaymentSchema} from '@cap/payments/postgres';
const pool = new Pool();
let connections = 0;
pool.connect = async () => { connections++; throw new Error('Constructor must not connect'); };
try {
  const store = new PostgresPaymentStore(pool);
  assert.equal(connections, 0);
  for (const method of ['createBudget','getBudget','getOperation']) assert.equal(typeof store[method], 'function');
  for (const method of ['resolve','reserve','sign','submit','applyProof']) assert.equal(store[method], undefined);
  assert.equal(typeof installPaymentSchema, 'function');
} finally { await pool.end(); }
console.log(JSON.stringify({passed:true}));\n`);
  assert.equal(JSON.parse((await node('postgres.mjs', types)).stdout).passed, true);
  check('Installed PostgreSQL public subpath uses the supplied pool without connecting or exposing financial mutation methods');

  const marker = join(directory, 'fallback-used');
  const fallback = join(app, 'fake-native.cjs');
  const fakeSource = `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'fallback used'); module.exports = {apiVersion:()=>1};\n`;
  await writeFile(fallback, fakeSource);
  const alternatives = ['@cap/payments-darwin-arm64', '@cap/cap-native-darwin-arm64', 'cap-native-darwin-arm64',
    '@cap/payments-wasm32-wasi', '@cap/cap-native-wasm32-wasi', 'cap-native-wasm32-wasi', '@napi-rs/wasm-runtime'];
  for (const name of alternatives) {
    const path = join(app, 'node_modules', name);
    await mkdir(path, {recursive:true});
    await save(join(path, 'package.json'), {name,version:'0.0.0',main:'index.cjs'});
    await writeFile(join(path, 'index.cjs'), fakeSource);
  }
  await writeFile(join(app, 'cap-native.wasi.cjs'), fakeSource);
  const overrides = { NAPI_RS_NATIVE_LIBRARY_PATH: fallback, NAPI_RS_FORCE_WASI: '1', CAP_NATIVE_PATH: fallback,
    CAP_NATIVE_BINDING: fallback, CAP_NATIVE_BINARY: fallback, CAP_NATIVE_LIBRARY_PATH: fallback };
  await writeFile(join(app, 'native-check.mjs'), `import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
const require = createRequire(import.meta.url);
for (const name of ${JSON.stringify(alternatives)}) assert.ok(require.resolve(name));
assert.ok(require.resolve('./cap-native.wasi.cjs'));
if (process.env.EXPECT_NATIVE_MISSING === '1') {
  await assert.rejects(import('@cap/payments'), error => {
    assert.equal(error.code,'native_unavailable');
    assert.equal(error.message,'CAP native binding is unavailable. Install the matching macOS arm64 artifact or rebuild with the pinned toolchain.');
    assert.deepEqual(Object.keys(error), ['code']); return true;
  });
  assert.equal(Object.hasOwn(globalThis,Symbol.for('@cap/payments/runtime/v1')),false);
} else {
  const {PaymentError} = await import('@cap/payments');
  const {MemoryPaymentStore} = await import('@cap/payments/testing');
  const store = new MemoryPaymentStore();
  const base = {ownerId:'native',budgetId:'native',network:'eip155:84532',payer:'0x1111111111111111111111111111111111111111'};
  await assert.rejects(store.createBudget({...base,limitAtomic:'01'}), error => error instanceof PaymentError && error.code === 'invalid_amount');
  assert.equal((await store.createBudget({...base,limitAtomic:'10000'})).heldAtomic,'0');
}
console.log(JSON.stringify({passed:true}));\n`);
  assert.equal(JSON.parse((await node('native-check.mjs', app, overrides)).stdout).passed, true);
  const binary = join(directSdk, 'native/cap-native.darwin-arm64.node');
  await rename(binary, binary + '.held');
  try {
    assert.equal(JSON.parse((await node('native-check.mjs', app, {...overrides, EXPECT_NATIVE_MISSING:'1'})).stdout).passed, true);
  } finally { await rename(binary + '.held', binary); }
  await assert.rejects(access(marker), {code:'ENOENT'});
  evidence.native.fallbackAlternatives = alternatives;
  evidence.native.freshProcessMissingRejected = true;
  evidence.native.presentIgnoredOverrides = true;
  check('Fresh present/missing native processes ignore override paths and resolvable platform/WASI alternatives; present binding performs real money validation');
  evidence.passed = true;
} finally {
  evidence.finishedAt = new Date().toISOString();
  try { await rm(directory, {recursive:true,force:true}); }
  catch (error) { evidence.passed = false; evidence.cleanupFailed = true; throw error; }
  finally {
    await mkdir(join(root, '.artifacts'), {recursive:true});
    await save(join(root, '.artifacts/consumer-smoke.json'), evidence);
  }
}
console.log(JSON.stringify({passed:true,checks:evidence.checks,artifact:'.artifacts/consumer-smoke.json'}));
