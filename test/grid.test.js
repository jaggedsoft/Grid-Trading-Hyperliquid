import test from "node:test";
import assert from "node:assert/strict";
import defaults from "../config.js";
import { generateGrid } from "../src/grid.js";
import { formatPrice, formatSizeForNotional } from "../src/precision.js";

const market = { fullName: "BTC", collateral: "USDC", szDecimals: 5, maxLeverage: 50 };

test("price formatting follows side-aware five-significant-figure limits", () => {
  assert.equal(formatPrice("1234.56", 1, "buy"), "1234.5");
  assert.equal(formatPrice("1234.56", 1, "sell"), "1234.6");
  assert.equal(formatPrice("123456.7", 5, "buy"), "123456");
  assert.equal(formatPrice("123456.1", 5, "sell"), "123457");
});

test("size is rounded up only when required to clear $10", () => {
  const sized = formatSizeForNotional(10, 60_000, 5, 10);
  assert.equal(sized.size, "0.00017");
  assert.ok(sized.actualNotional >= 10);
});

test("fixed grid excludes mid and reaches exact outer boundaries", () => {
  const config = { ...defaults, buyGrids: 4, sellGrids: 4 };
  const grid = generateGrid({ market, midPrice: 100_000, config });
  assert.deepEqual(grid.buys.map((order) => order.price), ["97500", "95000", "92500", "90000"]);
  assert.deepEqual(grid.sells.map((order) => order.price), ["102500", "105000", "107500", "110000"]);
  assert.equal(grid.buys[0].targetNotional, 10);
  assert.equal(grid.buys.at(-1).targetNotional, 30);
  assert.equal(grid.buys[0].pairedPrice, "100000");
});

test("multipliers apply before the exchange minimum floor", () => {
  const config = { ...defaults, buyGrids: 2, sellGrids: 2, buyMult: 0.5 };
  const grid = generateGrid({ market, midPrice: 100_000, config });
  assert.equal(grid.buys[0].targetNotional, 10);
  assert.equal(grid.buys[0].adjustedToMinimum, true);
  assert.equal(grid.buys[1].targetNotional, 15);
});

test("volatility grid is symmetric in log space", () => {
  const config = { ...defaults, buyGrids: 2, sellGrids: 2, gridMode: "volatility" };
  const grid = generateGrid({ market, midPrice: 100_000, config, weeklySigma: 0.1 });
  const lower = Number(grid.buys.at(-1).price);
  const upper = Number(grid.sells.at(-1).price);
  assert.ok(Math.abs(Math.log(lower / 100_000) + 0.1) < 0.00002);
  assert.ok(Math.abs(Math.log(upper / 100_000) - 0.1) < 0.00002);
});
