export function buildManagedWallets(wallets, { maxRank = 20, namePrefix = "GMGN", nameSeparator = "-" } = {}) {
  return wallets
    .filter((row) => row.rank <= maxRank && row.wallet && String(row.status || "").startsWith("resolved"))
    .sort((a, b) => a.rank - b.rank)
    .map((row) => ({
      rank: row.rank,
      address: row.wallet.toLowerCase(),
      name: `${namePrefix}${nameSeparator}${String(row.rank).padStart(2, "0")}`,
      status: row.status,
      source: row.source || null
    }));
}

export function diffManagedWallets(previous, desired, { syncRemove = true } = {}) {
  const desiredByAddress = new Map(desired.map((wallet) => [wallet.address, wallet]));
  const previousByAddress = new Map((previous || []).map((wallet) => [wallet.address, wallet]));
  const upsert = desired.filter((wallet) => {
    const old = previousByAddress.get(wallet.address);
    return !old || old.name !== wallet.name || old.rank !== wallet.rank;
  });
  const remove = syncRemove
    ? (previous || []).filter((wallet) => !desiredByAddress.has(wallet.address))
    : [];
  return { upsert, remove };
}

export function buildGmgnImportEntries(wallets, options = {}) {
  return buildManagedWallets(wallets, options).map((wallet) => ({
    address: wallet.address,
    name: wallet.name
  }));
}

export function toGmgnImportText(entries) {
  return entries.map((entry) => `${entry.address}:${entry.name}`).join("\n") + (entries.length ? "\n" : "");
}
