# Public Wallet Resolver

A read-only BSC analysis toolkit for resolving masked ranking entries against public transaction evidence.

![review](https://img.shields.io/badge/review-private-374151) ![primary](https://img.shields.io/badge/primary-JavaScript-2563EB) [![LinkedIn](https://img.shields.io/badge/LinkedIn-Douglas%20Silva-0A66C2?logo=linkedin&logoColor=white)](https://www.linkedin.com/in/douglas-silva-data-analyst/)

[Overview](#overview) · [Architecture](#architecture) · [Setup](#setup) · [Validation](#validation) · [Roadmap](#roadmap) · [Review notes](docs/REVIEW.md)

## Overview

- Masked-address matching preserves resolved, ambiguous and unresolved states.
- Router/event decoders contribute public-chain evidence.
- Local storage and dashboard modules expose ranked and enriched views.

**Technology:** JavaScript · Node.js 24 · SQLite · JSON-RPC · Redis protocol adapter · local dashboard

**Persistence and data:** SQLite stores intelligence and enrichment caches; Redis integration can publish updates. Original ranking/account snapshots are excluded.

## Architecture

```text
Ranking input → candidate matching → public-chain evidence → confidence/ambiguity state → SQLite/dashboard
```

| Location | Review focus |
| --- | --- |
| [`src/resolve.js`](src/resolve.js) | Source/configuration inspected for scope and structure |
| [`src/router-purchases.js`](src/router-purchases.js) | Source/configuration inspected for scope and structure |
| [`src/intel-db.js`](src/intel-db.js) | Source/configuration inspected for scope and structure |
| [`src/wallet-enrichment-db.js`](src/wallet-enrichment-db.js) | Source/configuration inspected for scope and structure |
| [`test/resolve.test.js`](test/resolve.test.js) | Source/configuration inspected for scope and structure |

Internal package and module names are retained where changing them would affect imports or compatibility. This descriptive repository name does not imply a completed package/API migration.

## Setup

Node.js >=24. Run node --test on the test/ files for offline checks. Live scans require locally supplied ranking input and configured RPC access.

Start from an isolated environment. Use `.env.example` when present and inspect the configuration loader: an example file is not necessarily loaded automatically. Runtime databases, real account sessions and private credentials are not bundled. Live integration prerequisites are separate from local tests.

## Validation

Static parsing checked 0 Python files and 1 strict JSON files. Python syntax errors: 0; JSON errors: 0. The selected offline suite passed.

```console
node --test test/amounts.test.js test/dashboard-data.test.js test/decoder.test.js test/intel-db.test.js test/rank-history.test.js test/resolve.test.js test/router-purchases.test.js test/sync-data.test.js test/wallet-enrichment-db.test.js
```

These results apply to the selected checks on the preparation copy. They do not establish deployment readiness, full coverage, live provider availability or measured performance. CI definitions, when present under `docs/ci-templates/`, are inactive review templates; no remote CI badge is claimed.

## Limits and current status

Address correlation does not prove a person's identity. Browser synchronization is a separate state-changing integration and was not run. Offline test success does not validate current API/RPC coverage.

This private snapshot is for code and portfolio review. Generated runtime material and unreviewed binary assets may be excluded. [Review notes](docs/REVIEW.md) record preparation scope, findings and outstanding validation.

## Roadmap

- [ ] Document matching confidence and false-match conditions.
- [ ] Provide synthetic ranking inputs for the dashboard.
- [ ] Separate optional browser synchronization from the read-only research workflow.

## History and attribution

No recoverable original Git history was verified for this snapshot. Import and preparation commits use their actual current dates; filesystem timestamps are not treated as development dates.

No open-source license is granted by this preparation. A license and attribution review is required before public redistribution.

## Maintainer and feedback

Douglas de Oliveira Silva · [GitHub](https://github.com/qquante) · [LinkedIn](https://www.linkedin.com/in/douglas-silva-data-analyst/)

For this private review, report reproducible issues with a minimal fixture and the exact check output. Keep account data, credentials and generated sensitive reports out of issues and commits. Existing contribution guidelines apply where present.

**Topics:** `javascript`, `nodejs`, `sqlite`, `blockchain-analytics`, `data-analysis`, `ethereum`
