import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import {
  getGmgnEndpointCache,
  initializeWalletEnrichmentDb,
  isEndpointFresh,
  upsertGmgnEndpointResult,
  upsertWalletBalance,
  getWalletBalance
} from "../src/wallet-enrichment-db.js";

const WALLET = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

function memoryDb() {
  const db = new DatabaseSync(":memory:");
  initializeWalletEnrichmentDb(db);
  return db;
}

test("wallet balance cache upserts latest RPC result", () => {
  const db = memoryDb();
  upsertWalletBalance(db, {
    wallet: WALLET,
    balance_wei: "1",
    balance_bnb: "0.000000000000000001",
    block_number: 10,
    checked_at_ms: 1000,
    checked_at: "2026-07-07T00:00:00.000Z"
  });
  upsertWalletBalance(db, {
    wallet: WALLET,
    balance_wei: "2000000000000000000",
    balance_bnb: "2",
    block_number: 11,
    checked_at_ms: 2000,
    checked_at: "2026-07-07T00:00:01.000Z"
  });

  const row = getWalletBalance(db, WALLET);
  assert.equal(row.balance_bnb, "2");
  assert.equal(row.block_number, 11);
  db.close();
});

test("endpoint cache tracks success and retry freshness separately", () => {
  const db = memoryDb();
  upsertGmgnEndpointResult(db, {
    wallet: WALLET,
    endpoint_key: "smartmoney",
    ok: true,
    status: 200,
    fetched_at_ms: 1000,
    fetched_at: "2026-07-07T00:00:00.000Z",
    payload: { code: 0, data: { bnb_balance: "3" } }
  });

  const cached = getGmgnEndpointCache(db, WALLET, "smartmoney");
  assert.equal(cached.ok, true);
  assert.equal(cached.payload.data.bnb_balance, "3");
  assert.equal(isEndpointFresh(cached, { nowMs: 1500, successTtlMs: 1000, errorRetryMs: 100 }), true);
  assert.equal(isEndpointFresh(cached, { nowMs: 2500, successTtlMs: 1000, errorRetryMs: 100 }), false);
  db.close();
});
