import test from "node:test";
import assert from "node:assert/strict";
import { buildContestLinksDashboard, buildContestSidesDashboard } from "../src/dashboard-data.js";

test("buildContestLinksDashboard groups high-balance candidates by contest rank", () => {
  const data = buildContestLinksDashboard(
    {
      generated_at: "wallets-ts",
      wallets: [
        { rank: 1, wallet: "0x111", masked_address: "0x111...111", status: "resolved", gmgn: { balance: 3 } },
        { rank: 2, wallet: "0x222", masked_address: "0x222...222", status: "resolved", gmgn: { balance: 4 } }
      ]
    },
    {
      generated_at: "enrich-ts",
      criteria: { min_bnb_balance: "2" },
      wallets: [
        {
          wallet: "0xaaa",
          balance_bnb: "5",
          linked_metrics: { related_ranks: [1, 2], total_windows_seen: 3 },
          gmgn: {
            smartmoney: { name: "alpha" },
            common_stat: {},
            profit_stat: { all: {}, "7d": {} },
            activity_all_p1: { activities: [] },
            holdings: {}
          }
        },
        {
          wallet: "0xbbb",
          balance_bnb: "3",
          linked_metrics: { related_ranks: [2], total_windows_seen: 1 },
          gmgn: {}
        }
      ]
    }
  );

  assert.equal(data.summary.high_balance_wallets, 2);
  assert.equal(data.summary.rank_memberships, 3);
  assert.equal(data.groups[0].stats.linked_wallets, 1);
  assert.equal(data.groups[1].stats.linked_wallets, 2);
  assert.equal(data.groups[1].wallets[0].wallet, "0xaaa");
  assert.equal(data.groups[1].stats.complete_gmgn, 1);
});

test("buildContestSidesDashboard compacts side scores and joins high-balance data", () => {
  const data = buildContestSidesDashboard(
    {
      generated_at: "sides-ts",
      checkpoint: { side_rows: 2 },
      groups: [
        {
          contest_rank: 1,
          contest_wallet: "0x111",
          anchor_windows_total: 10,
          side_wallets: [
            {
              candidate_wallet: "0xaaa",
              classification: "strong_side",
              side_score: 80,
              follow_windows: 4,
              anchor_windows_total: 10,
              follow_rate: 0.4,
              entries_le_10: 1,
              entries_le_15: 2,
              entries_le_50: 4,
              bucket_1_10: 1,
              bucket_11_15: 1,
              bucket_16_50: 2,
              specificity_score: 0.5,
              also_follows_ranks: [1, 2]
            }
          ]
        }
      ]
    },
    {
      generated_at: "enrich-ts",
      criteria: { min_bnb_balance: "2" },
      wallets: [
        {
          wallet: "0xaaa",
          balance_bnb: "5",
          linked_metrics: { related_ranks: [1] },
          gmgn: {
            smartmoney: { name: "alpha", total_value: 100, realized_profit_30d: 2500, pnl_30d: 0.4 },
            common_stat: {},
            profit_stat: { all: {}, "7d": {} },
            activity_all_p1: { activities: [] },
            holdings: {}
          }
        }
      ]
    },
    { limitPerContest: 10 }
  );

  assert.equal(data.summary.shown_side_wallets, 1);
  assert.equal(data.summary.strong_side, 1);
  assert.equal(data.summary.high_balance_matched, 1);
  assert.equal(data.summary.profitable_only, true);
  assert.equal(data.groups[0].side_wallets[0].entries_le_50, 4);
  assert.equal(data.groups[0].side_wallets[0].balance_bnb, "5");
  assert.equal(data.groups[0].side_wallets[0].realized_profit_30d, 2500);
});

test("buildContestSidesDashboard filters out non-profitable side wallets by default", () => {
  const data = buildContestSidesDashboard(
    {
      groups: [
        {
          contest_rank: 1,
          contest_wallet: "0x111",
          anchor_windows_total: 10,
          side_wallets: [
            {
              candidate_wallet: "0xaaa",
              classification: "strong_side",
              side_score: 80,
              follow_windows: 4,
              anchor_windows_total: 10,
              follow_rate: 0.4
            }
          ]
        }
      ]
    },
    {
      wallets: [
        {
          wallet: "0xaaa",
          balance_bnb: "5",
          linked_metrics: { related_ranks: [1] },
          gmgn: {
            smartmoney: { realized_profit_30d: 1999 },
            common_stat: {},
            profit_stat: { all: {}, "7d": {} },
            activity_all_p1: { activities: [] },
            holdings: {}
          }
        }
      ]
    }
  );

  assert.equal(data.summary.shown_side_wallets, 0);
  assert.equal(data.groups[0].side_wallets.length, 0);
});
