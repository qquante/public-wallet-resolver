import { DatabaseSync } from "node:sqlite";

export function openIntelDb(file) {
  const db = new DatabaseSync(file);
  initializeIntelDb(db);
  return db;
}

export function initializeIntelDb(db) {
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA synchronous = NORMAL;

    CREATE TABLE IF NOT EXISTS meta (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS contest_wallets (
      wallet TEXT PRIMARY KEY,
      rank INTEGER NOT NULL,
      masked_address TEXT,
      status TEXT,
      active INTEGER NOT NULL DEFAULT 1,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS purchases (
      purchase_key TEXT PRIMARY KEY,
      block_number INTEGER NOT NULL,
      log_index INTEGER NOT NULL,
      tx_hash TEXT NOT NULL,
      token TEXT NOT NULL,
      account TEXT NOT NULL,
      inserted_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE INDEX IF NOT EXISTS idx_purchases_token_order
      ON purchases(token, block_number, log_index);

    CREATE INDEX IF NOT EXISTS idx_purchases_account_order
      ON purchases(account, block_number, log_index);

    CREATE TABLE IF NOT EXISTS anchors (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      purchase_key TEXT NOT NULL UNIQUE,
      anchor_wallet TEXT NOT NULL,
      anchor_rank INTEGER NOT NULL,
      token TEXT NOT NULL,
      anchor_block INTEGER NOT NULL,
      anchor_log_index INTEGER NOT NULL,
      anchor_tx TEXT NOT NULL,
      next_count INTEGER NOT NULL DEFAULT 0,
      closed INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE INDEX IF NOT EXISTS idx_anchors_token_open
      ON anchors(token, closed, anchor_block, anchor_log_index);

    CREATE TABLE IF NOT EXISTS window_purchases (
      anchor_id INTEGER NOT NULL,
      position INTEGER NOT NULL,
      purchase_key TEXT NOT NULL,
      candidate_wallet TEXT NOT NULL,
      token TEXT NOT NULL,
      block_number INTEGER NOT NULL,
      log_index INTEGER NOT NULL,
      tx_hash TEXT NOT NULL,
      block_delay INTEGER NOT NULL,
      PRIMARY KEY(anchor_id, purchase_key),
      UNIQUE(anchor_id, position)
    );

    CREATE INDEX IF NOT EXISTS idx_window_candidate
      ON window_purchases(candidate_wallet);

    CREATE TABLE IF NOT EXISTS candidate_scores (
      candidate_wallet TEXT PRIMARY KEY,
      total_appearances INTEGER NOT NULL,
      distinct_tokens_after_contest INTEGER NOT NULL,
      total_windows_seen INTEGER NOT NULL,
      related_ranks TEXT NOT NULL,
      avg_position REAL NOT NULL,
      min_position INTEGER NOT NULL,
      avg_block_delay REAL NOT NULL,
      first_seen_block INTEGER NOT NULL,
      last_seen_block INTEGER NOT NULL,
      first_tx TEXT NOT NULL,
      last_tx TEXT NOT NULL,
      threshold_met INTEGER NOT NULL,
      updated_at TEXT NOT NULL
    );
  `);
}

export function withTransaction(db, fn) {
  db.exec("BEGIN IMMEDIATE");
  try {
    const result = fn();
    db.exec("COMMIT");
    return result;
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

export function purchaseKey(event) {
  return `${Number(event.blockNumber)}:${Number(event.logIndex)}`;
}

export function normalizePurchaseEvent(event) {
  return {
    purchaseKey: event.purchaseKey || purchaseKey(event),
    blockNumber: Number(event.blockNumber),
    logIndex: Number(event.logIndex),
    txHash: String(event.txHash).toLowerCase(),
    token: String(event.token).toLowerCase(),
    account: String(event.account).toLowerCase()
  };
}

export function sortPurchases(events) {
  return [...events].map(normalizePurchaseEvent).sort((a, b) => {
    const block = a.blockNumber - b.blockNumber;
    if (block !== 0) return block;
    return a.logIndex - b.logIndex;
  });
}

export function getMetaNumber(db, key, fallback = null) {
  const row = db.prepare("SELECT value FROM meta WHERE key = ?").get(key);
  if (!row) return fallback;
  const value = Number(row.value);
  return Number.isFinite(value) ? value : fallback;
}

export function setMeta(db, key, value) {
  db.prepare(
    "INSERT INTO meta(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value"
  ).run(key, String(value));
}

export function syncContestWallets(db, wallets) {
  return withTransaction(db, () => {
    db.prepare("UPDATE contest_wallets SET active = 0, updated_at = CURRENT_TIMESTAMP").run();
    const upsert = db.prepare(`
      INSERT INTO contest_wallets(wallet, rank, masked_address, status, active, updated_at)
      VALUES(?, ?, ?, ?, 1, CURRENT_TIMESTAMP)
      ON CONFLICT(wallet) DO UPDATE SET
        rank = excluded.rank,
        masked_address = excluded.masked_address,
        status = excluded.status,
        active = 1,
        updated_at = CURRENT_TIMESTAMP
    `);

    let active = 0;
    for (const wallet of wallets) {
      upsert.run(
        String(wallet.wallet).toLowerCase(),
        Number(wallet.rank),
        wallet.masked_address || null,
        wallet.status || null
      );
      active += 1;
    }

    db.prepare(`
      UPDATE anchors
      SET anchor_rank = (
        SELECT rank FROM contest_wallets WHERE contest_wallets.wallet = anchors.anchor_wallet
      )
      WHERE anchor_wallet IN (SELECT wallet FROM contest_wallets)
    `).run();

    const createdAnchors = insertMissingAnchorsForContestWallets(db);
    return { active, createdAnchors };
  });
}

export function ingestPurchaseEvents(db, events, { windowSize = 300 } = {}) {
  const purchases = sortPurchases(events);
  return withTransaction(db, () => {
    let inserted = 0;
    let anchorsCreated = 0;
    let windowRows = 0;

    for (const purchase of purchases) {
      const result = insertPurchase(db, purchase);
      if (result.changes === 0) continue;
      inserted += 1;
      anchorsCreated += maybeCreateAnchor(db, purchase);
      windowRows += fillOpenAnchorsForPurchase(db, purchase, windowSize);
    }

    return { inserted, anchorsCreated, windowRows };
  });
}

function insertPurchase(db, purchase) {
  return db.prepare(`
    INSERT OR IGNORE INTO purchases(purchase_key, block_number, log_index, tx_hash, token, account)
    VALUES(?, ?, ?, ?, ?, ?)
  `).run(
    purchase.purchaseKey,
    purchase.blockNumber,
    purchase.logIndex,
    purchase.txHash,
    purchase.token,
    purchase.account
  );
}

function maybeCreateAnchor(db, purchase) {
  const contest = db.prepare(
    "SELECT rank FROM contest_wallets WHERE wallet = ? AND active = 1"
  ).get(purchase.account);
  if (!contest) return 0;

  const result = db.prepare(`
    INSERT OR IGNORE INTO anchors(
      purchase_key, anchor_wallet, anchor_rank, token, anchor_block, anchor_log_index, anchor_tx
    )
    VALUES(?, ?, ?, ?, ?, ?, ?)
  `).run(
    purchase.purchaseKey,
    purchase.account,
    Number(contest.rank),
    purchase.token,
    purchase.blockNumber,
    purchase.logIndex,
    purchase.txHash
  );
  return result.changes;
}

function insertMissingAnchorsForContestWallets(db) {
  const result = db.prepare(`
    INSERT OR IGNORE INTO anchors(
      purchase_key, anchor_wallet, anchor_rank, token, anchor_block, anchor_log_index, anchor_tx
    )
    SELECT
      purchases.purchase_key,
      purchases.account,
      contest_wallets.rank,
      purchases.token,
      purchases.block_number,
      purchases.log_index,
      purchases.tx_hash
    FROM purchases
    JOIN contest_wallets ON contest_wallets.wallet = purchases.account
    WHERE contest_wallets.active = 1
  `).run();
  return result.changes;
}

function fillOpenAnchorsForPurchase(db, purchase, windowSize) {
  const anchors = db.prepare(`
    SELECT id, anchor_block, anchor_log_index, next_count
    FROM anchors
    WHERE token = ?
      AND closed = 0
      AND next_count < ?
      AND (
        anchor_block < ?
        OR (anchor_block = ? AND anchor_log_index < ?)
      )
    ORDER BY anchor_block, anchor_log_index
  `).all(purchase.token, windowSize, purchase.blockNumber, purchase.blockNumber, purchase.logIndex);

  let inserted = 0;
  for (const anchor of anchors) {
    const position = Number(anchor.next_count) + 1;
    const result = insertWindowPurchase(db, anchor, purchase, position);
    if (result.changes === 0) continue;
    inserted += 1;
    updateAnchorCount(db, anchor.id, windowSize);
  }
  return inserted;
}

function insertWindowPurchase(db, anchor, purchase, position) {
  return db.prepare(`
    INSERT OR IGNORE INTO window_purchases(
      anchor_id, position, purchase_key, candidate_wallet, token,
      block_number, log_index, tx_hash, block_delay
    )
    VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    anchor.id,
    position,
    purchase.purchaseKey,
    purchase.account,
    purchase.token,
    purchase.blockNumber,
    purchase.logIndex,
    purchase.txHash,
    purchase.blockNumber - Number(anchor.anchor_block)
  );
}

function updateAnchorCount(db, anchorId, windowSize) {
  const count = db.prepare(
    "SELECT COUNT(*) AS count FROM window_purchases WHERE anchor_id = ?"
  ).get(anchorId).count;
  db.prepare("UPDATE anchors SET next_count = ?, closed = ? WHERE id = ?").run(
    count,
    count >= windowSize ? 1 : 0,
    anchorId
  );
}

export function fillOpenAnchorsFromStoredPurchases(db, { windowSize = 300 } = {}) {
  return withTransaction(db, () => {
    const anchors = db.prepare(`
      SELECT id, token, anchor_block, anchor_log_index, next_count
      FROM anchors
      WHERE closed = 0 AND next_count < ?
      ORDER BY anchor_block, anchor_log_index
    `).all(windowSize);

    let inserted = 0;
    for (const anchor of anchors) {
      let count = db.prepare(
        "SELECT COUNT(*) AS count FROM window_purchases WHERE anchor_id = ?"
      ).get(anchor.id).count;
      if (count >= windowSize) {
        updateAnchorCount(db, anchor.id, windowSize);
        continue;
      }

      const purchases = db.prepare(`
        SELECT purchase_key, block_number AS blockNumber, log_index AS logIndex,
          tx_hash AS txHash, token, account
        FROM purchases
        WHERE token = ?
          AND (
            block_number > ?
            OR (block_number = ? AND log_index > ?)
          )
          AND purchase_key NOT IN (
            SELECT purchase_key FROM window_purchases WHERE anchor_id = ?
          )
        ORDER BY block_number, log_index
        LIMIT ?
      `).all(
        anchor.token,
        anchor.anchor_block,
        anchor.anchor_block,
        anchor.anchor_log_index,
        anchor.id,
        windowSize - count
      );

      for (const raw of purchases) {
        const purchase = normalizePurchaseEvent(raw);
        const result = insertWindowPurchase(db, anchor, purchase, count + 1);
        if (result.changes === 0) continue;
        inserted += 1;
        count += 1;
      }
      updateAnchorCount(db, anchor.id, windowSize);
    }
    return { anchorsChecked: anchors.length, inserted };
  });
}

export function refreshCandidateScores(db) {
  return withTransaction(db, () => {
    db.prepare("DELETE FROM candidate_scores").run();
    const rows = db.prepare(`
      SELECT
        wp.candidate_wallet AS candidate_wallet,
        COUNT(*) AS total_appearances,
        COUNT(DISTINCT wp.token) AS distinct_tokens_after_contest,
        COUNT(DISTINCT wp.anchor_id) AS total_windows_seen,
        GROUP_CONCAT(DISTINCT a.anchor_rank) AS related_ranks,
        AVG(wp.position) AS avg_position,
        MIN(wp.position) AS min_position,
        AVG(wp.block_delay) AS avg_block_delay,
        MIN(wp.block_number) AS first_seen_block,
        MAX(wp.block_number) AS last_seen_block
      FROM window_purchases wp
      JOIN anchors a ON a.id = wp.anchor_id
      WHERE wp.candidate_wallet != a.anchor_wallet
      GROUP BY wp.candidate_wallet
    `).all();

    const insert = db.prepare(`
      INSERT INTO candidate_scores(
        candidate_wallet, total_appearances, distinct_tokens_after_contest,
        total_windows_seen, related_ranks, avg_position, min_position,
        avg_block_delay, first_seen_block, last_seen_block, first_tx, last_tx,
        threshold_met, updated_at
      )
      VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
    `);

    for (const row of rows) {
      const relatedRanks = String(row.related_ranks || "")
        .split(",")
        .filter(Boolean)
        .map(Number)
        .sort((a, b) => a - b)
        .join(",");
      const firstTx = db.prepare(`
        SELECT tx_hash FROM window_purchases
        WHERE candidate_wallet = ?
        ORDER BY block_number, log_index
        LIMIT 1
      `).get(row.candidate_wallet)?.tx_hash || "";
      const lastTx = db.prepare(`
        SELECT tx_hash FROM window_purchases
        WHERE candidate_wallet = ?
        ORDER BY block_number DESC, log_index DESC
        LIMIT 1
      `).get(row.candidate_wallet)?.tx_hash || "";
      const thresholdMet =
        Number(row.distinct_tokens_after_contest) >= 2 ||
        Number(row.total_windows_seen) >= 3;

      insert.run(
        row.candidate_wallet,
        Number(row.total_appearances),
        Number(row.distinct_tokens_after_contest),
        Number(row.total_windows_seen),
        relatedRanks,
        Number(row.avg_position),
        Number(row.min_position),
        Number(row.avg_block_delay),
        Number(row.first_seen_block),
        Number(row.last_seen_block),
        firstTx,
        lastTx,
        thresholdMet ? 1 : 0
      );
    }
    return { candidates: rows.length };
  });
}

export function getCandidateScores(db, { linkedOnly = false, limit = 500 } = {}) {
  const where = linkedOnly ? "WHERE threshold_met = 1" : "";
  return db.prepare(`
    SELECT * FROM candidate_scores
    ${where}
    ORDER BY threshold_met DESC,
      distinct_tokens_after_contest DESC,
      total_windows_seen DESC,
      total_appearances DESC,
      avg_position ASC
    LIMIT ?
  `).all(limit).map(formatScoreRow);
}

function median(values) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) return sorted[mid];
  return (sorted[mid - 1] + sorted[mid]) / 2;
}

function sideClassification(row) {
  const rankSpread = row.also_follows_ranks.length;
  if (rankSpread >= 10 && row.specificity_score < 0.25) return "broad_flow";
  if (
    row.distinct_tokens >= 5 &&
    row.follow_rate >= 0.25 &&
    row.entries_le_50 >= 3 &&
    row.specificity_score >= 0.35
  ) {
    return "very_strong_side";
  }
  if (
    row.distinct_tokens >= 3 &&
    row.follow_rate >= 0.15 &&
    row.entries_le_50 >= 2 &&
    row.specificity_score >= 0.25
  ) {
    return "strong_side";
  }
  if (row.distinct_tokens >= 2 || row.follow_windows >= 3) return "possible_side";
  return "observed";
}

function sideScore(row) {
  const early =
    row.bucket_1_10 * 5 +
    row.bucket_11_15 * 3 +
    row.bucket_16_50 * 1.5 +
    row.bucket_51_100 * 0.5;
  const breadth = Math.log(row.follow_windows + 1) * 8 + row.distinct_tokens * 4;
  const rates = row.follow_rate * 100 + row.specificity_score * 30;
  const delayPenalty = Math.min(12, row.avg_position / 30);
  const broadPenalty = row.also_follows_ranks.length >= 10 && row.specificity_score < 0.25 ? 25 : 0;
  return Math.max(0, rates + breadth + early - delayPenalty - broadPenalty);
}

function emptySideAccumulator(row, anchorWindowsTotal) {
  return {
    contest_rank: Number(row.anchor_rank),
    contest_wallet: row.anchor_wallet,
    candidate_wallet: row.candidate_wallet,
    anchor_windows_total: anchorWindowsTotal,
    follow_windows: 0,
    raw_appearances: 0,
    distinct_tokens_set: new Set(),
    positions: [],
    delays: [],
    entries_le_10: 0,
    entries_le_15: 0,
    entries_le_50: 0,
    entries_le_100: 0,
    entries_le_200: 0,
    entries_le_300: 0,
    bucket_1_10: 0,
    bucket_11_15: 0,
    bucket_16_50: 0,
    bucket_51_100: 0,
    bucket_101_200: 0,
    bucket_201_300: 0,
    first_seen_block: null,
    last_seen_block: null,
    first_tx: "",
    last_tx: "",
    evidence_sample: []
  };
}

function addSideEvidence(acc, row) {
  const position = Number(row.first_position);
  const delay = Number(row.first_block_delay);
  const block = Number(row.first_block_number);
  acc.follow_windows += 1;
  acc.raw_appearances += Number(row.raw_appearances);
  acc.distinct_tokens_set.add(row.token);
  acc.positions.push(position);
  acc.delays.push(delay);

  if (position <= 10) acc.entries_le_10 += 1;
  if (position <= 15) acc.entries_le_15 += 1;
  if (position <= 50) acc.entries_le_50 += 1;
  if (position <= 100) acc.entries_le_100 += 1;
  if (position <= 200) acc.entries_le_200 += 1;
  if (position <= 300) acc.entries_le_300 += 1;

  if (position <= 10) acc.bucket_1_10 += 1;
  else if (position <= 15) acc.bucket_11_15 += 1;
  else if (position <= 50) acc.bucket_16_50 += 1;
  else if (position <= 100) acc.bucket_51_100 += 1;
  else if (position <= 200) acc.bucket_101_200 += 1;
  else if (position <= 300) acc.bucket_201_300 += 1;

  if (acc.first_seen_block == null || block < acc.first_seen_block) {
    acc.first_seen_block = block;
    acc.first_tx = row.first_tx;
  }
  if (acc.last_seen_block == null || block > acc.last_seen_block) {
    acc.last_seen_block = block;
    acc.last_tx = row.first_tx;
  }
  if (acc.evidence_sample.length < 20) {
    acc.evidence_sample.push({
      token: row.token,
      anchor_id: Number(row.anchor_id),
      anchor_block: Number(row.anchor_block),
      anchor_tx: row.anchor_tx,
      first_position: position,
      first_block_delay: delay,
      first_block_number: block,
      first_tx: row.first_tx
    });
  }
}

function formatSideAccumulator(acc, candidateTotals, candidateRanks) {
  const candidateTotalFollowWindows = candidateTotals.get(acc.candidate_wallet) || acc.follow_windows;
  const alsoFollowsRanks = [...(candidateRanks.get(acc.candidate_wallet) || new Set())].sort((a, b) => a - b);
  const distinctTokens = acc.distinct_tokens_set.size;
  const followRate = acc.anchor_windows_total > 0 ? acc.follow_windows / acc.anchor_windows_total : 0;
  const specificityScore = candidateTotalFollowWindows > 0 ? acc.follow_windows / candidateTotalFollowWindows : 0;
  const row = {
    contest_rank: acc.contest_rank,
    contest_wallet: acc.contest_wallet,
    candidate_wallet: acc.candidate_wallet,
    anchor_windows_total: acc.anchor_windows_total,
    follow_windows: acc.follow_windows,
    follow_rate: followRate,
    raw_appearances: acc.raw_appearances,
    distinct_tokens: distinctTokens,
    entries_le_10: acc.entries_le_10,
    entries_le_15: acc.entries_le_15,
    entries_le_50: acc.entries_le_50,
    entries_le_100: acc.entries_le_100,
    entries_le_200: acc.entries_le_200,
    entries_le_300: acc.entries_le_300,
    bucket_1_10: acc.bucket_1_10,
    bucket_11_15: acc.bucket_11_15,
    bucket_16_50: acc.bucket_16_50,
    bucket_51_100: acc.bucket_51_100,
    bucket_101_200: acc.bucket_101_200,
    bucket_201_300: acc.bucket_201_300,
    avg_position: acc.positions.reduce((sum, value) => sum + value, 0) / acc.positions.length,
    median_position: median(acc.positions),
    min_position: Math.min(...acc.positions),
    avg_block_delay: acc.delays.reduce((sum, value) => sum + value, 0) / acc.delays.length,
    median_block_delay: median(acc.delays),
    min_block_delay: Math.min(...acc.delays),
    first_seen_block: acc.first_seen_block,
    last_seen_block: acc.last_seen_block,
    first_tx: acc.first_tx,
    last_tx: acc.last_tx,
    candidate_total_follow_windows: candidateTotalFollowWindows,
    also_follows_ranks: alsoFollowsRanks,
    specificity_score: specificityScore,
    evidence_sample: acc.evidence_sample
  };
  return {
    ...row,
    classification: sideClassification(row),
    side_score: sideScore(row)
  };
}

export function getContestSideScores(db, { minFollowWindows = 2, limitPerContest = 200 } = {}) {
  const anchorTotals = new Map(
    db.prepare(`
      SELECT anchor_wallet, anchor_rank, COUNT(*) AS total
      FROM anchors
      JOIN contest_wallets ON contest_wallets.wallet = anchors.anchor_wallet
        AND contest_wallets.active = 1
      GROUP BY anchor_wallet, anchor_rank
    `).all().map((row) => [`${row.anchor_rank}:${row.anchor_wallet}`, Number(row.total)])
  );
  const firstFollows = db.prepare(`
    WITH ranked AS (
      SELECT
        a.id AS anchor_id,
        a.anchor_wallet,
        a.anchor_rank,
        a.token,
        a.anchor_block,
        a.anchor_tx,
        wp.candidate_wallet,
        wp.position,
        wp.block_delay,
        wp.block_number,
        wp.log_index,
        wp.tx_hash,
        COUNT(*) OVER (PARTITION BY a.id, wp.candidate_wallet) AS raw_appearances,
        ROW_NUMBER() OVER (
          PARTITION BY a.id, wp.candidate_wallet
          ORDER BY wp.position ASC, wp.block_number ASC, wp.log_index ASC
        ) AS rn
      FROM anchors a
      JOIN contest_wallets cw ON cw.wallet = a.anchor_wallet
        AND cw.active = 1
      JOIN window_purchases wp ON wp.anchor_id = a.id
      WHERE wp.candidate_wallet != a.anchor_wallet
    )
    SELECT
      anchor_id,
      anchor_wallet,
      anchor_rank,
      token,
      anchor_block,
      anchor_tx,
      candidate_wallet,
      position AS first_position,
      block_delay AS first_block_delay,
      block_number AS first_block_number,
      log_index AS first_log_index,
      tx_hash AS first_tx,
      raw_appearances
    FROM ranked
    WHERE rn = 1
    ORDER BY anchor_rank, anchor_wallet, candidate_wallet, first_block_number, first_log_index
  `).all();

  const groups = new Map();
  const candidateTotals = new Map();
  const candidateRanks = new Map();

  for (const row of firstFollows) {
    const rank = Number(row.anchor_rank);
    const anchorKey = `${rank}:${row.anchor_wallet}`;
    const groupKey = `${anchorKey}:${row.candidate_wallet}`;
    const candidateWallet = row.candidate_wallet;

    candidateTotals.set(candidateWallet, (candidateTotals.get(candidateWallet) || 0) + 1);
    if (!candidateRanks.has(candidateWallet)) candidateRanks.set(candidateWallet, new Set());
    candidateRanks.get(candidateWallet).add(rank);

    if (!groups.has(groupKey)) {
      groups.set(groupKey, emptySideAccumulator(row, anchorTotals.get(anchorKey) || 0));
    }
    addSideEvidence(groups.get(groupKey), row);
  }

  const sideRows = [...groups.values()]
    .map((acc) => formatSideAccumulator(acc, candidateTotals, candidateRanks))
    .filter((row) => row.follow_windows >= minFollowWindows)
    .sort(compareSideRows);

  const groupedByContest = new Map();
  for (const row of sideRows) {
    const key = `${row.contest_rank}:${row.contest_wallet}`;
    if (!groupedByContest.has(key)) {
      groupedByContest.set(key, {
        contest_rank: row.contest_rank,
        contest_wallet: row.contest_wallet,
        anchor_windows_total: row.anchor_windows_total,
        side_wallets: []
      });
    }
    const group = groupedByContest.get(key);
    if (group.side_wallets.length < limitPerContest) group.side_wallets.push(row);
  }

  return {
    rows: sideRows,
    groups: [...groupedByContest.values()].sort((a, b) => a.contest_rank - b.contest_rank)
  };
}

function compareSideRows(a, b) {
  const classWeight = {
    very_strong_side: 4,
    strong_side: 3,
    possible_side: 2,
    observed: 1,
    broad_flow: 0
  };
  return (
    (classWeight[b.classification] || 0) - (classWeight[a.classification] || 0) ||
    b.side_score - a.side_score ||
    b.follow_rate - a.follow_rate ||
    b.entries_le_50 - a.entries_le_50 ||
    a.avg_position - b.avg_position
  );
}

function formatScoreRow(row) {
  const formatted = {
    candidate_wallet: row.candidate_wallet,
    status: row.threshold_met ? "suspicious_candidate" : "observed",
    total_appearances: Number(row.total_appearances),
    distinct_tokens_after_contest: Number(row.distinct_tokens_after_contest),
    total_windows_seen: Number(row.total_windows_seen),
    related_ranks: String(row.related_ranks || "").split(",").filter(Boolean).map(Number),
    avg_position: Number(row.avg_position),
    min_position: Number(row.min_position),
    avg_block_delay: Number(row.avg_block_delay),
    first_seen_block: Number(row.first_seen_block),
    last_seen_block: Number(row.last_seen_block),
    first_tx: row.first_tx,
    last_tx: row.last_tx,
    threshold_met: Boolean(row.threshold_met)
  };
  return {
    ...formatted,
    ...classifyMevLikeCandidate(formatted)
  };
}

export function classifyMevLikeCandidate(row) {
  const rankSpread = row.related_ranks.length;
  const reasons = [];

  if (
    row.distinct_tokens_after_contest >= 20 &&
    row.total_windows_seen >= 25 &&
    rankSpread >= 10
  ) {
    reasons.push("broad_many_tokens_many_ranks");
  }
  if (
    row.total_appearances >= 100 &&
    row.distinct_tokens_after_contest >= 10 &&
    row.total_windows_seen >= 25 &&
    rankSpread >= 8
  ) {
    reasons.push("high_frequency_broad_bot");
  }
  if (
    row.min_position <= 3 &&
    row.avg_block_delay <= 60 &&
    row.distinct_tokens_after_contest >= 10 &&
    row.total_windows_seen >= 10
  ) {
    reasons.push("early_fast_sniper_pattern");
  }
  if (
    row.distinct_tokens_after_contest >= 15 &&
    row.total_windows_seen >= 25 &&
    rankSpread >= 12 &&
    row.avg_position >= 60
  ) {
    reasons.push("wide_late_generic_flow");
  }

  return {
    mev_like: reasons.length > 0,
    mev_reasons: reasons
  };
}

export function getCheckpoint(db) {
  const stats = db.prepare(`
    SELECT
      (SELECT COUNT(*) FROM purchases) AS purchases,
      (SELECT COUNT(*) FROM anchors) AS anchors,
      (SELECT COUNT(*) FROM anchors WHERE closed = 0) AS open_windows,
      (SELECT COUNT(*) FROM window_purchases) AS window_purchases,
      (SELECT COUNT(*) FROM candidate_scores) AS candidates,
      (SELECT COUNT(*) FROM candidate_scores WHERE threshold_met = 1) AS linked_candidates
  `).get();
  return {
    last_scanned_block: getMetaNumber(db, "last_scanned_block", null),
    purchases: Number(stats.purchases),
    anchors: Number(stats.anchors),
    open_windows: Number(stats.open_windows),
    window_purchases: Number(stats.window_purchases),
    candidates: Number(stats.candidates),
    linked_candidates: Number(stats.linked_candidates)
  };
}

export function getAnchorWindows(db, { limit = 10000 } = {}) {
  const anchors = db.prepare(`
    SELECT * FROM anchors
    ORDER BY anchor_block, anchor_log_index
    LIMIT ?
  `).all(limit);
  const purchasesByAnchor = db.prepare(`
    SELECT position, candidate_wallet, block_number, log_index, tx_hash, block_delay
    FROM window_purchases
    WHERE anchor_id = ?
    ORDER BY position
  `);
  return anchors.map((anchor) => ({
    anchor_id: Number(anchor.id),
    anchor_wallet: anchor.anchor_wallet,
    anchor_rank: Number(anchor.anchor_rank),
    token: anchor.token,
    anchor_block: Number(anchor.anchor_block),
    anchor_log_index: Number(anchor.anchor_log_index),
    anchor_tx: anchor.anchor_tx,
    collected: Number(anchor.next_count),
    closed: Boolean(anchor.closed),
    purchases: purchasesByAnchor.all(anchor.id).map((row) => ({
      position: Number(row.position),
      wallet: row.candidate_wallet,
      block_number: Number(row.block_number),
      log_index: Number(row.log_index),
      tx_hash: row.tx_hash,
      block_delay: Number(row.block_delay)
    }))
  }));
}

export function linkedWalletsToCsv(rows) {
  const header = [
    "candidate_wallet",
    "status",
    "total_appearances",
    "distinct_tokens_after_contest",
    "total_windows_seen",
    "related_ranks",
    "avg_position",
    "min_position",
    "avg_block_delay",
    "first_seen_block",
    "last_seen_block",
    "first_tx",
    "last_tx",
    "mev_like",
    "mev_reasons"
  ];
  const lines = rows.map((row) =>
    [
      row.candidate_wallet,
      row.status,
      row.total_appearances,
      row.distinct_tokens_after_contest,
      row.total_windows_seen,
      row.related_ranks.join("|"),
      row.avg_position.toFixed(2),
      row.min_position,
      row.avg_block_delay.toFixed(2),
      row.first_seen_block,
      row.last_seen_block,
      row.first_tx,
      row.last_tx,
      row.mev_like ? "1" : "0",
      row.mev_reasons.join("|")
    ].map(csvCell).join(",")
  );
  return `${header.join(",")}\n${lines.join("\n")}\n`;
}

export function contestSideScoresToCsv(rows) {
  const header = [
    "contest_rank",
    "contest_wallet",
    "candidate_wallet",
    "classification",
    "side_score",
    "anchor_windows_total",
    "follow_windows",
    "follow_rate",
    "raw_appearances",
    "distinct_tokens",
    "entries_le_10",
    "entries_le_15",
    "entries_le_50",
    "entries_le_100",
    "entries_le_200",
    "entries_le_300",
    "bucket_1_10",
    "bucket_11_15",
    "bucket_16_50",
    "bucket_51_100",
    "bucket_101_200",
    "bucket_201_300",
    "avg_position",
    "median_position",
    "min_position",
    "avg_block_delay",
    "median_block_delay",
    "min_block_delay",
    "specificity_score",
    "candidate_total_follow_windows",
    "also_follows_ranks",
    "first_seen_block",
    "last_seen_block",
    "first_tx",
    "last_tx"
  ];
  const lines = rows.map((row) =>
    [
      row.contest_rank,
      row.contest_wallet,
      row.candidate_wallet,
      row.classification,
      row.side_score.toFixed(4),
      row.anchor_windows_total,
      row.follow_windows,
      row.follow_rate.toFixed(6),
      row.raw_appearances,
      row.distinct_tokens,
      row.entries_le_10,
      row.entries_le_15,
      row.entries_le_50,
      row.entries_le_100,
      row.entries_le_200,
      row.entries_le_300,
      row.bucket_1_10,
      row.bucket_11_15,
      row.bucket_16_50,
      row.bucket_51_100,
      row.bucket_101_200,
      row.bucket_201_300,
      row.avg_position.toFixed(4),
      row.median_position,
      row.min_position,
      row.avg_block_delay.toFixed(4),
      row.median_block_delay,
      row.min_block_delay,
      row.specificity_score.toFixed(6),
      row.candidate_total_follow_windows,
      row.also_follows_ranks.join("|"),
      row.first_seen_block,
      row.last_seen_block,
      row.first_tx,
      row.last_tx
    ].map(csvCell).join(",")
  );
  return `${header.join(",")}\n${lines.join("\n")}\n`;
}

function csvCell(value) {
  const text = String(value ?? "");
  if (!/[",\n]/.test(text)) return text;
  return `"${text.replaceAll('"', '""')}"`;
}
