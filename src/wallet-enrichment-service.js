#!/usr/bin/env node
import fs from "node:fs/promises";
import path from "node:path";
import { parseDecimalToWei, hexWeiToBigInt, formatWeiToDecimal } from "./amounts.js";
import { BSC_CHAIN_ID_HEX, DEFAULT_OUT_DIR, DEFAULT_REDIS_URL } from "./constants.js";
import { CdpClient, findGmgnPage } from "./cdp-client.js";
import { DEFAULT_GMGN_ENDPOINT_SPECS, gmgnWalletEnrichmentFunction } from "./gmgn-wallet-enrichment.js";
import { ensureDir, writeJson, writeText } from "./io.js";
import { JsonRpcWsClient } from "./json-rpc-ws.js";
import { loadBscNodes } from "./nodes.js";
import { redisPublish, redisSet } from "./redis.js";
import {
  getGmgnEndpointCache,
  getWalletBalance,
  isEndpointFresh,
  listGmgnEndpointCacheForWallet,
  openWalletEnrichmentDb,
  setMeta,
  upsertGmgnEndpointResult,
  upsertWalletBalance
} from "./wallet-enrichment-db.js";

const REDIS_KEYS = {
  highBalance: "gmgn:s12:bsc:enrich:high_balance",
  checkpoint: "gmgn:s12:bsc:enrich:checkpoint",
  eventChannel: "gmgn:s12:bsc:enrich:events"
};

function envNumber(name, fallback) {
  const raw = process.env[name];
  if (raw == null || raw === "") return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value)) throw new Error(`${name} deve ser numerico`);
  return value;
}

function envBool(name, fallback = false) {
  const raw = process.env[name];
  if (raw == null || raw === "") return fallback;
  return raw !== "0" && raw.toLowerCase() !== "false";
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function mapWithConcurrency(items, concurrency, fn) {
  const results = new Array(items.length);
  let nextIndex = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(concurrency, items.length)) }, async () => {
    while (nextIndex < items.length) {
      const index = nextIndex;
      nextIndex += 1;
      results[index] = await fn(items[index], index);
    }
  });
  await Promise.all(workers);
  return results;
}

async function connectBestRpc({ redisUrl, explicitRpcUrls }) {
  const nodes = await loadBscNodes({ redisUrl, explicitRpcUrls });
  let lastError = null;
  for (const node of nodes) {
    const client = new JsonRpcWsClient(node.ws_url);
    try {
      const chainId = String(await client.request("eth_chainId")).toLowerCase();
      if (chainId !== BSC_CHAIN_ID_HEX) throw new Error(`chainId inesperado ${chainId}`);
      return { client, node };
    } catch (error) {
      lastError = error;
      client.close();
    }
  }
  throw new Error(`Nenhum RPC BSC passou no eth_chainId: ${lastError?.message || "sem detalhes"}`);
}

async function loadLinkedWallets(file, limit) {
  const raw = JSON.parse(await fs.readFile(file, "utf8"));
  if (!Array.isArray(raw.linked_wallets)) throw new Error(`${file} nao tem linked_wallets[]`);
  return raw.linked_wallets
    .filter((row) => row?.candidate_wallet && !row.mev_like)
    .slice(0, limit > 0 ? limit : undefined)
    .map((row) => ({
      ...row,
      candidate_wallet: String(row.candidate_wallet).toLowerCase()
    }));
}

function endpointSpecsFromEnv() {
  const raw = process.env.GMGN_ENRICH_ENDPOINTS;
  if (!raw) return DEFAULT_GMGN_ENDPOINT_SPECS;
  const wanted = new Set(raw.split(",").map((item) => item.trim()).filter(Boolean));
  return DEFAULT_GMGN_ENDPOINT_SPECS.filter((spec) => wanted.has(spec.key));
}

