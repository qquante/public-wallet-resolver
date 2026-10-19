import test from "node:test";
import assert from "node:assert/strict";
import {
  buildGmgnImportEntries,
  buildManagedWallets,
  diffManagedWallets,
  toGmgnImportText
} from "../src/sync-data.js";

test("buildManagedWallets keeps resolved top ranks only", () => {
  const wallets = buildManagedWallets(
    [
      { rank: 1, wallet: "0xABC0000000000000000000000000000000000001", status: "resolved" },
      { rank: 2, wallet: null, status: "not_found_on_fourmeme_window" },
      { rank: 21, wallet: "0xABC0000000000000000000000000000000000021", status: "resolved" },
      { rank: 3, wallet: "0xABC0000000000000000000000000000000000003", status: "resolved_tx_sender" }
    ],
    { maxRank: 20 }
  );

  assert.deepEqual(wallets.map((wallet) => wallet.name), ["GMGN-01", "GMGN-03"]);
  assert.equal(wallets[0].address, "0xabc0000000000000000000000000000000000001");
});

test("diffManagedWallets upserts changed names and removes stale managed wallets", () => {
  const previous = [
    { rank: 1, address: "0xaaa", name: "GMGN-01" },
    { rank: 2, address: "0xbbb", name: "GMGN-02" }
  ];
  const desired = [
    { rank: 1, address: "0xaaa", name: "GMGN-01" },
    { rank: 2, address: "0xccc", name: "GMGN-02" },
    { rank: 3, address: "0xddd", name: "GMGN-03" }
  ];

  const diff = diffManagedWallets(previous, desired, { syncRemove: true });
  assert.deepEqual(diff.upsert.map((wallet) => wallet.address), ["0xccc", "0xddd"]);
  assert.deepEqual(diff.remove.map((wallet) => wallet.address), ["0xbbb"]);
});

test("buildGmgnImportEntries emits GMGN import friendly data", () => {
  const entries = buildGmgnImportEntries(
    [
      { rank: 2, wallet: "0xABC0000000000000000000000000000000000002", status: "resolved" },
      { rank: 1, wallet: "0xABC0000000000000000000000000000000000001", status: "resolved" },
      { rank: 3, wallet: null, status: "not_found_on_fourmeme_window" }
    ],
    { maxRank: 20 }
  );

  assert.deepEqual(entries, [
    {
      address: "0xabc0000000000000000000000000000000000001",
      name: "GMGN-01"
    },
    {
      address: "0xabc0000000000000000000000000000000000002",
      name: "GMGN-02"
    }
  ]);
  assert.equal(
    toGmgnImportText(entries),
    "0xabc0000000000000000000000000000000000001:GMGN-01\n0xabc0000000000000000000000000000000000002:GMGN-02\n"
  );
});
