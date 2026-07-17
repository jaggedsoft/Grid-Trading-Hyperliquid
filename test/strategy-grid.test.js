import test from "node:test";
import assert from "node:assert/strict";
import defaults from "../config.js";
import { generateStrategyGrid } from "../src/strategy-grid.js";
import { TradingBot } from "../src/strategy-trading-bot.js";

const market = { fullName: "BTC", collateral: "USDC", szDecimals: 5, maxLeverage: 50 };

function config(overrides = {}) {
  return {
    ...defaults,
    long: false,
    short: false,
    pyramid: false,
    buyEntries: true,
    sellEntries: true,
    ...overrides,
  };
}

test("long-only grid contains only buy entries but retains sell references", () => {
  const grid = generateStrategyGrid({ market, midPrice: 100_000, config: config({ buyEntries: true, sellEntries: false, buyGrids: 4, sellGrids: 4 }) });
  assert.equal(grid.buys.length, 4);
  assert.equal(grid.sells.length, 0);
  assert.equal(grid.orders.every((order) => order.side === "buy"), true);
  assert.equal(grid.referenceSells.length, 4);
  assert.equal(grid.entrySides, "long");
});

test("short-only grid contains only sell entries", () => {
  const grid = generateStrategyGrid({ market, midPrice: 100_000, config: config({ buyEntries: false, sellEntries: true, buyGrids: 4, sellGrids: 3 }) });
  assert.equal(grid.buys.length, 0);
  assert.equal(grid.sells.length, 3);
  assert.equal(grid.orders.every((order) => order.side === "sell"), true);
  assert.equal(grid.entrySides, "short");
});

test("pyramid doubles target notional and stops at maxOrderNotional", () => {
  const grid = generateStrategyGrid({
    market,
    midPrice: 100_000,
    config: config({ pyramid: true, buyEntries: true, sellEntries: false, buyGrids: 6, maxOrderNotional: 160 }),
  });
  assert.deepEqual(grid.buys.map((order) => order.targetNotional), [10, 20, 40, 80, 160, 160]);
  assert.equal(grid.buys.every((order) => order.sizingStrategy === "pyramid"), true);
});

test("pyramid cap and start both honor the side multiplier", () => {
  const grid = generateStrategyGrid({
    market,
    midPrice: 100_000,
    config: config({ pyramid: true, buyEntries: true, sellEntries: false, buyGrids: 4, buyMult: 2 }),
  });
  assert.deepEqual(grid.buys.map((order) => order.targetNotional), [20, 40, 60, 60]);
});

test("long-only strategy can still create a protective sell exit", () => {
  const strategyConfig = config({ buyEntries: true, sellEntries: false, buyGrids: 4, sellGrids: 4 });
  const grid = generateStrategyGrid({ market, midPrice: 100_000, config: strategyConfig });
  const bot = new TradingBot({ config: strategyConfig, info: {}, logger: { log() {}, warn() {}, error() {} } });
  bot.market = market;
  const exit = bot.reanchoredExit({ size: 0.001, entryPrice: 95_000 }, grid);
  assert.equal(exit.side, "sell");
  assert.equal(exit.reduceOnly, true);
});
