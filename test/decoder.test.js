import test from "node:test";
import assert from "node:assert/strict";
import { EVENT_TOPICS } from "../src/constants.js";
import { decodeAddressWord, decodeFourMemeLog, emptyAccountIndex, mergeDecodedEvent } from "../src/fourmeme.js";

const SAMPLE_PURCHASE_DATA =
  "0x" +
  "00000000000000000000000076138888158f7ce4bbe14c59e18e880d57ab4444" +
  "0000000000000000000000004262f7b70b81538258eb2c5ecad3947ba4e0c8b0" +
  "000000000000000000000000000000000000000000000000000000029c13f537" +
  "00000000000000000000000000000000000000000003a339d3d41d9ad2a45200" +
  "00000000000000000000000000000000000000000000000000ae1e3ecafdee3e" +
  "0000000000000000000000000000000000000000000000000001bdbe1163d1be" +
  "000000000000000000000000000000000000000001991941ab911ad2ead49400" +
  "00000000000000000000000000000000000000000000000021ff7f07b91232ea";

test("decodeAddressWord extracts padded addresses from event data", () => {
  assert.equal(decodeAddressWord(SAMPLE_PURCHASE_DATA, 0), "0x76138888158f7ce4bbe14c59e18e880d57ab4444");
  assert.equal(decodeAddressWord(SAMPLE_PURCHASE_DATA, 1), "0x4262f7b70b81538258eb2c5ecad3947ba4e0c8b0");
});

test("decodeFourMemeLog decodes TokenPurchase account and token", () => {
  const decoded = decodeFourMemeLog({
    topics: [EVENT_TOPICS.TokenPurchase],
    data: SAMPLE_PURCHASE_DATA,
    blockNumber: "0x3e5cecb",
    logIndex: "0x2",
    transactionHash: "0x4f4e720a02e9523a7637426f64982552a791ab55d63b5849466826dd20289523"
  });

  assert.equal(decoded.eventName, "TokenPurchase");
  assert.equal(decoded.account, "0x4262f7b70b81538258eb2c5ecad3947ba4e0c8b0");
  assert.equal(decoded.token, "0x76138888158f7ce4bbe14c59e18e880d57ab4444");
});

test("mergeDecodedEvent keeps wallet evidence", () => {
  const index = emptyAccountIndex();
  mergeDecodedEvent(index, {
    eventName: "TokenSale",
    account: "0x4262f7b70b81538258eb2c5ecad3947ba4e0c8b0",
    token: "0x76138888158f7ce4bbe14c59e18e880d57ab4444",
    blockNumber: 100,
    logIndex: 0,
    txHash: "0xabc"
  });

  const stats = index.accounts["0x4262f7b70b81538258eb2c5ecad3947ba4e0c8b0"];
  assert.equal(stats.event_counts.TokenSale, 1);
  assert.equal(stats.first_seen_block, 100);
  assert.equal(stats.first_tx, "0xabc");
});

test("mergeDecodedEvent keeps GMGN router tx evidence", () => {
  const index = emptyAccountIndex();
  mergeDecodedEvent(index, {
    eventName: "GmgnRouterTx",
    sender: "0x155e8082abc875f9f0846d2abf2d6c13d4190cff",
    router: "0x1de460f363af910f51726def188f9004276bf4bc",
    selector: "0x4d819a2a",
    blockNumber: 108633576,
    logIndex: 0,
    txHash: "0xca7a1d5b366ca5e62bafafb535a53872b3f7020239c00902fde8aeac86f8d7c2"
  });

  const stats = index.router_txs["0x155e8082abc875f9f0846d2abf2d6c13d4190cff"];
  assert.equal(stats.event_counts.GmgnRouterTx, 1);
  assert.equal(stats.first_seen_block, 108633576);
  assert.equal(stats.first_tx, "0xca7a1d5b366ca5e62bafafb535a53872b3f7020239c00902fde8aeac86f8d7c2");
  assert.deepEqual(stats.router_samples, ["0x1de460f363af910f51726def188f9004276bf4bc"]);
  assert.deepEqual(stats.selector_samples, ["0x4d819a2a"]);
});
