#!/usr/bin/env node
import path from "node:path";
import {
  BSC_CHAIN_ID_HEX,
  CONTEST_END_TIMESTAMP,
  CONTEST_START_BLOCK,
  DEFAULT_CHUNK_SIZE,
  DEFAULT_GMGN_LIMIT,
  DEFAULT_MAX_RANK,
  DEFAULT_MIN_CHUNK_SIZE,
  DEFAULT_OUT_DIR,
  DEFAULT_REDIS_URL,
  GMGN_FOURMEME_ROUTERS,
  GMGN_FOURMEME_ROUTER_SELECTORS
} from "./constants.js";
import { loadGmgnRanking } from "./gmgn.js";
import { JsonRpcWsClient, getBlockNumber } from "./json-rpc-ws.js";
import { loadBscNodes } from "./nodes.js";
import { emptyAccountIndex, mergeIndex, scanFourMemeEvents, scanGmgnRouterTransactions } from "./fourmeme.js";
import { ensureDir, readJsonIfExists, writeJson, writeText } from "./io.js";
import { resolveRankingWallets, toWalletCsv } from "./resolve.js";
import { appendRankingSnapshot, buildRankingSnapshot, computeRankMovement } from "./rank-history.js";
import { redisPublish, redisSet } from "./redis.js";
import { buildGmgnImportEntries, toGmgnImportText } from "./sync-data.js";

