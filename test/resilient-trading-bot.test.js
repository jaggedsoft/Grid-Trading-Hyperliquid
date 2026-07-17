import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import defaults from "../config.js";
import { TradingBot } from "../src/resilient-trading-bot.js";
import { initialState } from "../src/state.js";

test("ambiguous pending orders reconcile before a rebuild is retried", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "hl-grid-reconcile-test-"));
  const logger = { log() {}, warn() {}, error() {} };
  const bot = new TradingBot({ config: { ...defaults }, info: {}, logger, workspace: root });
  bot.market = { fullName: "BTC" };
  bot.state = initialState("mainnet", "BTC");
  bot.state.phase = "RECONCILING";
  const cloid = `0x${"1".repeat(32)}`;
  bot.state.orders[cloid] = { cloid, status: "pending" };
  bot.stateFile = path.join(root, "state.json");
  const snapshot = { clearinghouse: { assetPositions: [] }, openOrders: [] };
  const before = Date.now();
  await bot.reconcileState(snapshot);
  assert.equal(bot.state.orders[cloid].status, "closed");
  assert.equal(bot.state.phase, "ACTIVE");
  assert.ok(bot.state.nextRebuildAt >= before);
});