function buildEndpointTasks(db, wallets, config, nowMs) {
  const tasks = [];
  for (const wallet of wallets) {
    for (const spec of config.endpointSpecs) {
      const cached = getGmgnEndpointCache(db, wallet.candidate_wallet, spec.key);
      if (
        isEndpointFresh(cached, {
          nowMs,
          successTtlMs: config.gmgnCacheTtlMs,
          errorRetryMs: config.gmgnErrorRetryMs
        })
      ) {
        continue;
      }
      tasks.push({
        wallet: wallet.candidate_wallet,
        endpoint_key: spec.key,
        ...spec
      });
      if (tasks.length >= config.maxEndpointTasksPerCycle) return tasks;
    }
  }
  return tasks;
}

function countEndpointTasks(db, wallets, config, nowMs) {
  let total = 0;
  for (const wallet of wallets) {
    for (const spec of config.endpointSpecs) {
      const cached = getGmgnEndpointCache(db, wallet.candidate_wallet, spec.key);
      if (
        isEndpointFresh(cached, {
          nowMs,
          successTtlMs: config.gmgnCacheTtlMs,
          errorRetryMs: config.gmgnErrorRetryMs
        })
      ) {
        continue;
      }
      total += 1;
    }
  }
  return total;
}

async function fetchBalances(db, rpc, suspects, config, blockNumber) {
  const nowMs = Date.now();
  const checkedAt = new Date(nowMs).toISOString();
  let fetched = 0;
  let cacheHits = 0;
  const rows = new Array(suspects.length);
  const stale = [];

  for (let index = 0; index < suspects.length; index += 1) {
    const suspect = suspects[index];
    const cached = getWalletBalance(db, suspect.candidate_wallet);
    if (cached && nowMs - cached.checked_at_ms <= config.balanceCacheTtlMs) {
      cacheHits += 1;
      rows[index] = { ...suspect, ...cached };
      continue;
    }
    stale.push({ suspect, index });
  }

  await mapWithConcurrency(stale, config.balanceRpcConcurrency, async ({ suspect, index }) => {
    const raw = await rpc.request("eth_getBalance", [suspect.candidate_wallet, "latest"]);
    const wei = hexWeiToBigInt(raw);
    const balance = {
      wallet: suspect.candidate_wallet,
      balance_wei: wei.toString(),
      balance_bnb: formatWeiToDecimal(wei, 18, 9),
      block_number: blockNumber,
      checked_at_ms: nowMs,
      checked_at: checkedAt
    };
    upsertWalletBalance(db, balance);
    rows[index] = { ...suspect, ...balance };
    fetched += 1;
  });

  return { rows: rows.filter(Boolean), fetched, cacheHits };
}

async function fetchGmgnEndpoints(db, tasks, config) {
  if (tasks.length === 0) {
    return { attempted: 0, ok: 0, failed: 0, auth: null, skipped: false };
  }

  let ok = 0;
  let failed = 0;
  let auth = null;
  let chromePage = null;

  for (let i = 0; i < tasks.length; i += config.cdpBatchSize) {
    const batch = tasks.slice(i, i + config.cdpBatchSize);
    let result;
    try {
      result = await evaluateGmgnBatch(config, batch);
    } catch {
      await sleep(1000);
      try {
        result = await evaluateGmgnBatch(config, batch);
      } catch (error) {
        const nowMs = Date.now();
        const fetchedAt = new Date(nowMs).toISOString();
        for (const task of batch) {
          upsertGmgnEndpointResult(db, {
            wallet: task.wallet,
            endpoint_key: task.endpoint_key,
            ok: false,
            status: null,
            fetched_at_ms: nowMs,
            fetched_at: fetchedAt,
            payload: null,
            error: error.message
          });
          failed += 1;
        }
        continue;
      }
    }

    auth = result.auth || auth;
    chromePage = result.chrome_page || chromePage;
    for (const item of result.results || []) {
      upsertGmgnEndpointResult(db, item);
      if (item.ok) ok += 1;
      else failed += 1;
    }
  }

  return {
    attempted: tasks.length,
    ok,
    failed,
    auth,
    chrome_page: chromePage,
    skipped: false
  };
}

