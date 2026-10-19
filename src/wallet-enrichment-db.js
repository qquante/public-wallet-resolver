import { DatabaseSync } from "node:sqlite";

export function openWalletEnrichmentDb(file) {
  const db = new DatabaseSync(file);
  initializeWalletEnrichmentDb(db);
  return db;
}

export function initializeWalletEnrichmentDb(db) {
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA synchronous = NORMAL;

    CREATE TABLE IF NOT EXISTS meta (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS wallet_balances (
      wallet TEXT PRIMARY KEY,
      balance_wei TEXT NOT NULL,
      balance_bnb TEXT NOT NULL,
      block_number INTEGER NOT NULL,
      checked_at_ms INTEGER NOT NULL,
      checked_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS gmgn_endpoint_cache (
      wallet TEXT NOT NULL,
      endpoint_key TEXT NOT NULL,
      ok INTEGER NOT NULL,
      status INTEGER,
      fetched_at_ms INTEGER NOT NULL,
      fetched_at TEXT NOT NULL,
      payload_json TEXT,
      error TEXT,
      PRIMARY KEY(wallet, endpoint_key)
    );

    CREATE INDEX IF NOT EXISTS idx_gmgn_endpoint_cache_fetched
      ON gmgn_endpoint_cache(endpoint_key, fetched_at_ms);
  `);
}

export function getMeta(db, key, fallback = null) {
  const row = db.prepare("SELECT value FROM meta WHERE key = ?").get(key);
  return row ? row.value : fallback;
}

export function setMeta(db, key, value) {
  db.prepare(`
    INSERT INTO meta(key, value) VALUES(?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value
  `).run(key, String(value));
}

export function upsertWalletBalance(db, row) {
  db.prepare(`
    INSERT INTO wallet_balances(
      wallet, balance_wei, balance_bnb, block_number, checked_at_ms, checked_at
    )
    VALUES(?, ?, ?, ?, ?, ?)
    ON CONFLICT(wallet) DO UPDATE SET
      balance_wei = excluded.balance_wei,
      balance_bnb = excluded.balance_bnb,
      block_number = excluded.block_number,
      checked_at_ms = excluded.checked_at_ms,
      checked_at = excluded.checked_at
  `).run(
    row.wallet,
    row.balance_wei,
    row.balance_bnb,
    Number(row.block_number),
    Number(row.checked_at_ms),
    row.checked_at
  );
}

export function getWalletBalance(db, wallet) {
  const row = db.prepare("SELECT * FROM wallet_balances WHERE wallet = ?").get(wallet);
  return row ? formatBalanceRow(row) : null;
}

export function listWalletBalances(db) {
  return db.prepare("SELECT * FROM wallet_balances ORDER BY CAST(balance_wei AS REAL) DESC").all()
    .map(formatBalanceRow);
}

function formatBalanceRow(row) {
  return {
    wallet: row.wallet,
    balance_wei: row.balance_wei,
    balance_bnb: row.balance_bnb,
    block_number: Number(row.block_number),
    checked_at_ms: Number(row.checked_at_ms),
    checked_at: row.checked_at
  };
}

export function upsertGmgnEndpointResult(db, result) {
  db.prepare(`
    INSERT INTO gmgn_endpoint_cache(
      wallet, endpoint_key, ok, status, fetched_at_ms, fetched_at, payload_json, error
    )
    VALUES(?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(wallet, endpoint_key) DO UPDATE SET
      ok = excluded.ok,
      status = excluded.status,
      fetched_at_ms = excluded.fetched_at_ms,
      fetched_at = excluded.fetched_at,
      payload_json = excluded.payload_json,
      error = excluded.error
  `).run(
    result.wallet,
    result.endpoint_key,
    result.ok ? 1 : 0,
    result.status == null ? null : Number(result.status),
    Number(result.fetched_at_ms),
    result.fetched_at,
    result.payload == null ? null : JSON.stringify(result.payload),
    result.error || null
  );
}

export function getGmgnEndpointCache(db, wallet, endpointKey) {
  const row = db.prepare(`
    SELECT * FROM gmgn_endpoint_cache WHERE wallet = ? AND endpoint_key = ?
  `).get(wallet, endpointKey);
  return row ? formatEndpointRow(row) : null;
}

export function listGmgnEndpointCacheForWallet(db, wallet) {
  return db.prepare(`
    SELECT * FROM gmgn_endpoint_cache WHERE wallet = ? ORDER BY endpoint_key
  `).all(wallet).map(formatEndpointRow);
}

export function isEndpointFresh(row, { nowMs, successTtlMs, errorRetryMs }) {
  if (!row) return false;
  const age = Number(nowMs) - Number(row.fetched_at_ms);
  return age <= (row.ok ? successTtlMs : errorRetryMs);
}

function formatEndpointRow(row) {
  let payload = null;
  if (row.payload_json) {
    try {
      payload = JSON.parse(row.payload_json);
    } catch {
      payload = null;
    }
  }
  return {
    wallet: row.wallet,
    endpoint_key: row.endpoint_key,
    ok: Boolean(row.ok),
    status: row.status == null ? null : Number(row.status),
    fetched_at_ms: Number(row.fetched_at_ms),
    fetched_at: row.fetched_at,
    payload,
    error: row.error || null
  };
}
