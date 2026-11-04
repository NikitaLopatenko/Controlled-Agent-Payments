# @cap/testing

`@cap/testing` is the simulated integration tester for CAP 0.1.0 on macOS arm64 / Node 24.22.2. It is unpublished and requires the matching `@cap/payments` tarball. Its independent JavaScript x402 verification and fixture signers do not belong in a production payer dependency tree.

Release is blocked by [RUSTSEC-2026-0387](https://rustsec.org/advisories/RUSTSEC-2026-0387.html). Passing simulations do not establish production-money safety.

## CLI

Run `cap test [--scenario exact-payment|operator-budget-recovery]... [--json] [--agent-module /absolute/local.mjs]`, or `cap --help`. The local module must default-export a `createAgentPayments`-compatible factory. It is trusted code, not a sandbox. No production wallet or credentials are needed or allowed in fixtures.

Passing scenarios show their final observed held/spent balances. Failed scenarios retain diagnostics. Use --json for the detailed report.

Results say `mode=simulated`. Real signatures are verified, but modeled contract calls are not an EVM or live settlement. Each async case has a 10000 ms deadline; CLI supervision has an entire-worker 15000 ms deadline through shutdown. The async API cannot preempt synchronous application code. CLI worker logs are discarded so JSON output remains one report. Exit codes: 0 pass, 1 behavior/deadline failure, 2 configuration, 130 interrupted.

The operator case ends held=0/spent=2400 atomic units after two modeled partial purchases. The exact case ends held=0/spent=1000. These are deterministic fixture assertions, not real-money evidence or performance claims. Public fixture keys must never be funded. LICENSE and NOTICE are included.

## Programmatic use

The API is `runPaymentTests({ createAgent, scenarios? })`; omit `createAgent` for the built-in payer. Both profiles execute the same checks, create the factory once per case and inspect owned accounting and independent signature/settlement counters. Unknown options and malformed factories are configuration errors, not silent built-in fallback.

```js
import { createAgentPayments } from '@cap/payments';
import { runPaymentTests } from '@cap/testing';

const report = await runPaymentTests({ createAgent: createAgentPayments });
console.log(report.passed);
```
