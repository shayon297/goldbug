# Goldbug Trading Bot - UX/UI Flow Document

> Generated: January 31, 2026
> Bot: @goldbug_tradingbot

---

## Table of Contents
1. [User States](#user-states)
2. [Commands](#commands)
3. [Callback Actions](#callback-actions)
4. [Natural Language Parsing](#natural-language-parsing)
5. [Error States](#error-states)
6. [Mini App Flows](#mini-app-flows)

---

## User States

### New User (No Wallet Connected)
**Condition:** `!userExists(telegramId)`

Any command shows:
```
Please connect your wallet first.
[🔗 Connect Wallet] (opens Mini App)
```

### Returning User (Wallet Connected)
**Condition:** `userExists(telegramId) && user.walletAddress`

Full functionality available.

### User with Funds on Arbitrum but not Hyperliquid
**Condition:** `arbUsdc >= 5 && hlBalance < 5`

Shows in `/status` and `/balance`:
```
⚠️ *You have USDC on Arbitrum!*
Use /bridge to move it to Hyperliquid
```

---

## Commands

### `/start`

#### New User
```
🥇 *Trade Gold. Keep Your Edge.*

Tired of MT4 spreads eating your profits?

Goldbug gives you:
• *0.01% fees* (vs 0.5%+ on MT4/MT5)
• *Up to 20x leverage* on gold
• *No broker* — trade directly on-chain
• *Instant withdrawals* — your money, your keys

━━━━━━━━━━━━━━━━━━━━
*Setup in 4 steps:*

1️⃣ Create wallet (30 sec)
2️⃣ Fund with card or crypto
3️⃣ Bridge to Hyperliquid
4️⃣ Trade gold

👇 *Tap below to start*

[🚀 Start Trading] (opens Mini App)
```

#### Returning User (Normal)
```
🥇 *xyz:GOLD Trading Bot*

💰 *Balance:* $XX.XX
📊 *Position:* LONG 0.0001 @ $2800 (+$5.00) | "No position"
📋 *Orders:* 2 open | "none"
💲 *Price:* $2850.00

[📈 Long] [📉 Short]
[📊 Position] [📋 Orders]
[💰 Details] [⚙️ Settings]
```

#### Returning User with Deep Link (`/start trade_L_100_10_m`)
**Condition:** Valid trade deep link parsed

```
📋 *Shared Trade*

📈 LONG xyz:GOLD
Size: $100 (~0.035 GOLD)
Leverage: 10x
Type: Market
Est. Entry: ~$2850

_Tap Execute to copy this trade_

[✅ Execute] [❌ Cancel]
```

#### Invalid/Expired Deep Link
```
⚠️ Trade link expired or invalid

[Shows normal dashboard]
```

---

### `/help`

```
🥇 *Goldbug Commands*

*Trade:*
`/long $100 5x` — Go long
`/short $50 10x` — Go short
`/close` — Close position

*Monitor:*
`/status` — Balance & position
`/chart` — Price chart

*Fund:*
`/fund` — Buy or bridge USDC

*Earn Points:*
Share your trades → Earn ⭐ points
Points unlock future bonuses & discounts

💡 _Type naturally: "long 100 5x" works too!_
```

---

### `/status` / `/balance`

```
🏦 *Wallet*
`0x92d00db3758ed00ebe97594ab924f5dace0e176d`

💎 *Hyperliquid*
💰 Balance: $XX.XX
💵 Withdrawable: $XX.XX

🔷 *Arbitrum*
💵 USDC: $XX.XX
⛽ ETH: 0.0000

📊 *xyz:GOLD Position*
📈 LONG 0.0001 xyz:GOLD @ 10x
Entry: $2800.00
🟢 PnL: $5.00

💲 *xyz:GOLD Price*: $2850.00

⭐ *Goldbug Points*: 150
_Share trades to earn rewards_

[💳 Buy USDC] [🌉 Bridge] [🔄 Refresh]
```

---

### `/fund`

```
💰 *Manage Funds*

*Your Wallet:*
`0x92d00db3...e176d`

Choose an option:

[💳 Buy USDC] (opens Mini App → onramp)
[🌉 Bridge to Hyperliquid] (opens Mini App → bridge)
[🏦 Withdraw to Bank] (opens Mini App → offramp)
[🏠 Main Menu]
```

---

### `/price`

```
💲 *xyz:GOLD*: $2,850.00

Ready to trade?

[📈 Long] [📉 Short]
[📊 View Chart]
```

---

### `/chart`

1. Sends: `📊 Generating chart...`
2. Fetches 48 x 5-minute candles
3. Generates chart image via QuickChart
4. Sends photo with caption:

```
📊 *xyz:GOLD 5m Chart*

💲 Current: $2850.00
📈 High: $2860.00
📉 Low: $2840.00
📊 Change: +0.35%
```

---

### `/long` / `/short`

#### With Arguments (`/long $100 5x`)
**Valid command parsed:**
```
*Confirm Order*

📈 LONG xyz:GOLD
Size: $100 (~0.035 GOLD)
Leverage: 5x
Type: Market
Est. Entry: ~$2850

[✅ Confirm] [❌ Cancel]
```

**With leverage warning (existing isolated position at different leverage):**
```
*Confirm Order*

⚠️ *Leverage Warning*
You have an existing 10x isolated position.
This trade will be added at 10x (not 5x).
_To use 5x, close position first._

📈 LONG xyz:GOLD
Size: $100 (~0.035 GOLD)
...
```

**Invalid command:**
```
❌ Invalid command. Try /long $10 2x
```

#### Without Arguments (`/long`)
Starts guided flow:
```
📈 LONG xyz:GOLD

Select size:

[$25] [$50] [$100]
[$250] [$500] [Custom]
```

---

### `/close`

**Has position:**
```
🔴 *Close Position?*

LONG 0.0050 xyz:GOLD
Current PnL: $12.50

[✅ Close Position] [❌ Cancel]
```

**No position:**
```
No position to close.
```

---

### `/cancel`

**Has orders:**
```
✅ Cancelled 3 order(s).
```

**No orders:**
```
No open orders to cancel.
```

---

### `/orders`

**Has orders:**
```
📋 *Open xyz:GOLD Orders*

📈 BUY 0.01 @ $2800 (#12345)
📉 SELL 0.01 @ $2900 (#12346)

[Cancel #12345] [Cancel #12346]
[Cancel All] [« Back]
```

**No orders:**
```
📋 *No Open Orders*
```

---

### `/fills`

```
*Recent Fills (xyz:GOLD)*

• B 0.0100 @ $2850.00 (oid 12345)
  1/31/2026, 2:30:00 PM
• S 0.0050 @ $2860.00 (oid 12344)
  1/31/2026, 1:15:00 PM
```

---

### `/position`

**Has position:**
```
📊 *xyz:GOLD Position*

📈 LONG 0.0100 xyz:GOLD
📊 Leverage: 10x
💵 Entry: $2800.00
🟢 PnL: $50.00
⚠️ Liquidation: $2520.00

[🔴 Close] [📊 Add to Position]
[🔄 Refresh] [« Back]
```

**No position:**
```
📊 *No xyz:GOLD Position*

Open a position to get started.
```

---

### `/deposit`

```
💰 *How to Fund Your Wallet*

💳 *Your Wallet:*
`0x92d00db3758ed00ebe97594ab924f5dace0e176d`

*Step 1: Get USDC on Arbitrum*
• Buy USDC on an exchange (Coinbase, Binance, etc.)
• Withdraw to your wallet on *Arbitrum One*
• Or bridge from another chain to Arbitrum

*Step 2: Deposit to Hyperliquid*
• Go to [app.hyperliquid.xyz](https://app.hyperliquid.xyz)
• Connect the same wallet you linked here
• Click *Deposit* and select USDC amount
• Confirm the transaction (~$0.01 gas)

*Step 3: Start Trading!*
• Your USDC balance appears automatically
• Use /long or /short to open positions
• Trading on Hyperliquid is *gasless* ⚡

💡 *Minimum:* $10 USDC to start trading
```

---

### `/bridge`

```
🌉 *Bridge USDC to Hyperliquid*

Your wallet:
`0x92d00db3758ed00ebe97594ab924f5dace0e176d`

Tap the button below to bridge your USDC from Arbitrum to Hyperliquid instantly.

[🌉 Bridge Now] (opens Mini App → bridge)
```

---

### `/onramp`

```
💳 *Buy USDC*

Purchase USDC with card, bank transfer, or other payment methods.
KYC may be required depending on your region.

[💳 Buy USDC] (opens Mini App → onramp)
```

---

### `/withdraw` / `/offramp`

```
🏦 *Withdraw to Bank*

💎 *Hyperliquid:* $150.00 withdrawable
🔷 *Arbitrum:* $25.00 USDC

_Step 1:_ Unbridge from Hyperliquid to Arbitrum
_Step 2:_ Sell USDC to fiat

[📤 Unbridge $150.00]
[🏦 Sell USDC to Fiat] (opens Mini App → offramp)
[« Back]
```

**After clicking "Unbridge":**
```
⏳ Withdrawing $150.00 from Hyperliquid to Arbitrum...
```

**Successful unbridge:**
```
✅ *Withdrawal Initiated*

$150.00 USDC is being transferred to Arbitrum.

⏱️ This takes 1-5 minutes. Once confirmed, tap below to sell:

[🏦 Sell USDC to Fiat]
[🔄 Refresh Balance]
```

**If only Arbitrum has funds (HL withdrawable < $1):**
Only shows `[🏦 Sell USDC to Fiat]` button.

**If neither has $1+:**
```
⚠️ Minimum $1 required to withdraw.
```

---

### `/debug`

```
🔧 *Debug Info*

*Wallet:* `0x92d00db3758ed00ebe97594ab924f5dace0e176d`
*Agent:* `0x1b57292b50f1a33addcac99eff5c67036f027902`

Compare this agent address with what's approved on Hyperliquid.
```

---

## Callback Actions

### Order Flow

#### `action:long` / `action:short`
Starts guided order flow → size selection

#### `size:25` / `size:50` / `size:100` / `size:250` / `size:500`
Sets size, advances to leverage selection:
```
Size: $100

Select leverage:

[2x] [3x] [5x]
[7x] [10x] [15x] [20x]
```

#### `size:custom`
```
Enter custom size (min $10, e.g., "$750" or "750"):
```

#### `leverage:X`
Sets leverage, advances to order type:
```
LONG xyz:GOLD
Size: $100
Leverage: 5x

Select order type:

[⚡ Market] [📝 Limit]
```

**If margin too small (size/leverage < $10):**
```
❌ Minimum margin is $10.
With 20x leverage, minimum size is $200.

Select a larger size:
[$25] [$50] [$100]...
```

#### `type:market`
Shows confirmation screen with current price.

#### `type:limit`
```
Enter limit price (e.g., "2800"):
```
(Then user types price, shows confirmation)

#### `confirm:yes`

1. `⏳ Checking order...`
2. Checks builder fee approval
3. If not approved → shows builder fee approval button (see Error States)
4. `⏳ Executing order...`
5. Result:

**Filled:**
```
✅ *Order Filled*

📈 *LONG* 0.0350 xyz:GOLD
💵 Entry: $2,850.00
📊 Leverage: 5x
💰 Notional: $100.00

[📤 Share Trade] [🔄 Copy Setup]
[📊 View Position] [🏠 Menu]
```

**Limit order placed:**
```
📝 *Limit Order Placed*

📈 *LONG* $100 @ 5x
⏳ Waiting at limit price
🔖 Order ID: #12345

[📊 Position] [📋 Orders]
```

**Error:**
```
❌ Order rejected: [error message]
```

#### `confirm:no`
```
Order cancelled.
```

---

### Position Actions

#### `action:position`
Shows position details (see `/position`)

#### `action:close`
Shows close confirmation (see `/close`)

#### `close:confirm`
1. `⏳ Closing position...`
2. Executes market close
3. Result:

**Filled:**
```
✅ *Position Closed*

Size: 0.0350 xyz:GOLD
Close Price: $2860.00
```

**Resting (limit):**
```
📝 *Close Order Placed*

Order #12345 waiting to fill.
Check /orders to see status.
```

---

### Order Management

#### `action:orders`
Shows open orders (see `/orders`)

#### `cancel_order:12345`
```
✅ Order #12345 cancelled.
```

#### `action:cancel_all`
```
✅ All orders cancelled.
```

---

### Withdraw Actions

#### `withdraw:unbridge:150.00`
1. `⏳ Withdrawing $150.00 from Hyperliquid to Arbitrum...`
2. Calls signer `/l1/withdraw`
3. Success/failure message (see `/withdraw`)

#### `menu:refresh_withdraw`
```
🔷 *Arbitrum Balance*

💵 USDC: $175.00
⛽ ETH: 0.0012

Ready to sell? Tap below:

[🏦 Sell USDC to Fiat]
[🔄 Refresh]
[« Back]
```

---

### Trade Sharing

#### `share:L_100_10_2850` (side_size_leverage_price)
Awards points, generates shareable receipt:
```
📤 *Share this trade:*

🥇 *GOLDBUG TRADE*
━━━━━━━━━━━━━━━━

📈 LONG xyz:GOLD
💰 Size: $100
📊 Leverage: 10x
💵 Entry: $2,850

👉 Copy this trade:
https://t.me/goldbug_tradingbot?start=trade_L_100_10_m

━━━━━━━━━━━━━━━━

⭐ *+25 points!* (Total: 175)
_Forward this message to any group or chat!_
```

#### `copy:L_100_10` (side_size_leverage)
Prefills trade from shared parameters:
```
🔄 *Copy Trade*

📈 LONG xyz:GOLD
Size: $100 (~0.035 GOLD)
Leverage: 10x
Type: Market
Est. Entry: ~$2850

[✅ Confirm] [❌ Cancel]
```

---

### Menu Actions

#### `action:menu` / `action:refresh`
Refreshes dashboard with current balances/position.

#### `menu:main`
Returns to main menu.

#### `action:details`
Shows full account summary (see `/status`)

#### `action:settings`
```
⚙️ *Settings*

[Default Leverage: 5x]
[Default Size: $100]
[« Back]
```

#### `action:chart`
Generates and sends chart (see `/chart`)

---

## Natural Language Parsing

The bot parses free-form text messages:

### Trade Commands
| Input | Parsed As |
|-------|-----------|
| `long 100 5x` | LONG $100 @ 5x market |
| `short $50 10x market` | SHORT $50 @ 10x market |
| `long 25 2x limit 2800` | LONG $25 @ 2x limit $2800 |
| `buy 100 5x` | LONG $100 @ 5x |
| `sell 50 3x` | SHORT $50 @ 3x |

### Close Commands
| Input | Parsed As |
|-------|-----------|
| `close` | Close 100% |
| `close half` | Close 50% |
| `close 25%` | Close 25% |

### Custom Size Input
When in `select_size` step:
- `$750` → sets size to $750
- `750` → sets size to $750
- Invalid → `Please enter a valid number (e.g., "$50" or "50")`
- < $10 → `Minimum size is $10`
- > $100,000 → `Maximum size is $100,000`

---

## Error States

### Builder Fee Not Approved
**Condition:** Trade attempted, builder fee check fails

```
🔒 *One-Time Setup*

Approve trading fees to start (0.1% per trade).
Your order will execute automatically after.

_This only needs to be done once._

[🔓 Approve Trading] (opens Mini App → approve-builder-fee)
```

**Pending order is saved.** After approval, backend auto-executes it.

---

### Agent Not Authorized
**Condition:** User has deposited but agent wallet not approved on Hyperliquid

```
🔐 *Authorization Required*

Your wallet has funds but trading isn't enabled yet.
Tap below to authorize trading.

_Your order will execute automatically after authorization._

[🔓 Authorize Trading] (opens Mini App)
```

---

### Insufficient Balance
**Condition:** Order size exceeds available margin

```
❌ Order failed: Insufficient margin
```

---

### API Errors
```
❌ Error: [error message from Hyperliquid]
```

---

## Mini App Flows

### Main Flow (`?action=undefined` or no action)
1. Privy login (Telegram/SMS/Email)
2. Wallet creation (if new)
3. Agent authorization (EIP-712 signature)
4. Registration with backend
5. Success → close Mini App

### Onramp Flow (`?action=onramp`)
1. Backend fetches user's wallet
2. Generates signed Onramper URL
3. Displays Onramper widget iframe
4. After purchase → webhook triggers bridge prompt

### Bridge Flow (`?action=bridge`)
1. Shows Arbitrum USDC balance
2. User selects amount
3. Calls Hyperliquid deposit contract
4. Confirms deposit on Hyperliquid

### Offramp Flow (`?action=offramp`)
1. Shows Onramper sell widget
2. User sells USDC → fiat

### Builder Fee Approval (`/approve-builder-fee`)
1. Shows builder address and fee rate
2. User signs EIP-712 `approveBuilderFee` action
3. Backend verifies and executes pending order
4. Success → close Mini App

---

## Scheduled Events

### Chart Broadcast (Every 12 Hours)
Sends chart image to all users:
```
📊 *xyz:GOLD 12H Update*
[Chart Image]
💲 Current: $2850.00
...
```

---

## Webhook Events

### Onramper `transaction_completed`
After successful fiat → crypto purchase:
```
✅ *USDC Purchased!*

Your USDC is now on Arbitrum.
Bridge it to Hyperliquid to start trading:

[🌉 Bridge to Hyperliquid]
[📊 Check Balance]
```

---

## Points System

| Action | Points |
|--------|--------|
| Share a trade | +25 |

Points displayed in `/status`:
```
⭐ *Goldbug Points*: 175
_Share trades to earn rewards_
```

---

## Button Reference

### Keyboards by State

| State | Available Buttons |
|-------|-------------------|
| Dashboard | Long, Short, Position, Orders, Details, Settings |
| Position View | Close, Add to Position, Refresh, Back |
| Order Confirm | Confirm, Cancel |
| Post-Trade | Share Trade, Copy Setup, View Position, Menu |
| Close Confirm | Close Position, Cancel |
| Balance View | Buy USDC, Bridge, Refresh |
| Withdraw View | Unbridge $X, Sell USDC, Back |

---

*End of UX Flow Document*