async function evaluateGmgnBatch(config, batch) {
  const page = await findGmgnPage(config.cdpUrl);
  const cdp = new CdpClient(page.webSocketDebuggerUrl);
  try {
    const result = await cdp.evaluate(
      gmgnWalletEnrichmentFunction().toString(),
      {
        chain: config.chain,
        tasks: batch,
        activityLimit: config.activityLimit,
        requestDelayMs: config.requestDelayMs
      },
      config.cdpTimeoutMs
    );
    return {
      ...result,
      chrome_page: { title: page.title, url: page.url }
    };
  } finally {
    cdp.close();
  }
}

function endpointPayload(cacheRow) {
  return cacheRow?.ok ? cacheRow.payload?.data ?? cacheRow.payload : null;
}

function cacheStatus(cacheRows) {
  return Object.fromEntries(
    cacheRows.map((row) => [
      row.endpoint_key,
      {
        ok: row.ok,
        status: row.status,
        fetched_at: row.fetched_at,
        error: row.error
      }
    ])
  );
}

function buildWalletOutput(db, eligibleRows) {
  return eligibleRows.map((row) => {
    const cacheRows = listGmgnEndpointCacheForWallet(db, row.candidate_wallet);
    const byKey = Object.fromEntries(cacheRows.map((cacheRow) => [cacheRow.endpoint_key, cacheRow]));
    const smartmoney = endpointPayload(byKey.smartmoney);
    const common = endpointPayload(byKey.common_stat);
    const activity = endpointPayload(byKey.activity_all_p1);
    const holdings = endpointPayload(byKey.holdings);
    const profitAll = endpointPayload(byKey.profit_stat_all);
    const profit7d = endpointPayload(byKey.profit_stat_7d);

    return {
      wallet: row.candidate_wallet,
      balance_wei: row.balance_wei,
      balance_bnb: row.balance_bnb,
      balance_block: row.block_number,
      balance_checked_at: row.checked_at,
      linked_metrics: {
        total_appearances: row.total_appearances,
        distinct_tokens_after_contest: row.distinct_tokens_after_contest,
        total_windows_seen: row.total_windows_seen,
        related_ranks: row.related_ranks,
        avg_position: row.avg_position,
        min_position: row.min_position,
        avg_block_delay: row.avg_block_delay,
        first_seen_block: row.first_seen_block,
        last_seen_block: row.last_seen_block,
        first_tx: row.first_tx,
        last_tx: row.last_tx
      },
      gmgn: {
        smartmoney,
        common_stat: common,
        profit_stat: {
          all: profitAll,
          "7d": profit7d
        },
        activity_all_p1: activity,
        holdings
      },
      gmgn_cache: cacheStatus(cacheRows)
    };
  });
}

function balancesCsv(rows) {
  const header = [
    "wallet",
    "eligible",
    "balance_bnb",
    "balance_wei",
    "block_number",
    "distinct_tokens_after_contest",
    "total_windows_seen",
    "total_appearances",
    "related_ranks",
    "first_tx",
    "last_tx"
  ];
  const lines = rows.map((row) =>
    [
      row.candidate_wallet,
      row.eligible ? "1" : "0",
      row.balance_bnb,
      row.balance_wei,
      row.block_number,
      row.distinct_tokens_after_contest,
      row.total_windows_seen,
      row.total_appearances,
      Array.isArray(row.related_ranks) ? row.related_ranks.join("|") : "",
      row.first_tx,
      row.last_tx
    ].map(csvCell).join(",")
  );
  return `${header.join(",")}\n${lines.join("\n")}\n`;
}

function enrichedCsv(rows) {
  const header = [
    "wallet",
    "balance_bnb",
    "total_value",
    "realized_profit",
    "pnl",
    "pnl_7d",
    "buy_7d",
    "sell_7d",
    "fund_from_address",
    "fund_amount",
    "follow_count",
    "remark_count",
    "activity_count",
    "last_activity_tx"
  ];
  const lines = rows.map((row) => {
    const smart = row.gmgn.smartmoney || {};
    const common = row.gmgn.common_stat || {};
    const activities = row.gmgn.activity_all_p1?.activities || [];
    return [
      row.wallet,
      row.balance_bnb,
      smart.total_value,
      smart.realized_profit,
      smart.pnl,
      smart.pnl_7d,
      smart.buy_7d,
      smart.sell_7d,
      common.fund_from_address,
      common.fund_amount,
      common.follow_count,
      common.remark_count,
      activities.length,
      activities[0]?.tx_hash
    ].map(csvCell).join(",");
  });
  return `${header.join(",")}\n${lines.join("\n")}\n`;
}

