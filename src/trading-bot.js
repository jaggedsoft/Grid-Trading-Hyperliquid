import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import Decimal from "decimal.js";
import { accountSnapshot, cancelByCloids, fetchVolatilityCandles, loadSelectedMarket, submitOrders } from "./hyperliquid-client.js";
import { generateGrid, intervalAtCenter } from "./grid.js";
import { printGrid, printMarketCandidates } from "./output.js";
import { confirmOrders } from "./prompt.js";
import { formatExistingSize, formatPrice } from "./precision.js";
import {
  adverseMove,
  calculateWeeklyVolatility,
  currentCandleLogMove,
} from "./volatility.js";
import {
  classifyLiquidationRisk,
  extractPosition,
  fillExposure,
  hasExitDepth,
  isExposureIncreasing,
  liquidationBufferRatio,
  liquidationDistance,
} from "./risk.js";
import {
  loadState,
  makeCloid,
  ownedOpenOrders,
  rememberFill,
  saveState,
  statePath,
} from "./state.js";

function orderSummary(order) {
  return `${order.side.toUpperCase()} ${order.price} ${order.size} (${Number(order.actualNotional ?? Number(order.price) * Number(order.size)).toFixed(2)} USDC)${order.reduceOnly ? " reduce-only" : ""}`;
}

function fillIdentity(fill) {
  return `${fill.hash}:${fill.tid}:${fill.oid}:${fill.time}`;
}

function sideFromFill(fill) {
  return fill.side === "B" ? "buy" : "sell";
}

export class TradingBot {
  constructor({ config, info, exchange = null, subscriptions = null, wsTransport = null, credentials = null, logger = console, workspace = process.cwd() }) {
    this.config = config;
    this.info = info;
    this.exchange = exchange;
    this.subscriptions = subscriptions;
    this.wsTransport = wsTransport;
    this.credentials = credentials;
    this.logger = logger;
    this.workspace = workspace;
    this.market = null;
    this.discovery = null;
    this.grid = null;
    this.state = null;
    this.stateFile = null;
    this.volatility = null;
    this.volatilityFetchedAt = 0;
    this.pollTimer = null;
    this.fillSubscription = null;
    this.operationQueue = Promise.resolve();
    this.shuttingDown = false;
    this.riskReductionRunning = false;
    this.lastFillPollAt = Date.now();
  }

  async initializeMarket() {
    const loaded = await loadSelectedMarket(this.info, this.config.market);
    this.discovery = loaded;
    this.market = loaded.selected;
    this.market.midPrice = loaded.midPrice;
    this.logger.log(`Discovered ${loaded.marketCount} perpetual markets across ${loaded.dexCount} DEXs.`);
    printMarketCandidates(loaded.candidates, this.market, this.logger);
    await this.refreshVolatility(true);
    this.grid = generateGrid({
      market: this.market,
      midPrice: loaded.midPrice,
      config: this.config,
      weeklySigma: this.config.gridMode === "volatility" ? this.volatility.weeklySigma : null,
    });
    return loaded;
  }

  async refreshVolatility(force = false) {
    const refreshMs = this.config.volatilityRefreshMinutes * 60_000;
    if (!force && Date.now() - this.volatilityFetchedAt < refreshMs) return this.volatility;
    const candles = await fetchVolatilityCandles(this.info, this.market, this.config);
    this.volatility = calculateWeeklyVolatility(candles, { interval: this.config.volatilityInterval });
    this.volatilityFetchedAt = Date.now();
    return this.volatility;
  }

  async runDryRun() {
    await this.initializeMarket();
    printGrid(this.market, this.grid, this.config, this.logger);
    return { market: this.market, grid: this.grid };
  }

