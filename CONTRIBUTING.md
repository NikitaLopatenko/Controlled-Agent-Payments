# Contributing

## Development

From the repository root, use Apple Command Line Tools (`xcode-select --install` if missing) and Node 24.22.2 from the official distribution or your version manager. `.node-version` pins the tested version; the package engines allow `>=24.22.2 <25`.

Install project-local Rust without changing your shell profile:

```sh
export CARGO_HOME="$PWD/.toolchain/cargo" RUSTUP_HOME="$PWD/.toolchain/rustup"
export PATH="$CARGO_HOME/bin:$PATH"
mkdir -p .toolchain/bootstrap
(
  set -e
  cd .toolchain/bootstrap
  url=https://static.rust-lang.org/rustup/dist/aarch64-apple-darwin/rustup-init
  curl --fail --show-error --location --proto '=https' --tlsv1.2 "$url" -o rustup-init
  curl --fail --show-error --location --proto '=https' --tlsv1.2 "$url.sha256" -o rustup-init.sha256
  shasum -a 256 -c rustup-init.sha256
  chmod +x rustup-init
  ./rustup-init --no-modify-path --profile minimal --default-toolchain 1.93.0 -y
)
```

Then build:

```sh
npm ci --ignore-scripts --include=dev
npm run build
```

Generated output and local toolchains stay out of source control.

## Checks

After Development, use the same shell. Install cargo-audit 0.22.2 and PostgreSQL 17 only if missing:

```sh
cargo install cargo-audit --version 0.22.2 --locked --no-default-features
brew install postgresql@17
```

Run the checks:

```sh
cargo test -p cap-core --locked
npm test
env -u CAP_TEST_DATABASE_URL CAP_POSTGRES_BIN="$(brew --prefix postgresql@17)/bin" npm run test:postgres
NODE_ENV=production npm run smoke:consumer
npm run measure
npm run security:check
```

The PostgreSQL proof owns and removes its temporary cluster. Alternatively, set `CAP_TEST_DATABASE_URL` to a PostgreSQL 17 test server with CREATE/DROP DATABASE rights and run `npm run test:postgres`. That route needs no local binaries and leaves the supplied database untouched. Do not use production credentials.

Measurements cover simulated purchases against a memory ledger, not chain latency, PostgreSQL capacity or a speed advantage over another engine. Dependency checks fail on findings and scanner errors.

## Local packages

These names are not published to a registry. After building:

```sh
npm pack --workspace @cap/payments --ignore-scripts
npm pack --workspace @cap/testing --ignore-scripts
```

Source builders need Rust. Consumers of matching prebuilt tarballs need no Rust or install hook. Install the payments tarball directly. For the tester, declare both packages as absolute `file:/...tgz` dependencies and override its `@cap/payments` dependency to that same payments tarball. Run `./node_modules/.bin/cap test`. `npm run smoke:consumer` checks this arrangement.

See the [SDK guide](packages/payments/README.md) for optional PostgreSQL peers, including `pg` and `@types/pg`.

## Changes and evidence

Describe the user-visible case and make the smallest complete change. For risky behavior, keep a regression that fails before the fix and passes after it. Reuse the existing tests and proof scripts; do not add automatic paid-request retries, unsafe hold releases, fallback payment engines or a memory-store fallback for PostgreSQL.

Use short comments for non-obvious constraints and safety decisions. Omit narration of the code. Retain compiler/test directives and upstream legal notices.

Report the commands actually run, their results and anything not checked. `.artifacts/` contains ignored local logs, not published evidence. Simulation is not funded-chain proof. A failed dependency scan stays failed; never hide an advisory to make CI green.

## Reporting and publication

Follow [SECURITY.md](SECURITY.md#reporting) for private security reports. Never put keys, signatures, payment headers, customer data or database URLs in public issues.

Before publishing, the owner must:

- Choose the actual GitHub destination and confirm the source contains no generated output or secrets.
- Enable private vulnerability reporting or provide a real private security contact in SECURITY.md.
- Run and observe the existing GitHub workflow before claiming hosted success. Keep the developer-preview label and failed release gate visible until the documented blocker is repaired and verification actually passes.
