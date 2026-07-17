import { accountSnapshot } from "./hyperliquid-client.js";
import { intervalAtCenter } from "./grid.js";
import { printGrid } from "./output.js";
import {
  classifyLiquidationRisk,
  hasExitDepth,
  isExposureIncreasing,
  liquidationBufferRatio,
  liquidationDistance,
} from "./risk.js";
import { saveState } from "./state.js";
import { confirmOrdersWithTimeout } from "./timed-prompt.js";
import { TradingBot as BaseTradingBot } from "./trading-bot.js";

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

export class TradingBot extends BaseTradingBot {
  async previewRoutineOrders(orders, reason) {
    this.logger.log(`\n${reason} order preview (${orders.length} orders):`);
    for (const order of orders) {
      const notional = Number(order.actualNotional ?? Number(order.price) * Number(order.size)).toFixed(2);
      this.logger.log(`  ${order.side.toUpperCase()} ${order.price} ${order.size} (${notional} USDC)${order.reduceOnly ? " reduce-only" : ""}`);
    }
    if (!this.config.preview) return true;
    return confirmOrdersWithTimeout(this.config.previewMaxAgeSeconds * 1000);
  }

  async rebuildGrid(reason) {
    this.state.generation += 1;
    for (let attempts = 1; attempts <= 5; attempts += 1) {
      const previewStarted = Date.now();
      const before = await accountSnapshot(this.info, this.credentials, this.market);
      const beforePosition = positionFromSnapshot(before, this.market.fullName);
      const { loaded, grid } = await this.freshMarketAndGrid();
      this.grid = grid;
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
      const interval = Math.min(intervalAtCenter(grid, "buy"), intervalAtCenter(grid, "sell"));
      const stale = Date.now() - previewStarted > this.config.previewMaxAgeSeconds * 1000;
      const drifted = Math.abs(freshMid - loaded.midPrice) > interval * this.config.previewMaxMidDriftFraction;
      const positionChanged = !samePosition(beforePosition, positionFromSnapshot(after, this.market.fullName));
      if (this.config.preview && (stale || drifted || positionChanged)) {
        this.logger.warn(`Preview invalidated by ${stale ? "age" : drifted ? "midprice drift" : "a position change"}; existing orders remain in place while a new preview is generated.`);
        continue;
      }

      await this.cancelAllOwned(after.openOrders);
      const statuses = await this.submitAndRemember(decorated, { reason: `${reason} rebuild`, preview: false });
      if (!statuses) return false;
      this.state.anchorMid = grid.anchorMid;
      this.state.weeklySigma = grid.weeklySigma;
      this.state.phase = "ACTIVE";
      this.state.calmSince = null;
      this.state.nextRebuildAt = Date.now() + this.config.rebuildIntervalHours * 60 * 60 * 1000;
      this.maxPositionNotional = this.config.maxPositionNotional ?? grid.maxPositionNotional;
      await saveState(this.stateFile, this.state);
      return true;
    }
    throw new Error("Market or position kept changing while awaiting preview; existing bot orders were preserved");
  }

  async monitorRisk(position, openOrders, mid, book) {
    const paused = () => ["PAUSED_RISK", "PAUSED_VOLATILITY", "REDUCING_RISK"].includes(this.state.phase);
    if (!position || position.size === 0) {
      this.state.initialLiquidationDistance = null;
      if (this.state.phase === "GUARDED") this.state.phase = "ACTIVE";
      await saveState(this.stateFile, this.state);
      return;
    }
    const currentDistance = liquidationDistance(mid, position.liquidationPrice);
    if (this.state.initialLiquidationDistance === null && currentDistance !== null) this.state.initialLiquidationDistance = currentDistance;
    const ratio = liquidationBufferRatio(currentDistance, this.state.initialLiquidationDistance);
    const level = classifyLiquidationRisk(ratio, this.config);
    const notional = Math.abs(position.size * mid);
    if (notional >= this.maxPositionNotional || level === "warning") {
      await this.cancelExposureIncreasing(position.size, openOrders);
      if (!paused()) this.state.phase = "GUARDED";
    } else if (level === "safe" && this.state.phase === "GUARDED") {
      this.state.phase = "ACTIVE";
    }
    if ((level === "reduce" || level === "emergency") && !this.riskReductionRunning) {
      await this.reduceRisk(position, ratio, level === "emergency");
    }
    const depth = hasExitDepth(book, mid, Math.min(notional, this.maxPositionNotional), this.config.maxEmergencySlippageBps);
    if (!depth.sufficient) {
      await this.cancelExposureIncreasing(position.size, openOrders);
      if (!paused()) this.state.phase = "GUARDED";
      this.logger.error("Exit-depth guard failed while a position is open; exposure-increasing orders canceled.");
    }
    await saveState(this.stateFile, this.state);
  }
}
