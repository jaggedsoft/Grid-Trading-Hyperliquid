function money(value) {
  return Number(value).toFixed(2);
}

function orderLine(label, order, collateral) {
  const action = order.orderType === "trigger"
    ? `${order.side.toUpperCase()} STOP`
    : order.side.toUpperCase();
  return `${label.padEnd(20)} ${action.padEnd(9)} ${order.price.toString().padStart(14)} ${order.size.toString().padStart(14)} ${money(order.actualNotional).padStart(10)} ${collateral}`;
}

export function printMarketCandidates(candidates, selected, logger = console) {
  logger.log("Matching perpetual markets:");
  for (const market of candidates) {
    const marker = market.assetId === selected.assetId ? "*" : " ";
    logger.log(`${marker} ${market.fullName.padEnd(18)} collateral=${market.collateral.padEnd(6)} OI=${market.openInterest ?? "n/a"} dayVolume=${market.dayNtlVlm ?? "n/a"} leverage=${market.maxLeverage}x`);
  }
  logger.log(`Selected ${selected.fullName}: ${selected.selectionReason}`);
}

export function printGrid(market, grid, config, logger = console) {
  const label = `${market.fullName}-${market.collateral}`;
  const showSells = grid.entrySides !== "long";
  const showBuys = grid.entrySides !== "short";
  const pyramid = grid.strategy === "pyramid";
  logger.log("");
  logger.log(config.dryRun ? "DRY RUN — no orders will be placed" : "LIVE ORDER PLAN");
  logger.log(`Market: ${market.fullName} | collateral: ${market.collateral} | OI: ${market.openInterest ?? "n/a"} | 24h volume: ${market.dayNtlVlm ?? "n/a"}`);
  logger.log(`Midprice: ${grid.anchorMid} | max leverage: ${market.maxLeverage}x isolated | mode: ${config.gridMode}${grid.weeklySigma ? ` | weekly sigma: ${(grid.weeklySigma * 100).toFixed(2)}%` : ""}`);

  if (showSells) {
    logger.log("");
    for (const order of grid.sells) logger.log(orderLine(label, order, market.collateral));
    const sellBase = grid.sells.reduce((sum, order) => sum + Number(order.size), 0);
    logger.log(pyramid
      ? `Short pyramid: ${grid.sells.length} falling-price triggers, cumulative ${money(grid.sellNotional)} ${market.collateral}`
      : `Sell liquidity: ${sellBase.toFixed(market.szDecimals)} ${market.fullName} worth ${money(grid.sellNotional)} ${market.collateral}`);
  }

  if (showBuys) {
    logger.log("");
    for (const order of grid.buys) logger.log(orderLine(label, order, market.collateral));
    logger.log(pyramid
      ? `Long pyramid: ${grid.buys.length} rising-price triggers, cumulative ${money(grid.buyNotional)} ${market.collateral}`
      : `Adding ${money(grid.buyNotional)} ${market.collateral} of buy liquidity`);
  }

  const adjusted = grid.orders.filter((order) => order.adjustedToMinimum).length;
  if (adjusted) logger.warn(`${adjusted} target notionals were raised to Hyperliquid's $${config.minOrderNotional} minimum.`);
}
