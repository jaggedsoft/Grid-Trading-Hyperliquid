import test from "node:test";
import assert from "node:assert/strict";
import { extractStrategyFlags, loadConfig } from "../src/strategy-configuration.js";

test("long and short aliases select entry sides", () => {
  const long = loadConfig(["--buy"]);
  assert.equal(long.long, true);
  assert.equal(long.buyEntries, true);
  assert.equal(long.sellEntries, false);

  const short = loadConfig(["--sell"]);
  assert.equal(short.short, true);
  assert.equal(short.buyEntries, false);
  assert.equal(short.sellEntries, true);
});

test("no side flag keeps both sides and explicit long plus short restores both", () => {
  const defaults = loadConfig([]);
  assert.equal(defaults.buyEntries, true);
  assert.equal(defaults.sellEntries, true);
  const both = loadConfig(["--long", "--short"]);
  assert.equal(both.buyEntries, true);
  assert.equal(both.sellEntries, true);
});

test("pyramid and strategy aliases do not swallow normal buy/sell settings", () => {
  const parsed = extractStrategyFlags(["--pyramid", "--buy-grids=8", "--short=false", "--sell-mult=2"]);
  assert.deepEqual(parsed.strategy, { long: false, short: false, pyramid: true });
  assert.deepEqual(parsed.remaining, ["--buy-grids=8", "--sell-mult=2"]);
  const config = loadConfig(["--pyramid", "--buy-grids=8", "--sell-mult=2"]);
  assert.equal(config.pyramid, true);
  assert.equal(config.buyGrids, 8);
  assert.equal(config.sellMult, 2);
});
