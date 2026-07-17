import test from "node:test";
import assert from "node:assert/strict";
import { discoverPerpetualMarkets, midpointFromBook, rankMarkets } from "../src/markets.js";

function market(overrides) {
  return {
    fullName: "BTC",
    collateral: "USDC",
    openInterest: 1,
    dayNtlVlm: 1,
    maxLeverage: 10,
    dexIndex: 0,
    ...overrides,
  };
}

test("USDC preference takes precedence over higher non-USDC open interest", () => {
  const selected = rankMarkets([
    market({ fullName: "aaa:BTC", collateral: "USDH", openInterest: 10_000, dexIndex: 1 }),
    market({ fullName: "BTC", openInterest: 100 }),
  ], "BTC");
  assert.equal(selected.fullName, "BTC");
});

test("open interest is primary and volume is its tie-breaker", () => {
  const selected = rankMarkets([
    market({ fullName: "one:BTC", openInterest: 100, dayNtlVlm: 10_000, dexIndex: 1 }),
    market({ fullName: "two:BTC", openInterest: 200, dayNtlVlm: 1, dexIndex: 2 }),
  ], "BTC");
  assert.equal(selected.fullName, "two:BTC");
  const tie = rankMarkets([
    market({ fullName: "one:BTC", openInterest: 100, dayNtlVlm: 10, dexIndex: 1 }),
    market({ fullName: "two:BTC", openInterest: 100, dayNtlVlm: 20, dexIndex: 2 }),
  ], "BTC");
  assert.equal(tie.fullName, "two:BTC");
});

test("daily volume is used when open interest is unavailable", () => {
  const selected = rankMarkets([
    market({ fullName: "one:BTC", openInterest: null, dayNtlVlm: 10, dexIndex: 1 }),
    market({ fullName: "two:BTC", openInterest: null, dayNtlVlm: 20, dexIndex: 2 }),
  ], "BTC");
  assert.equal(selected.fullName, "two:BTC");
  assert.match(selected.selectionReason, /unavailable/);
});

test("fully-qualified market bypasses ranking", () => {
  const selected = rankMarkets([
    market({ fullName: "one:BTC", openInterest: 1, dexIndex: 1 }),
    market({ fullName: "two:BTC", openInterest: 999, dexIndex: 2 }),
  ], "one:BTC");
  assert.equal(selected.fullName, "one:BTC");
});

test("market discovery resolves collateral and HIP-3 asset IDs", async () => {
  const metas = [
    { universe: [{ name: "BTC", szDecimals: 5, maxLeverage: 50, marginTableId: 50 }], marginTables: [], collateralToken: 0 },
    { universe: [{ name: "xyz:BTC", szDecimals: 4, maxLeverage: 20, marginTableId: 20 }], marginTables: [], collateralToken: 0 },
  ];
  const info = {
    perpDexs: async () => [null, { name: "xyz" }],
    allPerpMetas: async () => metas,
    spotMeta: async () => ({ tokens: [{ index: 0, name: "USDC" }], universe: [] }),
    metaAndAssetCtxs: async ({ dex } = {}) => dex === "xyz"
      ? [metas[1], [{ midPx: "100", markPx: "100", openInterest: "200", dayNtlVlm: "20" }]]
      : [metas[0], [{ midPx: "100", markPx: "100", openInterest: "100", dayNtlVlm: "10" }]],
  };
  const result = await discoverPerpetualMarkets(info, "BTC");
  assert.equal(result.selected.fullName, "xyz:BTC");
  assert.equal(result.selected.assetId, 110_000);
  assert.equal(result.selected.collateral, "USDC");
});

test("midpoint requires a valid two-sided book", () => {
  assert.equal(midpointFromBook({ levels: [[{ px: "99" }], [{ px: "101" }]] }), 100);
  assert.throws(() => midpointFromBook({ levels: [[], []] }), /Cannot calculate midpoint/);
});
