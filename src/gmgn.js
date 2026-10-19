import fs from "node:fs/promises";
import { DEFAULT_GMGN_LIMIT } from "./constants.js";

export function buildDefaultGmgnUrl(limit = DEFAULT_GMGN_LIMIT) {
  const url = new URL("https://gmgn.ai/api/v1/activity/s12/ladder_tournament_rank");
  url.searchParams.set("rank_type", "TOTAL_RANK");
  url.searchParams.set("order_by", "rank");
  url.searchParams.set("direction", "desc");
  url.searchParams.set("limit", String(limit));
  return url.toString();
}

export async function loadGmgnPayload({ file, url, limit = DEFAULT_GMGN_LIMIT } = {}) {
  if (file) {
    const raw = await fs.readFile(file, "utf8");
    return JSON.parse(raw);
  }

  const target = url || process.env.GMGN_RANKING_URL || buildDefaultGmgnUrl(limit);
  const headers = {
    accept: "application/json, text/plain, */*",
    referer: "https://gmgn.ai/contest/s12?chain=bsc",
    "user-agent":
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36"
  };
  if (process.env.GMGN_COOKIE) headers.cookie = process.env.GMGN_COOKIE;

  const response = await fetch(target, { headers });
  const text = await response.text();
  if (!response.ok) {
    throw new Error(
      `GMGN fetch falhou com HTTP ${response.status}. Use --gmgn-file ou defina GMGN_COOKIE. Body: ${text.slice(0, 120)}`
    );
  }
  return JSON.parse(text);
}

export function normalizeGmgnRanking(payload) {
  if (!payload || payload.code !== 0 || !Array.isArray(payload.data?.list)) {
    throw new Error("Payload GMGN inesperado: esperado { code: 0, data: { list: [] } }");
  }

  return {
    updated_at: payload.data.updated_at ?? null,
    rows: payload.data.list.map((row) => ({
      rank: Number(row.rank),
      masked_address: String(row.address || "").toLowerCase(),
      balance: Number(row.balance ?? 0),
      winrate: Number(row.winrate ?? 0),
      profit: Number(row.profit ?? 0),
      pnl: Number(row.pnl ?? 0),
      avatar: row.avatar ?? null
    }))
  };
}

export async function loadGmgnRanking(options = {}) {
  return normalizeGmgnRanking(await loadGmgnPayload(options));
}

