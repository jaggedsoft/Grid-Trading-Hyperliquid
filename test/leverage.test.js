import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import defaults from "../config.js";
import { loadConfig } from "../src/configuration.js";
import { normalizeLeverage, resolveLeverage } from "../src/leverage.js";
import { TradingBot } from "../src/resilient-trading-bot.js";

test("CLI leverage accepts max or a positive integer", () => {
  assert.equal(loadConfig(["--leverage=5"]).leverage, 5);
  assert.equal(loadConfig(["--leverage", "MAX"]).leverage, "max");
  assert.equal(normalizeLeverage("12"), 12);
  assert.throws(() => loadConfig(["--leverage=0"]), /positive integer/);
  assert.throws(() => loadConfig(["--leverage=2.5"]), /positive integer/);
  assert.throws(() => loadConfig(["--leverage=fast"]), /positive integer/);
});

test("leverage resolves max and rejects values above the selected market cap", () => {
  assert.equal(resolveLeverage("max", 40), 40);
  assert.equal(resolveLeverage(5, 40), 5);
  assert.throws(() => resolveLeverage(41, 40), /exceeds the selected market maximum of 40x/);
});

test("live startup sends the configured isolated leverage to the Exchange client", async () => {
  const workspace = await mkdtemp(path.join(tmpdir(), "hl-leverage-test-"));
  let update;
  const bot = new TradingBot({
    config: { ...defaults, dryRun: false, leverage: 7 },
    info: {},
    exchange: {
      updateLeverage: async (request) => {
        update = request;
        throw new Error("stop after leverage update");
      },
    },
    credentials: { accountAddress: `0x${"1".repeat(40)}` },
    logger: { log() {}, warn() {}, error() {} },
    workspace,
  });
  bot.initializeMarket = async () => {
    bot.market = { assetId: 0, fullName: "BTC", maxLeverage: 40 };
    bot.grid = { maxPositionNotional: 100 };
    bot.discovery = { book: {}, midPrice: 100_000 };
  };

  await assert.rejects(() => bot.runLive(), /stop after leverage update/);
  assert.deepEqual(update, { asset: 0, isCross: false, leverage: 7 });
});
