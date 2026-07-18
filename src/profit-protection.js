function finiteNonNegative(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

export function observedFillFeeRate(fill) {
  const notional = Math.abs(Number(fill?.px) * Number(fill?.sz));
  const fee = Number(fill?.fee);
  if (!(notional > 0) || !Number.isFinite(fee)) return null;
  return Math.max(0, fee / notional);
}

export function weightedFeeRate(currentRate, currentNotional, addedRate, addedNotional) {
  const oldNotional = finiteNonNegative(currentNotional);
  const newNotional = finiteNonNegative(addedNotional);
  if (!(newNotional > 0) || !Number.isFinite(Number(addedRate))) {
    return { rate: currentRate ?? null, notional: oldNotional };
  }
  const total = oldNotional + newNotional;
  const oldRate = finiteNonNegative(currentRate);
  const nextRate = finiteNonNegative(addedRate);
  return {
    rate: ((oldRate * oldNotional) + (nextRate * newNotional)) / total,
    notional: total,
  };
}

export function feeAwareBreakEven({
  entryPrice,
  direction,
  entryFeeRate,
  exitFeeRate,
  feeBufferBps = 0,
}) {
  const entry = Number(entryPrice);
  const entryRate = finiteNonNegative(entryFeeRate);
  const exitRate = finiteNonNegative(exitFeeRate);
  const bufferRate = finiteNonNegative(feeBufferBps) / 10_000;
  if (!(entry > 0)) throw new Error("entryPrice must be positive");
  if (direction === "long") {
    if (exitRate >= 1) throw new Error("exitFeeRate must be below 100%");
    return entry * (1 + entryRate + bufferRate) / (1 - exitRate);
  }
  if (direction === "short") {
    const retained = 1 - entryRate - bufferRate;
    if (!(retained > 0)) throw new Error("entry fees and fee buffer must be below 100%");
    return entry * retained / (1 + exitRate);
  }
  throw new Error("direction must be long or short");
}

export function isFeeProfitable(markPrice, direction, breakEvenPrice) {
  const mark = Number(markPrice);
  const breakEven = Number(breakEvenPrice);
  return direction === "long" ? mark > breakEven : mark < breakEven;
}

export function nextWatermark(previous, markPrice, direction) {
  const mark = Number(markPrice);
  if (!(mark > 0)) throw new Error("markPrice must be positive");
  if (!(Number(previous) > 0)) return mark;
  return direction === "long" ? Math.max(Number(previous), mark) : Math.min(Number(previous), mark);
}

export function trailingTriggerPrice(watermark, direction, distancePercent) {
  const price = Number(watermark);
  const distance = Number(distancePercent) / 100;
  if (!(price > 0)) throw new Error("watermark must be positive");
  if (!(distance > 0) || distance >= 1) throw new Error("trailing stop percent must be above 0 and below 100");
  return direction === "long" ? price * (1 - distance) : price * (1 + distance);
}

export function stopLimitWorstPrice(triggerPrice, direction, slippageBps) {
  const trigger = Number(triggerPrice);
  const slippage = finiteNonNegative(slippageBps) / 10_000;
  if (!(trigger > 0) || slippage >= 1) throw new Error("invalid protective stop price or slippage");
  return direction === "long" ? trigger * (1 - slippage) : trigger * (1 + slippage);
}

export function stopLocksFeeAdjustedProfit(triggerPrice, direction, breakEvenPrice, slippageBps) {
  const worst = stopLimitWorstPrice(triggerPrice, direction, slippageBps);
  return direction === "long" ? worst >= breakEvenPrice : worst <= breakEvenPrice;
}

export function shouldTightenStop(previousTrigger, nextTrigger, direction, minimumMoveBps = 0) {
  if (!(Number(previousTrigger) > 0)) return true;
  const threshold = finiteNonNegative(minimumMoveBps) / 10_000;
  if (direction === "long") return Number(nextTrigger) >= Number(previousTrigger) * (1 + threshold);
  return Number(nextTrigger) <= Number(previousTrigger) * (1 - threshold);
}
