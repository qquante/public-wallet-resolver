function numberOrNull(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function hasGmgnEndpointSet(wallet) {
  return Boolean(
    wallet?.gmgn?.smartmoney &&
    wallet?.gmgn?.common_stat &&
    wallet?.gmgn?.profit_stat?.all &&
    wallet?.gmgn?.profit_stat?.["7d"] &&
    wallet?.gmgn?.activity_all_p1 &&
    wallet?.gmgn?.holdings
  );
}

function candidateName(wallet) {
  return (
    wallet?.gmgn?.smartmoney?.name ||
    wallet?.gmgn?.common_stat?.name ||
    wallet?.gmgn?.smartmoney?.twitter_name ||
    wallet?.gmgn?.smartmoney?.twitter_username ||
    ""
  );
}

function candidateTags(wallet) {
  const smartTags = wallet?.gmgn?.smartmoney?.tags;
  const commonTags = wallet?.gmgn?.common_stat?.tags;
  const tags = Array.isArray(smartTags) ? smartTags : Array.isArray(commonTags) ? commonTags : [];
  return tags.slice(0, 6).map(String);
}

function compactCandidate(wallet) {
  const smart = wallet?.gmgn?.smartmoney || {};
  const common = wallet?.gmgn?.common_stat || {};
  const activity = wallet?.gmgn?.activity_all_p1?.activities || [];
  const metrics = wallet?.linked_metrics || {};
  return {
    wallet: wallet.wallet,
    gmgn_url: wallet.wallet ? `https://gmgn.ai/bsc/address/${wallet.wallet}` : null,
    balance_bnb: wallet.balance_bnb,
    balance_bnb_num: numberOrNull(wallet.balance_bnb),
    complete_gmgn: hasGmgnEndpointSet(wallet),
    name: candidateName(wallet),
    tags: candidateTags(wallet),
    twitter_username: smart.twitter_username || common.twitter_username || "",
    total_value: numberOrNull(smart.total_value),
    realized_profit: numberOrNull(smart.realized_profit),
    realized_profit_1d: numberOrNull(smart.realized_profit_1d),
    realized_profit_7d: numberOrNull(smart.realized_profit_7d),
    realized_profit_30d: numberOrNull(smart.realized_profit_30d),
    pnl: numberOrNull(smart.pnl),
    pnl_1d: numberOrNull(smart.pnl_1d),
    pnl_7d: numberOrNull(smart.pnl_7d),
    pnl_30d: numberOrNull(smart.pnl_30d),
    winrate: numberOrNull(smart.winrate),
    buy_7d: numberOrNull(smart.buy_7d),
    sell_7d: numberOrNull(smart.sell_7d),
    buy_all: numberOrNull(smart.buy),
    sell_all: numberOrNull(smart.sell),
    fund_from_address: common.fund_from_address || "",
    fund_amount: common.fund_amount || "",
    activity_count: Array.isArray(activity) ? activity.length : 0,
    last_activity_tx: activity[0]?.tx_hash || "",
    related_ranks: Array.isArray(metrics.related_ranks) ? metrics.related_ranks.map(Number) : [],
    total_appearances: numberOrNull(metrics.total_appearances),
    distinct_tokens_after_contest: numberOrNull(metrics.distinct_tokens_after_contest),
    total_windows_seen: numberOrNull(metrics.total_windows_seen),
    avg_position: numberOrNull(metrics.avg_position),
    min_position: numberOrNull(metrics.min_position),
    avg_block_delay: numberOrNull(metrics.avg_block_delay),
    first_seen_block: numberOrNull(metrics.first_seen_block),
    last_seen_block: numberOrNull(metrics.last_seen_block),
    first_tx: metrics.first_tx || "",
    last_tx: metrics.last_tx || ""
  };
}

function compactContestWallet(row) {
  return {
    rank: Number(row.rank),
    wallet: row.wallet || null,
    masked_address: row.masked_address || "",
    status: row.status || "",
    gmgn: {
      balance: numberOrNull(row.gmgn?.balance),
      winrate: numberOrNull(row.gmgn?.winrate),
      profit: numberOrNull(row.gmgn?.profit),
      pnl: numberOrNull(row.gmgn?.pnl),
      updated_at: row.gmgn?.updated_at || null
    }
  };
}

export function buildContestLinksDashboard(walletsState = {}, highBalanceState = {}) {
  const contestWallets = Array.isArray(walletsState.wallets)
    ? walletsState.wallets.map(compactContestWallet).sort((a, b) => a.rank - b.rank)
    : [];
  const groupsByRank = new Map(contestWallets.map((wallet) => [wallet.rank, {
    contest: wallet,
    stats: {
      linked_wallets: 0,
      complete_gmgn: 0,
      total_balance_bnb: 0,
      top_balance_bnb: 0
    },
    wallets: []
  }]));

  const candidates = Array.isArray(highBalanceState.wallets)
    ? highBalanceState.wallets.map(compactCandidate)
    : [];

  for (const candidate of candidates) {
    for (const rank of candidate.related_ranks) {
      const group = groupsByRank.get(rank);
      if (!group) continue;
      group.wallets.push(candidate);
    }
  }

  const groups = [...groupsByRank.values()].map((group) => {
    group.wallets.sort((a, b) => (b.balance_bnb_num || 0) - (a.balance_bnb_num || 0));
    const totalBalance = group.wallets.reduce((total, wallet) => total + (wallet.balance_bnb_num || 0), 0);
    group.stats = {
      linked_wallets: group.wallets.length,
      complete_gmgn: group.wallets.filter((wallet) => wallet.complete_gmgn).length,
      total_balance_bnb: totalBalance,
      top_balance_bnb: group.wallets[0]?.balance_bnb_num || 0
    };
    return group;
  });

  return {
    generated_at: new Date().toISOString(),
    source: {
      wallets_generated_at: walletsState.generated_at || null,
      enrichment_generated_at: highBalanceState.generated_at || null,
      enrichment_checkpoint: highBalanceState.checkpoint || null
    },
    summary: {
      contest_wallets: contestWallets.length,
      high_balance_wallets: candidates.length,
      wallets_with_complete_gmgn: candidates.filter((wallet) => wallet.complete_gmgn).length,
      rank_memberships: groups.reduce((total, group) => total + group.stats.linked_wallets, 0),
      min_bnb_balance: highBalanceState.criteria?.min_bnb_balance || "2"
    },
    groups
  };
}

function highBalanceIndex(highBalanceState = {}) {
  const map = new Map();
  for (const wallet of highBalanceState.wallets || []) {
    if (!wallet?.wallet) continue;
    map.set(String(wallet.wallet).toLowerCase(), compactCandidate(wallet));
  }
  return map;
}

function compactSideWallet(row, highBalance) {
  return {
    candidate_wallet: row.candidate_wallet,
    gmgn_url: row.candidate_wallet ? `https://gmgn.ai/bsc/address/${row.candidate_wallet}` : null,
    classification: row.classification,
    side_score: numberOrNull(row.side_score),
    follow_windows: numberOrNull(row.follow_windows),
    anchor_windows_total: numberOrNull(row.anchor_windows_total),
    follow_rate: numberOrNull(row.follow_rate),
    raw_appearances: numberOrNull(row.raw_appearances),
    distinct_tokens: numberOrNull(row.distinct_tokens),
    entries_le_10: numberOrNull(row.entries_le_10),
    entries_le_15: numberOrNull(row.entries_le_15),
    entries_le_50: numberOrNull(row.entries_le_50),
    entries_le_100: numberOrNull(row.entries_le_100),
    entries_le_200: numberOrNull(row.entries_le_200),
    entries_le_300: numberOrNull(row.entries_le_300),
    bucket_1_10: numberOrNull(row.bucket_1_10),
    bucket_11_15: numberOrNull(row.bucket_11_15),
    bucket_16_50: numberOrNull(row.bucket_16_50),
    bucket_51_100: numberOrNull(row.bucket_51_100),
    bucket_101_200: numberOrNull(row.bucket_101_200),
    bucket_201_300: numberOrNull(row.bucket_201_300),
    avg_position: numberOrNull(row.avg_position),
    median_position: numberOrNull(row.median_position),
    min_position: numberOrNull(row.min_position),
    avg_block_delay: numberOrNull(row.avg_block_delay),
    median_block_delay: numberOrNull(row.median_block_delay),
    min_block_delay: numberOrNull(row.min_block_delay),
    specificity_score: numberOrNull(row.specificity_score),
    candidate_total_follow_windows: numberOrNull(row.candidate_total_follow_windows),
    also_follows_ranks: Array.isArray(row.also_follows_ranks) ? row.also_follows_ranks.map(Number) : [],
    first_seen_block: numberOrNull(row.first_seen_block),
    last_seen_block: numberOrNull(row.last_seen_block),
    first_tx: row.first_tx || "",
    last_tx: row.last_tx || "",
    high_balance: Boolean(highBalance),
    balance_bnb: highBalance?.balance_bnb || null,
    balance_bnb_num: highBalance?.balance_bnb_num ?? null,
    complete_gmgn: Boolean(highBalance?.complete_gmgn),
    name: highBalance?.name || "",
    tags: highBalance?.tags || [],
    total_value: highBalance?.total_value ?? null,
    realized_profit: highBalance?.realized_profit ?? null,
    realized_profit_1d: highBalance?.realized_profit_1d ?? null,
    realized_profit_7d: highBalance?.realized_profit_7d ?? null,
    realized_profit_30d: highBalance?.realized_profit_30d ?? null,
    pnl: highBalance?.pnl ?? null,
    pnl_1d: highBalance?.pnl_1d ?? null,
    pnl_7d: highBalance?.pnl_7d ?? null,
    pnl_30d: highBalance?.pnl_30d ?? null
  };
}

export function buildContestSidesDashboard(
  sideState = {},
  highBalanceState = {},
  { limitPerContest = 50, profitableOnly = true, minRealizedProfit30d = 2000 } = {}
) {
  const highByWallet = highBalanceIndex(highBalanceState);
  const groups = (sideState.groups || []).map((group) => {
    const sideWallets = (group.side_wallets || [])
      .map((row) => compactSideWallet(row, highByWallet.get(String(row.candidate_wallet).toLowerCase())))
      .filter((row) => {
        if (!profitableOnly) return true;
        return Number(row.realized_profit_30d) >= minRealizedProfit30d;
      })
      .slice(0, limitPerContest);
    const classCounts = sideWallets.reduce((counts, row) => {
      counts[row.classification] = (counts[row.classification] || 0) + 1;
      return counts;
    }, {});
    return {
      contest_rank: Number(group.contest_rank),
      contest_wallet: group.contest_wallet,
      anchor_windows_total: Number(group.anchor_windows_total),
      stats: {
        shown_side_wallets: sideWallets.length,
        very_strong_side: classCounts.very_strong_side || 0,
        strong_side: classCounts.strong_side || 0,
        possible_side: classCounts.possible_side || 0,
        broad_flow: classCounts.broad_flow || 0,
        high_balance: sideWallets.filter((row) => row.high_balance).length,
        top_score: sideWallets[0]?.side_score || 0
      },
      side_wallets: sideWallets
    };
  }).sort((a, b) => a.contest_rank - b.contest_rank);

  const allShown = groups.flatMap((group) => group.side_wallets);
  return {
    generated_at: new Date().toISOString(),
    source: {
      side_generated_at: sideState.generated_at || null,
      side_checkpoint: sideState.checkpoint || null,
      enrichment_generated_at: highBalanceState.generated_at || null,
      enrichment_checkpoint: highBalanceState.checkpoint || null
    },
    summary: {
      contest_groups: groups.length,
      shown_side_wallets: allShown.length,
      very_strong_side: allShown.filter((row) => row.classification === "very_strong_side").length,
      strong_side: allShown.filter((row) => row.classification === "strong_side").length,
      possible_side: allShown.filter((row) => row.classification === "possible_side").length,
      broad_flow: allShown.filter((row) => row.classification === "broad_flow").length,
      high_balance_matched: allShown.filter((row) => row.high_balance).length,
      min_bnb_balance: highBalanceState.criteria?.min_bnb_balance || "2",
      limit_per_contest: limitPerContest,
      profitable_only: profitableOnly,
      min_realized_profit_30d: minRealizedProfit30d
    },
    groups
  };
}
