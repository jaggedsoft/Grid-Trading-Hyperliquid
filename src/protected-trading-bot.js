import { accountSnapshot, sdkOrder } from "./hyperliquid-client.js";
import { formatExistingSize, formatPrice } from "./precision.js";
import {
  feeAwareBreakEven,
  isFeeProfitable,
  nextWatermark,
  observedFillFeeRate,
  shouldTightenStop,
  stopLimitWorstPrice,
  stopLocksFeeAdjustedProfit,
  trailingTriggerPrice,
  weightedFeeRate,
} from "./profit-protection.js";
import { extractPosition, fillExposure } from "./risk.js";
import { saveState } from "./state.js";
import { TradingBot as StrategyTradingBot } from "./strategy-trading-bot.js";

const ACTIVE_ORDER_STATUSES = new Set(["open", "pending", "submitted"]);

function blankProtection(direction = null, watermark = null) {
  return {
    direction,
    watermark,
    entryFeeRate: null,
    entryFeeNotional: 0,
    breakEvenPrice: null,
    deriskDone: false,
    deriskOrderCloid: null,
    deriskBelowMinimumWarned: false,
    trailingStopCloid: null,
    trailingStopTrigger: null,
    trailingStopLimit: null,
    trailingActivatedAt: null,
  };
}

function fillId(fill) {
  return `${fill.hash}:${fill.tid}:${fill.oid}:${fill.time}`;
}

function sideFromFill(fill) {
  return fill.side === "B" ? "buy" : "sell";
}

function responseFilled(status) {
  return status && typeof status === "object" && "filled" in status;
}

export class TradingBot extends StrategyTradingBot {
  protectionLabel() {
    const trailing = this.config.trailingStopPercent > 0
      ? `${this.config.trailingStopPercent}% client-managed trail`
      : "trailing disabled";
    const derisk = this.config.deriskPercent > 0
      ? `${this.config.deriskPercent}% one-time derisk`
      : "derisk disabled";
    return `${trailing}; ${derisk}; fee buffer ${this.config.profitFeeBufferBps} bps`;
  }

  async runDryRun() {
    const result = await super.runDryRun();
    this.logger.log(`Profit protection: ${this.protectionLabel()}`);
    this.logger.log("Trailing activation waits until its worst permitted stop-limit fill is beyond fee-adjusted breakeven.");
    return result;
  }

  async runLive() {
    await this.refreshTakerFeeRate(true);
    this.logger.warn(`Automatic profit protection: ${this.protectionLabel()}.`);
    this.logger.warn("Authorized trailing-stop maintenance and profitable derisk reductions bypass interactive preview.");
    return super.runLive();
  }

  ensureProtectionState() {
    this.state.profitProtection ??= blankProtection();
    return this.state.profitProtection;
  }

  async refreshTakerFeeRate(force = false) {
    const fallback = this.config.feeFallbackTakerBps / 10_000;
    if (!this.credentials || typeof this.info?.userFees !== "function") {
      this.takerFeeRate = fallback;
      return fallback;
    }
    if (!force && this.feeRateFetchedAt && Date.now() - this.feeRateFetchedAt < 60 * 60_000) {
      return this.takerFeeRate;
    }
    try {
      const fees = await this.info.userFees({ user: this.credentials.accountAddress });
      const accountRate = Number(fees.userCrossRate);
      this.takerFeeRate = Number.isFinite(accountRate) && accountRate >= 0
        ? Math.max(accountRate, fallback)
        : fallback;
      this.feeRateFetchedAt = Date.now();
      this.feeRateWarningIssued = false;
    } catch (error) {
      this.takerFeeRate = fallback;
      if (!this.feeRateWarningIssued) {
        this.logger.warn(`Could not refresh account fee rate; using ${this.config.feeFallbackTakerBps} bps fallback: ${error.message}`);
        this.feeRateWarningIssued = true;
      }
    }
    return this.takerFeeRate;
  }

