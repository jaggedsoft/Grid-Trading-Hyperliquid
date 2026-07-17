import Decimal from "decimal.js";

Decimal.set({ precision: 40, rounding: Decimal.ROUND_HALF_UP });

export function stripTrailingZeros(value) {
  if (!value.includes(".")) return value;
  return value.replace(/\.?0+$/, "");
}

export function priceQuantum(price, szDecimals, maxDecimals = 6) {
  const px = new Decimal(price);
  if (!px.isPositive()) throw new Error("price must be positive");
  const decimalQuantum = new Decimal(10).pow(-(maxDecimals - szDecimals));
  if (px.greaterThanOrEqualTo(10_000)) return Decimal.max(1, decimalQuantum);
  const exponent = Math.floor(Math.log10(px.toNumber()));
  const significantQuantum = new Decimal(10).pow(exponent - 4);
  return Decimal.max(significantQuantum, decimalQuantum);
}

export function formatPrice(price, szDecimals, side, maxDecimals = 6) {
  const px = new Decimal(price);
  const quantum = priceQuantum(px, szDecimals, maxDecimals);
  const units = px.div(quantum);
  const roundedUnits = side === "buy" ? units.floor() : units.ceil();
  const result = roundedUnits.mul(quantum);
  const decimals = Math.max(0, Math.min(maxDecimals - szDecimals, quantum.decimalPlaces()));
  return stripTrailingZeros(result.toFixed(decimals));
}

export function formatSizeForNotional(targetNotional, price, szDecimals, minimumNotional = 10) {
  const px = new Decimal(price);
  const target = Decimal.max(targetNotional, minimumNotional);
  let size = target.div(px).toDecimalPlaces(szDecimals, Decimal.ROUND_DOWN);
  if (size.mul(px).lessThan(minimumNotional)) {
    size = new Decimal(minimumNotional).div(px).toDecimalPlaces(szDecimals, Decimal.ROUND_UP);
  }
  if (!size.isPositive()) throw new Error("Rounded order size is zero");
  return {
    size: stripTrailingZeros(size.toFixed(szDecimals)),
    actualNotional: size.mul(px).toNumber(),
    adjustedToMinimum: new Decimal(targetNotional).lessThan(minimumNotional),
  };
}

export function formatExistingSize(size, szDecimals, rounding = "down") {
  const mode = rounding === "up" ? Decimal.ROUND_UP : Decimal.ROUND_DOWN;
  const result = new Decimal(size).toDecimalPlaces(szDecimals, mode);
  return stripTrailingZeros(result.toFixed(szDecimals));
}
