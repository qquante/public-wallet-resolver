import test from "node:test";
import assert from "node:assert/strict";
import { matchesMask, parseMaskedAddress, resolveRankingWallets, toWalletCsv } from "../src/resolve.js";

test("parseMaskedAddress supports GMGN masked addresses", () => {
  const parsed = parseMaskedAddress("0xabc...123");
  assert.deepEqual(parsed, { type: "masked", prefix: "0xabc", suffix: "123" });
  assert.equal(matchesMask("0xabc0000000000000000000000000000000000123", parsed), true);
  assert.equal(matchesMask("0xabd0000000000000000000000000000000000123", parsed), false);
});

test("resolveRankingWallets returns resolved, ambiguous and not_found", () => {
  const ranking = {
    updated_at: 1,
    rows: [
      { rank: 1, masked_address: "0xabc...111", balance: 1, winrate: 0, profit: 0, pnl: 0 },
      { rank: 2, masked_address: "0xdef...222", balance: 1, winrate: 0, profit: 0, pnl: 0 },
      { rank: 3, masked_address: "0x999...333", balance: 1, winrate: 0, profit: 0, pnl: 0 }
    ]
  };
  const index = {
    accounts: {
      "0xabc0000000000000000000000000000000000111": {
        wallet: "0xabc0000000000000000000000000000000000111",
        event_counts: { TokenPurchase: 1, TokenSale: 0, TokenCreate: 0 },
        first_seen_block: 10,
        last_seen_block: 10,
        first_tx: "0x1",
        last_tx: "0x1"
      },
      "0xdef0000000000000000000000000000000000222": { wallet: "0xdef0000000000000000000000000000000000222" },
      "0xdef1111111111111111111111111111111111222": { wallet: "0xdef1111111111111111111111111111111111222" }
    },
    creators: {}
  };

  const rows = resolveRankingWallets(ranking, index);
  assert.equal(rows[0].status, "resolved");
  assert.equal(rows[1].status, "ambiguous");
  assert.equal(rows[2].status, "not_found_on_fourmeme_window");
});

test("resolveRankingWallets resolves GMGN router tx candidates", () => {
  const ranking = {
    updated_at: 1,
    rows: [{ rank: 1, masked_address: "0xabc...111", balance: 1, winrate: 0, profit: 0, pnl: 0 }]
  };
  const index = {
    accounts: {},
    router_txs: {
      "0xabc0000000000000000000000000000000000111": {
        wallet: "0xabc0000000000000000000000000000000000111",
        event_counts: { GmgnRouterTx: 2 },
        first_seen_block: 100,
        last_seen_block: 120,
        first_tx: "0xrouter1",
        last_tx: "0xrouter2"
      }
    },
    senders: {},
    creators: {}
  };

  const [row] = resolveRankingWallets(ranking, index);
  assert.equal(row.status, "resolved_gmgn_router_tx");
  assert.equal(row.source, "gmgn_router_tx");
  assert.equal(row.wallet, "0xabc0000000000000000000000000000000000111");
  assert.deepEqual(row.router_tx_candidates, ["0xabc0000000000000000000000000000000000111"]);
  assert.equal(row.first_seen_block, 100);
});

test("resolveRankingWallets keeps different account and router matches ambiguous", () => {
  const ranking = {
    updated_at: 1,
    rows: [{ rank: 1, masked_address: "0xabc...111", balance: 1, winrate: 0, profit: 0, pnl: 0 }]
  };
  const index = {
    accounts: {
      "0xabc0000000000000000000000000000000000111": { wallet: "0xabc0000000000000000000000000000000000111" }
    },
    router_txs: {
      "0xabc9999999999999999999999999999999999111": { wallet: "0xabc9999999999999999999999999999999999111" }
    },
    senders: {},
    creators: {}
  };

  const [row] = resolveRankingWallets(ranking, index);
  assert.equal(row.status, "ambiguous");
  assert.equal(row.wallet, null);
  assert.equal(row.candidate_count, 2);
});

test("toWalletCsv emits a simple CSV", () => {
  const csv = toWalletCsv([
    {
      rank: 1,
      masked_address: "0xabc...111",
      wallet: "0xabc0000000000000000000000000000000000111",
      status: "resolved",
      candidate_count: 1,
      first_seen_block: 10,
      last_seen_block: 11,
      first_tx: "0x1",
      last_tx: "0x2"
    }
  ]);
  assert.match(csv, /^rank,masked_address,wallet,status/);
  assert.match(csv, /0xabc0000000000000000000000000000000000111/);
});