  async processFill(fill) {
    const duplicate = this.state?.lastProcessedFillIds?.includes(fillId(fill));
    const record = fill.cloid ? this.state?.orders?.[fill.cloid] : null;
    const side = sideFromFill(fill);
    const exposure = fillExposure(fill.startPosition, side, fill.sz);
    await super.processFill(fill);
    if (duplicate || !record) return;

    let protection = this.ensureProtectionState();
    if (record.kind === "derisk" && exposure.reduced > 0) {
      protection.deriskDone = true;
      protection.deriskOrderCloid = null;
      this.logger.log(`Fee-aware derisk filled; ${this.config.deriskPercent}% reduction target is complete for this position.`);
    }
    if (record.kind === "trailing-stop" && exposure.reduced > 0) {
      protection.trailingStopCloid = null;
      protection.trailingStopTrigger = null;
      protection.trailingStopLimit = null;
    }

    if (exposure.opened > 0) {
      const direction = exposure.end > 0 ? "long" : "short";
      if (exposure.start === 0 || exposure.flipped || protection.direction !== direction) {
        this.state.profitProtection = blankProtection(direction, Number(fill.px));
        protection = this.state.profitProtection;
      }
      protection.direction = direction;
      protection.watermark = nextWatermark(protection.watermark, fill.px, direction);
      const feeRate = observedFillFeeRate(fill);
      const openedNotional = exposure.opened * Number(fill.px);
      const weighted = weightedFeeRate(
        protection.entryFeeRate,
        protection.entryFeeNotional,
        feeRate,
        openedNotional,
      );
      protection.entryFeeRate = weighted.rate;
      protection.entryFeeNotional = weighted.notional;
      this.logger.log(`Profit tracking armed for ${direction} exposure from ${fill.px}; awaiting fee-adjusted profitable territory.`);
    }

    if (exposure.end === 0) this.state.profitProtection = blankProtection();
    await saveState(this.stateFile, this.state);
  }

  async monitorTick() {
    if (this.shuttingDown) return;
    const snapshot = await this.reconcileState();
    await this.pollRecentFills();
    const position = extractPosition(snapshot.clearinghouse, this.market.fullName);
    const book = await this.info.l2Book({ coin: this.market.fullName });
    const mid = (Number(book.levels[0][0].px) + Number(book.levels[1][0].px)) / 2;
    await this.monitorRisk(position, snapshot.openOrders, mid, book);
    await this.monitorVolatility(position, mid, snapshot.openOrders);
    await this.monitorProfitProtection(position, mid);
    if (this.state.phase === "ACTIVE" && Date.now() >= this.state.nextRebuildAt) await this.rebuildGrid("24-hour");
  }

  async cancelTrackedTrailingStop(protection) {
    const cloid = protection.trailingStopCloid;
    const record = cloid ? this.state.orders[cloid] : null;
    if (record && ACTIVE_ORDER_STATUSES.has(record.status)) await this.cancelRecords([record]);
    protection.trailingStopCloid = null;
    protection.trailingStopTrigger = null;
    protection.trailingStopLimit = null;
    protection.trailingActivatedAt = null;
  }