function csvCell(value) {
  const text = String(value ?? "");
  if (!/[",\n]/.test(text)) return text;
  return `"${text.replaceAll('"', '""')}"`;
}

async function writeOutputs(config, allRows, eligibleRows, enrichedRows, extra) {
  const generatedAt = new Date().toISOString();
  const payload = {
    generated_at: generatedAt,
    criteria: {
      source: path.basename(config.linkedWalletsFile),
      min_bnb_balance: config.minBalanceBnb,
      balance_source: "eth_getBalance(latest)",
      gmgn_cache_ttl_ms: config.gmgnCacheTtlMs,
      gmgn_error_retry_ms: config.gmgnErrorRetryMs
    },
    checkpoint: {
      generated_at: generatedAt,
      suspects: allRows.length,
      high_balance_wallets: eligibleRows.length,
      ...extra
    },
    wallets: enrichedRows
  };
  const balancePayload = {
    generated_at: generatedAt,
    criteria: payload.criteria,
    checkpoint: payload.checkpoint,
    wallets: allRows
  };

  await writeJson(path.join(config.outDir, "suspect-balances.json"), balancePayload);
  await writeText(path.join(config.outDir, "suspect-balances.csv"), balancesCsv(allRows));
  await writeJson(path.join(config.outDir, "high-balance-linked-wallets.json"), payload);
  await writeText(path.join(config.outDir, "high-balance-linked-wallets.csv"), enrichedCsv(enrichedRows));

  const checkpointText = JSON.stringify(payload.checkpoint);
  await redisSet(config.redisUrl, REDIS_KEYS.highBalance, JSON.stringify(payload));
  await redisSet(config.redisUrl, REDIS_KEYS.checkpoint, checkpointText);
  await redisPublish(config.redisUrl, REDIS_KEYS.eventChannel, checkpointText);
  return payload.checkpoint;
}

async function runOnce(config, db) {
  const suspects = await loadLinkedWallets(config.linkedWalletsFile, config.maxSuspects);
  const connected = await connectBestRpc(config);
  let client = connected.client;
  try {
    const latestBlock = Number(BigInt(await client.request("eth_blockNumber")));
    const balanceSummary = await fetchBalances(db, client, suspects, config, latestBlock);
    const thresholdWei = parseDecimalToWei(config.minBalanceBnb);
    const allRows = balanceSummary.rows
      .map((row) => ({
        ...row,
        eligible: BigInt(row.balance_wei) >= thresholdWei
      }))
      .sort((a, b) => {
        const left = BigInt(a.balance_wei);
        const right = BigInt(b.balance_wei);
        if (left === right) return 0;
        return left > right ? -1 : 1;
      });
    const eligibleRows = allRows.filter((row) => row.eligible);
    const nowMs = Date.now();
    const tasks = buildEndpointTasks(db, eligibleRows, config, nowMs);

    let gmgnSummary = { attempted: 0, ok: 0, failed: 0, skipped: false };
    if (tasks.length > 0 && !config.disableGmgnFetch) {
      try {
        gmgnSummary = await fetchGmgnEndpoints(db, tasks, config);
      } catch (error) {
        gmgnSummary = {
          attempted: tasks.length,
          ok: 0,
          failed: tasks.length,
          skipped: true,
          error: error.message
        };
      }
    }

    const enrichedRows = buildWalletOutput(db, eligibleRows);
    const pendingEndpoints = countEndpointTasks(db, eligibleRows, config, Date.now());
    const checkpoint = await writeOutputs(config, allRows, eligibleRows, enrichedRows, {
      latest_block: latestBlock,
      rpc_endpoint: connected.node.endpoint,
      balances_fetched: balanceSummary.fetched,
      balance_cache_hits: balanceSummary.cacheHits,
      gmgn_endpoint_tasks_attempted: gmgnSummary.attempted,
      gmgn_endpoint_tasks_ok: gmgnSummary.ok,
      gmgn_endpoint_tasks_failed: gmgnSummary.failed,
      gmgn_fetch_skipped: gmgnSummary.skipped,
      gmgn_fetch_error: gmgnSummary.error || null,
      pending_gmgn_endpoints: pendingEndpoints,
      gmgn_endpoint_batch_cap: config.maxEndpointTasksPerCycle,
      chrome_page: gmgnSummary.chrome_page || null,
      auth: gmgnSummary.auth || null
    });
    setMeta(db, "last_checkpoint", JSON.stringify(checkpoint));
    console.log(
      `[enrich] suspects=${allRows.length} high_balance=${eligibleRows.length} balances_fetched=${balanceSummary.fetched} gmgn=${gmgnSummary.ok}/${gmgnSummary.attempted} pending=${pendingEndpoints}`
    );
  } finally {
    client.close();
  }
}

async function main() {
  const outDir = process.env.OUT_DIR || DEFAULT_OUT_DIR;
  await ensureDir(outDir);
  const config = {
    redisUrl: process.env.REDIS_URL || DEFAULT_REDIS_URL,
    outDir,
    dbFile: process.env.ENRICH_DB_FILE || path.join(outDir, "wallet-enrichment.sqlite"),
    linkedWalletsFile: process.env.LINKED_WALLETS_FILE || path.join(outDir, "linked-wallets.json"),
    minBalanceBnb: process.env.MIN_BNB_BALANCE || "2",
    maxSuspects: envNumber("ENRICH_MAX_SUSPECTS", 0),
    balanceRpcConcurrency: envNumber("BALANCE_RPC_CONCURRENCY", 25),
    balanceCacheTtlMs: envNumber("BALANCE_CACHE_TTL_MS", 60_000),
    gmgnCacheTtlMs: envNumber("GMGN_ENRICH_CACHE_TTL_MS", 60 * 60 * 1000),
    gmgnErrorRetryMs: envNumber("GMGN_ENRICH_ERROR_RETRY_MS", 5 * 60 * 1000),
    maxEndpointTasksPerCycle: envNumber("GMGN_ENRICH_MAX_ENDPOINTS_PER_CYCLE", 300),
    cdpBatchSize: envNumber("GMGN_ENRICH_CDP_BATCH_SIZE", 60),
    activityLimit: envNumber("GMGN_ENRICH_ACTIVITY_LIMIT", 50),
    requestDelayMs: envNumber("GMGN_ENRICH_REQUEST_DELAY_MS", 150),
    cdpTimeoutMs: envNumber("GMGN_ENRICH_CDP_TIMEOUT_MS", 300000),
    intervalMs: envNumber("ENRICH_INTERVAL_MS", 5 * 60 * 1000),
    runOnce: envBool("RUN_ONCE", false) || envBool("ENRICH_RUN_ONCE", false),
    disableGmgnFetch: envBool("GMGN_ENRICH_DISABLE_FETCH", false),
    cdpUrl: process.env.CHROME_CDP_URL || "http://127.0.0.1:9222",
    chain: process.env.GMGN_CHAIN || "bsc",
    endpointSpecs: endpointSpecsFromEnv(),
    explicitRpcUrls: (process.env.BSC_RPC_WS || "")
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean)
  };

  const db = openWalletEnrichmentDb(config.dbFile);
  console.log(
    `[enrich] start min=${config.minBalanceBnb}BNB source=${path.resolve(config.linkedWalletsFile)} db=${path.resolve(config.dbFile)}`
  );
  try {
    while (true) {
      try {
        await runOnce(config, db);
      } catch (error) {
        console.error(`[enrich] ${error.stack || error.message}`);
      }
      if (config.runOnce) break;
      await sleep(config.intervalMs);
    }
  } finally {
    db.close();
  }
}

main().catch((error) => {
  console.error(`[fatal] ${error.stack || error.message}`);
  process.exitCode = 1;
});
