# Changelog

## 0.1.0 — unpublished developer preview

- Shared USDC budgets and stable purchase IDs for requests to x402 services.
- x402 v2 exact/EIP-3009, exact/Permit2 and upto/Permit2 on Base and Base Sepolia.
- PostgreSQL-backed payment holds and recovery from finalized transaction evidence.
- A Rust core for protocol/payment-state validation, a Node SDK and a separate simulated integration tester.
- MIT licensing for CAP, with third-party licenses and attribution in NOTICE.
- Discard PostgreSQL connections after failed rollback, so later transactions cannot commit partial holds.
- Stop failed Rust bootstrap checks and clean up failed PostgreSQL worker launches; pin the local proof locale.

Release blocked by [RUSTSEC-2026-0387](SECURITY.md#current-release-gate).
