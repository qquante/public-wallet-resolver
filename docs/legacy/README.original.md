> Historical project notes. Paths, operational status, badges and test claims below are retained as archival reference and have not all been revalidated. Use the root README and docs/REVIEW.md for this review snapshot.

# GMGN Contest Wallet Resolver

Resolve masked GMGN S12 BSC ranking wallets using read-only BSC data from Four.Meme TokenManager2 logs plus GMGN/Four.Meme router transactions.

## Run

```powershell
npm test
npm run scan -- --gmgn-file .\data\gmgn-ranking-current.network-response --fresh
```

Default tracking is `rank <= 20`. Use `--max-rank 30` if you want all Top 30.

## Continuous service

Run locally once:

```powershell
$env:GMGN_FILE = "data/gmgn-ranking-current.network-response"
$env:RUN_ONCE = "1"
npm run service
```

Run both continuous Docker services:

```powershell
docker compose up -d --build
docker logs -f gmgn-contest-resolver
docker logs -f gmgn-browser-sync
docker logs -f gmgn-contest-intel
docker logs -f gmgn-wallet-enrich
docker logs -f gmgn-dashboard
```

`gmgn-contest-resolver` scans new BSC blocks, keeps `rank <= 20`, updates `data/wallets.json` and `data/wallets.csv`, and publishes:

- `gmgn:s12:bsc:wallets`
- `gmgn:s12:bsc:ranking`
- `gmgn:s12:bsc:pending`
- `gmgn:s12:bsc:checkpoint`

`gmgn-browser-sync` reads `data/wallets.json` every 5 minutes and syncs the resolved wallets into GMGN through the open CDP Chrome session. By default it does not reload the GMGN page after syncing.

`gmgn-browser-sync` also refreshes `data/gmgn-ranking-current.network-response` through the open Chrome session, so rank movement is based on live GMGN ranking snapshots instead of the initial captured file.

The resolver uses two on-chain sources:

- `fourmeme_account`: direct `TokenPurchase` / `TokenSale` account matches from `TokenManager2`.
- `gmgn_router_tx`: successful `tx.from` matches for GMGN/Four.Meme router calls, default router `0x1de460f363af910f51726def188f9004276bf4bc` and selector `0x4d819a2a`.

Router scanning is enabled by default through `GMGN_ROUTER_TX_SCAN=1`. It only records transactions whose sender matches a current GMGN ranking mask, so the backfill stays focused on contest wallets.

Dashboard:

```text
http://localhost:8788
```

It shows compact rank movement labels like `GMGN19+1` for 60 minutes, 4 hours, and 24 hours. It also shows probable side-wallets by contest rank/wallet, filtered by default to GMGN-enriched wallets with `realized_profit_30d >= 2000`, then groups high-balance linked wallets by contest rank/wallet using `data/high-balance-linked-wallets.json` and the `>= MIN_BNB_BALANCE` filter. Use `/api/contest-sides?all=1` to inspect the unfiltered side-score view.

`gmgn-contest-intel` tracks each Four.Meme buy made by a contest wallet and records the next 300 buys of that same token. It ingests both direct `TokenManager2.TokenPurchase` logs and GMGN/Four.Meme router buy transactions. It marks a candidate as suspicious only when it appears after contest wallets in at least 2 distinct tokens or 3 total anchor windows. It publishes:

- `gmgn:s12:bsc:intel:linked`
- `gmgn:s12:bsc:intel:mev`
- `gmgn:s12:bsc:intel:sides`
- `gmgn:s12:bsc:intel:checkpoint`

It also writes `data/contest-side-wallets.json` and `data/contest-side-wallets.csv`, grouped by active contest wallet. Each side row uses the first candidate buy inside each anchor window and includes follow rate plus entry buckets `<=10`, `<=15`, `<=50`, `<=100`, `<=200`, `<=300`, and exclusive ranges `1-10`, `11-15`, `16-50`, `51-100`, `101-200`, `201-300`. The service uses `eth_subscribe newHeads` as a live wake-up path and keeps checkpoint scans as the consistency layer.

`gmgn-wallet-enrich` reads the MEV-filtered suspects from `data/linked-wallets.json`, checks each wallet's current BNB balance through BSC `eth_getBalance`, keeps only wallets with `MIN_BNB_BALANCE` or more, and enriches those wallets through the open GMGN Chrome/CDP session. It caches RPC balances and GMGN endpoint responses in `data/wallet-enrichment.sqlite`, so restarts do not discard fetched data. It publishes:

