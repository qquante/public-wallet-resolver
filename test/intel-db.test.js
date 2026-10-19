import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import {
  classifyMevLikeCandidate,
  fillOpenAnchorsFromStoredPurchases,
  getAnchorWindows,
  getCandidateScores,
  getContestSideScores,
  initializeIntelDb,
  ingestPurchaseEvents,
  refreshCandidateScores,
  syncContestWallets
} from "../src/intel-db.js";

const ANCHOR = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const OTHER_ANCHOR = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const CANDIDATE = "0xcccccccccccccccccccccccccccccccccccccccc";
const CANDIDATE_2 = "0xdddddddddddddddddddddddddddddddddddddddd";

function walletSuffix(value) {
  return `0x${String(value).padStart(40, "0")}`;
}

function memoryDb() {
  const db = new DatabaseSync(":memory:");
  initializeIntelDb(db);
  syncContestWallets(db, [
    { rank: 1, wallet: ANCHOR, masked_address: "0xaaa...aaa", status: "resolved" },
    { rank: 2, wallet: OTHER_ANCHOR, masked_address: "0xbbb...bbb", status: "resolved" }
  ]);
  return db;
}

function purchase({ blockNumber, logIndex, account, token = "0x1111111111111111111111111111111111111111" }) {
  return {
    blockNumber,
    logIndex,
    txHash: `0x${String(blockNumber).padStart(8, "0")}${String(logIndex).padStart(56, "0")}`,
    token,
    account
  };
}

test("ingestPurchaseEvents sorts purchases and caps each anchor window", () => {
  const db = memoryDb();
  ingestPurchaseEvents(
    db,
    [
      purchase({ blockNumber: 3, logIndex: 0, account: CANDIDATE }),
      purchase({ blockNumber: 1, logIndex: 0, account: ANCHOR }),
      purchase({ blockNumber: 2, logIndex: 0, account: CANDIDATE_2 }),
      purchase({ blockNumber: 4, logIndex: 0, account: CANDIDATE })
    ],
    { windowSize: 2 }
  );

  const windows = getAnchorWindows(db);
  assert.equal(windows.length, 1);
  assert.equal(windows[0].collected, 2);
  assert.equal(windows[0].closed, true);
  assert.deepEqual(
    windows[0].purchases.map((row) => [row.position, row.wallet]),
    [
      [1, CANDIDATE_2],
      [2, CANDIDATE]
    ]
  );
  db.close();
});

test("refreshCandidateScores marks linked candidates by two tokens", () => {
  const db = memoryDb();
  ingestPurchaseEvents(
    db,
    [
      purchase({ blockNumber: 1, logIndex: 0, account: ANCHOR, token: "0x1000000000000000000000000000000000000000" }),
      purchase({ blockNumber: 2, logIndex: 0, account: CANDIDATE, token: "0x1000000000000000000000000000000000000000" }),
      purchase({ blockNumber: 3, logIndex: 0, account: ANCHOR, token: "0x2000000000000000000000000000000000000000" }),
      purchase({ blockNumber: 4, logIndex: 0, account: CANDIDATE, token: "0x2000000000000000000000000000000000000000" })
    ],
    { windowSize: 300 }
  );
  refreshCandidateScores(db);

  const linked = getCandidateScores(db, { linkedOnly: true });
  assert.equal(linked.length, 1);
  assert.equal(linked[0].candidate_wallet, CANDIDATE);
  assert.equal(linked[0].distinct_tokens_after_contest, 2);
  assert.equal(linked[0].threshold_met, true);
  db.close();
});

test("refreshCandidateScores marks linked candidates by three windows", () => {
  const db = memoryDb();
  ingestPurchaseEvents(
    db,
    [
      purchase({ blockNumber: 1, logIndex: 0, account: ANCHOR }),
      purchase({ blockNumber: 2, logIndex: 0, account: CANDIDATE }),
      purchase({ blockNumber: 3, logIndex: 0, account: OTHER_ANCHOR }),
      purchase({ blockNumber: 4, logIndex: 0, account: CANDIDATE }),
      purchase({ blockNumber: 5, logIndex: 0, account: ANCHOR }),
      purchase({ blockNumber: 6, logIndex: 0, account: CANDIDATE })
    ],
    { windowSize: 300 }
  );
  refreshCandidateScores(db);

  const linked = getCandidateScores(db, { linkedOnly: true });
  assert.equal(linked[0].candidate_wallet, CANDIDATE);
  assert.equal(linked[0].total_windows_seen, 3);
  db.close();
});

test("stored purchase backfill creates anchors when a contest wallet appears later", () => {
  const db = new DatabaseSync(":memory:");
  initializeIntelDb(db);
  ingestPurchaseEvents(
    db,
    [
      purchase({ blockNumber: 1, logIndex: 0, account: ANCHOR }),
      purchase({ blockNumber: 2, logIndex: 0, account: CANDIDATE })
    ],
    { windowSize: 300 }
  );

  const sync = syncContestWallets(db, [
    { rank: 1, wallet: ANCHOR, masked_address: "0xaaa...aaa", status: "resolved" }
  ]);
  const backfill = fillOpenAnchorsFromStoredPurchases(db, { windowSize: 300 });
  const windows = getAnchorWindows(db);

  assert.equal(sync.createdAnchors, 1);
  assert.equal(backfill.inserted, 1);
  assert.equal(windows[0].purchases[0].wallet, CANDIDATE);
  db.close();
});

