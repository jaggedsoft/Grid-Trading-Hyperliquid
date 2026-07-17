import assert from "node:assert/strict";
import test from "node:test";
import { printGrid } from "../src/output.js";

const market = {
  fullName: "BTC",
  collateral: "USDC",
  openInterest: 1,
  dayNtlVlm: 2,
  maxLeverage: 40,
  szDecimals: 5,
};

const config = {
  dryRun: true,
  gridMode: "fixed",
  minOrderNotional: 10,
};

function rendered(entrySides) {
  const lines = [];
  const side = entrySides === "long" ? "buy" : "sell";
  const order = { side, price: "60000", size: "0.00017", actualNotional: 10.2, adjustedToMinimum: false };
  const buys = side === "buy" ? [order] : [];
  const sells = side === "sell" ? [order] : [];
  printGrid(market, {
    entrySides,
    anchorMid: 61000,
    weeklySigma: null,
    buys,
    sells,
    orders: [order],
    buyNotional: buys.length ? 10.2 : 0,
    sellNotional: sells.length ? 10.2 : 0,
  }, config, { log: (line) => lines.push(line), warn: (line) => lines.push(line) });
  return lines.join("\n");
}

test("side-only previews omit the disabled entry side", () => {
  const longPreview = rendered("long");
  assert.match(longPreview, /BUY/);
  assert.doesNotMatch(longPreview, /SELL|Sell liquidity/);

  const shortPreview = rendered("short");
  assert.match(shortPreview, /SELL/);
  assert.doesNotMatch(shortPreview, /BUY|buy liquidity/);
});
