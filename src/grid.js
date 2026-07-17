import Decimal from "decimal.js";
import { formatPrice, formatSizeForNotional } from "./precision.js";

function linearNotional(level, count, minimum, maximum, multiplier) {
  const ratio = count === 1 ? 1 : (level - 1) / (count - 1);
  return new Decimal(minimum).plus(new Decimal(maximum).minus(minimum).mul(ratio)).mul(multiplier).toNumber();
}

function rawLevelPrice(mid, side, level, count, config, weeklySigma) {
  const progress = new Decimal(level).div(count);
  if (config.gridMode === "fixed") {
    const distance = new Decimal(config.fromMidPrice).div(100).mul(progress);
    return side === "buy" ? mid.mul(new Decimal(1).minus(distance)) : mid.mul(new Decimal(1).plus(distance));
  }
  if (!(weeklySigma > 0)) throw new Error("weeklySigma must be positive in volatility mode");
  const logDistance = weeklySigma * progress.toNumber();
  return side === "buy" ? mid.mul(Math.exp(-logDistance)) : mid.mul(Math.exp(logDistance));
}

function createSide(side, count, multiplier, midPrice, market, config, weeklySigma) {
  const mid = new Decimal(midPrice);
  const orders = [];
  let previousPrice = formatPrice(mid, market.szDecimals, side);
  for (let level = 1; level <= count; level += 1) {
    const rawPrice = rawLevelPrice(mid, side, level, count, config, weeklySigma);
    const price = formatPrice(rawPrice, market.szDecimals, side);
    const targetBeforeFloor = linearNotional(level, count, config.minOrderNotional, config.maxOrderNotional, multiplier);
    const targetNotional = Math.max(config.minOrderNotional, targetBeforeFloor);
    const sized = formatSizeForNotional(targetNotional, price, market.szDecimals, config.minOrderNotional);
    orders.push({
      key: `${side}-${level}`,
      side,
      level,
      price,
      size: sized.size,
      targetNotional,
      requestedNotional: targetBeforeFloor,
      actualNotional: sized.actualNotional,
      adjustedToMinimum: targetBeforeFloor < config.minOrderNotional,
      reduceOnly: false,
      kind: "entry",
      pairedPrice: previousPrice,
    });
    previousPrice = price;
  }
  const uniquePrices = new Set(orders.map((order) => order.price));
  if (uniquePrices.size !== orders.length) throw new Error(`${side} grid contains duplicate prices after precision rounding; reduce grid count or widen the range`);
  return orders;
}

export function generateGrid({ market, midPrice, config, weeklySigma = null }) {
  if (!(Number(midPrice) > 0)) throw new Error("midPrice must be positive");
  const buys = createSide("buy", config.buyGrids, config.buyMult, midPrice, market, config, weeklySigma);
  const sells = createSide("sell", config.sellGrids, config.sellMult, midPrice, market, config, weeklySigma);
  return {
    anchorMid: String(midPrice),
    weeklySigma,
    buys,
    sells,
    orders: [...sells, ...buys],
    buyNotional: buys.reduce((sum, order) => sum + order.actualNotional, 0),
    sellNotional: sells.reduce((sum, order) => sum + order.actualNotional, 0),
    maxPositionNotional: Math.max(
      buys.reduce((sum, order) => sum + order.actualNotional, 0),
      sells.reduce((sum, order) => sum + order.actualNotional, 0),
    ),
  };
}

export function intervalAtCenter(grid, side) {
  const orders = side === "buy" ? grid.buys : grid.sells;
  if (!orders.length) throw new Error(`No ${side} grid orders`);
  return Math.abs(Number(grid.anchorMid) - Number(orders[0].price));
}
