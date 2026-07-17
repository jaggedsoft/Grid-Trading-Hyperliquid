import { helpText as baseHelpText, loadConfig as loadBaseConfig, validateLiveEnvironment } from "./configuration.js";

const FLAG_ALIASES = new Map([
  ["long", "long"],
  ["buy", "long"],
  ["short", "short"],
  ["sell", "short"],
  ["pyramid", "pyramid"],
]);

function booleanValue(value, flag) {
  if (value === undefined || value === true || value === "true") return true;
  if (value === false || value === "false") return false;
  throw new Error(`--${flag} must be true or false`);
}

export function extractStrategyFlags(argv = process.argv.slice(2)) {
  const remaining = [];
  const strategy = { long: false, short: false, pyramid: false };
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith("--")) {
      remaining.push(token);
      continue;
    }
    const separator = token.indexOf("=");
    const key = separator >= 0 ? token.slice(2, separator) : token.slice(2);
    const canonical = FLAG_ALIASES.get(key);
    if (!canonical) {
      remaining.push(token);
      continue;
    }
    let value = separator >= 0 ? token.slice(separator + 1) : true;
    if (separator < 0 && ["true", "false"].includes(argv[index + 1])) {
      value = argv[index + 1];
      index += 1;
    }
    strategy[canonical] = booleanValue(value, key);
  }
  return { remaining, strategy };
}

export function loadConfig(argv = process.argv.slice(2)) {
  const { remaining, strategy } = extractStrategyFlags(argv);
  const base = loadBaseConfig(remaining);
  const explicitSides = strategy.long || strategy.short;
  return Object.freeze({
    ...base,
    ...strategy,
    buyEntries: explicitSides ? strategy.long : true,
    sellEntries: explicitSides ? strategy.short : true,
  });
}

export function helpText() {
  return `${baseHelpText()}
Strategy flags:
  --long, --buy       Place buy entry grids only
  --short, --sell     Place sell entry grids only
  --long --short      Explicitly enable both entry sides
  --pyramid           Double notional at each farther level, capped by maxOrderNotional

Protective reduce-only exits are still allowed on the opposite side.
Examples:
  npm.cmd run dry-run -- --long
  npm.cmd run dry-run -- --short --pyramid --max-order-notional=160
`;
}

export { validateLiveEnvironment };
