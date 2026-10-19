import test from "node:test";
import assert from "node:assert/strict";
import { formatWeiToDecimal, parseDecimalToWei } from "../src/amounts.js";

test("parseDecimalToWei converts BNB threshold exactly", () => {
  assert.equal(parseDecimalToWei("2").toString(), "2000000000000000000");
  assert.equal(parseDecimalToWei("2.5").toString(), "2500000000000000000");
  assert.equal(parseDecimalToWei("0.000000000000000001").toString(), "1");
});

test("formatWeiToDecimal formats without floating point loss", () => {
  assert.equal(formatWeiToDecimal(2000000000000000000n, 18, 9), "2");
  assert.equal(formatWeiToDecimal(14478042875196734905n, 18, 9), "14.478042875");
});
