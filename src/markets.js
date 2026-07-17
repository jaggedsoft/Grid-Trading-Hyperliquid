function numberOrNull(value) {
  if (value === null || value === undefined || value === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

export function baseTicker(name) {
  return String(name).split(":").at(-1).toUpperCase();
}

export function matchesMarket(name, requested) {
  const query = requested.trim().toUpperCase();
  const fullName = String(name).toUpperCase();
  return query.includes(":") ? fullName === query : baseTicker(fullName) === query;
}

export function rankMarkets(candidates, requested) {
  if (!candidates.length) throw new Error(`No tradable perpetual market matches ${requested}`);
  if (requested.includes(":")) {
    const exact = candidates.find((candidate) => candidate.fullName.toUpperCase() === requested.toUpperCase());
    if (!exact) throw new Error(`Exact perpetual market ${requested} is not tradable`);
    return { ...exact, selectionReason: "explicit fully-qualified market" };
  }
  const usdc = candidates.filter((candidate) => candidate.collateral.toUpperCase() === "USDC");
  const preferred = usdc.length ? usdc : candidates;
  const hasOpenInterest = preferred.some((candidate) => candidate.openInterest !== null);
  const sorted = [...preferred].sort((left, right) => {
    if (hasOpenInterest) {
      const oi = (right.openInterest ?? Number.NEGATIVE_INFINITY) - (left.openInterest ?? Number.NEGATIVE_INFINITY);
      if (oi !== 0) return oi;
    }
    const volume = (right.dayNtlVlm ?? Number.NEGATIVE_INFINITY) - (left.dayNtlVlm ?? Number.NEGATIVE_INFINITY);
    if (volume !== 0) return volume;
    if (right.maxLeverage !== left.maxLeverage) return right.maxLeverage - left.maxLeverage;
    if (left.dexIndex === 0 && right.dexIndex !== 0) return -1;
    if (right.dexIndex === 0 && left.dexIndex !== 0) return 1;
    return left.fullName.localeCompare(right.fullName);
  });
  const collateralReason = usdc.length ? "USDC-preferred; " : "no USDC candidate; ";
  const rankingReason = hasOpenInterest ? "highest open interest (daily volume tie-breaker)" : "open interest unavailable; highest daily notional volume";
  return { ...sorted[0], selectionReason: collateralReason + rankingReason };
}

export async function discoverPerpetualMarkets(info, requested) {
  const [dexDescriptors, metas, spot] = await Promise.all([
    info.perpDexs(),
    info.allPerpMetas(),
    info.spotMeta(),
  ]);
  if (metas.length !== dexDescriptors.length) throw new Error(`Hyperliquid returned ${metas.length} DEX metadata records for ${dexDescriptors.length} DEX descriptors`);
  const collateralNames = new Map(spot.tokens.map((token) => [token.index, token.name]));
  const matchingDexes = [];
  for (let dexIndex = 0; dexIndex < metas.length; dexIndex += 1) {
    const meta = metas[dexIndex];
    if (meta.universe.some((asset) => matchesMarket(asset.name, requested) && !asset.isDelisted)) matchingDexes.push(dexIndex);
  }
  if (!matchingDexes.length) throw new Error(`No perpetual market matches ${requested}`);

  const contexts = await Promise.all(matchingDexes.map(async (dexIndex) => {
    const dex = dexIndex === 0 ? "" : dexDescriptors[dexIndex]?.name;
    if (dexIndex !== 0 && !dex) throw new Error(`Missing descriptor for perp DEX index ${dexIndex}`);
    const response = await info.metaAndAssetCtxs(dex ? { dex } : {});
    return [dexIndex, response];
  }));

  const candidates = [];
  for (const [dexIndex, [meta, assetContexts]] of contexts) {
    const dex = dexIndex === 0 ? "" : dexDescriptors[dexIndex].name;
    const collateral = collateralNames.get(meta.collateralToken) ?? `token-${meta.collateralToken}`;
    for (let universeIndex = 0; universeIndex < meta.universe.length; universeIndex += 1) {
      const asset = meta.universe[universeIndex];
      const context = assetContexts[universeIndex];
      if (!matchesMarket(asset.name, requested) || asset.isDelisted || !context?.midPx) continue;
      candidates.push({
        name: baseTicker(asset.name),
        fullName: asset.name,
        dex,
        dexIndex,
        universeIndex,
        assetId: dexIndex === 0 ? universeIndex : 100_000 + (dexIndex * 10_000) + universeIndex,
        collateral,
        collateralToken: meta.collateralToken,
        szDecimals: asset.szDecimals,
        maxLeverage: asset.maxLeverage,
        marginMode: asset.marginMode ?? (asset.onlyIsolated ? "noCross" : "normal"),
        openInterest: numberOrNull(context.openInterest),
        dayNtlVlm: numberOrNull(context.dayNtlVlm),
        contextMidPrice: numberOrNull(context.midPx),
        markPrice: numberOrNull(context.markPx),
      });
    }
  }
  const selected = rankMarkets(candidates, requested);
  return { candidates, selected, dexCount: metas.length, marketCount: metas.reduce((sum, meta) => sum + meta.universe.length, 0) };
}

export function midpointFromBook(book) {
  const bid = Number(book?.levels?.[0]?.[0]?.px);
  const ask = Number(book?.levels?.[1]?.[0]?.px);
  if (!(bid > 0) || !(ask > 0) || bid > ask) throw new Error("Cannot calculate midpoint from the current order book");
  return (bid + ask) / 2;
}