  async runLive() {
    if (!this.exchange || !this.credentials) throw new Error("Live clients and credentials are required when dryRun=false");
    await this.initializeMarket();
    this.stateFile = statePath(this.workspace, this.config.network, this.market.fullName);
    this.state = await loadState(this.stateFile, this.config.network, this.market.fullName);
    await this.exchange.updateLeverage({ asset: this.market.assetId, isCross: false, leverage: this.market.maxLeverage });
    this.logger.warn(`LIVE MODE: ${this.market.fullName} set to ${this.market.maxLeverage}x isolated leverage.`);
    this.logger.warn("Authorized liquidation-risk reductions bypass interactive preview.");

    const maxPositionNotional = this.config.maxPositionNotional ?? this.grid.maxPositionNotional;
    this.maxPositionNotional = maxPositionNotional;
    const depth = hasExitDepth(this.discovery.book, this.discovery.midPrice, maxPositionNotional, this.config.maxEmergencySlippageBps);
    if (!depth.sufficient) {
      throw new Error(`Insufficient two-sided book depth within ${this.config.maxEmergencySlippageBps} bps to flatten ${maxPositionNotional.toFixed(2)} USDC (sell=${depth.sellCapacity.toFixed(2)}, buy=${depth.buyCapacity.toFixed(2)})`);
    }

    await this.reconcileState();
    const openOwned = Object.values(this.state.orders).filter((order) => order.status === "open" || order.status === "pending");
    if (!openOwned.length || Date.now() >= this.state.nextRebuildAt) {
      const placed = await this.rebuildGrid("startup");
      if (!placed) {
        this.logger.warn("Order placement canceled by operator; exiting.");
        return;
      }
    } else {
      this.state.phase = "ACTIVE";
      this.logger.log(`Resuming ${openOwned.length} persisted bot-owned orders.`);
      await saveState(this.stateFile, this.state);
    }

    await this.startFillSubscription();
    this.pollTimer = setInterval(() => {
      this.enqueue(() => this.monitorTick(), "monitor tick");
    }, this.config.pollIntervalSeconds * 1000);
    this.installSignalHandlers();
    this.logger.log("Continuous monitoring active. Press Ctrl+C for a guarded shutdown.");
  }

  enqueue(operation, label) {
    this.operationQueue = this.operationQueue
      .then(() => operation())
      .catch((error) => this.logger.error(`${label} failed: ${error.stack ?? error.message}`));
    return this.operationQueue;
  }

  installSignalHandlers() {
    const handler = (signal) => {
      this.logger.warn(`Received ${signal}; stopping exposure and shutting down.`);
      this.shutdown().finally(() => process.exit(0));
    };
    process.once("SIGINT", handler);
    process.once("SIGTERM", handler);
  }

  async freshMarketAndGrid() {
    const loaded = await loadSelectedMarket(this.info, this.config.market);
    if (loaded.selected.fullName !== this.market.fullName) {
      this.logger.warn(`Market selector changed from ${this.market.fullName} to ${loaded.selected.fullName}; switching only during this full rebuild.`);
      this.market = loaded.selected;
      this.state.market = loaded.selected.fullName;
    } else {
      this.market = { ...this.market, ...loaded.selected };
    }
    this.discovery = loaded;
    await this.refreshVolatility(true);
    const grid = generateGrid({
      market: this.market,
      midPrice: loaded.midPrice,
      config: this.config,
      weeklySigma: this.config.gridMode === "volatility" ? this.volatility.weeklySigma : null,
    });
    return { loaded, grid };
  }

  decorateOrders(orders) {
    return orders.map((order, index) => {
      const cloid = makeCloid(this.state, `${order.key}|${index}|${order.kind}`);
      return { ...order, cloid, status: "pending", generation: this.state.generation };
    });
  }

  async previewRoutineOrders(orders, reason) {
    this.logger.log(`\n${reason} order preview (${orders.length} orders):`);
    for (const order of orders) this.logger.log(`  ${orderSummary(order)}`);
    if (!this.config.preview) return true;
    return confirmOrders();
  }

  async submitAndRemember(orders, { reason, tif = "Alo", preview = true } = {}) {
    if (!orders.length) return [];
    if (preview && !(await this.previewRoutineOrders(orders, reason))) return null;
    for (const order of orders) this.state.orders[order.cloid] = order;
    await saveState(this.stateFile, this.state);
    let statuses;
    try {
      statuses = await submitOrders(this.exchange, this.market, orders, { tif });
    } catch (error) {
      this.state.phase = "RECONCILING";
      await saveState(this.stateFile, this.state);
      throw new Error(`Ambiguous ${reason} submission; state retained for client-ID reconciliation: ${error.message}`);
    }
    statuses.forEach((status, index) => {
      const record = this.state.orders[orders[index].cloid];
      record.exchangeStatus = status;
      record.status = typeof status === "object" && "resting" in status ? "open" : typeof status === "object" && "filled" in status ? "filled" : "submitted";
    });
    await saveState(this.stateFile, this.state);
    return statuses;
  }