const REDIS_KEYS = {
  wallets: "gmgn:s12:bsc:wallets",
  ranking: "gmgn:s12:bsc:ranking",
  pending: "gmgn:s12:bsc:pending",
  checkpoint: "gmgn:s12:bsc:checkpoint",
  movement: "gmgn:s12:bsc:rank_movement",
  eventChannel: "gmgn:s12:bsc:events"
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

function envList(name, fallback) {
  const raw = process.env[name];
  if (raw == null || raw === "") return fallback;
  return raw
    .split(",")
    .map((value) => value.trim().toLowerCase())
    .filter(Boolean);
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

async function connectRpcPool({ redisUrl, explicitRpcUrls }, limit) {
  const nodes = await loadBscNodes({ redisUrl, explicitRpcUrls });
  const pool = [];
  let lastError = null;
  for (const node of nodes) {
    if (pool.length >= limit) break;
    const client = new JsonRpcWsClient(node.ws_url);
    try {
      const chainId = String(await client.request("eth_chainId")).toLowerCase();
      if (chainId !== BSC_CHAIN_ID_HEX) throw new Error(`chainId inesperado ${chainId}`);
      pool.push({ client, node });
    } catch (error) {
      lastError = error;
      client.close();
    }
  }
  if (pool.length === 0) {
    throw new Error(`Nenhum RPC BSC passou no eth_chainId: ${lastError?.message || "sem detalhes"}`);
  }
  return pool;
}

function closeRpcPool(pool) {
  for (const item of pool) item.client.close();
}

async function loadRankingBestEffort(config, previousRanking) {
  try {
    const rankingRaw = await loadGmgnRanking({
      file: config.gmgnFile,
      url: config.gmgnUrl,
      limit: config.limit
    });
    return {
      ...rankingRaw,
      rows: rankingRaw.rows.filter((row) => row.rank <= config.maxRank),
      raw_rows: rankingRaw.rows.length,
      source: config.gmgnFile ? "file" : "fetch"
    };
  } catch (error) {
    if (previousRanking) {
      console.warn(`[ranking] mantendo ranking anterior: ${error.message}`);
      return previousRanking;
    }
    throw error;
  }
}

function summarizeRows(rows) {
  return {
    resolved: rows.filter((row) => row.status.startsWith("resolved")).length,
    ambiguous: rows.filter((row) => row.status === "ambiguous").length,
    not_found: rows.filter((row) => row.status === "not_found_on_fourmeme_window").length
  };
}

async function publishState(config, state) {
  const payload = JSON.stringify(state);
  const pending = JSON.stringify({
    generated_at: state.generated_at,
    wallets: state.wallets.filter((row) => row.status === "not_found_on_fourmeme_window")
  });
  const ranking = JSON.stringify({
    generated_at: state.generated_at,
    gmgn: state.gmgn,
    wallets: state.wallets.map((row) => ({
      rank: row.rank,
      masked_address: row.masked_address,
      wallet: row.wallet,
      status: row.status,
      source: row.source
    }))
  });
  const checkpoint = JSON.stringify({
    updated_at: state.generated_at,
    last_scanned_block: state.scan.to_block,
    gmgn_updated_at: state.gmgn.updated_at,
    ...summarizeRows(state.wallets)
  });

  await redisSet(config.redisUrl, REDIS_KEYS.wallets, payload);
  await redisSet(config.redisUrl, REDIS_KEYS.ranking, ranking);
  await redisSet(config.redisUrl, REDIS_KEYS.pending, pending);
  await redisSet(config.redisUrl, REDIS_KEYS.checkpoint, checkpoint);
  await redisPublish(config.redisUrl, REDIS_KEYS.eventChannel, checkpoint);
}

async function publishMovement(config, movement) {
  await redisSet(config.redisUrl, REDIS_KEYS.movement, JSON.stringify(movement));
}

async function writeOutputs(config, state, accountIndex) {
  const historyPath = path.join(config.outDir, "ranking-history.json");
  const movementPath = path.join(config.outDir, "rank-movement.json");
  const history = appendRankingSnapshot(
    await readJsonIfExists(historyPath, { snapshots: [] }),
    buildRankingSnapshot(state)
  );
  const movement = computeRankMovement(history, state);
  const gmgnImportEntries = buildGmgnImportEntries(state.wallets, { maxRank: config.maxRank });

  await writeJson(path.join(config.outDir, "account-index.json"), accountIndex);
  await writeJson(path.join(config.outDir, "wallets.json"), state);
  await writeText(path.join(config.outDir, "wallets.csv"), toWalletCsv(state.wallets));
  await writeJson(path.join(config.outDir, "gmgn-import-contest-only.json"), gmgnImportEntries);
  await writeText(path.join(config.outDir, "gmgn-import-contest-only.txt"), toGmgnImportText(gmgnImportEntries));
  await writeJson(historyPath, history);
  await writeJson(movementPath, movement);
  await writeJson(path.join(config.outDir, "checkpoint.json"), {
    updated_at: state.generated_at,
    last_scanned_block: accountIndex.scanned.to_block,
    gmgn_updated_at: state.gmgn.updated_at,
    ...summarizeRows(state.wallets)
  });
  return movement;
}

async function main() {
  const config = {
    redisUrl: process.env.REDIS_URL || DEFAULT_REDIS_URL,
    outDir: process.env.OUT_DIR || DEFAULT_OUT_DIR,
    gmgnFile: process.env.GMGN_FILE || null,
    gmgnUrl: process.env.GMGN_RANKING_URL || null,
    limit: envNumber("GMGN_LIMIT", DEFAULT_GMGN_LIMIT),
    maxRank: envNumber("MAX_RANK", DEFAULT_MAX_RANK),
    pollIntervalMs: envNumber("POLL_INTERVAL_MS", 15000),
    rankingIntervalMs: envNumber("RANKING_INTERVAL_MS", 5 * 60 * 1000),
    chunkSize: envNumber("CHUNK_SIZE", DEFAULT_CHUNK_SIZE),
    minChunkSize: envNumber("MIN_CHUNK_SIZE", DEFAULT_MIN_CHUNK_SIZE),
    includeTransactionSenders: envBool("INCLUDE_TX_SENDERS", true),
    routerTxScan: envBool("GMGN_ROUTER_TX_SCAN", true),
    routerTxConcurrency: envNumber("GMGN_ROUTER_TX_CONCURRENCY", 28),
    routerTxRpcPoolSize: envNumber("GMGN_ROUTER_TX_RPC_POOL_SIZE", 7),
    routerTxProgressEvery: envNumber("GMGN_ROUTER_TX_PROGRESS_EVERY", 1000),
    routerContracts: envList("GMGN_ROUTER_CONTRACTS", GMGN_FOURMEME_ROUTERS),
    routerSelectors: envList("GMGN_ROUTER_SELECTORS", GMGN_FOURMEME_ROUTER_SELECTORS),
    runOnce: envBool("RUN_ONCE", false),
    explicitRpcUrls: (process.env.BSC_RPC_WS || "")
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean)
  };

  await ensureDir(config.outDir);
  const indexPath = path.join(config.outDir, "account-index.json");
  const accountIndex = await readJsonIfExists(indexPath, emptyAccountIndex());
  accountIndex.scanned ||= emptyAccountIndex().scanned;
  accountIndex.router_scanned ||= emptyAccountIndex().router_scanned;
  accountIndex.accounts ||= {};
  accountIndex.creators ||= {};
  accountIndex.senders ||= {};
  accountIndex.router_txs ||= {};

  let ranking = null;
  let lastRankingLoad = 0;

  console.log(
    `[service] start maxRank=${config.maxRank} outDir=${path.resolve(config.outDir)} redis=${config.redisUrl}`
  );

  while (Math.floor(Date.now() / 1000) <= CONTEST_END_TIMESTAMP) {
    let pool = [];
    try {
      const now = Date.now();
      if (!ranking || now - lastRankingLoad >= config.rankingIntervalMs) {
        ranking = await loadRankingBestEffort(config, ranking);
        lastRankingLoad = now;
      }

      pool = config.routerTxScan
        ? await connectRpcPool(config, config.routerTxRpcPoolSize)
        : [await connectBestRpc(config)];
      const connected = pool[0];
      const client = connected.client;
      const latestBlock = await getBlockNumber(client);
      const scanFrom = Math.max(
        CONTEST_START_BLOCK,
        (accountIndex.scanned?.to_block ?? CONTEST_START_BLOCK - 1) + 1
      );

      let scanSummary = {
        skipped: scanFrom > latestBlock,
        from_block: scanFrom,
        to_block: latestBlock,
        chunks: 0,
        logs: 0
      };

      if (scanFrom <= latestBlock) {
        const scanIndex = await scanFourMemeEvents({
          rpc: client,
          fromBlock: scanFrom,
          toBlock: latestBlock,
          chunkSize: config.chunkSize,
          minChunkSize: config.minChunkSize,
          includeTransactionSenders: config.includeTransactionSenders,
          onProgress: ({ fromBlock, toBlock, logs }) => {
            console.log(`[scan] ${fromBlock}-${toBlock} logs=${logs}`);
          }
        });
        mergeIndex(accountIndex, scanIndex);
        scanSummary = {
          skipped: false,
          from_block: scanFrom,
          to_block: latestBlock,
          chunks: scanIndex.scanned.chunks,
          logs: scanIndex.scanned.logs
        };
      }

      const routerScanFrom = Math.max(
        CONTEST_START_BLOCK,
        (accountIndex.router_scanned?.to_block ?? CONTEST_START_BLOCK - 1) + 1
      );
      let routerScanSummary = {
        skipped: !config.routerTxScan || routerScanFrom > latestBlock,
        from_block: routerScanFrom,
        to_block: latestBlock,
        blocks: 0,
        transactions: 0,
        matched: 0
      };

      if (config.routerTxScan && routerScanFrom <= latestBlock) {
        const routerIndex = await scanGmgnRouterTransactions({
          rpcs: pool.map((item) => item.client),
          fromBlock: routerScanFrom,
          toBlock: latestBlock,
          routers: config.routerContracts,
          selectors: config.routerSelectors,
          candidateMasks: ranking.rows.map((row) => row.masked_address),
          concurrency: config.routerTxConcurrency,
          progressEvery: config.routerTxProgressEvery,
          onProgress: ({ blocks, transactions, matched, blockNumber }) => {
            console.log(`[router] block=${blockNumber} blocks=${blocks} txs=${transactions} matched=${matched}`);
          }
        });
        mergeIndex(accountIndex, routerIndex);
        routerScanSummary = {
          skipped: false,
          from_block: routerScanFrom,
          to_block: latestBlock,
          blocks: routerIndex.router_scanned.blocks,
          transactions: routerIndex.router_scanned.transactions,
          matched: routerIndex.router_scanned.matched
        };
      }

      const wallets = resolveRankingWallets(ranking, accountIndex);
      const state = {
        generated_at: new Date().toISOString(),
        gmgn: {
          updated_at: ranking.updated_at,
          rows: ranking.raw_rows,
          tracked_rows: ranking.rows.length,
          max_rank: config.maxRank,
          source: ranking.source
        },
        rpc: {
          endpoint: connected.node.endpoint,
          ws_url: connected.node.ws_url,
          chainId: 56
        },
        scan: {
          from_block: CONTEST_START_BLOCK,
          to_block: latestBlock,
          incremental: scanSummary,
          indexed_trade_wallets: Object.keys(accountIndex.accounts || {}).length,
          indexed_creator_wallets: Object.keys(accountIndex.creators || {}).length,
          indexed_transaction_senders: Object.keys(accountIndex.senders || {}).length,
          indexed_router_tx_wallets: Object.keys(accountIndex.router_txs || {}).length,
          router_incremental: routerScanSummary
        },
        wallets
      };

      const movement = await writeOutputs(config, state, accountIndex);
      await publishState(config, state);
      await publishMovement(config, movement);

      const summary = summarizeRows(wallets);
      console.log(
        `[state] block=${latestBlock} resolved=${summary.resolved} ambiguous=${summary.ambiguous} not_found=${summary.not_found}`
      );
    } catch (error) {
      console.error(`[service] ${error.stack || error.message}`);
    } finally {
      closeRpcPool(pool);
    }

    if (config.runOnce) {
      console.log("[service] RUN_ONCE=1, stopping after one cycle");
      break;
    }

    await sleep(config.pollIntervalMs);
  }

  console.log("[service] contest window ended");
}

main().catch((error) => {
  console.error(`[fatal] ${error.stack || error.message}`);
  process.exitCode = 1;
});
