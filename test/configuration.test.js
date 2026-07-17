import test from "node:test";
import assert from "node:assert/strict";
import defaults from "../config.js";
import { parseCliArgs, validateConfig, validateLiveEnvironment } from "../src/configuration.js";

test("CLI parser accepts kebab-case booleans and numbers", () => {
  assert.deepEqual(parseCliArgs(["--dry-run=false", "--buy-grids=8", "--grid-mode", "volatility"]), {
    dryRun: false,
    buyGrids: 8,
    gridMode: "volatility",
  });
});

test("config enforces Hyperliquid minimum and ordered safety thresholds", () => {
  assert.throws(() => validateConfig({ ...defaults, minOrderNotional: 6 }), /requires minOrderNotional >= 10/);
  assert.throws(() => validateConfig({ ...defaults, liquidationReduceRatio: 0.7 }), /Liquidation ratios/);
  assert.equal(validateConfig({ ...defaults }).market, "BTC");
});

test("live secrets are mandatory only through explicit validation", () => {
  assert.throws(() => validateLiveEnvironment({}), /HL_PRIVATE_KEY/);
  const valid = validateLiveEnvironment({
    HL_PRIVATE_KEY: `0x${"1".repeat(64)}`,
    HL_ACCOUNT_ADDRESS: `0x${"2".repeat(40)}`,
  });
  assert.equal(valid.accountAddress.length, 42);
});