  reanchoredExit(position, grid) {
    if (!position || position.size === 0) return null;
    const side = position.size > 0 ? "sell" : "buy";
    const sideOrders = side === "sell" ? grid.sells : grid.buys;
    const centerInterval = intervalAtCenter(grid, side);
    const threshold = position.size > 0 ? position.entryPrice + centerInterval : position.entryPrice - centerInterval;
    const candidate = position.size > 0
      ? sideOrders.find((order) => Number(order.price) >= threshold)
      : sideOrders.find((order) => Number(order.price) <= threshold);
    const rawPrice = candidate?.price ?? threshold;
    const price = formatPrice(rawPrice, this.market.szDecimals, side);
    const size = formatExistingSize(Math.abs(position.size), this.market.szDecimals);
    if (!(Number(size) > 0) || Number(size) * Number(price) < this.config.minOrderNotional) {
      this.logger.warn("Existing position is below the minimum notional for a reduce-only resting exit; risk monitor will still protect it.");
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
    const snapshot = await accountSnapshot(this.info, this.credentials, this.market);
    await this.cancelAllOwned(snapshot.openOrders);
    this.state.generation += 1;
    let attempts = 0;
    while (attempts < 5) {
      attempts += 1;
      const previewStarted = Date.now();
      const { loaded, grid } = await this.freshMarketAndGrid();
      this.grid = grid;
      printGrid(this.market, grid, { ...this.config, dryRun: false }, this.logger);
      const position = extractPosition(snapshot.clearinghouse, this.market.fullName);
      const exit = this.reanchoredExit(position, grid);
      let routine = [...grid.orders];
      if (exit) routine = routine.filter((order) => !(order.side === exit.side && order.price === exit.price));
      const decorated = this.decorateOrders(exit ? [exit, ...routine] : routine);
      if (!(await this.previewRoutineOrders(decorated, `${reason} rebuild`))) return false;
      const freshBook = await this.info.l2Book({ coin: this.market.fullName });
      const freshMid = (Number(freshBook.levels[0][0].px) + Number(freshBook.levels[1][0].px)) / 2;
      const interval = Math.min(intervalAtCenter(grid, "buy"), intervalAtCenter(grid, "sell"));
      const stale = Date.now() - previewStarted > this.config.previewMaxAgeSeconds * 1000;
      const drifted = Math.abs(freshMid - loaded.midPrice) > interval * this.config.previewMaxMidDriftFraction;
      if (this.config.preview && (stale || drifted)) {
        this.logger.warn(`Preview became ${stale ? "stale" : "price-drifted"}; regenerating before submission.`);
        continue;
      }
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
    throw new Error("Market kept moving while awaiting preview; rebuild aborted after five attempts");
  }

  async reconcileState(snapshot = null) {
    const current = snapshot ?? await accountSnapshot(this.info, this.credentials, this.market);
    const openByCloid = new Map(current.openOrders.filter((order) => order.cloid).map((order) => [order.cloid, order]));
    for (const record of Object.values(this.state.orders)) {
      if (["open", "pending", "submitted"].includes(record.status)) record.status = openByCloid.has(record.cloid) ? "open" : "closed";
    }
    await saveState(this.stateFile, this.state);
    return current;
  }

  async cancelRecords(records) {
    const open = records.filter((record) => ["open", "pending", "submitted"].includes(record.status));
    if (!open.length) return;
    await cancelByCloids(this.exchange, this.market, open.map((record) => record.cloid));
    for (const record of open) record.status = "canceled";
    await saveState(this.stateFile, this.state);
  }

  async cancelAllOwned(openOrders = null) {
    const orders = openOrders ?? (await accountSnapshot(this.info, this.credentials, this.market)).openOrders;
    const owned = ownedOpenOrders(this.state, orders);
    if (!owned.length) return;
    await cancelByCloids(this.exchange, this.market, owned.map((order) => order.cloid));
    for (const order of owned) if (this.state.orders[order.cloid]) this.state.orders[order.cloid].status = "canceled";
    await saveState(this.stateFile, this.state);
  }

  async cancelExposureIncreasing(positionSize, openOrders = null) {
    const orders = openOrders ?? (await accountSnapshot(this.info, this.credentials, this.market)).openOrders;
    const owned = ownedOpenOrders(this.state, orders);
    const cloids = owned
      .filter((order) => !order.reduceOnly && isExposureIncreasing(order.side === "B" ? "buy" : "sell", positionSize))
      .map((order) => order.cloid);
    if (!cloids.length) return;
    await cancelByCloids(this.exchange, this.market, cloids);
    for (const cloid of cloids) if (this.state.orders[cloid]) this.state.orders[cloid].status = "canceled";
    await saveState(this.stateFile, this.state);
  }

  async startFillSubscription() {
    if (!this.subscriptions) return;
    this.fillSubscription = await this.subscriptions.userFills(
      { user: this.credentials.accountAddress, aggregateByTime: false },
      (event) => {
        if (event.isSnapshot) return;
        for (const fill of event.fills) this.enqueue(() => this.processFill(fill), "fill processing");
      },
    );
  }

  async processFill(fill) {
    if (fill.coin !== this.market.fullName || !fill.cloid || !this.state.orders[fill.cloid]) return;
    const id = fillIdentity(fill);
    if (!rememberFill(this.state, id)) return;
    const record = this.state.orders[fill.cloid];
    const side = sideFromFill(fill);
    const exposure = fillExposure(fill.startPosition, side, fill.sz);
    record.filledSize = new Decimal(record.filledSize ?? 0).plus(fill.sz).toString();
    record.lastFillAt = fill.time;
    this.logger.log(`Fill ${id}: ${side.toUpperCase()} ${fill.sz} ${this.market.fullName} @ ${fill.px} (${fill.dir})`);

    const followups = [];
    if (exposure.opened > 0 && record.pairedPrice) {
      const exitSize = formatExistingSize(exposure.opened, this.market.szDecimals);
      if (Number(exitSize) * Number(record.pairedPrice) >= this.config.minOrderNotional) {
        followups.push({
          key: `exit-${fill.tid}`,
          side: side === "buy" ? "sell" : "buy",
          price: record.pairedPrice,
          size: exitSize,
          actualNotional: Number(exitSize) * Number(record.pairedPrice),
          reduceOnly: true,
          kind: "exit",
          pairedPrice: record.price,
          origin: { ...record, cloid: undefined, status: undefined, exchangeStatus: undefined },
        });
      } else {
        this.logger.warn("Partial exposure is below the resting-order minimum; it remains under the liquidation risk monitor.");
      }
    }
    if (exposure.reduced > 0 && record.kind === "exit" && record.origin) {
      const rearmSize = formatExistingSize(exposure.reduced, this.market.szDecimals);
      if (Number(rearmSize) * Number(record.origin.price) >= this.config.minOrderNotional) {
        followups.push({
          ...record.origin,
          key: `rearm-${fill.tid}`,
          size: rearmSize,
          actualNotional: Number(rearmSize) * Number(record.origin.price),
          reduceOnly: false,
          kind: "entry",
        });
      }
    }
    if (followups.length) {
      this.state.generation += 1;
      const decorated = this.decorateOrders(followups);
      await this.submitAndRemember(decorated, { reason: "paired fill", preview: true });
    }
    await saveState(this.stateFile, this.state);
  }

  async pollRecentFills() {
    const fills = await this.info.userFills({ user: this.credentials.accountAddress, aggregateByTime: false });
    const recent = fills.filter((fill) => fill.time >= this.lastFillPollAt - 1000).sort((a, b) => a.time - b.time);
    this.lastFillPollAt = Date.now();
    for (const fill of recent) await this.processFill(fill);
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
    if (this.state.phase === "ACTIVE" && Date.now() >= this.state.nextRebuildAt) await this.rebuildGrid("24-hour");
  }

  async monitorRisk(position, openOrders, mid, book) {
    if (!position || position.size === 0) {
      this.state.initialLiquidationDistance = null;
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
      this.state.phase = "GUARDED";
    }
    if ((level === "reduce" || level === "emergency") && !this.riskReductionRunning) {
      await this.reduceRisk(position, ratio, level === "emergency");
    }
    const depth = hasExitDepth(book, mid, Math.min(notional, this.maxPositionNotional), this.config.maxEmergencySlippageBps);
    if (!depth.sufficient) {
      await this.cancelExposureIncreasing(position.size, openOrders);
      this.state.phase = "GUARDED";
      this.logger.error("Exit-depth guard failed while a position is open; exposure-increasing orders canceled.");
    }
    await saveState(this.stateFile, this.state);
  }

  async reduceRisk(initialPosition, initialRatio, emergency) {
    this.riskReductionRunning = true;
    this.state.phase = "REDUCING_RISK";
    this.logger.error(`Liquidation buffer is ${(initialRatio * 100).toFixed(1)}% of its initial distance; starting staged reduction.`);
    try {
      await this.cancelAllOwned();
      for (let slice = 0; slice < this.config.riskReduceSlices; slice += 1) {
        const snapshot = await accountSnapshot(this.info, this.credentials, this.market);
        const position = extractPosition(snapshot.clearinghouse, this.market.fullName);
        if (!position || position.size === 0) break;
        const book = await this.info.l2Book({ coin: this.market.fullName });
        const mid = (Number(book.levels[0][0].px) + Number(book.levels[1][0].px)) / 2;
        const currentDistance = liquidationDistance(mid, position.liquidationPrice);
        const ratio = liquidationBufferRatio(currentDistance, this.state.initialLiquidationDistance);
        if (ratio !== null && ratio > this.config.liquidationWarningRatio) break;
        const allRemaining = emergency || (ratio !== null && ratio <= this.config.liquidationEmergencyRatio);
        const remainingSlices = this.config.riskReduceSlices - slice;
        const rawSize = allRemaining ? Math.abs(position.size) : Math.abs(position.size) / remainingSlices;
        const size = formatExistingSize(rawSize, this.market.szDecimals, allRemaining ? "up" : "down");
        if (!(Number(size) > 0)) break;
        const side = position.size > 0 ? "sell" : "buy";
        const slip = this.config.maxEmergencySlippageBps / 10_000;
        const rawPrice = position.size > 0 ? mid * (1 - slip) : mid * (1 + slip);
        const price = formatPrice(rawPrice, this.market.szDecimals, position.size > 0 ? "buy" : "sell");
        this.state.generation += 1;
        const [order] = this.decorateOrders([{
          key: `risk-${Date.now()}-${slice}`,
          side,
          price,
          size,
          actualNotional: Number(price) * Number(size),
          reduceOnly: true,
          kind: "risk-reduction",
          pairedPrice: null,
        }]);
        this.logger.error(`Emergency IOC (preview bypass): ${orderSummary(order)}`);
        await this.submitAndRemember([order], { reason: "risk reduction", tif: "Ioc", preview: false });
        if (allRemaining) break;
        await delay(this.config.riskReduceSliceDelaySeconds * 1000);
      }
    } finally {
      this.riskReductionRunning = false;
      this.state.phase = "PAUSED_RISK";
      this.state.calmSince = null;
      await saveState(this.stateFile, this.state);
    }
  }

  async monitorVolatility(position, mid, openOrders) {
    await this.refreshVolatility();
    const move = adverseMove(currentCandleLogMove(this.volatility.currentCandle, mid), position?.size ?? 0);
    const pauseThreshold = this.config.pauseSigma * this.volatility.intervalSigma;
    const resumeThreshold = this.config.resumeSigma * this.volatility.intervalSigma;
    if (["ACTIVE", "GUARDED"].includes(this.state.phase) && move >= pauseThreshold) {
      await this.cancelExposureIncreasing(position?.size ?? 0, openOrders);
      this.state.phase = "PAUSED_VOLATILITY";
      this.state.calmSince = null;
      this.logger.warn(`Volatility pause: current adverse 4h move ${(move * 100).toFixed(2)}% >= ${this.config.pauseSigma}σ.`);
    }
    if (["PAUSED_VOLATILITY", "PAUSED_RISK"].includes(this.state.phase)) {
      if (move <= resumeThreshold) this.state.calmSince ??= Date.now();
      else this.state.calmSince = null;
      const calmLongEnough = this.state.calmSince && Date.now() - this.state.calmSince >= this.config.calmMinutes * 60_000;
      const positionSafe = !position || position.size === 0 || this.currentPositionBuffer(position, mid) >= this.config.liquidationResumeRatio;
      if (calmLongEnough && positionSafe) {
        const book = await this.info.l2Book({ coin: this.market.fullName });
        const depth = hasExitDepth(book, mid, this.maxPositionNotional, this.config.maxEmergencySlippageBps);
        if (depth.sufficient) await this.rebuildGrid("automatic calm-state");
      }
    }
    await saveState(this.stateFile, this.state);
  }

  currentPositionBuffer(position, mid) {
    return liquidationBufferRatio(liquidationDistance(mid, position.liquidationPrice), this.state.initialLiquidationDistance) ?? 0;
  }

  async shutdown() {
    if (this.shuttingDown) return;
    this.shuttingDown = true;
    if (this.pollTimer) clearInterval(this.pollTimer);
    try {
      if (this.state && this.credentials) {
        const snapshot = await accountSnapshot(this.info, this.credentials, this.market);
        const position = extractPosition(snapshot.clearinghouse, this.market.fullName);
        await this.cancelExposureIncreasing(position?.size ?? 0, snapshot.openOrders);
        this.state.phase = "STOPPED";
        await saveState(this.stateFile, this.state);
      }
    } finally {
      if (this.fillSubscription) await this.fillSubscription.unsubscribe().catch(() => {});
      this.wsTransport?.close();
    }
  }
}
