# Public Wallet Resolver

A read-only BSC analysis toolkit for resolving masked ranking entries against public transaction evidence.

## Features

- Masked-address matching preserves resolved, ambiguous and unresolved states.
- Router/event decoders contribute public-chain evidence.
- Local storage and dashboard modules expose ranked and enriched views.

## Stack

JavaScript · Node.js 24 · SQLite · JSON-RPC · Redis protocol adapter · local dashboard

SQLite stores intelligence and enrichment caches; Redis integration can publish updates. Original ranking/account snapshots are excluded.

## Getting started

Node.js >=24. Run node --test on the test/ files for offline checks. Live scans require locally supplied ranking input and configured RPC access.

## How it works

```text
Ranking input → candidate matching → public-chain evidence → confidence/ambiguity state → SQLite/dashboard
```

## Current limitations

Address correlation does not prove a person's identity. Browser synchronization is a separate state-changing integration and was not run. Offline test success does not validate current API/RPC coverage.

## Tests

```console
node --test test/amounts.test.js test/dashboard-data.test.js test/decoder.test.js test/intel-db.test.js test/rank-history.test.js test/resolve.test.js test/router-purchases.test.js test/sync-data.test.js test/wallet-enrichment-db.test.js
```

These checks use offline fixtures or controlled backends.

## License

Project-authored source code is licensed under the [MIT License](LICENSE). Third-party components and datasets retain their respective rights and licenses.
