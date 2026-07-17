# Hyperliquid Continuous Grid Bot

A Node.js 22 CLI for fixed-range, volatility-scaled, and capped pyramid grids on Hyperliquid perpetual markets.

The safe default is a read-only BTC mainnet simulation. It fetches every core and HIP-3 perpetual market, prefers USDC collateral, selects the eligible BTC market with the highest open interest, and prints orders without loading a private key.

> **High risk:** Live mode uses the selected market's maximum isolated leverage. Pyramid sizing deliberately increases exposure into an adverse trend. Circuit breakers reduce risk but cannot guarantee profit, prevent every liquidation, or eliminate slippage. Use a dedicated API wallet and testnet first.

## Requirements and setup

- Node.js 22.12 or newer
- A Hyperliquid account and dedicated API wallet for live mode only

```powershell
npm.cmd install
npm.cmd test
npm.cmd run dry-run
```

The default simulation needs no `.env` file. It uses live mainnet data, prints 16 sells and 16 buys, and exits.

## Entry-side flags

Use either the directional name or its order-side alias:

```powershell
# Buy entries only
npm.cmd run dry-run -- --long
npm.cmd run dry-run -- --buy

# Sell entries only
npm.cmd run dry-run -- --short
npm.cmd run dry-run -- --sell

# Both sides (also the default when no side flag is present)
npm.cmd run dry-run -- --long --short
```

These flags filter exposure-opening grid orders. They never block a required reduce-only order on the opposite side. For example, a long-only grid can still place sell exits for filled buys.

## Pyramid strategy

`--pyramid` doubles the target notional at each level farther from midprice. It always stops at `maxOrderNotional`, applied with the side multiplier:

```powershell
# Default cap: $10, $20, $30, $30 ...
npm.cmd run dry-run -- --long --pyramid

# Wider progression: $10, $20, $40, $80, $160, $160 ...
npm.cmd run dry-run -- --long --pyramid --max-order-notional=160

# Short pyramid with a 1.5 sell multiplier: $15, $30, $60 ... capped at $240
npm.cmd run dry-run -- --short --pyramid --max-order-notional=160 --sell-mult=1.5
```

Using `--pyramid` without a side flag applies doubling independently to both buy and sell grids. The automatically derived maximum-position limit uses the resulting active-side total.

## Configuration

Edit `config.js` for persistent defaults, or override a key as a kebab-case CLI flag:

```powershell
npm.cmd start -- --grid-mode=volatility --buy-grids=12 --sell-grids=12
npm.cmd start -- --market=WTIOIL --from-mid-price=8 --buy-mult=1.25
```

| Setting | Default | Meaning |
| --- | ---: | --- |
| `dryRun` | `true` | Print one grid and exit without signing |
| `preview` | `true` | Require Enter before every routine live order batch |
| `buyGrids` / `sellGrids` | `16` | Available levels on each side |
| `gridMode` | `fixed` | `fixed` or `volatility` |
| `fromMidPrice` | `10` | Fixed grid outer distance in percent |
| `minOrderNotional` / `maxOrderNotional` | `10` / `30` | Linear bounds or pyramid start/cap |
| `buyMult` / `sellMult` | `1` / `1` | Side-specific notional multipliers |
| `rebuildIntervalHours` | `24` | Full cancel/reanchor interval |
| `maxEmergencySlippageBps` | `100` | Live entry depth check and risk IOC cap |

Volatility mode uses closed 4h candle log returns from the trailing seven days. It scales sample deviation by `sqrt(42)` and uses `mid * exp(+/-weeklySigma)` as the grid bounds.

To try public testnet data:

```powershell
npm.cmd run testnet:smoke
```

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
npm.cmd start -- --network=testnet --dry-run=false --preview=true --market=BTC --long
```

Mainnet live mode is explicit:

```powershell
npm.cmd start -- --network=mainnet --dry-run=false --preview=true --market=BTC --long --pyramid
```

Routine initial, paired, and rebuild orders obey `preview`. Authorized liquidation-risk reductions bypass the prompt because waiting for terminal input could make liquidation more likely.

## Continuous behavior and risk controls

- Orders are post-only (`Alo`) and tagged with deterministic 128-bit client IDs.
- Only client IDs recorded in the ignored `state/` directory are canceled.
- An exposure-opening fill creates a reduce-only opposite order one interval toward the anchor. A completed exit rearms its entry.
- Changing side or pyramid flags forces a fresh rebuild instead of resuming incompatible persisted orders.
- Every 24 hours the bot refreshes the midpoint, previews replacements, then cancels and reanchors its own orders.
- Live startup requires enough book depth to flatten the configured maximum position within 100 bps.
- At 60% of the initial liquidation buffer, exposure-increasing orders are canceled. At 40%, four reduce-only IOC slices begin; at 20%, the next slice targets the full remainder.
- A three-sigma adverse 4h move pauses exposure. Trading resumes only after one-sigma calm persists for 60 minutes and account/depth checks pass.
- Network ambiguity triggers client-ID reconciliation instead of blind resubmission.
- Ctrl+C cancels exposure-increasing bot orders, preserves valid exits, saves state, and closes the WebSocket.

## Tests

`npm test` uses Node's built-in runner and never makes signed exchange calls. Coverage includes market ranking, volume fallback, HIP-3 IDs, precision, both range modes, side aliases, pyramid caps and multipliers, protective exits, partial/flipping fills, persistence, depth checks, and risk thresholds.
