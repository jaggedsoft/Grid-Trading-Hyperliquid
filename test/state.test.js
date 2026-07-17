import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { loadState, makeCloid, rememberFill, saveState, statePath } from "../src/state.js";

test("state is persisted atomically and client IDs are deterministic", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "hl-grid-test-"));
  const file = statePath(root, "mainnet", "xyz:BTC");
  const state = await loadState(file, "mainnet", "xyz:BTC");
  const first = makeCloid(state, "buy-1");
  const second = makeCloid(state, "buy-1");
  assert.match(first, /^0x[0-9a-f]{32}$/);
  assert.equal(first, second);
  state.phase = "ACTIVE";
  await saveState(file, state);
  assert.equal(JSON.parse(await readFile(file, "utf8")).phase, "ACTIVE");
});

test("fill deduplication remembers each fill once", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "hl-grid-test-"));
  const state = await loadState(statePath(root, "mainnet", "BTC"), "mainnet", "BTC");
  assert.equal(rememberFill(state, "fill-1"), true);
  assert.equal(rememberFill(state, "fill-1"), false);
});
