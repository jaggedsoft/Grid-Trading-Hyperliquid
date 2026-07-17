import Decimal from "decimal.js";
import { generateGrid } from "./grid.js";
import { formatSizeForNotional } from "./precision.js";

function pyramidSide(orders, multiplier, config, market) {
  if (!config.pyramid) return orders;
  const requestedStart = new Decimal(config.minOrderNotional).mul(multiplier);
  const start = Decimal.max(config.minOrderNotional, requestedStart);
  const cap = Decimal.max(config.minOrderNotional, new Decimal(config.maxOrderNotional).mul(multiplier));
  return orders.map((order, index) => {
    const requested = requestedStart.mul(new Decimal(2).pow(index));
    const target = Decimal.min(cap, Decimal.max(config.minOrderNotional, start.mul(new Decimal(2).pow(index))));
    const sized = formatSizeForNotional(target.toNumber(), order.price, market.szDecimals, config.minOrderNotional);
    return {
      ...order,
      targetNotional: target.toNumber(),
      requestedNotional: requested.toNumber(),
      size: sized.size,
      actualNotional: sized.actualNotional,
      adjustedToMinimum: requested.lessThan(config.minOrderNotional),
      sizingStrategy: "pyramid",
    };
  });
}

export function generateStrategyGrid({ market, midPrice, config, weeklySigma = null }) {
  const base = generateGrid({ market, midPrice, config, weeklySigma });
  const referenceBuys = pyramidSide(base.buys, config.buyMult, config, market);
  const referenceSells = pyramidSide(base.sells, config.sellMult, config, market);
  const buys = config.buyEntries ? referenceBuys : [];
  const sells = config.sellEntries ? referenceSells : [];
  const buyNotional = buys.reduce((sum, order) => sum + order.actualNotional, 0);
  const sellNotional = sells.reduce((sum, order) => sum + order.actualNotional, 0);
  return {
    ...base,
    buys,
    sells,
    referenceBuys,
    referenceSells,
    orders: [...sells, ...buys],
    buyNotional,
    sellNotional,
    maxPositionNotional: Math.max(buyNotional, sellNotional),
    strategy: config.pyramid ? "pyramid" : "linear",
    entrySides: config.buyEntries && config.sellEntries ? "both" : config.buyEntries ? "long" : "short",
  };
}

export function strategyIntervalAtCenter(grid, side) {
  const active = side === "buy" ? grid.buys : grid.sells;
  const reference = side === "buy" ? grid.referenceBuys : grid.referenceSells;
  const orders = active.length ? active : reference;
  if (!orders?.length) throw new Error(`No ${side} grid reference levels`);
  return Math.abs(Number(grid.anchorMid) - Number(orders[0].price));
}

export function activeCenterInterval(grid) {
  const intervals = [];
  if (grid.buys.length) intervals.push(strategyIntervalAtCenter(grid, "buy"));
  if (grid.sells.length) intervals.push(strategyIntervalAtCenter(grid, "sell"));
  if (!intervals.length) throw new Error("At least one entry side must be enabled");
  return Math.min(...intervals);
}