- `gmgn:s12:bsc:enrich:high_balance`
- `gmgn:s12:bsc:enrich:checkpoint`

If direct GMGN fetch is blocked by Cloudflare, keep `GMGN_FILE` pointed at a captured ranking response. If you have a valid cookie, set `GMGN_COOKIE` and unset `GMGN_FILE`.

## Sync into GMGN using an isolated Chrome

Open the persistent isolated CDP Chrome profile:

```powershell
.\scripts\open-gmgn-isolated-chrome.ps1 -CloseChromeFirst
```

This uses `%LOCALAPPDATA%\GMGNContestIsolatedChrome` and does not clone your normal Chrome profile. Install the wallet extensions you want and log in to GMGN there. Do not use `-ResetProfile` after logging in.

When Docker services need to reach the CDP port directly, open the isolated Chrome with:

```powershell
.\scripts\open-gmgn-isolated-chrome.ps1 -DockerReachable
```

`-DockerReachable` binds the CDP port to `0.0.0.0`; use it only on a trusted local machine/session because CDP controls the browser profile.

To intentionally wipe this isolated profile:

```powershell
.\scripts\open-gmgn-isolated-chrome.ps1 -CloseChromeFirst -ResetProfile
```

Log in to GMGN in that profile and keep a `gmgn.ai` tab open. The Docker `gmgn-browser-sync` service will use that browser through `CHROME_CDP_URL=http://host.docker.internal:9222`.

Legacy cloned-profile launcher remains available as `scripts/open-gmgn-chrome.ps1`, but the isolated launcher is the recommended path for stable GMGN tracking.

Manual local sync is still available:

```powershell
npm run browser-sync
```

`browser-sync` reads `data/wallets.json`, keeps only resolved `rank <= 20`, and uses the open Chrome session to call GMGN `follow_wallet` / `unfollow_wallet`. It writes `data/gmgn-browser-sync-state.json`. By default it does not send a fixed GMGN group id; set `GMGN_GROUP_ID` only if you want to force a known group from the current GMGN account.

To import the current list into another GMGN profile, open Track -> Import and paste either `data/gmgn-import-current.json` or `data/gmgn-import-current.txt`. Leave "Add to single group" off unless you want to use a group selected inside that GMGN profile.

Fast clipboard export:

```powershell
.\scripts\copy-gmgn-import.ps1
```

This refreshes `data/gmgn-import-current.json` and `data/gmgn-import-current.txt`, then copies the import payload to the clipboard. By default the current import contains the Top 20 contest wallets plus deduped side wallets from `/api/contest-sides` whose classification is only `possible_side` or `strong_side`, using the dashboard's default profitable filter (`realized_profit_30d >= 2000`).

Use `-Format json` if you want the JSON array copied instead. Use `-NoSides` to export only the contest wallets.

The script also writes:

- `data/gmgn-import-contest-only.json`
- `data/gmgn-import-contest-only.txt`
- `data/gmgn-import-sides.json`
- `data/gmgn-import-sides.txt`

Useful flags:

```powershell
$env:RUN_ONCE = "1"       # one sync cycle only
$env:DRY_RUN = "1"        # do not send changes
$env:SYNC_REMOVE = "0"    # do not remove stale managed wallets
```

If direct GMGN fetch is available in your environment:

```powershell
$env:GMGN_COOKIE = "<cloudflare/session cookie if needed>"
npm run scan -- --fresh
```

Outputs:

- `data/wallets.json`
- `data/wallets.csv`
- `data/gmgn-import-current.json`
- `data/gmgn-import-current.txt`
- `data/account-index.json`
- `data/checkpoint.json`
- `data/ranking-history.json`
- `data/rank-movement.json`
- `data/intel.sqlite`
- `data/linked-wallets.json`
- `data/linked-wallets.csv`
- `data/linked-wallets-raw.json`
- `data/mev-wallets.json`
- `data/contest-side-wallets.json`
- `data/contest-side-wallets.csv`
- `data/suspect-balances.json`
- `data/high-balance-linked-wallets.json`
- `data/wallet-enrichment.sqlite`
- `data/contest-buy-windows.jsonl`

## Safety

The collector is read-only. It uses `eth_chainId`, `eth_blockNumber`, `eth_getBlockByNumber`, `eth_getTransactionReceipt`, and `eth_getLogs`. It never asks for a private key and never broadcasts transactions.
