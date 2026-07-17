import "dotenv/config";
import defaults from "../config.js";

const BOOLEAN_KEYS = new Set(["dryRun", "preview"]);
const NUMBER_KEYS = new Set([
  "buyGrids",
  "sellGrids",
  "buyMult",
  "sellMult",
  "fromMidPrice",
  "minOrderNotional",
  "maxOrderNotional",
  "rebuildIntervalHours",
  "volatilityLookbackDays",
  "pauseSigma",
  "resumeSigma",
  "calmMinutes",
  "maxPositionNotional",
  "maxEmergencySlippageBps",
  "previewMaxAgeSeconds",
  "previewMaxMidDriftFraction",
  "pollIntervalSeconds",
  "volatilityRefreshMinutes",
  "liquidationWarningRatio",
  "liquidationReduceRatio",
  "liquidationEmergencyRatio",
  "liquidationResumeRatio",
  "riskReduceSlices",
  "riskReduceSliceDelaySeconds",
]);

function toCamelCase(value) {
  return value.replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());
}

function parseBoolean(value, key) {
  if (value === true || value === "true") return true;
  if (value === false || value === "false") return false;
  throw new Error(`${key} must be true or false`);
}

export function parseCliArgs(argv = process.argv.slice(2)) {
  const result = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === "--help" || token === "-h") {
      result.help = true;
      continue;
    }
    if (!token.startsWith("--")) throw new Error(`Unexpected argument: ${token}`);
    const separator = token.indexOf("=");
    const rawKey = separator >= 0 ? token.slice(2, separator) : token.slice(2);
    const key = toCamelCase(rawKey);
    if (!(key in defaults)) throw new Error(`Unknown setting: --${rawKey}`);
    let value = separator >= 0 ? token.slice(separator + 1) : argv[index + 1];
    if (separator < 0) {
      if (BOOLEAN_KEYS.has(key) && (value === undefined || value.startsWith("--"))) value = true;
      else index += 1;
    }
    if (value === undefined) throw new Error(`Missing value for --${rawKey}`);
    if (BOOLEAN_KEYS.has(key)) result[key] = parseBoolean(value, key);
    else if (NUMBER_KEYS.has(key)) {
      if (value === "null" && key === "maxPositionNotional") result[key] = null;
      else {
        const parsed = Number(value);
        if (!Number.isFinite(parsed)) throw new Error(`${key} must be a finite number`);
        result[key] = parsed;
      }
    } else result[key] = String(value);
  }
  return result;
}

export function validateConfig(config) {
  if (!config.market.trim()) throw new Error("market cannot be empty");
  if (!["mainnet", "testnet"].includes(config.network)) throw new Error("network must be mainnet or testnet");
  if (!["fixed", "volatility"].includes(config.gridMode)) throw new Error("gridMode must be fixed or volatility");
  if (config.volatilityInterval !== "4h") throw new Error("This strategy currently requires volatilityInterval=4h");
  if (config.marginMode !== "isolated") throw new Error("Only isolated margin is supported by this risk model");
  for (const key of ["buyGrids", "sellGrids", "riskReduceSlices"]) {
    if (!Number.isInteger(config[key]) || config[key] < 1) throw new Error(`${key} must be a positive integer`);
  }
  for (const key of ["buyMult", "sellMult", "fromMidPrice", "minOrderNotional", "maxOrderNotional", "rebuildIntervalHours", "volatilityLookbackDays", "pauseSigma", "resumeSigma", "calmMinutes", "maxEmergencySlippageBps", "pollIntervalSeconds"]) {
    if (!(config[key] > 0)) throw new Error(`${key} must be greater than zero`);
  }
  if (config.fromMidPrice >= 100) throw new Error("fromMidPrice must be below 100%");
  if (config.minOrderNotional < 10) throw new Error("Hyperliquid requires minOrderNotional >= 10");
  if (config.maxOrderNotional < config.minOrderNotional) throw new Error("maxOrderNotional must be >= minOrderNotional");
  if (config.resumeSigma >= config.pauseSigma) throw new Error("resumeSigma must be below pauseSigma");
  if (!(config.liquidationEmergencyRatio < config.liquidationReduceRatio && config.liquidationReduceRatio < config.liquidationWarningRatio && config.liquidationWarningRatio < config.liquidationResumeRatio && config.liquidationResumeRatio <= 1)) {
    throw new Error("Liquidation ratios must increase in emergency < reduce < warning < resume order");
  }
  return Object.freeze({ ...config });
}

export function loadConfig(argv) {
  return validateConfig({ ...defaults, ...parseCliArgs(argv) });
}

export function validateLiveEnvironment(env = process.env) {
  if (!/^0x[0-9a-fA-F]{64}$/.test(env.HL_PRIVATE_KEY ?? "")) throw new Error("HL_PRIVATE_KEY must be a 32-byte 0x-prefixed private key when dryRun=false");
  if (!/^0x[0-9a-fA-F]{40}$/.test(env.HL_ACCOUNT_ADDRESS ?? "")) throw new Error("HL_ACCOUNT_ADDRESS must be a 20-byte 0x-prefixed address when dryRun=false");
  if (env.HL_VAULT_ADDRESS && !/^0x[0-9a-fA-F]{40}$/.test(env.HL_VAULT_ADDRESS)) throw new Error("HL_VAULT_ADDRESS is invalid");
  return {
    privateKey: env.HL_PRIVATE_KEY,
    accountAddress: env.HL_ACCOUNT_ADDRESS,
    vaultAddress: env.HL_VAULT_ADDRESS || undefined,
  };
}

export function helpText() {
  return `Hyperliquid continuous grid bot

Usage:
  npm run dry-run
  npm start -- --dry-run=false --preview=true --market=BTC

All config.js keys can be overridden as kebab-case flags, for example:
  --grid-mode=volatility --buy-grids=12 --sell-mult=1.5
`;
}
