import test from "node:test";
import assert from "node:assert/strict";
import defaults from "../config.js";
import { classifyLiquidationRisk, fillExposure, hasExitDepth, liquidationBufferRatio } from "../src/risk.js";

test("risk thresholds implement 60/40/20 and 80 percent resume", () => {
  assert.equal(classifyLiquidationRisk(0.9, defaults), "safe");
  assert.equal(classifyLiquidationRisk(0.7, defaults), "guarded");
  assert.equal(classifyLiquidationRisk(0.6, defaults), "warning");
  assert.equal(classifyLiquidationRisk(0.4, defaults), "reduce");
  assert.equal(classifyLiquidationRisk(0.2, defaults), "emergency");
  assert.equal(liquidationBufferRatio(0.005, 0.01), 0.5);
});

test("fill exposure separates opening, reducing, and flipping quantities", () => {
  assert.deepEqual(fillExposure("1", "buy", "0.5"), { start: 1, end: 1.5, opened: 0.5, reduced: 0, flipped: false });
  assert.deepEqual(fillExposure("1", "sell", "0.5"), { start: 1, end: 0.5, opened: 0, reduced: 0.5, flipped: false });
  assert.deepEqual(fillExposure("1", "sell", "2"), { start: 1, end: -1, opened: 1, reduced: 1, flipped: true });
});

test("depth guard requires both exits within the configured slippage", () => {
  const book = { levels: [
    [{ px: "100", sz: "5" }, { px: "98", sz: "100" }],
    [{ px: "101", sz: "5" }, { px: "103", sz: "100" }],
  ] };
  assert.equal(hasExitDepth(book, 100.5, 400, 100).sufficient, true);
  assert.equal(hasExitDepth(book, 100.5, 600, 100).sufficient, false);
});
