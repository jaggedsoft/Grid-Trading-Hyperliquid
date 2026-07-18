# Hyperliquid Continuous Grid Bot

A Node.js trading bot for fixed-range, volatility-scaled, and directional pyramid strategies on Hyperliquid perpetual markets.

The safe default is a read-only BTC mainnet simulation. It fetches every core and HIP-3 perpetual market, prefers USDC collateral, selects the eligible market with the highest open interest, and prints orders without loading a private key.

> **High risk:** Live mode defaults to the selected market's maximum isolated leverage. Use `--leverage=<integer>` to choose a lower value. Neither a trailing stop nor a profitable-price calculation can guarantee profit: gaps, fees changing, funding, latency, unavailable liquidity, and unfilled stop-limits can still cause losses. Use a dedicated API wallet and testnet first.

## Requirements and setup

- Node.js 22.12 or newer
- A Hyperliquid account and dedicated API wallet for live mode only

```bash
npm install
npm test
npm run dry-run
```

The default simulation needs no `.env` file. It uses live mainnet data, prints 16 sells and 16 buys, and exits.

## Entry-side flags

Use either the directional name or its order-side alias:

```bash
# Buy entries only
npm run dry-run -- --long

# Sell entries only
npm run dry-run -- --short
```

These flags filter exposure-opening orders. They never block a required reduce-only order on the opposite side.

## Pyramid strategy

- `--pyramid` is a trend-following position-building strategy. It is designed to add to winning positions:
- `--long --pyramid`: buy stop-limits above midprice; additional buys trigger as price rises.
- `--short --pyramid`: sell stop-limits below midprice; additional sells trigger as price falls.
- `--pyramid` alone arms both breakout directions while flat; the bot cancels its opposite-side triggers after the first fill.
- Layers decrease linearly from maxOrderNotional toward minOrderNotional, while cumulative position exposure increases.
- Existing positions only receive additions beyond their weighted entry—never on their losing side.
- Pyramid fills are excluded from the normal countertrend grid rearm cycle.

- Long pyramid: buy stop-limit triggers are placed above the anchor. Higher levels add to the long only as price rises.
- Short pyramid: sell stop-limit triggers are placed below the anchor. Lower levels add to the short only as price falls.
- The first layer is the largest and later additions become successively smaller, from `maxOrderNotional` toward `minOrderNotional`.
- If both directions are armed while flat, the first pyramid fill cancels the bot's opposite-direction triggers.
- When rebuilding an existing position, additions on the losing side of its weighted entry are discarded.