  async monitorProfitProtection(position, mid) {
    let protection = this.ensureProtectionState();
    if (!position || position.size === 0) {
      if (protection.trailingStopCloid) await this.cancelTrackedTrailingStop(protection);
      if (protection.direction) this.state.profitProtection = blankProtection();
      await saveState(this.stateFile, this.state);
      return;
    }

    const direction = position.size > 0 ? "long" : "short";
    if (protection.direction && protection.direction !== direction) {
      await this.cancelTrackedTrailingStop(protection);
      this.state.profitProtection = blankProtection(direction, mid);
      protection = this.state.profitProtection;
    } else if (!protection.direction) {
      this.state.profitProtection = blankProtection(direction, mid);
      protection = this.state.profitProtection;
    }
    protection.watermark = nextWatermark(protection.watermark, mid, direction);

    const takerRate = await this.refreshTakerFeeRate();
    const fallback = this.config.feeFallbackTakerBps / 10_000;
    const entryRate = protection.entryFeeRate ?? Math.max(takerRate, fallback);
    const exitRate = Math.max(takerRate, fallback, protection.entryFeeRate ?? 0);
    const breakEven = feeAwareBreakEven({
      entryPrice: position.entryPrice,
      direction,
      entryFeeRate: entryRate,
      exitFeeRate: exitRate,
      feeBufferBps: this.config.profitFeeBufferBps,
    });
    protection.breakEvenPrice = breakEven;
    this.refreshDeriskTracking(protection);

    if (["RECONCILING", "REDUCING_RISK"].includes(this.state.phase)) {
      await saveState(this.stateFile, this.state);
      return;
    }

    if (
      this.config.deriskPercent > 0
      && !protection.deriskDone
      && !protection.deriskOrderCloid
      && isFeeProfitable(mid, direction, breakEven)
    ) {
      const submitted = await this.submitProfitableDerisk(position, direction, breakEven, protection);
      await saveState(this.stateFile, this.state);
      if (submitted) return;
    }

    if (this.config.trailingStopPercent > 0) {
      await this.maintainTrailingStop(position, mid, direction, breakEven, protection);
    }
    await saveState(this.stateFile, this.state);
  }

  refreshDeriskTracking(protection) {
    if (!protection.deriskOrderCloid) return;
    const record = this.state.orders[protection.deriskOrderCloid];
    if (Number(record?.filledSize) > 0) {
      protection.deriskDone = true;
      protection.deriskOrderCloid = null;
    } else if (!record || ["closed", "canceled", "rejected"].includes(record.status)) {
      protection.deriskOrderCloid = null;
    }
  }

  async submitProfitableDerisk(position, direction, breakEven, protection) {
    const rawSize = Math.abs(position.size) * this.config.deriskPercent / 100;
    const size = formatExistingSize(rawSize, this.market.szDecimals, "down");
    const side = direction === "long" ? "sell" : "buy";
    const price = formatPrice(breakEven, this.market.szDecimals, side);
    if (!(Number(size) > 0) || Number(size) * Number(price) < this.config.minOrderNotional) {
      if (!protection.deriskBelowMinimumWarned) {
        this.logger.warn(`Configured ${this.config.deriskPercent}% derisk is below Hyperliquid's minimum lot/notional for this position; it will be retried if position value grows.`);
        protection.deriskBelowMinimumWarned = true;
      }
      return false;
    }

    this.state.generation += 1;
    const [order] = this.decorateOrders([{
      key: `derisk-${Date.now()}`,
      side,
      price,
      size,
      actualNotional: Number(price) * Number(size),
      reduceOnly: true,
      kind: "derisk",
      pairedPrice: null,
    }]);
    protection.deriskOrderCloid = order.cloid;
    await saveState(this.stateFile, this.state);
    this.logger.warn(`Automatic profitable derisk (preview bypass): ${side.toUpperCase()} ${size} @ fee-adjusted limit ${price}.`);
    const statuses = await this.submitAndRemember([order], { reason: "profitable derisk", tif: "Ioc", preview: false });
    if (responseFilled(statuses?.[0])) {
      protection.deriskDone = true;
      protection.deriskOrderCloid = null;
    } else {
      protection.deriskOrderCloid = null;
    }
    return true;
  }

