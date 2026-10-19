#!/usr/bin/env node
import fs from "node:fs/promises";
import path from "node:path";
import {
  BSC_CHAIN_ID_HEX,
  CONTEST_END_TIMESTAMP,
  CONTEST_START_BLOCK,
  DEFAULT_CHUNK_SIZE,
  DEFAULT_MIN_CHUNK_SIZE,
  DEFAULT_OUT_DIR,
  DEFAULT_REDIS_URL,
  EVENT_TOPICS,
  GMGN_FOURMEME_ROUTERS,
  GMGN_FOURMEME_ROUTER_SELECTORS,
  TOKEN_MANAGER2
} from "./constants.js";
import { decodeFourMemeLog } from "./fourmeme.js";
import { getBlockNumber, JsonRpcWsClient, numberToHex } from "./json-rpc-ws.js";
import { loadBscNodes } from "./nodes.js";
import { ensureDir, writeJson, writeText } from "./io.js";
import { redisPublish, redisSet } from "./redis.js";
import { scanRouterPurchaseEvents } from "./router-purchases.js";
import {
  contestSideScoresToCsv,
  fillOpenAnchorsFromStoredPurchases,
  getAnchorWindows,
  getCandidateScores,
  getCheckpoint,
  getContestSideScores,
  getMetaNumber,
  ingestPurchaseEvents,
  linkedWalletsToCsv,
  openIntelDb,
  refreshCandidateScores,
  setMeta,
  syncContestWallets
} from "./intel-db.js";

const REDIS_KEYS = {
  linked: "gmgn:s12:bsc:intel:linked",
  mev: "gmgn:s12:bsc:intel:mev",
  sides: "gmgn:s12:bsc:intel:sides",
  checkpoint: "gmgn:s12:bsc:intel:checkpoint",
  eventChannel: "gmgn:s12:bsc:intel:events"
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

async function waitForNextCycle(client, config) {
  if (!config.liveWs || !client) {
    await sleep(config.pollIntervalMs);
    return "poll_sleep";
  }

  let subscriptionId = null;
  let settled = false;
  return await new Promise((resolve) => {
    const finish = async (reason) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (subscriptionId) {
        try {
          await client.unsubscribe(subscriptionId);
        } catch {
          // Best-effort cleanup; the loop closes this WS right after waking.
        }
      }
      resolve(reason);
    };
    const timer = setTimeout(() => finish("live_timeout"), config.liveTimeoutMs);
    client
      .subscribe("newHeads", [], (head) => {
        const blockNumber = head?.number || "unknown";
        finish(`new_head:${blockNumber}`);
      })
      .then((id) => {
        subscriptionId = id;
      })
      .catch(() => {
        clearTimeout(timer);
        sleep(config.pollIntervalMs).then(() => resolve("subscribe_failed_poll_sleep"));
      });
  });
}

async function loadContestWallets(walletsFile, maxRank) {
  const raw = JSON.parse(await fs.readFile(walletsFile, "utf8"));
  if (!Array.isArray(raw.wallets)) throw new Error(`${walletsFile} nao tem wallets[]`);
  return raw.wallets
    .filter((row) => row.rank <= maxRank && row.wallet && String(row.status || "").startsWith("resolved"))
    .map((row) => ({
      rank: Number(row.rank),
      wallet: String(row.wallet).toLowerCase(),
      masked_address: row.masked_address || null,
      status: row.status || null
    }));
}

async function scanPurchaseEvents({
  rpc,
  fromBlock,
  toBlock,
  chunkSize,
  minChunkSize,
  onEvents,
  onProgress
}) {
  let cursor = fromBlock;
  let span = chunkSize;
  let chunks = 0;
  let logsTotal = 0;

  while (cursor <= toBlock) {
    const end = Math.min(toBlock, cursor + span - 1);
    try {
      const logs = await rpc.request(
        "eth_getLogs",
        [
          {
            address: TOKEN_MANAGER2,
            fromBlock: numberToHex(cursor),
            toBlock: numberToHex(end),
            topics: [[EVENT_TOPICS.TokenPurchase]]
          }
        ],
        30000
      );
      const events = logs
        .map(decodeFourMemeLog)
        .filter((event) => event?.eventName === "TokenPurchase")
        .sort((a, b) => a.blockNumber - b.blockNumber || a.logIndex - b.logIndex);
      const ingest = events.length > 0 ? onEvents(events) : { inserted: 0, anchorsCreated: 0, windowRows: 0 };
      chunks += 1;
      logsTotal += logs.length;
      onProgress({ fromBlock: cursor, toBlock: end, logs: logs.length, span, ingest });
      cursor = end + 1;
      if (span < chunkSize) span = Math.min(chunkSize, span * 2);
    } catch (error) {
      if (span <= minChunkSize) {
        throw new Error(`eth_getLogs TokenPurchase falhou em ${cursor}-${end}: ${error.message}`);
      }
      span = Math.max(minChunkSize, Math.floor(span / 2));
    }
  }

  return { chunks, logs: logsTotal };
}