Hyperliquid requires conditional stops for this behavior. The bot sends stop-limit trigger orders with the trigger and limit at the displayed level. See [Hyperliquid order types](https://hyperliquid.gitbook.io/hyperliquid-docs/trading/order-types) and the [exchange trigger payload](https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api/exchange-endpoint).

```bash
npm run dry-run -- --long --pyramid
npm run dry-run -- --short --pyramid
npm run dry-run -- --pyramid
npm run dry-run -- --long --pyramid --buy-grids=6 --max-order-notional=160
```

## Fee-aware profit protection

Profit protection is enabled by default and operates on the account's aggregate one-way position.

### Trailing stop

`trailingStopPercent=1` tracks the most favorable mark after an opening fill:

- Long: the high-water mark rises with price and the stop trails below it.
- Short: the low-water mark falls with price and the stop trails above it.
- The stop activates only when its worst permitted stop-limit execution price is beyond fee-adjusted breakeven.
- Once active, the stop only tightens; it never moves away from the market.
- Position-size changes update the reduce-only stop size.

Hyperliquid does not document a native trailing order. The bot therefore maintains a fixed reduce-only stop-limit and atomically modifies it by client order ID when the watermark improves. The process must remain online to advance the trail. If it disconnects, the last successfully submitted exchange-native stop remains, but it no longer trails.

```bash
# Trail 0.75% behind the favorable watermark
npm run dry-run -- --trailing-stop-percent=0.75

# Disable trailing protection
npm run dry-run -- --trailing-stop-percent=0
```

The stop-limit permits at most `maxEmergencySlippageBps` between trigger and limit. Its limit must still be fee-profitable before activation. A gap through the limit can leave it unfilled.

### Profitable derisk

`deriskPercent=25` makes one automatic attempt per net position lifecycle to close 25% of the current base size once mark price moves beyond fee-adjusted breakeven. It submits a reduce-only IOC whose limit is the calculated breakeven boundary, so it will not deliberately accept a worse price.

```bash
# Close 40% once estimated net PnL is positive
npm run dry-run -- --derisk-percent=40

# Disable automatic derisk
npm run dry-run -- --derisk-percent=0
```

The calculation uses:

- Actual entry fee rates observed in bot-owned fills, when available. Hyperliquid fills include `fee` and `feeToken` fields. [Fill schema](https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api/info-endpoint)
- The account's current taker rate from `userFees` for the estimated closing fee. [Fee endpoint and formula](https://hyperliquid.gitbook.io/hyperliquid-docs/trading/fees)
- `feeFallbackTakerBps=5` if the fee endpoint is unavailable.
- An additional `profitFeeBufferBps=2` safety margin.

Funding payments are not trading fees and are not included. If the requested partial size is below Hyperliquid's lot or $10 minimum, the bot waits and retries if the position grows.

Trailing-stop activation, stop tightening, and profitable derisk reductions are explicitly authorized protective actions and bypass `preview`; waiting for terminal input would defeat their purpose.

## Configuration

Edit `config.js` for persistent defaults, or override a key as a kebab-case CLI flag:

```bash
npm run dry-run -- --leverage=5 --trailing-stop-percent=0.75 --derisk-percent=30
npm start -- --grid-mode=volatility --buy-grids=12 --sell-grids=12
npm start -- --market=WTIOIL --from-mid-price=8 --buy-mult=1.25
```

| Setting | Default | Meaning |
| --- | ---: | --- |
| `dryRun` | `true` | Print one plan and exit without signing |
| `preview` | `true` | Require Enter before routine live batches |
| `leverage` | `max` | `max` or a positive integer within the market maximum |
| `trailingStopPercent` | `1` | Distance behind favorable watermark; `0` disables |
| `deriskPercent` | `25` | Current position percentage reduced once net-profitable; `0` disables |
| `profitFeeBufferBps` | `2` | Additional breakeven safety margin |
| `feeFallbackTakerBps` | `5` | Conservative fee rate used if `userFees` is unavailable |
| `trailingStopUpdateBps` | `5` | Minimum favorable stop improvement before modifying it |
| `buyGrids` / `sellGrids` | `16` | Levels available to each strategy side |
| `gridMode` | `fixed` | `fixed` or `volatility` |
| `fromMidPrice` | `10` | Fixed outer distance in percent |
| `minOrderNotional` / `maxOrderNotional` | `10` / `30` | Grid bounds; pyramid smallest/largest layer |
| `buyMult` / `sellMult` | `1` / `1` | Side-specific notional multipliers |
| `rebuildIntervalHours` | `24` | Full cancel/reanchor interval |
| `maxEmergencySlippageBps` | `100` | Exit depth, emergency IOC, and trailing stop-limit cap |

Volatility mode uses closed 4h candle log returns from the trailing seven days and scales sample deviation by `sqrt(42)`.

## Live mode

Copy `.env.example` to `.env` and provide a dedicated wallet:

```dotenv
HL_PRIVATE_KEY=0x...
HL_ACCOUNT_ADDRESS=0x...
HL_VAULT_ADDRESS=
```

`HL_ACCOUNT_ADDRESS` is the account whose positions, fills, fees, and orders are monitored. Never commit `.env`.

Start on testnet first:

```bash
npm start -- --network=testnet --dry-run=false --preview=true --market=BTC --long --pyramid --leverage=3 --trailing-stop-percent=1 --derisk-percent=25
```

Mainnet live mode remains explicit:

```bash
npm start -- --network=mainnet --dry-run=false --preview=true --market=BTC --long --pyramid --leverage=5
```

## Continuous behavior and risk controls

- Range-grid entries are post-only. Pyramid entries and protective stops are stop-limit triggers.
- Every bot order has a deterministic 128-bit client ID; unrelated orders are never canceled.
- A range-grid opening fill creates a paired reduce-only exit. Profit protection independently follows the aggregate remaining position.
- Every 24 hours the bot refreshes the midpoint, previews replacements, then reanchors its own grid orders.
- Live startup requires enough book depth to flatten the configured maximum position within the configured slippage.
- At 60% of initial liquidation buffer, exposure-increasing orders are canceled. At 40%, four reduce-only IOC slices begin; at 20%, the next slice targets the full remainder.
- A three-sigma adverse 4h move pauses exposure; one-sigma calm for 60 minutes is required to resume.
- Network ambiguity stops new sends and triggers client-ID reconciliation.
- Ctrl+C cancels exposure-increasing bot orders, preserves valid reduce-only exits and trailing stops, saves state, and closes the WebSocket.

## Tests

`npm test` uses Node's built-in runner and mocks signed Exchange calls. Coverage includes market ranking, leverage, grid precision, pyramid triggers, fee-aware breakeven math, actual fill-fee rates, profitable partial IOC sizing, trailing activation and tightening, persistence, depth checks, and liquidation controls.

Note: For Windows machines, use `npm.cmd` in place of `npm`