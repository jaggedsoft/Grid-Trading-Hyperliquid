const INTERVAL_MS = { "4h": 4 * 60 * 60 * 1000 };

export function sampleStandardDeviation(values) {
  if (values.length < 2) throw new Error("At least two observations are required");
  const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
  const variance = values.reduce((sum, value) => sum + ((value - mean) ** 2), 0) / (values.length - 1);
  return Math.sqrt(variance);
}

export function closedCandles(candles, now = Date.now()) {
  return [...candles]
    .filter((candle) => Number(candle.T) < now && Number(candle.c) > 0)
    .sort((a, b) => Number(a.t) - Number(b.t));
}

export function calculateWeeklyVolatility(candles, { interval = "4h", now = Date.now(), minimumReturns = 10 } = {}) {
  if (!(interval in INTERVAL_MS)) throw new Error(`Unsupported volatility interval: ${interval}`);
  const complete = closedCandles(candles, now);
  const returns = [];
  for (let index = 1; index < complete.length; index += 1) {
    returns.push(Math.log(Number(complete[index].c) / Number(complete[index - 1].c)));
  }
  if (returns.length < minimumReturns) throw new Error(`Need at least ${minimumReturns + 1} closed ${interval} candles; received ${complete.length}`);
  const intervalSigma = sampleStandardDeviation(returns);
  const intervalsPerWeek = (7 * 24 * 60 * 60 * 1000) / INTERVAL_MS[interval];
  return {
    intervalSigma,
    weeklySigma: intervalSigma * Math.sqrt(intervalsPerWeek),
    returns: returns.length,
    currentCandle: [...candles].sort((a, b) => Number(b.t) - Number(a.t))[0] ?? null,
  };
}

export function currentCandleLogMove(candle, midPrice) {
  if (!candle || !(Number(candle.o) > 0) || !(Number(midPrice) > 0)) return 0;
  return Math.log(Number(midPrice) / Number(candle.o));
}

export function adverseMove(logMove, positionSize = 0) {
  if (positionSize > 0) return Math.max(0, -logMove);
  if (positionSize < 0) return Math.max(0, logMove);
  return Math.abs(logMove);
}
