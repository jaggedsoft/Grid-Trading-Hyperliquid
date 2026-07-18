import { accountSnapshot } from "./hyperliquid-client.js";
import { resolveLeverage } from "./leverage.js";
import { hasExitDepth } from "./risk.js";
import { loadState, ownedOpenOrders, saveState, statePath } from "./state.js";
import { TradingBot as SafeTradingBot } from "./safe-trading-bot.js";

export class TradingBot extends SafeTradingBot {
  async runLive() {
    if (!this.exchange || !this.credentials) throw new Error("Live clients and credentials are required when dryRun=false");
    await this.initializeMarket();
    this.stateFile = statePath(this.workspace, this.config.network, this.market.fullName);
    this.state = await loadState(this.stateFile, this.config.network, this.market.fullName);
    const leverage = resolveLeverage(this.config.leverage, this.market.maxLeverage);
    await this.exchange.updateLeverage({ asset: this.market.assetId, isCross: false, leverage });
    this.logger.warn(`LIVE MODE: ${this.market.fullName} set to ${leverage}x isolated leverage (market maximum ${this.market.maxLeverage}x).`);
    this.logger.warn("Authorized liquidation-risk reductions bypass interactive preview.");

    this.maxPositionNotional = this.config.maxPositionNotional ?? this.grid.maxPositionNotional;
    const depth = hasExitDepth(this.discovery.book, this.discovery.midPrice, this.maxPositionNotional, this.config.maxEmergencySlippageBps);
    if (!depth.sufficient) {
      throw new Error(`Insufficient two-sided book depth within ${this.config.maxEmergencySlippageBps} bps to flatten ${this.maxPositionNotional.toFixed(2)} USDC (sell=${depth.sellCapacity.toFixed(2)}, buy=${depth.buyCapacity.toFixed(2)})`);
    }

    await this.reconcileState();
    const openOwned = Object.values(this.state.orders).filter((order) => order.status === "open" || order.status === "pending");
    if (!openOwned.length || Date.now() >= this.state.nextRebuildAt) {
      try {
        const placed = await this.rebuildGrid("startup");
        if (!placed) {
          this.logger.warn("Order placement canceled by operator; existing bot orders were preserved.");
          return;
        }
      } catch (error) {
        this.state.phase = "RECONCILING";
        await saveState(this.stateFile, this.state);
        this.logger.error(`Startup rebuild failed after its safety checks: ${error.message}`);
        this.logger.error("The process will remain alive to reconcile client IDs and monitor position risk.");
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

  async reconcileState(snapshot = null) {
    const current = await super.reconcileState(snapshot);
    if (this.state.phase === "RECONCILING") {
      const open = ownedOpenOrders(this.state, current.openOrders);
      const unresolved = Object.values(this.state.orders).some((order) => order.status === "pending" || order.status === "submitted");
      if (!unresolved) {
        this.state.phase = "ACTIVE";
        if (!open.length) this.state.nextRebuildAt = Date.now();
        this.logger.warn(`Reconciliation complete: ${open.length} bot-owned orders are open.`);
        await saveState(this.stateFile, this.state);
      }
    }
    return current;
  }
}
