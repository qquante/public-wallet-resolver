#!/usr/bin/env node
import path from "node:path";
import {
  BSC_CHAIN_ID_HEX,
  CONTEST_END_TIMESTAMP,
  CONTEST_START_BLOCK,
  CONTEST_START_TIMESTAMP,
  DEFAULT_CHUNK_SIZE,
  DEFAULT_GMGN_LIMIT,
  DEFAULT_MAX_RANK,
  DEFAULT_MIN_CHUNK_SIZE,
  DEFAULT_OUT_DIR,
  DEFAULT_REDIS_URL,
  DEFAULT_WATCH_INTERVAL_MS,
  GMGN_FOURMEME_ROUTERS,
  GMGN_FOURMEME_ROUTER_SELECTORS
} from "./constants.js";
import { loadGmgnRanking } from "./gmgn.js";
import { JsonRpcWsClient, findBlockAtOrAfterTimestamp, getBlockByNumber, getBlockNumber, hexToNumber } from "./json-rpc-ws.js";
import { loadBscNodes } from "./nodes.js";
import { emptyAccountIndex, mergeIndex, scanFourMemeEvents, scanGmgnRouterTransactions } from "./fourmeme.js";
import { ensureDir, readJsonIfExists, writeJson, writeText } from "./io.js";
import { resolveRankingWallets, toWalletCsv } from "./resolve.js";

function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const item = argv[i];
    if (!item.startsWith("--")) {
      args._.push(item);
      continue;
    }
    const eq = item.indexOf("=");
    if (eq !== -1) {
      args[item.slice(2, eq)] = item.slice(eq + 1);
      continue;
    }
    const key = item.slice(2);
    const next = argv[i + 1];
    if (!next || next.startsWith("--")) {
      args[key] = true;
    } else {
      args[key] = next;
      i += 1;
    }
  }
  return args;
}

function numberArg(args, key, fallback) {
  if (args[key] == null || args[key] === true) return fallback;
  const value = Number(args[key]);
  if (!Number.isFinite(value)) throw new Error(`--${key} deve ser numerico`);
  return value;
}

function stringArg(args, key, fallback = null) {
  if (args[key] == null || args[key] === true) return fallback;
  return String(args[key]);
}

function boolArg(args, key, fallback = false) {
  if (args[key] == null) return fallback;
  return args[key] !== "false" && args[key] !== false;
}

function csvList(value) {
  if (!value) return [];
  return String(value)
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean);
}

async function connectBestRpc(nodes) {
  let lastError = null;
  for (const node of nodes) {
    const client = new JsonRpcWsClient(node.ws_url);
    try {
      const chainId = String(await client.request("eth_chainId")).toLowerCase();
      if (chainId !== BSC_CHAIN_ID_HEX) {
        throw new Error(`chainId inesperado ${chainId}`);
      }
      return { client, node, chainId };
    } catch (error) {
      lastError = error;
      client.close();
    }
  }
  throw new Error(`Nenhum RPC BSC passou no eth_chainId: ${lastError?.message || "sem detalhes"}`);
}

