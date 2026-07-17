import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

function safePart(value) {
  return String(value).replace(/[^a-zA-Z0-9_-]/g, "_");
}

export function statePath(root, network, market) {
  return path.join(root, "state", `${safePart(network)}-${safePart(market)}.json`);
}

export function initialState(network, market, now = Date.now()) {
  return {
    version: 1,
    botId: randomUUID(),
    network,
    market,
    phase: "STARTING",
    generation: 0,
    anchorMid: null,
    weeklySigma: null,
    orders: {},
    cycles: {},
    lastProcessedFillIds: [],
    initialLiquidationDistance: null,
    calmSince: null,
    nextRebuildAt: now,
    updatedAt: now,
  };
}

export async function loadState(file, network, market) {
  try {
    const parsed = JSON.parse(await readFile(file, "utf8"));
    if (parsed.version !== 1 || parsed.network !== network || parsed.market !== market) throw new Error(`State file ${file} does not match this bot configuration`);
    return parsed;
  } catch (error) {
    if (error.code === "ENOENT") return initialState(network, market);
    throw error;
  }
}

export async function saveState(file, state) {
  await mkdir(path.dirname(file), { recursive: true });
  state.updatedAt = Date.now();
  const temporary = `${file}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(state, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  await rename(temporary, file);
}

export function makeCloid(state, key) {
  const digest = createHash("sha256").update(`hl-grid-v1|${state.botId}|${state.generation}|${key}`).digest("hex").slice(0, 32);
  return `0x${digest}`;
}

export function rememberFill(state, fillId, maximum = 2000) {
  if (state.lastProcessedFillIds.includes(fillId)) return false;
  state.lastProcessedFillIds.push(fillId);
  if (state.lastProcessedFillIds.length > maximum) state.lastProcessedFillIds.splice(0, state.lastProcessedFillIds.length - maximum);
  return true;
}

export function ownedOpenOrders(state, openOrders) {
  const owned = new Set(Object.keys(state.orders));
  return openOrders.filter((order) => order.cloid && owned.has(order.cloid));
}
