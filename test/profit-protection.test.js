import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import defaults from "../config.js";
import { loadConfig } from "../src/configuration.js";
import {
  feeAwareBreakEven,
  observedFillFeeRate,
  shouldTightenStop,
  stopLocksFeeAdjustedProfit,
  trailingTriggerPrice,
  weightedFeeRate,
} from "../src/profit-protection.js";
import { TradingBot } from "../src/protected-trading-bot.js";
import { initialState } from "../src/state.js";

const quietLogger = { log() {}, warn() {}, error() {} };

test("profit-protection CLI percentages and fee controls validate", () => {
  const config = loadConfig([
    "--trailing-stop-percent=0.75",
    "--derisk-percent=40",
    "--profit-fee-buffer-bps=3",
  ]);
  assert.equal(config.trailingStopPercent, 0.75);
  assert.equal(config.deriskPercent, 40);
  assert.equal(config.profitFeeBufferBps, 3);
  assert.throws(() => loadConfig(["--trailing-stop-percent=100"]), /trailingStopPercent/);
  assert.throws(() => loadConfig(["--derisk-percent=101"]), /deriskPercent/);
  assert.equal(loadConfig(["--trailing-stop-percent=0", "--derisk-percent=0"]).deriskPercent, 0);
});

test("fee-aware breakeven includes entry fee, estimated exit fee, and buffer", () => {
  const long = feeAwareBreakEven({
    entryPrice: 100,
    direction: "long",
    entryFeeRate: 0.001,
    exitFeeRate: 0.002,
    feeBufferBps: 10,
  });
  assert.ok(Math.abs(long - (100 * 1.002 / 0.998)) < 1e-12);
  const short = feeAwareBreakEven({
    entryPrice: 100,
    direction: "short",
    entryFeeRate: 0.001,
    exitFeeRate: 0.002,
    feeBufferBps: 10,
  });
  assert.ok(Math.abs(short - (100 * 0.998 / 1.002)) < 1e-12);
});

test("observed fill fees and weighted rates use actual fill notional", () => {
  const rate = observedFillFeeRate({ px: "100", sz: "2", fee: "0.1" });
  assert.equal(rate, 0.0005);
  const weighted = weightedFeeRate(0.0002, 100, 0.0006, 300);
  assert.equal(weighted.rate, 0.0005);
  assert.equal(weighted.notional, 400);
});

test("trailing stops only tighten and must lock profit at their worst limit", () => {
  const trigger = trailingTriggerPrice(103, "long", 1);
  assert.equal(trigger, 101.97);
  assert.equal(stopLocksFeeAdjustedProfit(trigger, "long", 100.5, 100), true);
  assert.equal(stopLocksFeeAdjustedProfit(trigger, "long", 101.5, 100), false);
  assert.equal(shouldTightenStop(101, 102, "long", 5), true);
  assert.equal(shouldTightenStop(101, 100, "long", 5), false);
  assert.equal(shouldTightenStop(99, 98, "short", 5), true);
});

async function protectedBot(overrides = {}) {
  const workspace = await mkdtemp(path.join(tmpdir(), "hl-profit-protection-test-"));
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
    logger: quietLogger,
    workspace,
  });
  bot.market = { assetId: 0, fullName: "BTC", collateral: "USDC", szDecimals: 5, maxLeverage: 40 };
  bot.state = initialState("mainnet", "BTC");
  bot.state.phase = "ACTIVE";
  bot.stateFile = path.join(workspace, "state.json");
  return bot;
}

test("fee-profitable derisk submits the configured position percentage as reduce-only IOC", async () => {
  const bot = await protectedBot({ trailingStopPercent: 0, deriskPercent: 25 });
  let submitted;
  bot.submitAndRemember = async (orders, options) => {
    submitted = { order: orders[0], options };
    bot.state.orders[orders[0].cloid] = { ...orders[0], status: "filled" };
    return [{ filled: { totalSz: orders[0].size } }];
  };

  await bot.monitorProfitProtection({ size: 0.004, entryPrice: 100_000 }, 100_100);
  assert.equal(submitted.order.side, "sell");
  assert.equal(submitted.order.size, "0.001");
  assert.equal(submitted.order.reduceOnly, true);
  assert.equal(submitted.order.kind, "derisk");
  assert.deepEqual(submitted.options, { reason: "profitable derisk", tif: "Ioc", preview: false });
  assert.equal(bot.state.profitProtection.deriskDone, true);
});

test("trailing stop activates beyond breakeven and modifies in place on a new high", async () => {
  const bot = await protectedBot({ trailingStopPercent: 1, deriskPercent: 0, maxEmergencySlippageBps: 100, trailingStopUpdateBps: 5 });
  let initialOrder;
  bot.submitAndRemember = async (orders) => {
    [initialOrder] = orders;
    bot.state.orders[initialOrder.cloid] = { ...initialOrder, status: "open" };
    return [{ resting: { oid: 1 } }];
  };
  let modification;
  bot.exchange.modify = async (request) => {
    modification = request;
    return { status: "ok" };
  };

  const position = { size: 0.001, entryPrice: 100_000 };
  await bot.monitorProfitProtection(position, 103_000);
  assert.equal(initialOrder.kind, "trailing-stop");
  assert.equal(initialOrder.orderType, "trigger");
  assert.equal(initialOrder.reduceOnly, true);
  assert.ok(Number(initialOrder.triggerPx) < 103_000);
  assert.ok(Number(initialOrder.price) >= 100_000);

  await bot.monitorProfitProtection(position, 104_000);
  assert.equal(modification.oid, initialOrder.cloid);
  assert.equal(modification.a, true);
  assert.ok(Number(modification.order.t.trigger.triggerPx) > Number(initialOrder.triggerPx));
});