async function runScanOnce(args) {
  const outDir = stringArg(args, "out-dir", DEFAULT_OUT_DIR);
  const gmgnFile = stringArg(args, "gmgn-file");
  const gmgnUrl = stringArg(args, "gmgn-url");
  const redisUrl = stringArg(args, "redis-url", DEFAULT_REDIS_URL);
  const fromBlock = numberArg(args, "from-block", CONTEST_START_BLOCK);
  const chunkSize = numberArg(args, "chunk-size", DEFAULT_CHUNK_SIZE);
  const minChunkSize = numberArg(args, "min-chunk-size", DEFAULT_MIN_CHUNK_SIZE);
  const limit = numberArg(args, "limit", DEFAULT_GMGN_LIMIT);
  const maxRank = numberArg(args, "max-rank", DEFAULT_MAX_RANK);
  const fresh = boolArg(args, "fresh", false);
  const noScan = boolArg(args, "no-scan", false);
  const noRouterScan = boolArg(args, "no-router-scan", false);
  const routerTxConcurrency = numberArg(args, "router-tx-concurrency", 12);
  const routerContracts = csvList(stringArg(args, "router-contracts")).length
    ? csvList(stringArg(args, "router-contracts"))
    : GMGN_FOURMEME_ROUTERS;
  const routerSelectors = csvList(stringArg(args, "router-selectors")).length
    ? csvList(stringArg(args, "router-selectors"))
    : GMGN_FOURMEME_ROUTER_SELECTORS;
  const skipStartCheck = boolArg(args, "skip-start-check", false);
  const explicitRpcUrls = csvList(stringArg(args, "rpc", process.env.BSC_RPC_WS || ""));

  await ensureDir(outDir);

  const rankingRaw = await loadGmgnRanking({ file: gmgnFile, url: gmgnUrl, limit });
  const ranking = {
    ...rankingRaw,
    rows: rankingRaw.rows.filter((row) => row.rank <= maxRank)
  };
  const nodes = await loadBscNodes({ redisUrl, explicitRpcUrls });
  const { client, node } = await connectBestRpc(nodes);

  try {
    const latestBlock = await getBlockNumber(client);
    const toBlockArg = stringArg(args, "to-block", "latest");
    const toBlock = toBlockArg === "latest" ? latestBlock : Number(toBlockArg);

    let startCheck = null;
    if (!skipStartCheck) {
      const found = await findBlockAtOrAfterTimestamp(
        client,
        CONTEST_START_TIMESTAMP,
        Math.max(0, fromBlock - 10000),
        Math.min(latestBlock, fromBlock + 10000)
      );
      const block = await getBlockByNumber(client, found);
      startCheck = {
        expected_timestamp: CONTEST_START_TIMESTAMP,
        expected_from_block: CONTEST_START_BLOCK,
        found_block: found,
        found_timestamp: hexToNumber(block.timestamp),
        ok: found === CONTEST_START_BLOCK
      };
    }

    const indexPath = path.join(outDir, "account-index.json");
    const accountIndex = fresh ? emptyAccountIndex() : await readJsonIfExists(indexPath, emptyAccountIndex());
    accountIndex.scanned ||= emptyAccountIndex().scanned;
    accountIndex.router_scanned ||= emptyAccountIndex().router_scanned;
    accountIndex.accounts ||= {};
    accountIndex.creators ||= {};
    accountIndex.senders ||= {};
    accountIndex.router_txs ||= {};
    const scanFrom = Math.max(fromBlock, (accountIndex.scanned?.to_block ?? fromBlock - 1) + 1);

    let scanSummary = {
      skipped: noScan || scanFrom > toBlock,
      from_block: scanFrom,
      to_block: toBlock,
      chunks: 0,
      logs: 0
    };

    if (!noScan && scanFrom <= toBlock) {
      const scanIndex = await scanFourMemeEvents({
        rpc: client,
        fromBlock: scanFrom,
        toBlock,
        chunkSize,
        minChunkSize,
        onProgress: ({ fromBlock: a, toBlock: b, logs, span }) => {
          console.log(`[scan] ${a}-${b} logs=${logs} span=${span}`);
        }
      });
      mergeIndex(accountIndex, scanIndex);
      scanSummary = {
        skipped: false,
        from_block: scanFrom,
        to_block: toBlock,
        chunks: scanIndex.scanned.chunks,
        logs: scanIndex.scanned.logs
      };
    }

    const routerScanFrom = Math.max(
      fromBlock,
      (accountIndex.router_scanned?.to_block ?? fromBlock - 1) + 1
    );
    let routerScanSummary = {
      skipped: noScan || noRouterScan || routerScanFrom > toBlock,
      from_block: routerScanFrom,
      to_block: toBlock,
      blocks: 0,
      transactions: 0,
      matched: 0
    };

    if (!noScan && !noRouterScan && routerScanFrom <= toBlock) {
      const routerIndex = await scanGmgnRouterTransactions({
        rpc: client,
        fromBlock: routerScanFrom,
        toBlock,
        routers: routerContracts,
        selectors: routerSelectors,
        candidateMasks: ranking.rows.map((row) => row.masked_address),
        concurrency: routerTxConcurrency,
        onProgress: ({ blockNumber, blocks, transactions, matched }) => {
          console.log(`[router] block=${blockNumber} blocks=${blocks} txs=${transactions} matched=${matched}`);
        }
      });
      mergeIndex(accountIndex, routerIndex);
      routerScanSummary = {
        skipped: false,
        from_block: routerScanFrom,
        to_block: toBlock,
        blocks: routerIndex.router_scanned.blocks,
        transactions: routerIndex.router_scanned.transactions,
        matched: routerIndex.router_scanned.matched
      };
    }

    await writeJson(indexPath, accountIndex);

    const rows = resolveRankingWallets(ranking, accountIndex);
    const result = {
      generated_at: new Date().toISOString(),
      gmgn: {
        updated_at: ranking.updated_at,
        rows: rankingRaw.rows.length,
        tracked_rows: ranking.rows.length,
        max_rank: maxRank,
        source: gmgnFile ? "file" : "fetch"
      },
      rpc: {
        endpoint: node.endpoint,
        ws_url: node.ws_url,
        chainId: 56
      },
      scan: {
        from_block: fromBlock,
        to_block: toBlock,
        start_check: startCheck,
        incremental: scanSummary,
        router_incremental: routerScanSummary,
        indexed_trade_wallets: Object.keys(accountIndex.accounts || {}).length,
        indexed_creator_wallets: Object.keys(accountIndex.creators || {}).length,
        indexed_router_tx_wallets: Object.keys(accountIndex.router_txs || {}).length
      },
      wallets: rows
    };

    await writeJson(path.join(outDir, "wallets.json"), result);
    await writeText(path.join(outDir, "wallets.csv"), toWalletCsv(rows));
    await writeJson(path.join(outDir, "checkpoint.json"), {
      updated_at: result.generated_at,
      last_scanned_block: accountIndex.scanned.to_block,
      gmgn_updated_at: ranking.updated_at,
      resolved: rows.filter((row) => row.status.startsWith("resolved")).length,
      ambiguous: rows.filter((row) => row.status === "ambiguous").length,
      not_found: rows.filter((row) => row.status === "not_found_on_fourmeme_window").length
    });

    printWalletTable(rows);
    const resolved = rows.filter((row) => row.status.startsWith("resolved")).length;
    const ambiguous = rows.filter((row) => row.status === "ambiguous").length;
    const notFound = rows.filter((row) => row.status === "not_found_on_fourmeme_window").length;
    console.log(`[done] resolved=${resolved} ambiguous=${ambiguous} not_found=${notFound}`);
    console.log(`[out] ${path.resolve(outDir)}`);
  } finally {
    client.close();
  }
}

function printWalletTable(rows) {
  const compact = rows.map((row) => ({
    rank: row.rank,
    wallet: row.wallet || "",
    status: row.status,
    candidates: row.candidate_count
  }));
  console.table(compact);
}

async function runWatch(args) {
  const intervalMs = numberArg(args, "interval-ms", DEFAULT_WATCH_INTERVAL_MS);
  while (Math.floor(Date.now() / 1000) <= CONTEST_END_TIMESTAMP) {
    await runScanOnce(args);
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const command = args._[0] || "scan";
  if (command === "scan") {
    await runScanOnce(args);
    return;
  }
  if (command === "watch") {
    await runWatch(args);
    return;
  }
  throw new Error(`Comando desconhecido: ${command}`);
}

main().catch((error) => {
  console.error(`[error] ${error.message}`);
  process.exitCode = 1;
});
