import test from "node:test";
import assert from "node:assert/strict";
import {
  appendRankingSnapshot,
  buildRankingSnapshot,
  compactMovementLabel,
  computeRankMovement
} from "../src/rank-history.js";

function stateAt(generatedAt, wallets) {
  return {
    generated_at: generatedAt,
    gmgn: { updated_at: Math.floor(new Date(generatedAt).getTime() / 1000) },
    wallets
  };
}

test("compactMovementLabel formats quick movement labels", () => {
  assert.equal(compactMovementLabel(19, 1), "GMGN19+1");
  assert.equal(compactMovementLabel(18, -2), "GMGN18-2");
  assert.equal(compactMovementLabel(20, 0), "GMGN20=");
});

test("computeRankMovement compares current rank with window baseline", () => {
  const baseline = stateAt("2026-07-07T10:00:00.000Z", [
    { rank: 3, masked_address: "0xaaa...111", wallet: "0xaaa", status: "resolved", gmgn: {} },
    { rank: 1, masked_address: "0xbbb...222", wallet: "0xbbb", status: "resolved", gmgn: {} }
  ]);
  const current = stateAt("2026-07-07T11:00:00.000Z", [
    { rank: 2, masked_address: "0xaaa...111", wallet: "0xaaa", status: "resolved", gmgn: {} },
    { rank: 1, masked_address: "0xbbb...222", wallet: "0xbbb", status: "resolved", gmgn: {} }
  ]);
  const history = appendRankingSnapshot({ snapshots: [] }, buildRankingSnapshot(baseline), {
    now: new Date(baseline.generated_at).getTime()
  });

  const movement = computeRankMovement(history, current, {
    now: new Date(current.generated_at).getTime(),
    windows: [{ key: "60m", label: "60 min", ms: 60 * 60 * 1000 }]
  });

  assert.deepEqual(movement.quick["60m"], ["GMGN2+1"]);
  assert.equal(movement.rows[0].movement["60m"].previous_rank, 3);
  assert.equal(movement.rows[0].movement["60m"].delta, 1);
  assert.equal(movement.rows[1].movement["60m"].delta, 0);
});

test("appendRankingSnapshot skips duplicate snapshots", () => {
  const state = stateAt("2026-07-07T10:00:00.000Z", [
    { rank: 1, masked_address: "0xaaa...111", wallet: "0xaaa", status: "resolved", gmgn: {} }
  ]);
  const snapshot = buildRankingSnapshot(state);
  const once = appendRankingSnapshot({ snapshots: [] }, snapshot, { now: new Date(state.generated_at).getTime() });
  const twice = appendRankingSnapshot(once, snapshot, { now: new Date(state.generated_at).getTime() + 1000 });
  assert.equal(twice.snapshots.length, 1);
});
