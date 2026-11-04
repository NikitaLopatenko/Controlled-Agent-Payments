# @cap/payments

`@cap/payments` is the Node SDK with a packaged macOS-arm64 Rust binding. Consumers need no Rust, install script or JavaScript payment-engine fallback.

CAP 0.1.0 is experimental, unpublished and tested on Node 24.22.2. The full Cargo.lock scan reports [RUSTSEC-2026-0387](https://rustsec.org/advisories/RUSTSEC-2026-0387.html), which blocks release.

The root exports `createAgentPayments`, `PaymentError` and `readPaymentReceipt`. Your application supplies the authenticated context, authorized signer, trusted bounded read-only RPC and budget store.

`@cap/payments/postgres` exports `PostgresPaymentStore` and `installPaymentSchema(pool)`. Supply your existing `pg.Pool`; your application owns its lifetime. `pg@^8.23.1` and `@types/pg@^8.23.1` are optional peers; TypeScript PostgreSQL consumers install both. Root and `/testing` imports need neither.

`@cap/payments/testing` exports only `MemoryPaymentStore`, a nondurable single-realm test store. It is not a production store or a PostgreSQL failure fallback. The CLI and independent simulator are in the separate `@cap/testing` package.

Consume or cancel response bodies, including `error.response`. `PaymentError.toJSON()` omits raw errors and responses; the caller-accessible `error.response` is not safe to log. The host owns authentication, signer authorization, RPC trust/deadlines and database timeouts. Read `SECURITY.md` in the source repository before using a wallet. LICENSE and NOTICE ship in the package.

## Backend contract

Import `createAgentPayments`, `PaymentError` and `readPaymentReceipt` from `@cap/payments`. Supply these options:

- `network`: `eip155:8453` (Base) or `eip155:84532` (Base Sepolia), using their pinned six-decimal USDC deployments.
- `store`: a `PostgresPaymentStore` from `@cap/payments/postgres`. Call `installPaymentSchema(pool)` explicitly first. CAP receives your existing `pg.Pool`; it never creates, migrates automatically or closes it. TypeScript PostgreSQL consumers also install `@types/pg@^8.23.1`. Ordinary imports need neither peer.
- `policy`: positive `maxPerPaymentAtomic`, nonempty `allowedSchemes`, and `merchants: [{ origin, payTo }]`. Origins must be canonical HTTPS; Sepolia also permits loopback HTTP.
- `resolveSigner(context)`: your already-authorized wallet callback, returning `{ address, signTypedData }`. Typed data uses decimal strings for uints. CAP does not hold private keys.
- `rpc(request, signal?)`: your trusted raw read-only JSON-RPC adapter. Return decoded JSON result values, not JSON-RPC envelopes or decoded BigInt-rich viem action results. Bound HTTP decoding and set deadlines in that adapter.
- Optional `fetch`: otherwise Node Fetch. Do not add automatic paid-request retries in this transport.

Create one immutable budget with `store.createBudget({ ownerId, budgetId, network, payer, limitAtomic })`. Equal creation returns its current balances; changes to network, payer or limit conflict. Use `payments.fetch({ ownerId, budgetId, agentId, operationId }, input, init)`; it returns the original Fetch Response. `getOperation(key)` reads the record; `reconcile(key, transactionHash?)` applies only verified final evidence. Keys for reads/recovery are `{ ownerId, budgetId, operationId }`.

Use canonical decimal strings, never JavaScript numbers, for money. 1 USDC = 1000000 atomic units. IDs are nonempty, at most 256 UTF-8 bytes, untrimmed and free of ASCII controls. One stable operation ID means one purchase. A new ID is a new purchase, not a retry.

Supported payments: v2 exact/EIP-3009, exact/Permit2 and upto/Permit2. Permit2 needs an existing sufficient owner allowance; CAP never approves or signs sponsorship. Wallet signatures are nonempty hex bytes up to 4096 bytes, not restricted to 65-byte EOAs. Headers are limited to 16 KiB; replayable request bodies to 1 MiB. Streaming input is not a streaming billing product.

## What balances mean

Before invoking a wallet, CAP atomically holds the full maximum and stores unsigned authorization details. It records submission before one paid Fetch. A coherent service report still keeps the maximum held. Canonical finalized transaction evidence replaces that hold with the actual charge, once. Finalized expired-and-unused nonce evidence releases it without spending.

Holds are bookkeeping, not on-chain escrow. HTTP 402 is not a refund. Budget limits cover that CAP budget's USDC only, not gas, outside spending or another budget. Paying a merchant does not guarantee a useful answer.

A used or invalidated nonce without an obtainable supported transaction hash can stay held indefinitely. Supply a hash from the wallet or service. There is no hidden indexer, replacement payment, manual force-release API, or number/latest-block fallback for expired-unused proof. Unsupported batched/sponsored calldata stays unresolved. The RPC must support finalized blocks and EIP-1898 hash-pinned `eth_call` for unused recovery.

`PaymentError.toJSON()` emits only its fixed code, uncertainty state and safe ID/hash. `error.response` intentionally gives the original response/body to the caller and is not log-safe. Consume or cancel bodies you receive, including error responses. Reconcile unresolved purchases; do not invent a fresh ID merely to pay again.
