# Public Wallet Resolver

![Language: JavaScript](https://img.shields.io/badge/Language-JavaScript-F7DF1E?style=flat-square&logo=javascript) ![Store: SQLite](https://img.shields.io/badge/Store-SQLite-555555?style=flat-square) [![License: MIT](https://img.shields.io/badge/License-MIT-555555?style=flat-square)](LICENSE)

Resolve masked BSC ranking addresses against public Four.Meme and transaction evidence, while retaining ambiguous and unresolved matches.

The core resolver compares a ranking mask with candidate addresses from account events, router transactions and transaction senders. It returns both the chosen source and candidate sets instead of silently selecting the first address that happens to match.

## Three outcomes worth keeping separate

| Outcome | What the source does |
| --- | --- |
| One candidate | Resolves the wallet and identifies the supporting observation source. |
| Several candidates | Returns `ambiguous` with candidates for review. |
| No candidate | Retains `not_found_on_fourmeme_window`; absence is bounded by the scanned window. |

Creator matches are retained separately and do not automatically become the resolved trading wallet. See [resolve.js](src/resolve.js).

## Run the resolver fixture tests

```console
node --test test/resolve.test.js
```

Node.js 24+ is required. The broader `npm test` suite also covers amount handling, decoders, ranking history, enrichment storage and dashboard data.

## Collection is a separate layer

| Command | Role |
| --- | --- |
| `npm run scan` / `npm run watch` | Collect public-chain observations for resolution. |
| `npm run service` / `npm run intel` | Run ongoing source/intelligence services. |
| `npm run enrich` | Extend wallet observations. |
| `npm run dashboard` | Serve the local presentation layer. |

The source includes SQLite state, Redis messaging and browser/CDP synchronization adapters. These operational paths need their own inputs and authorized browser/account context; they are not exercised by the resolver fixture test. A mask correlation is not proof of a person's identity or wallet ownership.

**Technology:** JavaScript · Node.js 24 · SQLite · JSON-RPC · Redis protocol adapter · local dashboard

Project-authored source: [MIT](LICENSE). Third-party components retain their own notices and terms.
