import test from "node:test";
import assert from "node:assert/strict";
import defaults from "../config.js";
import { TradingBot } from "../src/trading-bot.js";

function candles() {
  const result = [];
  const interval = 4 * 60 * 60 * 1000;
  const start = Date.now() - 44 * interval;
  for (let index = 0; index < 44; index += 1) {
    result.push({ t: start + index * interval, T: start + (index + 1) * interval - 1, o: "100000", c: String(100000 + (index % 2) * 100) });
  }
  return result;
}

test("dry run performs public discovery and never requires an exchange client", async () => {
  const meta = { universe: [{ name: "BTC", szDecimals: 5, maxLeverage: 50, marginTableId: 50 }], marginTables: [], collateralToken: 0 };
  const info = {
    perpDexs: async () => [null],
    allPerpMetas: async () => [meta],
    spotMeta: async () => ({ tokens: [{ index: 0, name: "USDC" }], universe: [] }),
    metaAndAssetCtxs: async () => [meta, [{ midPx: "100000", markPx: "100000", openInterest: "1000", dayNtlVlm: "5000" }]],
    l2Book: async () => ({ levels: [[{ px: "99999", sz: "1" }], [{ px: "100001", sz: "1" }]] }),
    candleSnapshot: async () => candles(),
  };
  const lines = [];
  const logger = { log: (line = "") => lines.push(String(line)), warn: (line) => lines.push(String(line)), error: (line) => lines.push(String(line)) };
  const bot = new TradingBot({ config: { ...defaults }, info, logger });
  const result = await bot.runDryRun();
  assert.equal(result.grid.orders.length, 32);
  assert.equal(result.market.fullName, "BTC");
  assert.ok(lines.some((line) => line.includes("DRY RUN")));
});
