# Security boundaries

CAP 0.1.0 is an experimental macOS arm64 / Node 24.22.2 build. It has had an AI-assisted source review, not an independent security audit or funded-chain validation. Local checks do not establish that it is safe for production funds.

## Current release gate

The full Cargo.lock scan reports [RUSTSEC-2026-0387](https://rustsec.org/advisories/RUSTSEC-2026-0387.html) for crypto-bigint 0.5.5: some arithmetic intended to have constant timing can leak secret-dependent timing information. It is absent from the activated darwin-arm64 native normal/build dependency tree; no exploitable CAP path was established. The full-lockfile gate still fails. No advisory was ignored and no dependency was automatically upgraded.

The locked path is alloy-primitives 1.6.0's optional k256 0.13.4 → elliptic-curve 0.13.8 → crypto-bigint 0.5.5. Alloy's enabled `std` feature forwards `k256?/std` without selecting k256 for compilation. [Cargo issue 10801](https://github.com/rust-lang/cargo/issues/10801) tracks disabled optional weak dependencies entering Cargo.lock. This explains the lockfile entry, not proof that secret arithmetic is safe. elliptic-curve requires crypto-bigint 0.5; the advisory's patched >=0.7.6 is not a compatible direct replacement. No safe drop-in repair has been established, so the full-lockfile failure remains a release blocker.

Three dependencies also have unmaintained-package warnings. `npm run security:check` writes raw reports, scanner versions and the RustSec database revision to ignored `.artifacts/` logs.

## The host is trusted

Authenticate and authorize every budget, purchase, read and reconciliation call. ownerId/budgetId/agentId/operationId are labels, not access control. A store handle proves only that CAP constructed it. It does not authenticate a tenant. Budgets are not wallet-wide limits.

Supply an already-authorized signer. Never expose an unrestricted typed-data signing endpoint. Wallet ownership, custody, key storage, gas, allowance setup and spending outside CAP remain the host's job. Public fixture keys must never be funded or used outside simulations.

Choose the read-only RPC yourself, never from a service's 402 challenge. CAP checks coherent finalized evidence against that RPC's chain view; it is not an Ethereum consensus light client. Sealed native proofs prevent plain-object proof injection, not lies from a dishonest host/RPC. The RPC HTTP decoder must bound response input and use deadlines before returning JSON to CAP.

Use pool connection/query/statement timeouts. Cancellation cannot undo a possibly committed transaction or preempt synchronous host code. CAP waits for locked financial cleanup and never closes your pool. An ambiguous commit is not rollback proof. Supplied Fetch must not retry paid requests automatically. The merchant allowlist controls signing, not ordinary network access; the host must restrict network targets if its agents process untrusted URLs.

## Financial invariants

- Commit the maximum hold, immutable terms, full unsigned authorization and unique nonce before the wallet callback.
- Commit submitted intent before the one paid Fetch. Do not persist reusable signatures, payment headers, credentials or bodies.
- Matching operation IDs never create another authorization. Changed inputs conflict; terminal records never reopen.
- A service report is not final evidence. Missing/failed/zero reports and caller cancellation cannot release an authorized hold.
- Only coherent canonical finalized settlement replaces a hold with actual spending. Exact equals maximum; upto cannot exceed it. Expired-unused proof needs a strictly later finalized timestamp and a false authorization state / clear nonce bit at a canonical block hash.
- Failed reconciliation changes no state, balance or last-error metadata. Unknown outcomes remain held; there is no unsafe force-release fallback.

Used/invalidated nonce without a supported transaction hash can remain held indefinitely. Unsupported batches/sponsorship and unsupported hash-pinned RPC stay unresolved. Holds are not escrow; unused hold release is not an on-chain refund. A merchant charge is not proof of useful work.

## Input and artifact limits

Canonical uint256 decimal strings; nonzero 20-byte addresses; IDs <=256 UTF-8 bytes; payment headers <=16 KiB; RPC JSON <=1 MiB before native conversion; replayable request bodies <=1 MiB; signatures <=4096 bytes of nonempty hex. Default serde recursion limits remain enabled. Host callbacks can allocate or block before CAP receives their result; CAP cannot reverse that.

Only the local macOS-arm64 native artifact is loaded. No environment override, platform-package search, WASI/JavaScript fallback or compilation-on-install exists. Identical SDK copies share one realm-local binding/error/store registry. This is not a sandbox against malicious code in the same process. Agent modules passed to the CLI are trusted local code; CLI isolation bounds work and discards worker logs, not its OS permissions.

Error messages/codes are fixed and caught causes are not retained. toJSON omits raw errors and responses. error.response is intentionally caller-accessible and not log-safe; do not log it, request headers, signatures or provider bodies. Consume or cancel returned bodies.

## Reporting

Do not publish private keys, signatures, authorization headers, customer payloads or database URLs. Report a reproducible case with package/native checksums, runtime versions, safe error code and operation state through the repository's private security reporting channel if configured; otherwise contact the repository owner privately. No response-time or disclosure program is claimed.
