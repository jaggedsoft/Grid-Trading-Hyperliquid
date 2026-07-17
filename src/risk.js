export function liquidationDistance(markPrice, liquidationPrice) {
  const mark = Number(markPrice);
  const liquidation = Number(liquidationPrice);
  if (!(mark > 0) || !(liquidation > 0)) return null;
  return Math.abs(mark - liquidation) / mark;
}

export function liquidationBufferRatio(currentDistance, initialDistance) {
  if (!(initialDistance > 0) || currentDistance === null) return null;
  return currentDistance / initialDistance;
}

export function classifyLiquidationRisk(ratio, config) {
  if (ratio === null) return "unknown";
  if (ratio <= config.liquidationEmergencyRatio) return "emergency";
  if (ratio <= config.liquidationReduceRatio) return "reduce";
  if (ratio <= config.liquidationWarningRatio) return "warning";
  if (ratio >= config.liquidationResumeRatio) return "safe";
  return "guarded";
}

export function fillExposure(startPosition, side, fillSize) {
  const start = Number(startPosition);
  const signedFill = side === "buy" ? Number(fillSize) : -Number(fillSize);
  const end = start + signedFill;
  const sameDirection = start === 0 || Math.sign(start) === Math.sign(signedFill);
  const opened = sameDirection ? Math.abs(signedFill) : Math.max(0, Math.abs(signedFill) - Math.abs(start));
  const reduced = sameDirection ? 0 : Math.min(Math.abs(start), Math.abs(signedFill));
  return { start, end, opened, reduced, flipped: start !== 0 && end !== 0 && Math.sign(start) !== Math.sign(end) };
}

export function isExposureIncreasing(orderSide, positionSize) {
  if (positionSize > 0) return orderSide === "buy";
  if (positionSize < 0) return orderSide === "sell";
  return true;
}

export function bookDepthWithinSlippage(book, midPrice, slippageBps) {
  if (!book?.levels?.[0] || !book?.levels?.[1]) return { sellCapacity: 0, buyCapacity: 0 };
  const mid = Number(midPrice);
  const fraction = slippageBps / 10_000;
  const minBid = mid * (1 - fraction);
  const maxAsk = mid * (1 + fraction);
  const sellCapacity = book.levels[0]
    .filter((level) => Number(level.px) >= minBid)
    .reduce((sum, level) => sum + Number(level.px) * Number(level.sz), 0);
  const buyCapacity = book.levels[1]
    .filter((level) => Number(level.px) <= maxAsk)
    .reduce((sum, level) => sum + Number(level.px) * Number(level.sz), 0);
  return { sellCapacity, buyCapacity };
}

export function hasExitDepth(book, midPrice, requiredNotional, slippageBps) {
  const depth = bookDepthWithinSlippage(book, midPrice, slippageBps);
  return { ...depth, sufficient: depth.sellCapacity >= requiredNotional && depth.buyCapacity >= requiredNotional };
}

export function extractPosition(clearinghouse, coin) {
  const assetPosition = clearinghouse?.assetPositions?.find((item) => item.position?.coin === coin);
  if (!assetPosition) return null;
  const position = assetPosition.position;
  return {
    coin: position.coin,
    size: Number(position.szi),
    entryPrice: Number(position.entryPx),
    liquidationPrice: position.liquidationPx ? Number(position.liquidationPx) : null,
    positionValue: Number(position.positionValue),
    leverage: position.leverage,
  };
}
