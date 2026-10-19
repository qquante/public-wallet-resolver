#!/usr/bin/env node
import fs from "node:fs/promises";
import path from "node:path";
import { CdpClient, findGmgnPage } from "./cdp-client.js";
import { gmgnPageSyncFunction } from "./gmgn-page-sync.js";
import { ensureDir, readJsonIfExists, writeJson } from "./io.js";
import { buildManagedWallets, diffManagedWallets } from "./sync-data.js";

const DEFAULT_GROUP_ID = "";

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

async function readWalletState(walletsFile) {
  const raw = JSON.parse(await fs.readFile(walletsFile, "utf8"));
  if (!Array.isArray(raw.wallets)) {
    throw new Error(`${walletsFile} nao tem campo wallets[]`);
  }
  return raw;
}

async function syncOnce(config) {
  const page = await findGmgnPage(config.cdpUrl);
  const cdp = new CdpClient(page.webSocketDebuggerUrl);
  try {
    const walletState = await readWalletState(config.walletsFile);
    const desired = buildManagedWallets(walletState.wallets, {
      maxRank: config.maxRank,
      namePrefix: config.namePrefix,
      nameSeparator: config.nameSeparator
    });
    const syncState = await readJsonIfExists(config.stateFile, { managed: [] });
    const previousManaged = syncState.auth_lost ? [] : syncState.managed || [];
    const diff = diffManagedWallets(previousManaged, desired, {
      syncRemove: config.syncRemove
    });

    const result = await cdp.evaluate(
      gmgnPageSyncFunction().toString(),
      {
        chain: config.chain,
        groupId: config.groupId,
        desired: diff.upsert,
        remove: diff.remove,
        dryRun: config.dryRun,
        batchSize: config.batchSize,
        requestDelayMs: config.requestDelayMs,
        reloadAfterSync: config.reloadAfterSync,
        fetchRanking: config.fetchRanking,
        rankingLimit: config.rankingLimit
      },
      120000
    );

    const failed = (result.results || []).filter((item) => !item.ok || item.json?.code !== 0);
    const rankingOk = result.ranking?.ok && result.ranking?.json?.code === 0;
    if (rankingOk && config.rankingFile) {
      await writeJson(config.rankingFile, result.ranking.json);
    }
    const authLost = Boolean(result.authLost);
    const nextManaged = config.dryRun
      ? syncState.managed || []
      : authLost
        ? syncState.managed || []
        : desired;
    const attemptedUpserts = (result.results || [])
      .filter((item) => item.action === "follow_wallet")
      .reduce((total, item) => total + Number(item.count || 0), 0);
    const attemptedRemoves = (result.results || [])
      .filter((item) => item.action === "unfollow_wallet").length;
    const output = {
      updated_at: new Date().toISOString(),
      chrome_page: {
        title: page.title,
        url: page.url
      },
      source_wallets_generated_at: walletState.generated_at,
      group_id: config.groupId,
      max_rank: config.maxRank,
      desired_count: desired.length,
      upsert_count: attemptedUpserts,
      remove_count: attemptedRemoves,
      pending_upsert_count: diff.upsert.length,
      pending_remove_count: diff.remove.length,
      auth_lost: authLost,
      auth: result.auth || null,
      dry_run: config.dryRun,
      failed_count: failed.length,
      ranking_fetch: result.ranking
        ? {
            ok: result.ranking.ok,
            status: result.ranking.status,
            code: result.ranking.json?.code,
            updated_at: result.ranking.json?.data?.updated_at,
            rows: result.ranking.json?.data?.list?.length ?? null,
            wrote_file: Boolean(rankingOk && config.rankingFile)
          }
        : null,
      result,
      managed: nextManaged
    };

    await writeJson(config.stateFile, output);
    console.log(
      `[browser-sync] desired=${desired.length} upsert=${attemptedUpserts} remove=${attemptedRemoves} pending_upsert=${diff.upsert.length} pending_remove=${diff.remove.length} failed=${failed.length} auth=${authLost ? "lost" : "ok"} ranking=${rankingOk ? "ok" : "skip"} dryRun=${config.dryRun}`
    );
    if (failed.length > 0) {
      console.log(JSON.stringify(failed, null, 2));
    }
  } finally {
    cdp.close();
  }
}

async function main() {
  const outDir = process.env.OUT_DIR || "data";
  await ensureDir(outDir);
  const config = {
    cdpUrl: process.env.CHROME_CDP_URL || "http://127.0.0.1:9222",
    walletsFile: process.env.WALLETS_FILE || path.join(outDir, "wallets.json"),
    stateFile: process.env.BROWSER_SYNC_STATE || path.join(outDir, "gmgn-browser-sync-state.json"),
    groupId: process.env.GMGN_GROUP_ID ?? DEFAULT_GROUP_ID,
    chain: process.env.GMGN_CHAIN || "bsc",
    maxRank: envNumber("MAX_RANK", 20),
    rankingFile: process.env.GMGN_RANKING_FILE || path.join(outDir, "gmgn-ranking-current.network-response"),
    fetchRanking: envBool("GMGN_FETCH_RANKING", true),
    rankingLimit: envNumber("GMGN_LIMIT", 30),
    namePrefix: process.env.GMGN_NAME_PREFIX || "GMGN",
    nameSeparator: process.env.GMGN_NAME_SEPARATOR ?? "-",
    batchSize: envNumber("GMGN_SYNC_BATCH_SIZE", 200),
    requestDelayMs: envNumber("GMGN_SYNC_DELAY_MS", 500),
    reloadAfterSync: envBool("GMGN_RELOAD_AFTER_SYNC", true),
    syncRemove: envBool("SYNC_REMOVE", true),
    dryRun: envBool("DRY_RUN", false),
    runOnce: envBool("RUN_ONCE", false),
    intervalMs: envNumber("BROWSER_SYNC_INTERVAL_MS", 5 * 60 * 1000)
  };

  console.log(
    `[browser-sync] cdp=${config.cdpUrl} group=${config.groupId} maxRank=${config.maxRank} syncRemove=${config.syncRemove}`
  );
  while (true) {
    try {
      await syncOnce(config);
    } catch (error) {
      console.error(`[browser-sync] ${error.stack || error.message}`);
    }
    if (config.runOnce) break;
    await sleep(config.intervalMs);
  }
}

main().catch((error) => {
  console.error(`[fatal] ${error.stack || error.message}`);
  process.exitCode = 1;
});
