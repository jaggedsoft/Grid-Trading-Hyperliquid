import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import defaults from "../config.js";
import { TradingBot } from "../src/protected-trading-bot.js";
import { initialState } from "../src/state.js";

async function shortBot(overrides = {}) {
  const workspace = await mkdtemp(path.join(tmpdir(), "hl-short-protection-test-"));
  const bot = new TradingBot({
    config: {
      ...defaults,
      feeFallbackTakerBps: 0,
      profitFeeBufferBps: 0,
      ...overrides,
    },
    info: { userFees: async () => ({ userCrossRate: "0" }) },
    exchange: { modify: async () => ({ status: "ok" }) },
    credentials: { accountAddress: `0x${"1".repeat(40)}` },
    logger: { log() {}, warn() {}, error() {} },
    workspace,
  });
  bot.market = { assetId: 0, fullName: "BTC", collateral: "USDC", szDecimals: 5, maxLeverage: 40 };
  bot.state = initialState("mainnet", "BTC");
  bot.state.phase = "ACTIVE";
  bot.stateFile = path.join(workspace, "state.json");
  return bot;
}

test("short profit protection derisks with a buy and trails above a falling market", async () => {
  const deriskBot = await shortBot({ trailingStopPercent: 0, deriskPercent: 25 });
  let deriskOrder;
  deriskBot.submitAndRemember = async (orders) => {
    [deriskOrder] = orders;
    deriskBot.state.orders[deriskOrder.cloid] = { ...deriskOrder, status: "filled" };
    return [{ filled: { totalSz: deriskOrder.size } }];
  };
  await deriskBot.monitorProfitProtection({ size: -0.004, entryPrice: 100_000 }, 99_900);
  assert.equal(deriskOrder.side, "buy");
  assert.equal(deriskOrder.size, "0.001");
  assert.equal(deriskOrder.reduceOnly, true);

  const trailingBot = await shortBot({ trailingStopPercent: 1, deriskPercent: 0, maxEmergencySlippageBps: 100 });
  let stopOrder;
  trailingBot.submitAndRemember = async (orders) => {
    [stopOrder] = orders;
    trailingBot.state.orders[stopOrder.cloid] = { ...stopOrder, status: "open" };
    return [{ resting: { oid: 1 } }];
  };
  await trailingBot.monitorProfitProtection({ size: -0.001, entryPrice: 100_000 }, 97_000);
  assert.equal(stopOrder.side, "buy");
  assert.ok(Number(stopOrder.triggerPx) > 97_000);
  assert.ok(Number(stopOrder.price) <= 100_000);
});
