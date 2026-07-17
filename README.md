# Hyperliquid Continuous Grid Bot

A Node.js 22 CLI for fixed-range, volatility-scaled, and directional pyramid strategies on Hyperliquid perpetual markets.

The safe default is a read-only BTC mainnet simulation. It fetches every core and HIP-3 perpetual market, prefers USDC collateral, selects the eligible BTC market with the highest open interest, and prints orders without loading a private key.

> **High risk:** Live mode uses the selected market's maximum isolated leverage. Pyramiding intentionally increases exposure after a move has started, so a reversal can rapidly increase losses. Circuit breakers cannot guarantee profit, prevent every liquidation, or eliminate slippage. Use a dedicated API wallet and testnet first.

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

# Sell entries only
npm.cmd run dry-run -- --short
```

These flags filter exposure-opening orders. They never block a required reduce-only order on the opposite side.

## Pyramid strategy

`--pyramid` is a trend-following position-building strategy. It is designed to add to winning positions:
`--long --pyramid`: buy stop-limits above midprice; additional buys trigger as price rises.
`--short --pyramid`: sell stop-limits below midprice; additional sells trigger as price falls.
`--pyramid` alone arms both breakout directions while flat; the bot cancels its opposite-side triggers after the first fill.
Layers decrease linearly from maxOrderNotional toward minOrderNotional, while cumulative position exposure increases.
Existing positions only receive additions beyond their weighted entry—never on their losing side.
Pyramid fills are excluded from the normal countertrend grid rearm cycle.

- Long pyramid: buy stop-limit triggers are placed above the anchor. Higher levels add to the long only as price rises.
- Short pyramid: sell stop-limit triggers are placed below the anchor. Lower levels add to the short only as price falls.
- The first layer is the largest and later additions become successively smaller, from `maxOrderNotional` toward `minOrderNotional`. This follows the common pyramid shape while cumulative position size still increases.
- If both directions are armed while flat, the first pyramid fill cancels the bot's opposite-direction triggers.
- When rebuilding an existing long or short, additions on the losing side of its weighted entry are discarded.

Hyperliquid requires conditional stops for this behavior: a normal buy limit above mid or sell limit below mid would execute immediately. The bot therefore sends stop-limit trigger orders with the trigger and limit at the displayed level. A price gap can leave a triggered limit unfilled rather than accepting uncontrolled market-order slippage. See [Hyperliquid order types](https://hyperliquid.gitbook.io/hyperliquid-docs/trading/order-types) and the [exchange trigger payload](https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api/exchange-endpoint).

Examples:

```powershell
# Buy strength as BTC rises
npm.cmd run dry-run -- --long --pyramid

# Sell weakness as BTC falls
npm.cmd run dry-run -- --short --pyramid

# Arm both breakout directions; the unchosen side is canceled after the first fill
npm.cmd run dry-run -- --pyramid

# Six long layers ranging from $160 down toward $10
npm.cmd run dry-run -- --long --pyramid --buy-grids=6 --max-order-notional=160
```

## Configuration

Edit `config.js` for persistent defaults, or override a key as a kebab-case CLI flag:

```powershell
npm.cmd start -- --grid-mode=volatility --buy-grids=12 --sell-grids=12
npm.cmd start -- --market=WTIOIL --from-mid-price=8 --buy-mult=1.25
```

| Setting | Default | Meaning |
| --- | ---: | --- |
| `dryRun` | `true` | Print one plan and exit without signing |
| `preview` | `true` | Require Enter before every routine live order batch |
| `buyGrids` / `sellGrids` | `16` | Levels available to each strategy side |
| `gridMode` | `fixed` | `fixed` or `volatility` |
| `fromMidPrice` | `10` | Fixed outer distance in percent |
| `minOrderNotional` / `maxOrderNotional` | `10` / `30` | Linear grid bounds; pyramid smallest/largest layer |
| `buyMult` / `sellMult` | `1` / `1` | Side-specific notional multipliers |
| `rebuildIntervalHours` | `24` | Full cancel/reanchor interval |
| `maxEmergencySlippageBps` | `100` | Live entry depth check and risk IOC cap |

Volatility mode uses closed 4h candle log returns from the trailing seven days. It scales sample deviation by `sqrt(42)` and uses `mid * exp(+/-weeklySigma)` as the strategy bounds.

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
npm.cmd start -- --network=testnet --dry-run=false --preview=true --market=BTC --long --pyramid
```

Mainnet live mode is explicit:

```powershell
npm.cmd start -- --network=mainnet --dry-run=false --preview=true --market=BTC --long --pyramid
```

Routine initial and rebuild orders obey `preview`. Authorized liquidation-risk reductions bypass the prompt because waiting for terminal input could make liquidation more likely.

## Continuous behavior and risk controls

- Range-grid entries are post-only. Pyramid entries are stop-limit triggers. Every bot order has a deterministic 128-bit client ID.
- Only client IDs recorded in the ignored `state/` directory are canceled.
- A range-grid opening fill creates a paired reduce-only exit and a completed cycle rearms its entry. Pyramid additions are not converted into countertrend grid cycles.
- When a two-direction pyramid first fills, the bot cancels its unchosen direction. Manual and unrelated orders remain untouched.
- Changing side flags or upgrading from the old doubling pyramid forces a fresh rebuild instead of resuming incompatible orders.
- Every 24 hours the bot refreshes the midpoint, previews replacements, then cancels and reanchors its own orders.
- Live startup requires enough book depth to flatten the configured maximum position within 100 bps.
- At 60% of the initial liquidation buffer, exposure-increasing orders are canceled. At 40%, four reduce-only IOC slices begin; at 20%, the next slice targets the full remainder.
- A three-sigma adverse 4h move pauses exposure. Trading resumes only after one-sigma calm persists for 60 minutes and account/depth checks pass.
- Network ambiguity triggers client-ID reconciliation instead of blind resubmission.
- Ctrl+C cancels exposure-increasing bot orders, preserves valid exits, saves state, and closes the WebSocket.

## Tests

`npm test` uses Node's built-in runner and never makes signed exchange calls. Coverage includes market ranking, volume fallback, HIP-3 IDs, precision, both range modes, side aliases, directional pyramid prices and sizing, Hyperliquid trigger serialization, opposite-breakout cancellation, protective exits, partial/flipping fills, persistence, depth checks, and risk thresholds.