  async maintainTrailingStop(position, mid, direction, breakEven, protection) {
    let record = protection.trailingStopCloid ? this.state.orders[protection.trailingStopCloid] : null;
    if (record && !ACTIVE_ORDER_STATUSES.has(record.status)) {
      protection.trailingStopCloid = null;
      record = null;
    }
    if (record) {
      const existingLocksProfit = direction === "long"
        ? Number(record.price) >= breakEven
        : Number(record.price) <= breakEven;
      if (!existingLocksProfit) {
        await this.cancelTrackedTrailingStop(protection);
        record = null;
        this.logger.warn("Weighted entry or fees moved beyond the previous trailing stop; canceled it until a net-profitable stop can be armed again.");
      }
    }

    const rawTrigger = trailingTriggerPrice(protection.watermark, direction, this.config.trailingStopPercent);
    if (!stopLocksFeeAdjustedProfit(rawTrigger, direction, breakEven, this.config.maxEmergencySlippageBps)) return;
    const triggerSide = direction === "long" ? "sell" : "buy";
    const triggerPx = formatPrice(rawTrigger, this.market.szDecimals, triggerSide);
    if ((direction === "long" && Number(triggerPx) >= mid) || (direction === "short" && Number(triggerPx) <= mid)) return;
    const rawLimit = stopLimitWorstPrice(triggerPx, direction, this.config.maxEmergencySlippageBps);
    const limitSide = direction === "long" ? "buy" : "sell";
    const price = formatPrice(rawLimit, this.market.szDecimals, limitSide);
    if ((direction === "long" && Number(price) < breakEven) || (direction === "short" && Number(price) > breakEven)) return;
    const size = formatExistingSize(Math.abs(position.size), this.market.szDecimals, "down");
    if (!(Number(size) > 0) || Number(size) * Number(price) < this.config.minOrderNotional) return;

    const candidate = {
      key: `trailing-${direction}`,
      side: triggerSide,
      price,
      triggerPx,
      trigger: { isMarket: false, tpsl: "sl" },
      orderType: "trigger",
      size,
      actualNotional: Number(price) * Number(size),
      reduceOnly: true,
      kind: "trailing-stop",
      pairedPrice: null,
    };

    if (!record) {
      await this.placeTrailingStop(candidate, protection);
      return;
    }
    const tighter = shouldTightenStop(record.triggerPx, triggerPx, direction, this.config.trailingStopUpdateBps);
    const sizeChanged = record.size !== size;
    if (!tighter && !sizeChanged) return;
    const replacement = tighter
      ? candidate
      : { ...candidate, triggerPx: record.triggerPx, price: record.price, actualNotional: Number(record.price) * Number(size) };
    await this.modifyTrailingStop(record, replacement, protection);
  }

  async placeTrailingStop(candidate, protection) {
    this.state.generation += 1;
    const [order] = this.decorateOrders([candidate]);
    this.logger.warn(`Trailing stop activated (preview bypass): ${order.side.toUpperCase()} ${order.size}, trigger ${order.triggerPx}, limit ${order.price}.`);
    const statuses = await this.submitAndRemember([order], { reason: "trailing stop activation", preview: false });
    if (statuses?.[0] && typeof statuses[0] === "object" && "resting" in statuses[0]) {
      protection.trailingStopCloid = order.cloid;
      protection.trailingStopTrigger = order.triggerPx;
      protection.trailingStopLimit = order.price;
      protection.trailingActivatedAt ??= Date.now();
    }
  }

  async modifyTrailingStop(record, replacement, protection) {
    const order = { ...replacement, cloid: record.cloid };
    try {
      await this.exchange.modify({
        oid: record.cloid,
        order: sdkOrder(this.market, order, "Gtc"),
        a: true,
      });
    } catch (error) {
      this.state.phase = "RECONCILING";
      await saveState(this.stateFile, this.state);
      throw new Error(`Ambiguous trailing-stop modification; client-ID reconciliation required: ${error.message}`);
    }
    Object.assign(record, order, { status: "open" });
    protection.trailingStopTrigger = order.triggerPx;
    protection.trailingStopLimit = order.price;
    this.logger.log(`Trailing stop tightened: trigger ${order.triggerPx}, limit ${order.price}, size ${order.size}.`);
  }
}
