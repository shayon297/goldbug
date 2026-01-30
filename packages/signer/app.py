import os
from typing import Optional

from eth_account import Account
from fastapi import FastAPI, Header, HTTPException
from pydantic import BaseModel, Field

from hyperliquid.exchange import Exchange


API_URL = os.getenv("HYPERLIQUID_API_URL", "https://api.hyperliquid.xyz")
TRADING_ASSET = os.getenv("TRADING_ASSET", "xyz:GOLD")
SIGNER_API_KEY = os.getenv("SIGNER_API_KEY")

# Builder fee configuration - fee in tenths of basis points (100 = 10bp = 0.1%)
# Hyperliquid caps perp builder fees at 0.1%, so 100 is the effective max
BUILDER_ADDRESS = os.getenv("BUILDER_ADDRESS", "")
BUILDER_FEE_BPS = int(os.getenv("BUILDER_FEE_BPS", "100"))


def parse_dex(asset: str) -> Optional[str]:
    if ":" in asset:
        return asset.split(":", 1)[0]
    return None


PERP_DEX = parse_dex(TRADING_ASSET)


def get_builder() -> Optional[dict]:
    """Get builder fee config if enabled, else None."""
    if BUILDER_ADDRESS and BUILDER_ADDRESS != "0x...your_builder_wallet_address":
        return {"b": BUILDER_ADDRESS.lower(), "f": BUILDER_FEE_BPS}
    return None


def ensure_hex_prefix(key: str) -> str:
    return key if key.startswith("0x") else f"0x{key}"


def require_api_key(x_signer_api_key: Optional[str]) -> None:
    if SIGNER_API_KEY and x_signer_api_key != SIGNER_API_KEY:
        raise HTTPException(status_code=401, detail="Invalid signer API key")


def get_exchange(agent_private_key: str, wallet_address: str) -> Exchange:
    key = ensure_hex_prefix(agent_private_key)
    wallet = Account.from_key(key)
    account_address = wallet_address.lower()

    perp_dexs = None
    if PERP_DEX:
        # Include builder perp dex for HIP-3 assets
        perp_dexs = ["", PERP_DEX]

    # Use account_address for normal trading. vault_address should only be set
    # when trading on behalf of a vault account (not the default flow).
    return Exchange(
        wallet=wallet,
        base_url=API_URL,
        account_address=account_address,
        perp_dexs=perp_dexs,
        timeout=30,
    )


class BaseRequest(BaseModel):
    agent_private_key: str = Field(..., min_length=32)
    wallet_address: str = Field(..., min_length=40)


class UpdateLeverageRequest(BaseRequest):
    coin: str
    leverage: int
    is_cross: bool = False


class LimitOrderRequest(BaseRequest):
    coin: str
    is_buy: bool
    size: float
    limit_px: float
    tif: str = "Gtc"
    reduce_only: bool = False


class MarketOrderRequest(BaseRequest):
    coin: str
    is_buy: bool
    size: float
    slippage: float = 0.01
    px: Optional[float] = None


class MarketCloseRequest(BaseRequest):
    coin: str
    size: Optional[float] = None
    slippage: float = 0.01
    px: Optional[float] = None


class CancelOrderRequest(BaseRequest):
    coin: str
    oid: int


app = FastAPI()


@app.get("/health")
def health():
    return {"status": "ok"}


@app.post("/l1/update_leverage")
def update_leverage(
    req: UpdateLeverageRequest, x_signer_api_key: Optional[str] = Header(default=None)
):
    require_api_key(x_signer_api_key)
    exchange = get_exchange(req.agent_private_key, req.wallet_address)
    return exchange.update_leverage(req.leverage, req.coin, req.is_cross)


@app.post("/l1/order")
def limit_order(req: LimitOrderRequest, x_signer_api_key: Optional[str] = Header(default=None)):
    require_api_key(x_signer_api_key)
    exchange = get_exchange(req.agent_private_key, req.wallet_address)
    order_type = {"limit": {"tif": req.tif}}
    builder = get_builder()
    return exchange.order(
        name=req.coin,
        is_buy=req.is_buy,
        sz=req.size,
        limit_px=req.limit_px,
        order_type=order_type,
        reduce_only=req.reduce_only,
        builder=builder,
    )


@app.post("/l1/market_open")
def market_open(req: MarketOrderRequest, x_signer_api_key: Optional[str] = Header(default=None)):
    require_api_key(x_signer_api_key)
    exchange = get_exchange(req.agent_private_key, req.wallet_address)
    builder = get_builder()
    print(f"[market_open] name={req.coin}, is_buy={req.is_buy}, size={req.size}, slippage={req.slippage}, builder={builder}")
    result = exchange.market_open(
        name=req.coin,
        is_buy=req.is_buy,
        sz=req.size,
        px=req.px,
        slippage=req.slippage,
        builder=builder,
    )
    print(f"[market_open] result: {result}")
    return result


@app.post("/l1/market_close")
def market_close(req: MarketCloseRequest, x_signer_api_key: Optional[str] = Header(default=None)):
    require_api_key(x_signer_api_key)
    exchange = get_exchange(req.agent_private_key, req.wallet_address)
    builder = get_builder()
    print(f"[market_close] name={req.coin}, size={req.size}, slippage={req.slippage}, builder={builder}")
    result = exchange.market_close(
        name=req.coin,  # SDK uses 'name' not 'coin' (same as market_open)
        sz=req.size,
        px=req.px,
        slippage=req.slippage,
        builder=builder,
    )
    print(f"[market_close] result: {result}")
    return result


@app.post("/l1/cancel")
def cancel(req: CancelOrderRequest, x_signer_api_key: Optional[str] = Header(default=None)):
    require_api_key(x_signer_api_key)
    exchange = get_exchange(req.agent_private_key, req.wallet_address)
    print(f"[cancel] coin={req.coin}, oid={req.oid}")
    result = exchange.cancel(req.coin, req.oid)
    print(f"[cancel] result: {result}")
    return result


@app.post("/l1/enable_dex")
def enable_dex_abstraction(req: BaseRequest, x_signer_api_key: Optional[str] = Header(default=None)):
    require_api_key(x_signer_api_key)
    exchange = get_exchange(req.agent_private_key, req.wallet_address)
    return exchange.agent_enable_dex_abstraction()