test("duplicate purchase ingestion is idempotent", () => {
  const db = memoryDb();
  const events = [
    purchase({ blockNumber: 1, logIndex: 0, account: ANCHOR }),
    purchase({ blockNumber: 2, logIndex: 0, account: CANDIDATE })
  ];
  const first = ingestPurchaseEvents(db, events, { windowSize: 300 });
  const second = ingestPurchaseEvents(db, events, { windowSize: 300 });

  assert.equal(first.inserted, 2);
  assert.equal(second.inserted, 0);
  assert.equal(getAnchorWindows(db)[0].purchases.length, 1);
  db.close();
});

test("classifyMevLikeCandidate flags broad and fast bot patterns", () => {
  const broad = classifyMevLikeCandidate({
    total_appearances: 120,
    distinct_tokens_after_contest: 25,
    total_windows_seen: 40,
    related_ranks: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10],
    avg_position: 100,
    min_position: 1,
    avg_block_delay: 40
  });

  assert.equal(broad.mev_like, true);
  assert.ok(broad.mev_reasons.includes("broad_many_tokens_many_ranks"));
  assert.ok(broad.mev_reasons.includes("early_fast_sniper_pattern"));
});

test("classifyMevLikeCandidate keeps narrow repeated candidates", () => {
  const narrow = classifyMevLikeCandidate({
    total_appearances: 5,
    distinct_tokens_after_contest: 2,
    total_windows_seen: 3,
    related_ranks: [3],
    avg_position: 12,
    min_position: 2,
    avg_block_delay: 80
  });

  assert.equal(narrow.mev_like, false);
  assert.deepEqual(narrow.mev_reasons, []);
});

test("getContestSideScores counts first entry buckets per contest wallet", () => {
  const db = memoryDb();
  const secondTokenFillers = Array.from({ length: 10 }, (_, index) =>
    purchase({
      blockNumber: 20 + index,
      logIndex: 0,
      account: walletSuffix(index + 1),
      token: "0x2000000000000000000000000000000000000000"
    })
  );
  ingestPurchaseEvents(
    db,
    [
      purchase({ blockNumber: 1, logIndex: 0, account: ANCHOR, token: "0x1000000000000000000000000000000000000000" }),
      purchase({ blockNumber: 2, logIndex: 0, account: CANDIDATE, token: "0x1000000000000000000000000000000000000000" }),
      purchase({ blockNumber: 3, logIndex: 0, account: CANDIDATE, token: "0x1000000000000000000000000000000000000000" }),
      purchase({ blockNumber: 10, logIndex: 0, account: ANCHOR, token: "0x2000000000000000000000000000000000000000" }),
      ...secondTokenFillers,
      purchase({ blockNumber: 31, logIndex: 0, account: CANDIDATE, token: "0x2000000000000000000000000000000000000000" }),
      purchase({ blockNumber: 30, logIndex: 0, account: OTHER_ANCHOR, token: "0x3000000000000000000000000000000000000000" }),
      purchase({ blockNumber: 32, logIndex: 0, account: CANDIDATE, token: "0x3000000000000000000000000000000000000000" })
    ],
    { windowSize: 300 }
  );

  const sides = getContestSideScores(db, { minFollowWindows: 1, limitPerContest: 20 });
  const rankOne = sides.rows.find((row) => row.contest_rank === 1 && row.candidate_wallet === CANDIDATE);
  assert.equal(rankOne.anchor_windows_total, 2);
  assert.equal(rankOne.follow_windows, 2);
  assert.equal(rankOne.raw_appearances, 3);
  assert.equal(rankOne.entries_le_10, 1);
  assert.equal(rankOne.entries_le_15, 2);
  assert.equal(rankOne.bucket_1_10, 1);
  assert.equal(rankOne.bucket_11_15, 1);
  assert.equal(rankOne.distinct_tokens, 2);
  assert.equal(rankOne.follow_rate, 1);
  assert.equal(rankOne.specificity_score, 2 / 3);
  assert.deepEqual(rankOne.also_follows_ranks, [1, 2]);
  db.close();
});

test("getContestSideScores excludes inactive contest wallets", () => {
  const db = memoryDb();
  ingestPurchaseEvents(
    db,
    [
      purchase({ blockNumber: 1, logIndex: 0, account: ANCHOR }),
      purchase({ blockNumber: 2, logIndex: 0, account: CANDIDATE }),
      purchase({ blockNumber: 3, logIndex: 0, account: OTHER_ANCHOR }),
      purchase({ blockNumber: 4, logIndex: 0, account: CANDIDATE_2 })
    ],
    { windowSize: 300 }
  );
  syncContestWallets(db, [
    { rank: 1, wallet: ANCHOR, masked_address: "0xaaa...aaa", status: "resolved" }
  ]);

  const sides = getContestSideScores(db, { minFollowWindows: 1, limitPerContest: 20 });
  assert.ok(sides.groups.some((group) => group.contest_wallet === ANCHOR));
  assert.equal(sides.groups.some((group) => group.contest_wallet === OTHER_ANCHOR), false);
  db.close();
});
