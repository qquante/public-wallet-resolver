const FULL_ADDRESS_RE = /^0x[0-9a-f]{40}$/i;
const MASKED_ADDRESS_RE = /^(0x[0-9a-f]+)\.\.\.([0-9a-f]+)$/i;

export function parseMaskedAddress(maskedAddress) {
  const text = String(maskedAddress || "").toLowerCase();
  if (FULL_ADDRESS_RE.test(text)) {
    return { type: "full", address: text };
  }
  const match = text.match(MASKED_ADDRESS_RE);
  if (!match) {
    throw new Error(`Endereco GMGN invalido ou inesperado: ${maskedAddress}`);
  }
  return { type: "masked", prefix: match[1], suffix: match[2] };
}

export function matchesMask(address, parsedMask) {
  const value = String(address || "").toLowerCase();
  if (parsedMask.type === "full") return value === parsedMask.address;
  return value.startsWith(parsedMask.prefix) && value.endsWith(parsedMask.suffix);
}

function statsFor(index, wallet) {
  return index.accounts?.[wallet] || index.router_txs?.[wallet] || index.senders?.[wallet] || null;
}

export function resolveRankingWallets(ranking, accountIndex) {
  const tradeWallets = Object.keys(accountIndex.accounts || {});
  const routerTxWallets = Object.keys(accountIndex.router_txs || {});
  const senderWallets = Object.keys(accountIndex.senders || {});
  const creatorWallets = Object.keys(accountIndex.creators || {});

  return ranking.rows.map((row) => {
    const parsed = parseMaskedAddress(row.masked_address);
    const accountMatches = tradeWallets.filter((wallet) => matchesMask(wallet, parsed)).sort();
    const routerTxMatches = routerTxWallets.filter((wallet) => matchesMask(wallet, parsed)).sort();
    const senderMatches = senderWallets.filter((wallet) => matchesMask(wallet, parsed)).sort();
    const matches = [...new Set([...accountMatches, ...routerTxMatches, ...senderMatches])].sort();
    const creatorMatches = creatorWallets.filter((wallet) => matchesMask(wallet, parsed)).sort();

    let status = "not_found_on_fourmeme_window";
    let wallet = null;
    let eventStats = null;
    let source = null;
    if (matches.length === 1) {
      wallet = matches[0];
      source = accountMatches.includes(wallet)
        ? "fourmeme_account"
        : routerTxMatches.includes(wallet)
          ? "gmgn_router_tx"
          : "transaction_sender";
      status =
        source === "fourmeme_account"
          ? "resolved"
          : source === "gmgn_router_tx"
            ? "resolved_gmgn_router_tx"
            : "resolved_tx_sender";
      eventStats = statsFor(accountIndex, wallet);
    } else if (matches.length > 1) {
      status = "ambiguous";
    }

    return {
      rank: row.rank,
      masked_address: row.masked_address,
      wallet,
      status,
      source,
      candidate_count: matches.length,
      candidates: matches,
      account_candidates: accountMatches,
      router_tx_candidates: routerTxMatches,
      sender_candidates: senderMatches,
      creator_candidate_count: creatorMatches.length,
      creator_candidates: creatorMatches,
      event_counts: eventStats?.event_counts ?? null,
      first_seen_block: eventStats?.first_seen_block ?? null,
      last_seen_block: eventStats?.last_seen_block ?? null,
      first_tx: eventStats?.first_tx ?? null,
      last_tx: eventStats?.last_tx ?? null,
      gmgn: {
        balance: row.balance,
        winrate: row.winrate,
        profit: row.profit,
        pnl: row.pnl,
        updated_at: ranking.updated_at
      }
    };
  });
}

export function toWalletCsv(rows) {
  const header = [
    "rank",
    "masked_address",
    "wallet",
    "status",
    "candidate_count",
    "first_seen_block",
    "last_seen_block",
    "first_tx",
    "last_tx"
  ];
  const lines = [header.join(",")];
  for (const row of rows) {
    lines.push(
      [
        row.rank,
        row.masked_address,
        row.wallet || "",
        row.status,
        row.candidate_count,
        row.first_seen_block ?? "",
        row.last_seen_block ?? "",
        row.first_tx || "",
        row.last_tx || ""
      ]
        .map(csvCell)
        .join(",")
    );
  }
  return `${lines.join("\n")}\n`;
}

function csvCell(value) {
  const text = String(value);
  if (!/[",\n]/.test(text)) return text;
  return `"${text.replaceAll('"', '""')}"`;
}
