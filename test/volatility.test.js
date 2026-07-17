import test from "node:test";
import assert from "node:assert/strict";
import { calculateWeeklyVolatility, closedCandles, sampleStandardDeviation } from "../src/volatility.js";

test("sample standard deviation uses n-1", () => {
  assert.equal(sampleStandardDeviation([1, 2, 3]), 1);
});

test("weekly volatility excludes the incomplete candle and scales 4h returns", () => {
  const interval = 4 * 60 * 60 * 1000;
  const now = 100 * interval;
  const candles = [];
  let close = 100;
  for (let index = 0; index < 43; index += 1) {
    close *= Math.exp(index % 2 === 0 ? 0.01 : -0.005);
    candles.push({ t: index * interval, T: (index + 1) * interval - 1, o: "100", c: String(close) });
  }
  candles.push({ t: now, T: now + interval, o: "100", c: "999" });
  const result = calculateWeeklyVolatility(candles, { now });
  assert.equal(result.returns, 42);
  assert.ok(result.intervalSigma > 0);
  assert.ok(Math.abs(result.weeklySigma - result.intervalSigma * Math.sqrt(42)) < 1e-12);
  assert.equal(closedCandles(candles, now).length, 43);
});

test("volatility calculation rejects inadequate history", () => {
  assert.throws(() => calculateWeeklyVolatility([{ t: 0, T: 1, c: "100" }], { now: 2 }), /Need at least/);
});
