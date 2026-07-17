# Hyperliquid Continuous Grid Bot

A Node.js 22 CLI for building and maintaining fixed-range or volatility-scaled grids on Hyperliquid perpetual markets.

The safe default is a read-only BTC mainnet simulation. It fetches every core and HIP-3 perpetual market, prefers USDC collateral, selects the eligible BTC market with the highest open interest, and prints the orders without loading a private key.

> **High risk:** Live mode uses the selected market's maximum isolated leverage because that is the requested strategy. The circuit breakers reduce risk; they cannot guarantee a profit, prevent every liquidation, or eliminate slippage. Use a dedicated API wallet and testnet first.

## Requirements and setup

- Node.js 22.12 or newer
- A Hyperliquid account and dedicated API wallet for live mode only

```powershell
npm.cmd install
npm.cmd test
npm.cmd run dry-run
```

The default simulation needs no `.env` file. It uses live public mainnet data, prints 16 sells and 16 buys, and exits.

To try the public testnet data path:

```powershell
npm.cmd run testnet:smoke
```

## Configuration

Edit `config.js` for persistent defaults, or override any key as a kebab-case CLI flag:

```powershell
npm.cmd start -- --grid-mode=volatility --buy-grids=12 --sell-grids=12
npm.cmd start -- --market=WTIOIL --from-mid-price=8 --buy-mult=1.25
```

Important defaults:

| Setting | Default | Meaning |
| --- | ---: | --- |
| `dryRun` | `true` | Print one grid and exit without signing |
| `preview` | `true` | Require Enter before every routine live order batch |
| `buyGrids` / `sellGrids` | `16` | Orders on each side |
| `gridMode` | `fixed` | `fixed` or `volatility` |
| `fromMidPrice` | `10` | Fixed grid outer distance in percent |
| `minOrderNotional` / `maxOrderNotional` | `10` / `30` | Linear inner-to-outer notional schedule |
| `buyMult` / `sellMult` | `1` / `1` | Side-specific notional multipliers |
| `rebuildIntervalHours` | `24` | Full cancel/reanchor interval |
| `maxEmergencySlippageBps` | `100` | Live entry depth check and risk IOC cap |

`volatility` mode uses closed 4h candle log returns from the trailing seven days. It scales the sample deviation by `sqrt(42)` and uses `mid × exp(±weeklySigma)` as the outer grid bounds.

## Live mode

Copy `.env.example` to `.env` and provide a dedicated wallet:

```dotenv
HL_PRIVATE_KEY=0x...
HL_ACCOUNT_ADDRESS=0x...
HL_VAULT_ADDRESS=
```

`HL_ACCOUNT_ADDRESS` is the account whose positions, fills, and orders are monitored. `HL_PRIVATE_KEY` may be its key or an approved API-wallet key. Never commit `.env`.

Start on testnet first:

```powershell
npm.cmd start -- --network=testnet --dry-run=false --preview=true --market=BTC
```

Mainnet live mode is explicit:

```powershell
npm.cmd start -- --network=mainnet --dry-run=false --preview=true --market=BTC
```

Routine initial, paired, and rebuild orders obey `preview`. Authorized liquidation-risk reductions bypass the prompt because waiting for terminal input could make liquidation more likely.

## Continuous behavior

- Orders are post-only (`Alo`) and tagged with deterministic 128-bit client IDs.
- Only client IDs recorded in the ignored `state/` directory are canceled.
- An exposure-opening fill creates a reduce-only order one grid interval toward the anchor. A completed exit rearms its entry.
- Every 24 hours the bot cancels its own orders, refreshes the midpoint, reanchors any position exit, and rebuilds.
- On restart it reconciles persisted client IDs with actual open orders before submitting.
- Ctrl+C cancels exposure-increasing bot orders, preserves valid reduce-only exits, saves state, and closes the WebSocket.

## Risk controls

- Live startup refuses to trade unless both sides of the book can flatten the configured maximum position within 100 bps.
- At 60% of the position's initial liquidation-price buffer, exposure-increasing orders are canceled.
- At 40%, the bot cancels its orders and starts four reduce-only IOC slices. At 20%, the next slice targets the full remainder.
- A three-sigma adverse 4h move pauses new exposure. Trading resumes only after the move stays below one sigma for 60 minutes, account risk is safe, and exit depth is available.
- Network ambiguity moves the bot into reconciliation instead of blindly resubmitting.

## Tests

`npm test` uses Node's built-in test runner. Signed exchange calls are never made. Coverage includes market ranking and volume fallback, HIP-3 IDs, precision, minimum notional, both grid modes, partial/flipping fills, persistence, depth checks, and the 60/40/20 risk thresholds.
