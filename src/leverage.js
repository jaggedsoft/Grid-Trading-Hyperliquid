export function normalizeLeverage(value) {
  if (typeof value === "string" && value.trim().toLowerCase() === "max") return "max";
  const leverage = Number(value);
  if (!Number.isSafeInteger(leverage) || leverage < 1) {
    throw new Error("leverage must be 'max' or a positive integer");
  }
  return leverage;
}

export function resolveLeverage(requested, marketMaximum) {
  const maximum = Number(marketMaximum);
  if (!Number.isSafeInteger(maximum) || maximum < 1) {
    throw new Error(`Selected market has invalid maximum leverage: ${marketMaximum}`);
  }
  const leverage = normalizeLeverage(requested);
  if (leverage === "max") return maximum;
  if (leverage > maximum) {
    throw new Error(`Requested leverage ${leverage}x exceeds the selected market maximum of ${maximum}x`);
  }
  return leverage;
}
