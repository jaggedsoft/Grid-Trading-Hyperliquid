import {
  ExchangeClient,
  HttpTransport,
  InfoClient,
  SubscriptionClient,
  WebSocketTransport,
} from "@nktkas/hyperliquid";
import { privateKeyToAccount } from "viem/accounts";
import { discoverPerpetualMarkets, midpointFromBook } from "./markets.js";

const pinnedSelections = new WeakMap();

export function createPublicClients(network) {
  const isTestnet = network === "testnet";
  const transport = new HttpTransport({ isTestnet, timeout: 15_000 });
  return { transport, info: new InfoClient({ transport }) };
}

export function createLiveClients(network, credentials) {
  const isTestnet = network === "testnet";
  const transport = new HttpTransport({ isTestnet, timeout: 15_000 });
  const wallet = privateKeyToAccount(credentials.privateKey);
  const exchange = new ExchangeClient({
    transport,
    wallet,
    ...(credentials.vaultAddress ? { defaultVaultAddress: credentials.vaultAddress } : {}),
  });
  const wsTransport = new WebSocketTransport({ isTestnet, timeout: 15_000, resubscribe: true });
  const subscriptions = new SubscriptionClient({ transport: wsTransport });
  return { transport, info: new InfoClient({ transport }), exchange, wsTransport, subscriptions, wallet };
}

export async function loadSelectedMarket(info, requested) {
  const discovery = await discoverPerpetualMarkets(info, requested);
  let cache = pinnedSelections.get(info);
  if (!cache) {
    cache = new Map();
    pinnedSelections.set(info, cache);
  }
  const key = requested.trim().toUpperCase();
  const pinnedAssetId = cache.get(key);
  let selected = discovery.selected;
  if (pinnedAssetId !== undefined) {
    const pinned = discovery.candidates.find((candidate) => candidate.assetId === pinnedAssetId);
    if (!pinned) throw new Error(`The active market for ${requested} is no longer tradable`);
    selected = { ...pinned, selectionReason: `${pinned.selectionReason ?? discovery.selected.selectionReason}; pinned for this running process` };
  } else {
    cache.set(key, selected.assetId);
  }
  const book = await info.l2Book({ coin: selected.fullName });
  const midPrice = midpointFromBook(book);
  return { ...discovery, selected, book, midPrice };
}

export async function fetchVolatilityCandles(info, market, config, now = Date.now()) {
  const lookback = config.volatilityLookbackDays * 24 * 60 * 60 * 1000;
  return info.candleSnapshot({
    coin: market.fullName,
    interval: config.volatilityInterval,
    startTime: now - lookback - (8 * 60 * 60 * 1000),
    endTime: now,
  });
}

export function sdkOrder(market, order, tif = "Alo") {
  const type = order.orderType === "trigger"
    ? {
        trigger: {
          isMarket: Boolean(order.trigger?.isMarket),
          triggerPx: String(order.triggerPx ?? order.price),
          tpsl: order.trigger?.tpsl ?? "sl",
        },
      }
    : { limit: { tif } };
  return {
    a: market.assetId,
    b: order.side === "buy",
    p: String(order.price),
    s: String(order.size),
    r: Boolean(order.reduceOnly),
    t: type,
    ...(order.cloid ? { c: order.cloid } : {}),
  };
}

export async function submitOrders(exchange, market, orders, { tif = "Alo" } = {}) {
  if (!orders.length) return [];
  const response = await exchange.order({ orders: orders.map((order) => sdkOrder(market, order, tif)), grouping: "na" });
  return response.response.data.statuses;
}

export async function cancelByCloids(exchange, market, cloids) {
  if (!cloids.length) return null;
  return exchange.cancelByCloid({ cancels: cloids.map((cloid) => ({ asset: market.assetId, cloid })) });
}

export async function accountSnapshot(info, credentials, market) {
  const params = { user: credentials.accountAddress, ...(market.dex ? { dex: market.dex } : {}) };
  const [clearinghouse, openOrders] = await Promise.all([
    info.clearinghouseState(params),
    info.openOrders(params),
  ]);
  return { clearinghouse, openOrders };
}
