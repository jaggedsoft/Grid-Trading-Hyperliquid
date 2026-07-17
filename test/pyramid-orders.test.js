import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import defaults from "../config.js";
import { sdkOrder } from "../src/hyperliquid-client.js";
import { TradingBot } from "../src/strategy-trading-bot.js";
import { initialState } from "../src/state.js";

test("SDK serialization uses Hyperliquid stop-limit trigger fields for pyramid entries", () => {
  const order = sdkOrder({ assetId: 0 }, {
    side: "buy",
    price: "105000",
    triggerPx: "105000",
    size: "0.0003",
    reduceOnly: false,
    orderType: "trigger",
    trigger: { isMarket: false, tpsl: "sl" },
    cloid: `0x${"1".repeat(32)}`,
  });
  assert.deepEqual(order.t, { trigger: { isMarket: false, triggerPx: "105000", tpsl: "sl" } });
  assert.equal(order.p, "105000");
  assert.equal(order.b, true);
});

test("a pyramid fill cancels the unchosen breakout direction", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "hl-pyramid-fill-test-"));
  const bot = new TradingBot({
    config: { ...defaults, pyramid: true, buyEntries: true, sellEntries: true },
    info: {},
    exchange: {},
    credentials: {},
    logger: { log() {}, warn() {}, error() {} },
  });
  bot.market = { fullName: "BTC", szDecimals: 5 };
  bot.stateFile = path.join(root, "state.json");
  bot.state = initialState("mainnet", "BTC");
  const buyCloid = `0x${"1".repeat(32)}`;
  const sellCloid = `0x${"2".repeat(32)}`;
  bot.state.orders[buyCloid] = {
    cloid: buyCloid,
    side: "buy",
    price: "105000",
    triggerPx: "105000",
    size: "0.0003",
    actualNotional: 31.5,
    kind: "pyramid-entry",
    pairedPrice: null,
    status: "open",
  };
  bot.state.orders[sellCloid] = {
    cloid: sellCloid,
    side: "sell",
    price: "95000",
    triggerPx: "95000",
    size: "0.0003",
    actualNotional: 28.5,
    kind: "pyramid-entry",
    pairedPrice: null,
    status: "open",
  };
  let canceled = [];
  bot.cancelRecords = async (records) => {
    canceled = records;
    for (const record of records) record.status = "canceled";
  };

  await bot.processFill({
    coin: "BTC",
    cloid: buyCloid,
    hash: "0xabc",
    tid: 1,
    oid: 2,
    time: 3,
    side: "B",
    sz: "0.0001",
    px: "105000",
    startPosition: "0",
    dir: "Open Long",
  });

  assert.deepEqual(canceled.map((order) => order.cloid), [sellCloid]);
  assert.equal(bot.state.pyramidDirection, "long");
});
