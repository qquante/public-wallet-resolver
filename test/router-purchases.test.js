import test from "node:test";
import assert from "node:assert/strict";
import {
  ERC20_TRANSFER_TOPIC,
  extractRouterPurchaseEvent,
  isRouterTx
} from "../src/router-purchases.js";

const ROUTER = "0x1de460f363af910f51726def188f9004276bf4bc";
const ACCOUNT = "0x155e8082abc875f9f0846d2abf2d6c13d4190cff";
const WBNB = "0xbb4cdb9cbd36b01bd1cbaebf2de08d9173bc095c";
const TOKEN = "0xcd1a9dbbc041386902c96717f0ce1d4a0e2e4444";
const PAIR = "0xc698e7e644ec6271a501574a24a645a17e7d8908";

function topicAddress(address) {
  return `0x${"0".repeat(24)}${address.slice(2)}`;
}

test("isRouterTx detects GMGN Four.Meme router buys", () => {
  assert.equal(
    isRouterTx({
      to: ROUTER,
      input: "0x4d819a2a00000000000000000000000000000000000000000000000000000000000000a0"
    }),
    true
  );
  assert.equal(isRouterTx({ to: ROUTER, input: "0xdeadbeef" }), false);
});

test("extractRouterPurchaseEvent uses token transfer to tx sender", () => {
  const tx = {
    hash: "0xca7a1d5b366ca5e62bafafb535a53872b3f7020239c00902fde8aeac86f8d7c2",
    from: ACCOUNT,
    to: ROUTER,
    input: "0x4d819a2a00000000000000000000000000000000000000000000000000000000000000a0",
    blockNumber: "0x67965e8"
  };
  const receipt = {
    status: "0x1",
    logs: [
      {
        address: WBNB,
        topics: [ERC20_TRANSFER_TOPIC, topicAddress(ROUTER), topicAddress(PAIR)],
        data: "0x1",
        logIndex: "0x2"
      },
      {
        address: TOKEN,
        topics: [ERC20_TRANSFER_TOPIC, topicAddress(PAIR), topicAddress(ACCOUNT)],
        data: "0x2",
        logIndex: "0x3"
      }
    ]
  };

  const event = extractRouterPurchaseEvent(tx, receipt);
  assert.equal(event.account, ACCOUNT);
  assert.equal(event.token, TOKEN);
  assert.equal(event.blockNumber, 108619240);
  assert.equal(event.logIndex, 3);
  assert.match(event.purchaseKey, /^router:108619240:3:/);
});
