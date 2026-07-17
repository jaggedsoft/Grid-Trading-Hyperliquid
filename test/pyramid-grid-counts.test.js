import assert from "node:assert/strict";
import test from "node:test";
import defaults from "../config.js";
import { generateStrategyGrid } from "../src/strategy-grid.js";

test("pyramid directions keep their own buyGrids and sellGrids counts", () => {
  const grid = generateStrategyGrid({
    market: { fullName: "BTC", collateral: "USDC", szDecimals: 5, maxLeverage: 40 },
    midPrice: 100_000,
    config: {
      ...defaults,
      pyramid: true,
      buyEntries: true,
      sellEntries: true,
      buyGrids: 3,
      sellGrids: 5,
    },
  });
  assert.equal(grid.buys.length, 3);
  assert.equal(grid.sells.length, 5);
  assert.equal(Number(grid.buys.at(-1).triggerPx), 110_000);
  assert.equal(Number(grid.sells.at(-1).triggerPx), 90_000);
});