async function writeOutputs(config, db, extra) {
  const checkpoint = {
    updated_at: new Date().toISOString(),
    ...getCheckpoint(db),
    ...extra
  };
  const rawLinked = getCandidateScores(db, { linkedOnly: true, limit: config.outputLimit });
  const mevLike = rawLinked.filter((row) => row.mev_like);
  const linked = rawLinked.filter((row) => !row.mev_like);
  const payload = {
    generated_at: checkpoint.updated_at,
    criteria: {
      suspicious_if_distinct_tokens_gte: 2,
      suspicious_if_total_windows_gte: 3,
      window_size: config.windowSize,
      mev_filter: {
        broad_many_tokens_many_ranks: "tokens>=20, windows>=25, related ranks>=10",
        high_frequency_broad_bot: "appearances>=100, tokens>=10, windows>=25, related ranks>=8",
        early_fast_sniper_pattern: "min position<=3, avg block delay<=60, tokens>=10, windows>=10",
        wide_late_generic_flow: "tokens>=15, windows>=25, related ranks>=12, avg position>=60"
      }
    },
    checkpoint: {
      ...checkpoint,
      linked_candidates_raw: rawLinked.length,
      mev_filtered_candidates: mevLike.length,
      linked_candidates_clean: linked.length
    },
    linked_wallets: linked
  };
  const rawPayload = {
    generated_at: checkpoint.updated_at,
    criteria: payload.criteria,
    checkpoint: payload.checkpoint,
    linked_wallets: rawLinked
  };
  const mevPayload = {
    generated_at: checkpoint.updated_at,
    criteria: payload.criteria.mev_filter,
    checkpoint: payload.checkpoint,
    mev_wallets: mevLike
  };
  const sideScores = getContestSideScores(db, {
    minFollowWindows: config.sideMinFollowWindows,
    limitPerContest: config.sideLimitPerContest
  });
  const sidesPayload = {
    generated_at: checkpoint.updated_at,
    criteria: {
      source: "anchors + first candidate purchase per anchor window",
      window_size: config.windowSize,
      min_follow_windows: config.sideMinFollowWindows,
      limit_per_contest: config.sideLimitPerContest,
      classifications: {
        very_strong_side: "tokens>=5, follow_rate>=25%, entries<=50>=3, specificity>=35%",
        strong_side: "tokens>=3, follow_rate>=15%, entries<=50>=2, specificity>=25%",
        possible_side: "tokens>=2 or follow_windows>=3",
        broad_flow: "candidate follows many ranks with low specificity"
      }
    },
    checkpoint: {
      ...payload.checkpoint,
      side_rows: sideScores.rows.length,
      side_groups: sideScores.groups.length
    },
    groups: sideScores.groups
  };

  await writeJson(path.join(config.outDir, "linked-wallets.json"), payload);
  await writeText(path.join(config.outDir, "linked-wallets.csv"), linkedWalletsToCsv(linked));
  await writeJson(path.join(config.outDir, "linked-wallets-raw.json"), rawPayload);
  await writeText(path.join(config.outDir, "linked-wallets-raw.csv"), linkedWalletsToCsv(rawLinked));
  await writeJson(path.join(config.outDir, "mev-wallets.json"), mevPayload);
  await writeText(path.join(config.outDir, "mev-wallets.csv"), linkedWalletsToCsv(mevLike));
  await writeJson(path.join(config.outDir, "contest-side-wallets.json"), sidesPayload);
  await writeText(path.join(config.outDir, "contest-side-wallets.csv"), contestSideScoresToCsv(sideScores.rows));
  const windows = getAnchorWindows(db, { limit: config.windowOutputLimit });
  await writeText(
    path.join(config.outDir, "contest-buy-windows.jsonl"),
    windows.map((row) => JSON.stringify(row)).join("\n") + (windows.length > 0 ? "\n" : "")
  );

  const checkpointText = JSON.stringify(checkpoint);
  await redisSet(config.redisUrl, REDIS_KEYS.linked, JSON.stringify(payload));
  await redisSet(config.redisUrl, REDIS_KEYS.mev, JSON.stringify(mevPayload));
  await redisSet(config.redisUrl, REDIS_KEYS.sides, JSON.stringify(sidesPayload));
  await redisSet(config.redisUrl, REDIS_KEYS.checkpoint, checkpointText);
  await redisPublish(config.redisUrl, REDIS_KEYS.eventChannel, checkpointText);
  return { checkpoint, linked };
}

