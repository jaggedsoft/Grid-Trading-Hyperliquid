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

test("long pyramid buys strength above mid with successively smaller stop-limit layers", () => {
  const grid = generateStrategyGrid({
    market,
    midPrice: 100_000,
    config: config({ pyramid: true, buyEntries: true, sellEntries: false, buyGrids: 6, sellGrids: 6 }),
  });
  assert.deepEqual(grid.buys.map((order) => order.targetNotional), [30, 26, 22, 18, 14, 10]);
  assert.equal(grid.buys.every((order) => Number(order.triggerPx) > 100_000), true);
  assert.equal(grid.buys.every((order, index, orders) => index === 0 || Number(order.triggerPx) > Number(orders[index - 1].triggerPx)), true);
  assert.equal(grid.buys.every((order) => order.orderType === "trigger" && order.trigger.isMarket === false), true);
  assert.equal(grid.buys.every((order) => order.pairedPrice === null), true);
});

test("short pyramid sells weakness below mid", () => {
  const grid = generateStrategyGrid({
    market,
    midPrice: 100_000,
    config: config({ pyramid: true, buyEntries: false, sellEntries: true, buyGrids: 4, sellGrids: 4 }),
  });
  assert.equal(grid.sells.every((order) => Number(order.triggerPx) < 100_000), true);
  assert.equal(grid.sells.every((order, index, orders) => index === 0 || Number(order.triggerPx) < Number(orders[index - 1].triggerPx)), true);
  assert.equal(grid.sells.every((order) => order.side === "sell" && order.kind === "pyramid-entry"), true);
});

test("pyramid multipliers scale layers without changing their descending shape", () => {
  const grid = generateStrategyGrid({
    market,
    midPrice: 100_000,
    config: config({ pyramid: true, buyEntries: true, sellEntries: false, buyGrids: 4, sellGrids: 4, buyMult: 2 }),
  });
  const notionals = grid.buys.map((order) => order.targetNotional);
  assert.equal(notionals[0], 60);
  assert.equal(notionals.at(-1), 20);
  assert.equal(notionals.every((value, index) => index === 0 || value < notionals[index - 1]), true);
});

test("existing pyramid positions only retain additions beyond weighted entry", () => {
  const strategyConfig = config({ pyramid: true, buyEntries: true, sellEntries: true, buyGrids: 4, sellGrids: 4 });
  const grid = generateStrategyGrid({ market, midPrice: 100_000, config: strategyConfig });
  const bot = new TradingBot({ config: strategyConfig, info: {}, logger: { log() {}, warn() {}, error() {} } });
  const longAdds = bot.pyramidOrdersForPosition(grid, { size: 1, entryPrice: 104_000 });
  assert.equal(longAdds.every((order) => order.side === "buy" && Number(order.triggerPx) > 104_000), true);
  const shortAdds = bot.pyramidOrdersForPosition(grid, { size: -1, entryPrice: 96_000 });
  assert.equal(shortAdds.every((order) => order.side === "sell" && Number(order.triggerPx) < 96_000), true);
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
