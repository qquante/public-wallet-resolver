export const RANK_WINDOWS = [
  { key: "60m", label: "60 min", ms: 60 * 60 * 1000 },
  { key: "4h", label: "4 horas", ms: 4 * 60 * 60 * 1000 },
  { key: "24h", label: "24 horas", ms: 24 * 60 * 60 * 1000 }
];

const DEFAULT_MAX_HISTORY_AGE_MS = 3 * 24 * 60 * 60 * 1000;

function toTime(value) {
  const time = new Date(value).getTime();
  return Number.isFinite(time) ? time : Date.now();
}

function rowKey(row) {
  return row.wallet || row.masked_address;
}

function snapshotSignature(snapshot) {
  return snapshot.rows
    .map((row) => `${row.rank}:${row.masked_address}:${row.wallet || ""}:${row.status || ""}`)
    .join("|");
}

function displayRank(rank) {
  return String(rank).padStart(2, "0");
}

export function syncNameForRank(rank) {
  return `GMGN-${displayRank(rank)}`;
}

export function compactMovementLabel(rank, delta) {
  if (delta == null) return `GMGN${rank}?`;
  if (delta === 0) return `GMGN${rank}=`;
  return `GMGN${rank}${delta > 0 ? "+" : ""}${delta}`;
}

export function buildRankingSnapshot(state) {
  return {
    captured_at: state.generated_at,
    gmgn_updated_at: state.gmgn?.updated_at ?? null,
    rows: (state.wallets || []).map((row) => ({
      rank: row.rank,
      masked_address: row.masked_address,
      wallet: row.wallet || null,
      status: row.status,
      balance: row.gmgn?.balance ?? null,
      profit: row.gmgn?.profit ?? null,
      pnl: row.gmgn?.pnl ?? null,
      winrate: row.gmgn?.winrate ?? null
    }))
  };
}

export function appendRankingSnapshot(history, snapshot, { now = Date.now(), maxAgeMs = DEFAULT_MAX_HISTORY_AGE_MS } = {}) {
  const previous = Array.isArray(history?.snapshots) ? history.snapshots : [];
  const currentSignature = snapshotSignature(snapshot);
  const last = previous.at(-1);
  const lastSignature = last ? snapshotSignature(last) : null;

  const snapshots = lastSignature === currentSignature
    ? previous
    : [...previous, snapshot];

  const cutoff = now - maxAgeMs;
  return {
    updated_at: new Date(now).toISOString(),
    snapshots: snapshots.filter((item) => toTime(item.captured_at) >= cutoff)
  };
}

function snapshotAtOrBefore(snapshots, targetTime) {
  let selected = null;
  for (const snapshot of snapshots) {
    const time = toTime(snapshot.captured_at);
    if (time <= targetTime) selected = snapshot;
    if (time > targetTime) break;
  }
  return selected || snapshots[0] || null;
}

function indexSnapshot(snapshot) {
  const byMask = new Map();
  const byWallet = new Map();
  for (const row of snapshot?.rows || []) {
    if (row.masked_address) byMask.set(row.masked_address, row);
    if (row.wallet) byWallet.set(row.wallet, row);
  }
  return { byMask, byWallet };
}

function movementForRow(row, baselineIndex) {
  const previous = (row.wallet && baselineIndex.byWallet.get(row.wallet)) ||
    baselineIndex.byMask.get(row.masked_address);

  if (!previous) {
    return {
      delta: null,
      previous_rank: null,
      direction: "unknown",
      label: compactMovementLabel(row.rank, null)
    };
  }

  const delta = previous.rank - row.rank;
  return {
    delta,
    previous_rank: previous.rank,
    direction: delta > 0 ? "up" : delta < 0 ? "down" : "same",
    label: compactMovementLabel(row.rank, delta)
  };
}

export function computeRankMovement(history, state, { now = toTime(state.generated_at), windows = RANK_WINDOWS } = {}) {
  const snapshots = (Array.isArray(history?.snapshots) ? history.snapshots : [])
    .slice()
    .sort((a, b) => toTime(a.captured_at) - toTime(b.captured_at));

  const rows = (state.wallets || []).map((row) => ({
    rank: row.rank,
    name: syncNameForRank(row.rank),
    compact_name: `GMGN${row.rank}`,
    masked_address: row.masked_address,
    wallet: row.wallet || null,
    status: row.status,
    gmgn: row.gmgn,
    movement: {}
  }));

  const windowSummaries = {};
  const quick = {};

  for (const window of windows) {
    const target = now - window.ms;
    const baseline = snapshotAtOrBefore(snapshots, target);
    const baselineTime = baseline ? toTime(baseline.captured_at) : null;
    const baselineIndex = indexSnapshot(baseline);
    const complete = baselineTime != null && baselineTime <= target;
    const changed = [];
    let up = 0;
    let down = 0;
    let same = 0;
    let unknown = 0;

    for (const row of rows) {
      const movement = movementForRow(row, baselineIndex);
      movement.baseline_at = baseline?.captured_at ?? null;
      movement.baseline_complete = complete;
      movement.baseline_age_minutes = baselineTime == null ? null : Math.round((now - baselineTime) / 60000);
      row.movement[window.key] = movement;

      if (movement.delta == null) {
        unknown += 1;
      } else if (movement.delta > 0) {
        up += 1;
        changed.push({ rank: row.rank, name: row.name, label: movement.label, delta: movement.delta, direction: "up" });
      } else if (movement.delta < 0) {
        down += 1;
        changed.push({ rank: row.rank, name: row.name, label: movement.label, delta: movement.delta, direction: "down" });
      } else {
        same += 1;
      }
    }

    changed.sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta) || a.rank - b.rank);
    quick[window.key] = changed.map((item) => item.label);
    windowSummaries[window.key] = {
      label: window.label,
      baseline_at: baseline?.captured_at ?? null,
      baseline_complete: complete,
      up,
      down,
      same,
      unknown,
      changed: changed.length
    };
  }

  return {
    updated_at: new Date(now).toISOString(),
    gmgn_updated_at: state.gmgn?.updated_at ?? null,
    windows: windowSummaries,
    quick,
    rows
  };
}
