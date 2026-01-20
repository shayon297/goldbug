# GOLD Trade Bot

A Telegram-first trading bot for GOLD on Hyperliquid with up to 20x leverage.

## Features

- **Single Asset Focus**: Trade only GOLD - no distractions, no discovery UI
- **Telegram Native**: All trading happens in Telegram chat with inline keyboards
- **Privy Authentication**: Secure wallet management with embedded wallets
- **Non-Custodial**: Backend never sees your private keys - uses delegated agent signing
- **Up to 20x Leverage**: Trade with leverage from 1x to 20x

## Architecture

```
┌─────────────────────┐     ┌─────────────────────┐
│   Telegram Chat     │     │   Mini App (Next.js)│
│   /start, /long,    │     │   Privy Login +     │
│   inline keyboards  │     │   Agent Authorization│
└──────────┬──────────┘     └──────────┬──────────┘
           │                           │
           ▼                           ▼
┌──────────────────────────────────────────────────┐
│              Backend (Node.js/Express)           │
│  ┌──────────┐ ┌──────────┐ ┌──────────────────┐ │
│  │ Telegram │ │  Privy   │ │   Hyperliquid    │ │
│  │ Handlers │ │ Verify   │ │   Adapter        │ │
│  └──────────┘ └──────────┘ └──────────────────┘ │
│              ┌──────────────┐                    │
│              │   SQLite DB  │                    │
│              │  (encrypted) │                    │
│              └──────────────┘                    │
└──────────────────────────────────────────────────┘
           │
           ▼
┌──────────────────────────────────────────────────┐
│           Hyperliquid Mainnet API               │
│           https://api.hyperliquid.xyz           │
└──────────────────────────────────────────────────┘
```

## Setup

### Prerequisites

- Node.js 20+
- npm 10+
- Railway CLI (`npm i -g @railway/cli`)

### 1. Get Credentials

#### Telegram Bot Token
1. Message [@BotFather](https://t.me/BotFather) on Telegram
2. Send `/newbot` and follow prompts
3. Copy the bot token (format: `123456789:ABC-DEF...`)

#### Privy App
1. Sign up at [privy.io](https://privy.io)
2. Create a new app
3. Enable login methods: Telegram, SMS, Email
4. Copy the App ID and App Secret

### 2. Local Development

```bash
# Clone repository
git clone https://github.com/shayon297/goldbug.git
cd goldbug

# Install dependencies
npm install

# Copy environment files
cp packages/backend/.env.example packages/backend/.env
cp packages/miniapp/.env.example packages/miniapp/.env.local

# Edit .env files with your credentials
# Generate encryption key: openssl rand -hex 32

# Generate Prisma client
npm run db:generate --workspace=@goldbug/backend

# Push database schema
npm run db:push --workspace=@goldbug/backend

# Start development servers
npm run dev:backend  # Port 3000
npm run dev:miniapp  # Port 3001
```

### 3. Deploy to Railway

```bash
# Login to Railway
railway login

# Create project and link
railway init

# Deploy backend
cd packages/backend
railway up

# Deploy miniapp
cd ../miniapp
railway up

# Set environment variables in Railway dashboard
```

## Chat Commands

| Command | Description |
|---------|-------------|
| `/start` | Show welcome message and connect button |
| `/balance` | View account balance and position |
| `/long` | Start long order flow |
| `/short` | Start short order flow |

### Natural Language Trading

You can also type commands directly:
- `Long 5x $1000 market` - Market long at 5x leverage
- `Short 2x $500 limit 2800` - Limit short at $2800
- `Buy 10x $2000` - Same as long

## Security

### Key Management

The bot uses Hyperliquid's **Agent Wallet** pattern:

1. User logs in via Privy and creates an embedded wallet
2. Mini App generates a new "agent" keypair locally
3. User signs authorization for the agent (one-time)
4. Backend stores the encrypted agent private key
5. All trades are signed by the agent key

**The user's primary wallet key never touches the backend.**

### Encryption

Agent private keys are encrypted using AES-256-GCM before storage:
- 256-bit key derived from `ENCRYPTION_KEY` environment variable
- Random 16-byte IV per encryption
- Authentication tag prevents tampering

## Threat Model

### Attack Surfaces

| Threat | Mitigation |
|--------|------------|
| **Telegram Spoofing** | Validate `initData` signature from Telegram Web App SDK |
| **Replay Attacks** | Hyperliquid requires timestamp nonces; expired actions rejected |
| **Command Injection** | Strict input validation with Zod schemas; sanitize all user input |
| **Session Hijacking** | Short session TTL; require re-auth for sensitive operations |
| **MITM** | All API calls over HTTPS; Privy handles auth tokens securely |
| **Database Breach** | Agent keys encrypted at rest; user wallet keys never stored |

### Security Checklist

- [x] Rate limiting on all endpoints
- [x] Helmet.js for HTTP security headers
- [x] Input validation with Zod
- [x] Encrypted key storage (AES-256-GCM)
- [x] Telegram init data validation
- [x] Session expiration (30 minutes)
- [x] Least privilege (agent can only trade, not withdraw)

### What We Don't Do

- Store user primary wallet private keys
- Allow withdrawals via the bot (agent doesn't have permission)
- Store trading history long-term (fetched live from Hyperliquid)
- Process any fiat/crypto on/off-ramp

## Project Structure

```
packages/
├── backend/
│   ├── src/
│   │   ├── telegram/      # Bot handlers, keyboards, command parser
│   │   ├── hyperliquid/   # GOLD-only trading adapter
│   │   ├── privy/         # Session verification
│   │   ├── state/         # Database + encryption
│   │   └── index.ts       # Express server
│   ├── prisma/
│   │   └── schema.prisma  # User + Session models
│   └── package.json
└── miniapp/
    ├── app/
    │   ├── page.tsx       # Login + authorization flow
    │   └── layout.tsx
    ├── lib/
    │   ├── privy.tsx      # Privy provider
    │   └── telegram.ts    # TMA utilities
    └── package.json
```

## Testing

```bash
# Run backend tests
npm test --workspace=@goldbug/backend

# Tests cover:
# - Command parsing (long/short/leverage/size)
# - Input validation (leverage 1-20x, size limits)
# - Hyperliquid adapter (mocked API calls)
```

## Environment Variables

### Backend

| Variable | Description |
|----------|-------------|
| `TELEGRAM_BOT_TOKEN` | Bot token from BotFather |
| `TELEGRAM_WEBHOOK_SECRET` | Random string for webhook URL |
| `PRIVY_APP_ID` | Privy app ID |
| `PRIVY_APP_SECRET` | Privy app secret |
| `HYPERLIQUID_API_URL` | `https://api.hyperliquid.xyz` |
| `ENCRYPTION_KEY` | 32-byte hex key for AES-256 |
| `DATABASE_URL` | SQLite file path |
| `PORT` | Server port (default: 3000) |
| `BACKEND_URL` | Public URL for webhook |
| `MINIAPP_URL` | Mini app URL for buttons |

### Mini App

| Variable | Description |
|----------|-------------|
| `NEXT_PUBLIC_PRIVY_APP_ID` | Privy app ID |
| `NEXT_PUBLIC_API_URL` | Backend API URL |

## License

MIT

