import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import defaults from "../config.js";
import { TradingBot } from "../src/safe-trading-bot.js";
import { initialState } from "../src/state.js";

const quietLogger = { log() {}, warn() {}, error() {} };

function sampleGrid() {
  const buy = { key: "buy-1", side: "buy", level: 1, price: "99", size: "0.11", actualNotional: 10.89, reduceOnly: false, kind: "entry", pairedPrice: "100" };
  const sell = { key: "sell-1", side: "sell", level: 1, price: "101", size: "0.1", actualNotional: 10.1, reduceOnly: false, kind: "entry", pairedPrice: "100" };
  return { anchorMid: "100", weeklySigma: null, buys: [buy], sells: [sell], orders: [sell, buy], buyNotional: 10.89, sellNotional: 10.1, maxPositionNotional: 10.89 };
}

test("canceling a rebuild preview preserves existing bot orders", async () => {
  const info = {
    clearinghouseState: async () => ({ assetPositions: [] }),
    openOrders: async () => [{ cloid: `0x${"1".repeat(32)}` }],
  };
  const bot = new TradingBot({ config: { ...defaults }, info, exchange: {}, credentials: { accountAddress: `0x${"2".repeat(40)}` }, logger: quietLogger });
  bot.market = { fullName: "BTC", dex: "", szDecimals: 5, collateral: "USDC", maxLeverage: 50 };
  bot.state = initialState("mainnet", "BTC");
  bot.freshMarketAndGrid = async () => ({ loaded: { midPrice: 100 }, grid: sampleGrid() });
  bot.previewRoutineOrders = async () => false;
  let canceled = false;
  bot.cancelAllOwned = async () => { canceled = true; };
  const result = await bot.rebuildGrid("test");
  assert.equal(result, false);
  assert.equal(canceled, false);
});

test("risk warning does not overwrite a paused-risk state", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "hl-grid-safe-test-"));
  const bot = new TradingBot({ config: { ...defaults }, info: {}, exchange: {}, credentials: {}, workspace: root, logger: quietLogger });
  bot.market = { fullName: "BTC" };
  bot.state = initialState("mainnet", "BTC");
  bot.state.phase = "PAUSED_RISK";
  bot.state.initialLiquidationDistance = 0.01;
  bot.stateFile = path.join(root, "state.json");
  bot.maxPositionNotional = 1_000;
  bot.cancelExposureIncreasing = async () => {};
  const position = { size: 1, liquidationPrice: 99.4 };
  const book = { levels: [[{ px: "100", sz: "100" }], [{ px: "100", sz: "100" }]] };
  await bot.monitorRisk(position, [], 100, book);
  assert.equal(bot.state.phase, "PAUSED_RISK");
});
