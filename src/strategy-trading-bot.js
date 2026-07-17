import { accountSnapshot } from "./hyperliquid-client.js";
import { printGrid } from "./output.js";
import { formatExistingSize, formatPrice } from "./precision.js";
import { saveState } from "./state.js";
import { activeCenterInterval, generateStrategyGrid, strategyIntervalAtCenter } from "./strategy-grid.js";
import { TradingBot as ResilientTradingBot } from "./resilient-trading-bot.js";

function samePosition(left, right) {
  if (!left && !right) return true;
  if (!left || !right) return false;
  return left.size === right.size && left.entryPrice === right.entryPrice;
}

function positionFromSnapshot(snapshot, coin) {
  const item = snapshot.clearinghouse?.assetPositions?.find((entry) => entry.position?.coin === coin);
  if (!item) return null;
  return {
    size: Number(item.position.szi),
    entryPrice: Number(item.position.entryPx),
    liquidationPrice: item.position.liquidationPx ? Number(item.position.liquidationPx) : null,
  };
}

export class TradingBot extends ResilientTradingBot {
  strategySignature() {
    return JSON.stringify({
      buyEntries: this.config.buyEntries,
      sellEntries: this.config.sellEntries,
      pyramid: this.config.pyramid,
    });
  }

  strategyLabel(grid = this.grid) {
    return `${grid.entrySides} entries, ${grid.strategy} sizing${this.config.pyramid ? ` (doubling capped at ${this.config.maxOrderNotional} before side multiplier)` : ""}`;
  }

  async initializeMarket() {
    const loaded = await super.initializeMarket();
    this.grid = generateStrategyGrid({
      market: this.market,
      midPrice: loaded.midPrice,
      config: this.config,
      weeklySigma: this.config.gridMode === "volatility" ? this.volatility.weeklySigma : null,
    });
    return loaded;
  }

  async freshMarketAndGrid() {
    const { loaded } = await super.freshMarketAndGrid();
    const grid = generateStrategyGrid({
      market: this.market,
      midPrice: loaded.midPrice,
      config: this.config,
      weeklySigma: this.config.gridMode === "volatility" ? this.volatility.weeklySigma : null,
    });
    return { loaded, grid };
  }

  async runDryRun() {
    await this.initializeMarket();
    this.logger.log(`Entry strategy: ${this.strategyLabel()}`);
    printGrid(this.market, this.grid, this.config, this.logger);
    return { market: this.market, grid: this.grid };
  }

  reanchoredExit(position, grid) {
    if (!position || position.size === 0) return null;
    const side = position.size > 0 ? "sell" : "buy";
    const sideOrders = side === "sell" ? grid.referenceSells : grid.referenceBuys;
    const centerInterval = strategyIntervalAtCenter(grid, side);
    const threshold = position.size > 0 ? position.entryPrice + centerInterval : position.entryPrice - centerInterval;
    const candidate = position.size > 0
      ? sideOrders.find((order) => Number(order.price) >= threshold)
      : sideOrders.find((order) => Number(order.price) <= threshold);
    const price = formatPrice(candidate?.price ?? threshold, this.market.szDecimals, side);
    const size = formatExistingSize(Math.abs(position.size), this.market.szDecimals);
    if (!(Number(size) > 0) || Number(size) * Number(price) < this.config.minOrderNotional) {
      this.logger.warn("Existing position is below the resting-order minimum; the risk monitor remains active.");
      return null;
    }
    return {
      key: `reanchor-exit-${side}`,
      side,
      level: 0,
      price,
      size,
      actualNotional: Number(price) * Number(size),
      reduceOnly: true,
      kind: "exit",
      pairedPrice: null,
      origin: null,
    };
  }

  async rebuildGrid(reason) {
    this.state.generation += 1;
    for (let attempts = 1; attempts <= 5; attempts += 1) {
      const previewStarted = Date.now();
      const before = await accountSnapshot(this.info, this.credentials, this.market);
      const beforePosition = positionFromSnapshot(before, this.market.fullName);
      const { loaded, grid } = await this.freshMarketAndGrid();
      this.grid = grid;
      this.logger.log(`Entry strategy: ${this.strategyLabel(grid)}`);
      printGrid(this.market, grid, { ...this.config, dryRun: false }, this.logger);
      const exit = this.reanchoredExit(beforePosition, grid);
      let routine = [...grid.orders];
      if (exit) routine = routine.filter((order) => !(order.side === exit.side && order.price === exit.price));
      const decorated = this.decorateOrders(exit ? [exit, ...routine] : routine);
      if (!(await this.previewRoutineOrders(decorated, `${reason} rebuild`))) return false;

      const [freshBook, after] = await Promise.all([
        this.info.l2Book({ coin: this.market.fullName }),
        accountSnapshot(this.info, this.credentials, this.market),
      ]);
      const bid = Number(freshBook?.levels?.[0]?.[0]?.px);
      const ask = Number(freshBook?.levels?.[1]?.[0]?.px);
      if (!(bid > 0) || !(ask > 0)) throw new Error("Cannot validate preview against a fresh two-sided book");
      const freshMid = (bid + ask) / 2;
      const interval = activeCenterInterval(grid);
      const stale = Date.now() - previewStarted > this.config.previewMaxAgeSeconds * 1000;
      const drifted = Math.abs(freshMid - loaded.midPrice) > interval * this.config.previewMaxMidDriftFraction;
      const positionChanged = !samePosition(beforePosition, positionFromSnapshot(after, this.market.fullName));
      if (this.config.preview && (stale || drifted || positionChanged)) {
        this.logger.warn(`Preview invalidated by ${stale ? "age" : drifted ? "midprice drift" : "a position change"}; existing orders remain in place.`);
        continue;
      }

      await this.cancelAllOwned(after.openOrders);
      const statuses = await this.submitAndRemember(decorated, { reason: `${reason} rebuild`, preview: false });
      if (!statuses) return false;
      this.state.anchorMid = grid.anchorMid;
      this.state.weeklySigma = grid.weeklySigma;
      this.state.strategySignature = this.strategySignature();
      this.state.phase = "ACTIVE";
      this.state.calmSince = null;
      this.state.nextRebuildAt = Date.now() + this.config.rebuildIntervalHours * 60 * 60 * 1000;
      this.maxPositionNotional = this.config.maxPositionNotional ?? grid.maxPositionNotional;
      await saveState(this.stateFile, this.state);
      return true;
    }
    throw new Error("Market or position kept changing while awaiting preview; existing bot orders were preserved");
  }

  async reconcileState(snapshot = null) {
    const current = await super.reconcileState(snapshot);
    const signature = this.strategySignature();
    if (this.state.strategySignature !== signature) {
      this.state.strategySignature = signature;
      this.state.nextRebuildAt = Date.now();
      this.logger.warn("Strategy flags changed; a fresh grid rebuild is required.");
      await saveState(this.stateFile, this.state);
    }
    return current;
  }
}