async function main() {
  const outDir = process.env.OUT_DIR || DEFAULT_OUT_DIR;
  const config = {
    redisUrl: process.env.REDIS_URL || DEFAULT_REDIS_URL,
    outDir,
    dbFile: process.env.INTEL_DB_FILE || path.join(outDir, "intel.sqlite"),
    walletsFile: process.env.WALLETS_FILE || path.join(outDir, "wallets.json"),
    maxRank: envNumber("MAX_RANK", 20),
    fromBlock: envNumber("INTEL_FROM_BLOCK", CONTEST_START_BLOCK),
    pollIntervalMs: envNumber("INTEL_POLL_INTERVAL_MS", 15000),
    windowSize: envNumber("INTEL_WINDOW_SIZE", 300),
    chunkSize: envNumber("INTEL_CHUNK_SIZE", DEFAULT_CHUNK_SIZE),
    minChunkSize: envNumber("INTEL_MIN_CHUNK_SIZE", DEFAULT_MIN_CHUNK_SIZE),
    outputLimit: envNumber("INTEL_OUTPUT_LIMIT", 10000),
    windowOutputLimit: envNumber("INTEL_WINDOW_OUTPUT_LIMIT", 10000),
    sideMinFollowWindows: envNumber("SIDE_MIN_FOLLOW_WINDOWS", 2),
    sideLimitPerContest: envNumber("SIDE_LIMIT_PER_CONTEST", 200),
    liveWs: envBool("INTEL_LIVE_WS", true),
    liveTimeoutMs: envNumber("INTEL_LIVE_TIMEOUT_MS", envNumber("INTEL_POLL_INTERVAL_MS", 15000)),
    routerScan: envBool("INTEL_ROUTER_SCAN", true),
    routerFromBlock: envNumber("INTEL_ROUTER_FROM_BLOCK", envNumber("INTEL_FROM_BLOCK", CONTEST_START_BLOCK)),
    routerChunkBlocks: envNumber("INTEL_ROUTER_CHUNK_BLOCKS", 1000),
    routerConcurrency: envNumber("INTEL_ROUTER_CONCURRENCY", 28),
    routerRpcPoolSize: envNumber("INTEL_ROUTER_RPC_POOL_SIZE", 7),
    routerOutputEveryChunks: envNumber("INTEL_ROUTER_OUTPUT_EVERY_CHUNKS", 5),
    routerContracts: envList("GMGN_ROUTER_CONTRACTS", GMGN_FOURMEME_ROUTERS),
    routerSelectors: envList("GMGN_ROUTER_SELECTORS", GMGN_FOURMEME_ROUTER_SELECTORS),
    runOnce: envBool("RUN_ONCE", false) || envBool("INTEL_RUN_ONCE", false),
    explicitRpcUrls: (process.env.BSC_RPC_WS || "")
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean)
  };

  await ensureDir(config.outDir);
  const db = openIntelDb(config.dbFile);
  console.log(
    `[intel] start maxRank=${config.maxRank} window=${config.windowSize} db=${path.resolve(config.dbFile)}`
  );

  let startupBackfillDone = false;
  while (Math.floor(Date.now() / 1000) <= CONTEST_END_TIMESTAMP) {
    let pool = [];
    let waited = false;
    try {
      const contestWallets = await loadContestWallets(config.walletsFile, config.maxRank);
      const walletSync = syncContestWallets(db, contestWallets);
      let storedBackfill = { anchorsChecked: 0, inserted: 0 };
      if (!startupBackfillDone || walletSync.createdAnchors > 0) {
        storedBackfill = fillOpenAnchorsFromStoredPurchases(db, { windowSize: config.windowSize });
        startupBackfillDone = true;
      }

      pool = await connectRpcPool(config, config.routerScan ? config.routerRpcPoolSize : 1);
      const connected = pool[0];
      const client = connected.client;
      const latestBlock = await getBlockNumber(client);
      const lastScanned = getMetaNumber(db, "last_scanned_block", config.fromBlock - 1);
      const scanFrom = Math.max(config.fromBlock, lastScanned + 1);
      let scan = { skipped: scanFrom > latestBlock, from_block: scanFrom, to_block: latestBlock, chunks: 0, logs: 0 };
      const routerLastScanned = getMetaNumber(db, "last_router_scanned_block", config.routerFromBlock - 1);
      const routerScanFrom = Math.max(config.routerFromBlock, routerLastScanned + 1);
      let routerScan = {
        skipped: !config.routerScan || routerScanFrom > latestBlock,
        from_block: routerScanFrom,
        to_block: latestBlock,
        chunks: 0,
        blocks: 0,
        transactions: 0,
        router_txs: 0,
        purchases: 0
      };

      if (scanFrom <= latestBlock) {
        const summary = await scanPurchaseEvents({
          rpc: client,
          fromBlock: scanFrom,
          toBlock: latestBlock,
          chunkSize: config.chunkSize,
          minChunkSize: config.minChunkSize,
          onEvents: (events) => ingestPurchaseEvents(db, events, { windowSize: config.windowSize }),
          onProgress: ({ fromBlock, toBlock, logs, ingest }) => {
            console.log(
              `[intel:scan] ${fromBlock}-${toBlock} logs=${logs} inserted=${ingest.inserted} anchors=${ingest.anchorsCreated} windowRows=${ingest.windowRows}`
            );
          }
        });
        setMeta(db, "last_scanned_block", latestBlock);
        scan = { skipped: false, from_block: scanFrom, to_block: latestBlock, ...summary };
      }

      if (config.routerScan && routerScanFrom <= latestBlock) {
        try {
          let routerChunksCompleted = 0;
          let routerPartialOutputs = 0;
          const summary = await scanRouterPurchaseEvents({
            rpcs: pool.map((item) => item.client),
            fromBlock: routerScanFrom,
            toBlock: latestBlock,
            routers: config.routerContracts,
            selectors: config.routerSelectors,
            chunkBlocks: config.routerChunkBlocks,
            concurrency: config.routerConcurrency,
            onEvents: (events) => ingestPurchaseEvents(db, events, { windowSize: config.windowSize }),
            onProgress: async ({ fromBlock, toBlock, blocks, transactions, routerTxs, purchases, ingest }) => {
              routerChunksCompleted += 1;
              setMeta(db, "last_router_scanned_block", toBlock);
              console.log(
                `[intel:router] ${fromBlock}-${toBlock} blocks=${blocks} txs=${transactions} routerTxs=${routerTxs} purchases=${purchases} inserted=${ingest.inserted} anchors=${ingest.anchorsCreated} windowRows=${ingest.windowRows}`
              );
              const shouldFlush =
                config.routerOutputEveryChunks > 0 &&
                (routerChunksCompleted % config.routerOutputEveryChunks === 0 ||
                  ingest.anchorsCreated > 0 ||
                  ingest.windowRows > 0);
              if (shouldFlush) {
                const scoreRefresh = refreshCandidateScores(db);
                await writeOutputs(config, db, {
                  contest_wallets: contestWallets.length,
                  rpc_endpoint: connected.node.endpoint,
                  scan,
                  router_scan: {
                    skipped: false,
                    partial: true,
                    from_block: routerScanFrom,
                    to_block: latestBlock,
                    last_flushed_block: toBlock,
                    chunks_completed: routerChunksCompleted
                  },
                  wallet_sync: walletSync,
                  stored_backfill: storedBackfill,
                  score_refresh: scoreRefresh
                });
                routerPartialOutputs += 1;
              }
            }
          });
          setMeta(db, "last_router_scanned_block", latestBlock);
          routerScan = {
            skipped: false,
            from_block: routerScanFrom,
            to_block: latestBlock,
            partial_outputs: routerPartialOutputs,
            ...summary
          };
        } catch (error) {
          routerScan = {
            ...routerScan,
            skipped: false,
            error: error.message
          };
          console.error(`[intel:router] ${error.stack || error.message}`);
        }
      }

      const scoreRefresh = refreshCandidateScores(db);
      const { checkpoint, linked } = await writeOutputs(config, db, {
        contest_wallets: contestWallets.length,
        rpc_endpoint: connected.node.endpoint,
        scan,
        router_scan: routerScan,
        wallet_sync: walletSync,
        stored_backfill: storedBackfill,
        score_refresh: scoreRefresh
      });
      console.log(
        `[intel:state] block=${checkpoint.last_scanned_block} purchases=${checkpoint.purchases} anchors=${checkpoint.anchors} open=${checkpoint.open_windows} linked=${linked.length}`
      );

      if (config.runOnce) {
        console.log("[intel] RUN_ONCE=1, stopping after one cycle");
        break;
      }
      const wakeReason = await waitForNextCycle(client, config);
      waited = true;
      console.log(`[intel:live] wake=${wakeReason}`);
    } catch (error) {
      console.error(`[intel] ${error.stack || error.message}`);
    } finally {
      closeRpcPool(pool);
    }

    if (config.runOnce) {
      console.log("[intel] RUN_ONCE=1, stopping after one cycle");
      break;
    }
    if (!waited) await sleep(config.pollIntervalMs);
  }

  db.close();
  console.log("[intel] contest window ended");
}

main().catch((error) => {
  console.error(`[fatal] ${error.stack || error.message}`);
  process.exitCode = 1;
});
