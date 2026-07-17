import Decimal from "decimal.js";
import { generateGrid } from "./grid.js";
import { formatSizeForNotional } from "./precision.js";

function pyramidNotional(level, count, minimum, maximum, multiplier) {
  const progress = count === 1 ? new Decimal(0) : new Decimal(level - 1).div(count - 1);
  const requested = new Decimal(maximum)
    .minus(new Decimal(maximum).minus(minimum).mul(progress))
    .mul(multiplier);
  return {
    requested: requested.toNumber(),
    target: Decimal.max(minimum, requested).toNumber(),
  };
}

function pyramidSide(sourceOrders, side, multiplier, config, market) {
  return sourceOrders.map((source, index) => {
    const level = index + 1;
    const notional = pyramidNotional(
      level,
      sourceOrders.length,
      config.minOrderNotional,
      config.maxOrderNotional,
      multiplier,
    );
    const sized = formatSizeForNotional(
      notional.target,
      source.price,
      market.szDecimals,
      config.minOrderNotional,
    );
    return {
      key: `pyramid-${side}-${level}`,
      side,
      level,
      price: source.price,
      triggerPx: source.price,
      size: sized.size,
      targetNotional: notional.target,
      requestedNotional: notional.requested,
      actualNotional: sized.actualNotional,
      adjustedToMinimum: notional.requested < config.minOrderNotional,
      reduceOnly: false,
      kind: "pyramid-entry",
      pairedPrice: null,
      orderType: "trigger",
      trigger: { isMarket: false, tpsl: "sl" },
      sizingStrategy: "pyramid",
      trendDirection: side === "buy" ? "up" : "down",
    };
  });
}

export function generateStrategyGrid({ market, midPrice, config, weeklySigma = null }) {
  const base = generateGrid({ market, midPrice, config, weeklySigma });
  const pyramidPrices = config.pyramid
    ? generateGrid({
        market,
        midPrice,
        config: {
          ...config,
          buyGrids: config.sellGrids,
          sellGrids: config.buyGrids,
        },
        weeklySigma,
      })
    : null;
  const candidateBuys = config.pyramid
    ? pyramidSide(pyramidPrices.sells, "buy", config.buyMult, config, market)
    : base.buys;
  const candidateSells = config.pyramid
    ? pyramidSide(pyramidPrices.buys, "sell", config.sellMult, config, market)
    : base.sells;
  const buys = config.buyEntries ? candidateBuys : [];
  const sells = config.sellEntries ? candidateSells : [];
  const buyNotional = buys.reduce((sum, order) => sum + order.actualNotional, 0);
  const sellNotional = sells.reduce((sum, order) => sum + order.actualNotional, 0);
  return {
    ...base,
    buys,
    sells,
    referenceBuys: base.buys,
    referenceSells: base.sells,
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
