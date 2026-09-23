import type { MarketConfig } from './types';
import { MODEL_VERSION, STRATEGY_BAR_TICKS } from './strategy';

type ReplayPackageInput = {
  config: MarketConfig;
  simStartMs: number;
  code: string;
  dryRun: boolean;
  ticks: number;
};

const ENGINE_VERSION = 'finpub-python-replay-v1';
const encoder = new TextEncoder();

function crc32(bytes: Uint8Array): number {
  let value = 0xffff_ffff;
  for (const byte of bytes) {
    value ^= byte;
    for (let bit = 0; bit < 8; bit += 1) value = (value >>> 1) ^ (0xedb8_8320 & -(value & 1));
  }
  return (value ^ 0xffff_ffff) >>> 0;
}

function writeUint16(view: DataView, offset: number, value: number): void { view.setUint16(offset, value, true); }
function writeUint32(view: DataView, offset: number, value: number): void { view.setUint32(offset, value, true); }

function createStoredZip(files: Array<{ name: string; content: string }>): Blob {
  const entries = files.map((file) => ({ name: encoder.encode(file.name), bytes: encoder.encode(file.content) }));
  const localSize = entries.reduce((total, entry) => total + 30 + entry.name.length + entry.bytes.length, 0);
  const centralSize = entries.reduce((total, entry) => total + 46 + entry.name.length, 0);
  const bytes = new Uint8Array(localSize + centralSize + 22);
  const view = new DataView(bytes.buffer);
  let offset = 0;
  const central: Array<{ entry: (typeof entries)[number]; offset: number; crc: number }> = [];
  for (const entry of entries) {
    const crc = crc32(entry.bytes);
    const localOffset = offset;
    writeUint32(view, offset, 0x04034b50); writeUint16(view, offset + 4, 20); writeUint16(view, offset + 6, 0); writeUint16(view, offset + 8, 0);
    writeUint16(view, offset + 10, 0); writeUint16(view, offset + 12, 0); writeUint32(view, offset + 14, crc);
    writeUint32(view, offset + 18, entry.bytes.length); writeUint32(view, offset + 22, entry.bytes.length);
    writeUint16(view, offset + 26, entry.name.length); writeUint16(view, offset + 28, 0);
    bytes.set(entry.name, offset + 30); bytes.set(entry.bytes, offset + 30 + entry.name.length);
    offset += 30 + entry.name.length + entry.bytes.length;
    central.push({ entry, offset: localOffset, crc });
  }
  const centralOffset = offset;
  for (const item of central) {
    const { entry, crc } = item;
    writeUint32(view, offset, 0x02014b50); writeUint16(view, offset + 4, 20); writeUint16(view, offset + 6, 20); writeUint16(view, offset + 8, 0); writeUint16(view, offset + 10, 0);
    writeUint16(view, offset + 12, 0); writeUint16(view, offset + 14, 0); writeUint32(view, offset + 16, crc);
    writeUint32(view, offset + 20, entry.bytes.length); writeUint32(view, offset + 24, entry.bytes.length);
    writeUint16(view, offset + 28, entry.name.length); writeUint16(view, offset + 30, 0); writeUint16(view, offset + 32, 0);
    writeUint16(view, offset + 34, 0); writeUint16(view, offset + 36, 0); writeUint32(view, offset + 38, 0); writeUint32(view, offset + 42, item.offset);
    bytes.set(entry.name, offset + 46); offset += 46 + entry.name.length;
  }
  const centralLength = offset - centralOffset;
  writeUint32(view, offset, 0x06054b50); writeUint16(view, offset + 4, 0); writeUint16(view, offset + 6, 0);
  writeUint16(view, offset + 8, entries.length); writeUint16(view, offset + 10, entries.length);
  writeUint32(view, offset + 12, centralLength); writeUint32(view, offset + 16, centralOffset); writeUint16(view, offset + 20, 0);
  return new Blob([bytes], { type: 'application/zip' });
}

function download(filename: string, blob: Blob): void {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 0);
}

const packageReadme = String.raw`# FinPub Python replay package

This package runs the same discrete FinPub market rules without waiting one real second per auction. It includes the exact configuration captured from the browser, the current strategy.py, a deterministic LCG random generator, NPC rules, event rules, matching rules, and the strategy context used by on_bar(ctx).

Run it with Python 3.10 or newer:

    python run.py

Change ticks in replay_config.json to choose the number of auction ticks. The runner writes result.json, trades.csv, portfolio.csv, strategy_bars.csv, strategy_runs.csv, and strategy_orders.csv.

Reproducibility rule: start a fresh browser market with the exported initial configuration, use the same strategy.py from tick 0, set the same Dry run / live mode, and advance to the same tick count. The browser and this package then use the same seed, event schedule, NPC decisions, order sequencing, visible-top-five validation, and matching order. Manual browser orders or editing/enabling a strategy partway through a session are intentionally not replayed by this package; express those actions inside on_bar(ctx) for a fully portable replay.

Only edit strategy.py. It must define on_bar(ctx) and return a list of actions. buy(symbol, quantity, price) and sell(symbol, quantity, price) create limit orders; omit price for a market order. cancel(order_id) requests one cancellation, and cancel_all(symbol=None, side=None) requests all matching active cancellations. A bar allows up to six actions, including at most three orders of 25 units each. A bar runs after every five auction ticks. In dry_run mode actions are validated and recorded but do not change the book.
`;

const pythonRunner = String.raw`import csv
import importlib.util
import json
from pathlib import Path

from market_engine import (
    BAR_TICKS, ENGINE_VERSION, advance_tick, build_context, create_market,
    cancel_validation_error, queue_player_order, request_cancel, strategy_validation_error,
)

ROOT = Path(__file__).resolve().parent
with (ROOT / "replay_config.json").open(encoding="utf-8") as source:
    replay = json.load(source)

def buy(symbol, quantity, price=None):
    result = {"action": "order", "side": "buy", "symbol": symbol, "quantity": quantity, "type": "market" if price is None else "limit"}
    if price is not None: result["price"] = price
    return result

def sell(symbol, quantity, price=None):
    result = {"action": "order", "side": "sell", "symbol": symbol, "quantity": quantity, "type": "market" if price is None else "limit"}
    if price is not None: result["price"] = price
    return result

def cancel(order_id):
    return {"action": "cancel", "order_id": order_id}

def cancel_all(symbol=None, side=None):
    result = {"action": "cancel_all"}
    if symbol is not None: result["symbol"] = symbol
    if side is not None: result["side"] = side
    return result

spec = importlib.util.spec_from_file_location("finpub_strategy", ROOT / "strategy.py")
strategy = importlib.util.module_from_spec(spec)
strategy.buy = buy
strategy.sell = sell
strategy.cancel = cancel
strategy.cancel_all = cancel_all
spec.loader.exec_module(strategy)
if not callable(getattr(strategy, "on_bar", None)):
    raise ValueError("strategy.py must define callable on_bar(ctx).")

market = create_market(replay["initial_config"], replay["sim_start_ms"])
session = {"bars": [], "last_volume": {}}
runs, orders = [], []
dry_run = replay["strategy_mode"] == "dry_run"

for _ in range(int(replay["ticks"])):
    advance_tick(market)
    if market["tick"] % BAR_TICKS:
        continue
    context = build_context(market, session)
    try:
        result = strategy.on_bar(context)
        if not isinstance(result, list):
            raise ValueError("on_bar must return a list of order or cancellation actions.")
        if len(result) > 6:
            raise ValueError("At most 6 actions are allowed per bar.")
        normalized, order_count = [], 0
        for item in result:
            if not isinstance(item, dict):
                raise ValueError("Each strategy action must be an object.")
            action = item.get("action", "order")
            if action == "cancel":
                if not isinstance(item.get("order_id"), str) or not item["order_id"]:
                    raise ValueError("cancel(order_id) needs a non-empty order id.")
                normalized.append({"action": "cancel", "order_id": item["order_id"]})
                continue
            if action == "cancel_all":
                if ("symbol" in item and not isinstance(item["symbol"], str)) or ("side" in item and item["side"] not in ("buy", "sell")):
                    raise ValueError("cancel_all accepts only optional symbol and side filters.")
                intent = {"action": "cancel_all"}
                if "symbol" in item: intent["symbol"] = item["symbol"]
                if "side" in item: intent["side"] = item["side"]
                normalized.append(intent)
                continue
            if action != "order":
                raise ValueError("Actions must be created with buy(), sell(), cancel(), or cancel_all().")
            order_count += 1
            if order_count > 3:
                raise ValueError("At most 3 orders are allowed per bar.")
            side, symbol, quantity = item.get("side"), item.get("symbol"), item.get("quantity")
            kind = item.get("type", "market" if item.get("price") is None else "limit")
            if side not in ("buy", "sell") or not isinstance(symbol, str) or type(quantity) is not int or not 1 <= quantity <= 25 or kind not in ("limit", "market"):
                raise ValueError("Orders need side, symbol, integer quantity 1-25, and type limit or market.")
            intent = {"action": "order", "side": side, "symbol": symbol, "quantity": quantity, "type": kind}
            if kind == "limit":
                if not isinstance(item.get("price"), (int, float)):
                    raise ValueError("Limit orders need a numeric visible price.")
                intent["price"] = float(item["price"])
            elif item.get("price") is not None:
                raise ValueError("Market orders must omit price.")
            normalized.append(intent)

        actions = []
        for intent in normalized:
            if intent["action"] != "cancel_all":
                actions.append(intent)
                continue
            matching = [order for order in sorted(market["orders"].values(), key=lambda order: order["sequence"])
                        if order["participantId"] == "player" and order["status"] in ("queued", "open", "partial")
                        and (not intent.get("symbol") or order["symbol"] == intent["symbol"])
                        and (not intent.get("side") or order["side"] == intent["side"])]
            actions.extend({"action": "cancel", "order_id": order["id"]} for order in matching)

        for action in actions:
            base = {"sim_time": context["sim_time"], "tick": context["tick"], "bar_index": context["bar_index"]}
            if action["action"] == "cancel":
                error = cancel_validation_error(market, action["order_id"])
                record = {**base, "action": "cancel", "order_id": action["order_id"]}
                if error:
                    orders.append({**record, "mode": "rejected", "message": error})
                elif dry_run:
                    orders.append({**record, "mode": "dry_run", "message": "Validated only; no cancellation was requested."})
                else:
                    cancelled = request_cancel(market, action["order_id"])
                    orders.append({**record, "mode": "cancel_requested" if cancelled["ok"] else "rejected", "message": cancelled["message"]})
                continue
            error = strategy_validation_error(market, action)
            record = {**base, "action": "order", "order_type": action["type"], "side": action["side"], "symbol": action["symbol"], "quantity": action["quantity"], "price": action.get("price")}
            if error:
                orders.append({**record, "mode": "rejected", "message": error})
            elif dry_run:
                orders.append({**record, "mode": "dry_run", "message": "Validated only; no market order was queued."})
            else:
                queued = queue_player_order(market, action)
                orders.append({**record, "mode": "queued" if queued["ok"] else "rejected", "message": queued["message"]})
        requested_cancel_all = sum(1 for intent in normalized if intent["action"] == "cancel_all")
        message = ("Validated cancel_all; no matching open orders." if not actions and requested_cancel_all else f"Validated {len(actions)} action{'s' if len(actions) != 1 else ''} in dry-run mode.") if dry_run else ("cancel_all found no matching open orders." if not actions and requested_cancel_all else f"{len(actions)} action{'s' if len(actions) != 1 else ''} queued for the next auction.")
        runs.append({"sim_time": context["sim_time"], "tick": context["tick"], "bar_index": context["bar_index"], "model_version": replay["model_version"], "status": "ok", "order_count": len(actions), "message": message, "intents_json": json.dumps(normalized, ensure_ascii=False)})
    except Exception as error:
        runs.append({"sim_time": context["sim_time"], "tick": context["tick"], "bar_index": context["bar_index"], "model_version": replay["model_version"], "status": "error", "order_count": 0, "message": str(error), "intents_json": "[]"})

def write_csv(name, rows):
    path = ROOT / name
    columns = list(dict.fromkeys(key for row in rows for key in row)) if rows else []
    with path.open("w", newline="", encoding="utf-8-sig") as output:
        writer = csv.DictWriter(output, fieldnames=columns)
        writer.writeheader()
        writer.writerows(rows)

write_csv("trades.csv", list(reversed(market["trades"])))
write_csv("portfolio.csv", market["portfolio"])
write_csv("strategy_bars.csv", session["bars"])
write_csv("strategy_runs.csv", runs)
write_csv("strategy_orders.csv", orders)

result = {"engine_version": ENGINE_VERSION, "tick": market["tick"], "summary": market["summary"](), "trades": len(market["trades"]), "strategy_runs": len(runs), "strategy_orders": len(orders)}
with (ROOT / "result.json").open("w", encoding="utf-8") as output:
    json.dump(result, output, ensure_ascii=False, indent=2)
print(json.dumps(result, ensure_ascii=False, indent=2))
`;
const pythonEngine = [String.raw`import json
import math
from datetime import datetime, timezone

ENGINE_VERSION = "finpub-python-replay-v1"
BAR_TICKS = 5
INSTRUMENTS = [
    {"symbol": "BDX", "name": "Bordeaux Reserve", "initialPrice": 102.4, "tickSize": 0.1},
    {"symbol": "ISL", "name": "Islay Single Malt", "initialPrice": 148.6, "tickSize": 0.1},
    {"symbol": "JDG", "name": "Daiginjo", "initialPrice": 86.2, "tickSize": 0.1},
    {"symbol": "CRM", "name": "Caribbean Aged Rum", "initialPrice": 74.8, "tickSize": 0.1},
    {"symbol": "CHM", "name": "Vintage Champagne", "initialPrice": 126.5, "tickSize": 0.1},
    {"symbol": "OCR", "name": "Orchard Cider", "initialPrice": 39.4, "tickSize": 0.1},
]
STYLES = ["market_maker", "value", "trend", "news", "noise"]

def js_round(value):
    return math.floor(value + 0.5)

def round_currency(value):
    return js_round((value + 2.220446049250313e-16) * 100) / 100

def round_price(value, tick):
    return float(format(js_round((value + 2.220446049250313e-16) / tick) * tick, ".4f"))

def sim_time(market):
    ms = market["sim_start_ms"] + market["tick"] * 1000
    stamp = datetime.fromtimestamp(ms / 1000, timezone.utc)
    return stamp.strftime("%Y-%m-%dT%H:%M:%S.") + f"{ms % 1000:03d}Z"

def next_random(market):
    market["rng"] = (market["rng"] * 48271) % 2147483647
    return (market["rng"] - 1) / 2147483646

def random_between(market, low, high):
    return low + (high - low) * next_random(market)

def random_int(market, low, high):
    return math.floor(random_between(market, low, high + 1))

def positions(config, initial=False):
    return {item["symbol"]: {"quantity": max(0, math.floor(config["playerPositions"].get(item["symbol"], 0))) if initial else 0, "reserved": 0, "averageCost": config["initialPrices"][item["symbol"]] if initial else 0} for item in INSTRUMENTS}

def account(identifier, kind, config, profile=None):
    held = positions(config, kind == "player")
    net = round_currency(config["playerCash"] + sum(held[item["symbol"]]["quantity"] * config["initialPrices"][item["symbol"]] for item in INSTRUMENTS)) if kind == "player" else 0
    return {"id": identifier, "type": kind, "style": profile["style"] if profile else None, "cash": config["playerCash"] if kind == "player" else 0, "initialNetAsset": net, "positions": held, "realizedPnl": 0, "makerFees": 0, "takerFees": 0, "tradeCount": 0, "buyVolume": 0, "sellVolume": 0, "reservedCash": 0}

def make_profile(market, index):
    return {"id": f"npc-{index + 1:03d}", "style": STYLES[index % len(STYLES)], "valuationBias": {item["symbol"]: random_between(market, -0.025, 0.025) for item in INSTRUMENTS}, "targetInventory": {item["symbol"]: random_int(market, -35, 35) for item in INSTRUMENTS}, "sensitivity": random_between(market, 0.65, 1.45), "maxOrderSize": random_int(market, 3, 18)}

def create_market(raw, sim_start_ms):
    config = dict(raw)
    config["npcCount"] = max(20, min(200, math.floor(config["npcCount"])))
    config["playerCash"] = max(0, round_currency(config["playerCash"]))
    config["seed"] = max(1, math.floor(config["seed"]) or 1)
    config["makerFeeRate"] = max(0, config["makerFeeRate"])
    config["takerFeeRate"] = max(0, config["takerFeeRate"])
    market = {"config": config, "sim_start_ms": sim_start_ms, "tick": 0, "sequence": 0, "trade_sequence": 0, "rng": config["seed"], "assets": {}, "books": {}, "accounts": {}, "profiles": {}, "orders": {}, "pending": [], "pending_cancel": [], "trades": [], "events": [], "latest_event": None, "next_event_tick": 15, "portfolio": []}
    for item in INSTRUMENTS:
        symbol, tick = item["symbol"], item["tickSize"]
        price = round_price(max(tick, config["initialPrices"].get(symbol, item["initialPrice"])), tick)
        market["assets"][symbol] = {"definition": item, "lastPrice": price, "previousClose": price, "volume": 0, "fairValue": price, "permanentShift": 0, "transientShift": 0, "eventVolatility": 0, "priceHistory": []}
        market["books"][symbol] = {"bids": [], "asks": []}
    market["accounts"]["player"] = account("player", "player", config)
    for index in range(config["npcCount"]):
        profile = make_profile(market, index)
        market["profiles"][profile["id"]] = profile
        market["accounts"][profile["id"]] = account(profile["id"], "npc", config, profile)
    bootstrap_liquidity(market)
    capture_portfolio(market)
    market["summary"] = lambda: summary(market)
    return market

def new_order(market, data):
    market["sequence"] += 1
    return {**data, "id": f"O-{market['sequence']:07d}", "submittedTick": market["tick"], "sequence": market["sequence"], "status": "queued", "reservedCash": 0, "reservedQuantity": 0}

def insert_resting(market, order):
    items = market["books"][order["symbol"]]["bids" if order["side"] == "buy" else "asks"]
    items.append(order)
    items.sort(key=lambda x: ((-x["limitPrice"]) if order["side"] == "buy" else x["limitPrice"], x["sequence"]))
    order["status"] = "open" if order["remaining"] == order["quantity"] else "partial"

def bootstrap_liquidity(market):
    profiles = [value for value in market["profiles"].values() if value["style"] == "market_maker"][:18]
    providers = profiles or list(market["profiles"].values())[:12]
    for asset in market["assets"].values():
        for index, profile in enumerate(providers):
            width, quantity = 0.003 + index * 0.00055, 5 + index % 4 * 2
            tick = asset["definition"]["tickSize"]
            for side, price in (("buy", round_price(asset["fairValue"] * (1 - width), tick)), ("sell", round_price(asset["fairValue"] * (1 + width), tick))):
                order = new_order(market, {"participantId": profile["id"], "symbol": asset["definition"]["symbol"], "side": side, "type": "limit", "limitPrice": price, "quantity": quantity, "remaining": quantity})
                market["orders"][order["id"]] = order
                insert_resting(market, order)

def levels(market, symbol, side, depth=5):
    result = []
    for order in market["books"][symbol]["bids" if side == "buy" else "asks"]:
        found = next((row for row in result if row["price"] == order["limitPrice"]), None)
        if found:
            found["quantity"] += order["remaining"]
            found["orderCount"] += 1
            found["hasPlayerOrder"] = found["hasPlayerOrder"] or order["participantId"] == "player"
        elif len(result) < depth:
            result.append({"price": order["limitPrice"], "quantity": order["remaining"], "orderCount": 1, "hasPlayerOrder": order["participantId"] == "player"})
    return result

def quotes(market, symbol):
    bids, asks = market["books"][symbol]["bids"], market["books"][symbol]["asks"]
    bid, ask = (bids[0]["limitPrice"] if bids else None), (asks[0]["limitPrice"] if asks else None)
    tick = market["assets"][symbol]["definition"]["tickSize"]
    return {"bestBid": bid, "bestAsk": ask, "mid": round_price((bid + ask) / 2, tick) if bid is not None and ask is not None else None, "spread": round_price(ask - bid, tick) if bid is not None and ask is not None else None}

def fee_rates(market):
    config = market["config"]
    return (config["makerFeeRate"], config["takerFeeRate"]) if config["feesEnabled"] else (0, 0)
`, String.raw`
def is_visible(market, symbol, price):
    return any(level["price"] == price for level in levels(market, symbol, "buy") + levels(market, symbol, "sell"))

def estimate_market_order(market, symbol, side, quantity):
    raw, remaining, gross, filled = market["books"][symbol]["asks" if side == "buy" else "bids"], quantity, 0, 0
    for order in raw:
        if remaining <= 0: break
        used = min(remaining, order["remaining"])
        gross += used * order["limitPrice"]
        filled += used
        remaining -= used
    fee = round_currency(gross * fee_rates(market)[1])
    return {"quantity": filled, "gross": round_currency(gross), "fee": fee, "total": round_currency(gross + fee)}

def queue_player_order(market, intent):
    symbol, side, quantity = intent["symbol"], intent["side"], math.floor(intent["quantity"])
    if quantity <= 0: return {"ok": False, "message": "Quantity must be a positive integer."}
    if symbol not in market["assets"]: return {"ok": False, "message": "Unknown instrument."}
    kind, price = intent.get("type"), intent.get("price")
    if kind == "limit":
        if not isinstance(price, (int, float)) or not is_visible(market, symbol, price): return {"ok": False, "message": "Choose a price from the visible order book."}
        price = round_price(price, market["assets"][symbol]["definition"]["tickSize"])
        reserve = round_currency(price * quantity * (1 + max(fee_rates(market))))
    else:
        estimate = estimate_market_order(market, symbol, side, quantity)
        if estimate["quantity"] == 0: return {"ok": False, "message": "No opposing liquidity is currently available."}
        reserve = estimate["total"]
    player = market["accounts"]["player"]
    if side == "buy":
        if reserve > round_currency(player["cash"] - player["reservedCash"]) + 0.0001: return {"ok": False, "message": f"Insufficient available cash. Need {reserve:.2f} 酒币."}
        player["reservedCash"] = round_currency(player["reservedCash"] + reserve)
    else:
        position = player["positions"][symbol]
        if quantity > position["quantity"] - position["reserved"]: return {"ok": False, "message": "Insufficient available inventory."}
        position["reserved"] += quantity
    order = new_order(market, {"participantId": "player", "symbol": symbol, "side": side, "type": kind, "limitPrice": price if kind == "limit" else None, "quantity": quantity, "remaining": quantity})
    order["reservedCash"] = reserve if side == "buy" else 0
    order["reservedQuantity"] = quantity if side == "sell" else 0
    market["orders"][order["id"]] = order
    market["pending"].append(order["id"])
    return {"ok": True, "message": f"{order['id']} queued — it will be processed at the next 1s auction."}

def strategy_validation_error(market, intent):
    if intent["symbol"] not in market["assets"]: return "Unknown instrument."
    player = market["accounts"]["player"]
    if intent["side"] == "sell" and intent["quantity"] > player["positions"][intent["symbol"]]["quantity"] - player["positions"][intent["symbol"]]["reserved"]: return "Insufficient available inventory."
    if intent["type"] == "limit":
        if not is_visible(market, intent["symbol"], intent["price"]): return "Strategy limit price must be one of the visible top-five levels."
        if intent["side"] == "buy":
            required = intent["price"] * intent["quantity"] * (1 + max(fee_rates(market)))
            if required > player["cash"] - player["reservedCash"] + 0.0001: return f"Insufficient available cash. Need {required:.2f} 酒币."
        return None
    estimate = estimate_market_order(market, intent["symbol"], intent["side"], intent["quantity"])
    if estimate["quantity"] == 0: return "No opposing liquidity is currently available."
    if intent["side"] == "buy" and estimate["total"] > player["cash"] - player["reservedCash"] + 0.0001: return f"Insufficient available cash. Need {estimate['total']:.2f} 酒币."
    return None

def cancel_validation_error(market, order_id):
    order = market["orders"].get(order_id)
    if not order or order["participantId"] != "player": return "Order not found."
    if order["status"] not in ("queued", "open", "partial") or order["remaining"] <= 0: return "This order can no longer be cancelled."
    return None

def request_cancel(market, order_id):
    error = cancel_validation_error(market, order_id)
    if error: return {"ok": False, "message": error}
    order = market["orders"][order_id]
    order["status"] = "pending_cancel"
    if order_id not in market["pending_cancel"]: market["pending_cancel"].append(order_id)
    return {"ok": True, "message": f"{order_id} cancellation queued for the next auction."}

def remove_from_book(market, order):
    key = "bids" if order["side"] == "buy" else "asks"
    market["books"][order["symbol"]][key] = [row for row in market["books"][order["symbol"]][key] if row["id"] != order["id"]]

def release(market, order):
    if order["participantId"] != "player": return
    player = market["accounts"]["player"]
    if order["side"] == "buy" and order["reservedCash"] > 0:
        player["reservedCash"] = round_currency(max(0, player["reservedCash"] - order["reservedCash"]))
        order["reservedCash"] = 0
    if order["side"] == "sell" and order["reservedQuantity"] > 0:
        position = player["positions"][order["symbol"]]
        position["reserved"] = max(0, position["reserved"] - order["reservedQuantity"])
        order["reservedQuantity"] = 0

def cancel(market, order):
    remove_from_book(market, order)
    release(market, order)
    order["status"] = "cancelled"

def update_position(account, symbol, delta, price):
    position, before = account["positions"][symbol], account["positions"][symbol]["quantity"]
    after = before + delta
    if before == 0 or before * delta > 0:
        position["averageCost"] = price if before == 0 else (abs(before) * position["averageCost"] + abs(delta) * price) / abs(after)
    else:
        closed = min(abs(before), abs(delta))
        account["realizedPnl"] = round_currency(account["realizedPnl"] + closed * (price - position["averageCost"]) * (1 if before > 0 else -1))
        if after == 0: position["averageCost"] = 0
        elif (after > 0) != (before > 0): position["averageCost"] = price
    position["quantity"] = after

def apply_fill(account, symbol, side, price, quantity, fee, role):
    gross = round_currency(price * quantity)
    if side == "buy":
        account["cash"] = round_currency(account["cash"] - gross - fee)
        update_position(account, symbol, quantity, price)
        account["buyVolume"] += quantity
    else:
        account["cash"] = round_currency(account["cash"] + gross - fee)
        update_position(account, symbol, -quantity, price)
        account["sellVolume"] += quantity
    account["realizedPnl"] = round_currency(account["realizedPnl"] - fee)
    key = "makerFees" if role == "maker" else "takerFees"
    account[key] = round_currency(account[key] + fee)
    account["tradeCount"] += 1
`, String.raw`
def release_after_fill(market, order, cash_debit, quantity):
    if order["participantId"] != "player": return
    player = market["accounts"]["player"]
    if order["side"] == "buy":
        before = order["reservedCash"]
        after = round_currency(order["limitPrice"] * order["remaining"] * (1 + max(fee_rates(market)))) if order["type"] == "limit" else max(0, round_currency(before - cash_debit))
        order["reservedCash"] = after
        player["reservedCash"] = round_currency(max(0, player["reservedCash"] - max(0, before - after)))
    else:
        position = player["positions"][order["symbol"]]
        released = min(order["reservedQuantity"], quantity)
        if released:
            position["reserved"] = max(0, position["reserved"] - released)
            order["reservedQuantity"] -= released

def execute_trade(market, maker, taker, quantity):
    price = maker["limitPrice"]
    buyer, seller = (maker, taker) if maker["side"] == "buy" else (taker, maker)
    maker_rate, taker_rate = fee_rates(market)
    gross = round_currency(price * quantity)
    maker_fee, taker_fee = round_currency(gross * maker_rate), round_currency(gross * taker_rate)
    buyer_fee = maker_fee if buyer["id"] == maker["id"] else taker_fee
    seller_fee = maker_fee if seller["id"] == maker["id"] else taker_fee
    debit = round_currency(gross + buyer_fee)
    if buyer["participantId"] == "player" and (market["accounts"]["player"]["cash"] + 0.0001 < debit or buyer["reservedCash"] + 0.0001 < debit): return False
    maker["remaining"] -= quantity
    taker["remaining"] -= quantity
    apply_fill(market["accounts"][buyer["participantId"]], maker["symbol"], "buy", price, quantity, buyer_fee, "maker" if buyer["id"] == maker["id"] else "taker")
    apply_fill(market["accounts"][seller["participantId"]], maker["symbol"], "sell", price, quantity, seller_fee, "maker" if seller["id"] == maker["id"] else "taker")
    release_after_fill(market, buyer, debit, quantity)
    release_after_fill(market, seller, 0, quantity)
    market["trade_sequence"] += 1
    market["trades"].insert(0, {"sim_time": sim_time(market), "tick": market["tick"], "trade_id": f"T-{market['trade_sequence']:08d}", "symbol": maker["symbol"], "price": price, "quantity": quantity, "aggressor_side": taker["side"], "buyer_id": buyer["participantId"], "seller_id": seller["participantId"], "maker_id": maker["participantId"], "taker_id": taker["participantId"]})
    asset = market["assets"][maker["symbol"]]
    asset["lastPrice"], asset["volume"] = price, asset["volume"] + quantity
    asset["priceHistory"].append({"tick": market["tick"], "price": price})
    return True

def process_order(market, order):
    book = market["books"][order["symbol"]]
    opposing = book["asks" if order["side"] == "buy" else "bids"]
    while order["remaining"] > 0 and opposing:
        maker = opposing[0]
        crosses = order["type"] == "market" or (order["limitPrice"] >= maker["limitPrice"] if order["side"] == "buy" else order["limitPrice"] <= maker["limitPrice"])
        if not crosses: break
        before = order["remaining"]
        execute_trade(market, maker, order, min(order["remaining"], maker["remaining"]))
        if order["remaining"] == before: break
        if maker["remaining"] == 0:
            opposing.pop(0); release(market, maker); maker["status"] = "filled"
        else: maker["status"] = "partial"
    if order["remaining"] == 0:
        release(market, order); order["status"] = "filled"
    elif order["type"] == "market":
        release(market, order); order["status"] = "cancelled"
    else: insert_resting(market, order)

def update_fair_values(market):
    for asset in market["assets"].values():
        asset["transientShift"] *= 0.93; asset["eventVolatility"] *= 0.88
        symbol, item = asset["definition"]["symbol"], asset["definition"]
        asset["fairValue"] = round_price(item["initialPrice"] * (market["config"]["initialPrices"][symbol] / item["initialPrice"]) * (1 + asset["permanentShift"] + asset["transientShift"]), item["tickSize"])

def make_event(market):
    target = list(market["assets"].values())[random_int(market, 0, len(market["assets"]) - 1)]
    direction, impact = ("bullish" if next_random(market) > 0.47 else "bearish"), random_between(market, 0.018, 0.075)
    groups = {"BDX": ["BDX", "CHM"], "CHM": ["BDX", "CHM"], "ISL": ["ISL", "CRM"], "CRM": ["ISL", "CRM"], "JDG": ["JDG", "OCR"], "OCR": ["JDG", "OCR"]}
    symbols = groups[target["definition"]["symbol"]] if next_random(market) > 0.72 else [target["definition"]["symbol"]]
    random_int(market, 0, 2)  # Same RNG draw as the browser's event-title selection.
    event = {"tick": market["tick"], "direction": direction, "symbols": symbols, "impact": impact, "permanentShare": random_between(market, 0.16, 0.38)}
    market["events"].insert(0, event); market["latest_event"] = event
    sign = 1 if direction == "bullish" else -1
    for symbol in symbols:
        asset = market["assets"][symbol]
        asset["permanentShift"] += sign * impact * event["permanentShare"]
        asset["transientShift"] += sign * impact * (1 - event["permanentShare"])
        asset["eventVolatility"] = min(0.12, asset["eventVolatility"] + impact * 0.8)
    market["next_event_tick"] = market["tick"] + random_int(market, 15, 40)
`, String.raw`
def queue_npc(market, data):
    order = new_order(market, data)
    market["orders"][order["id"]] = order
    market["pending"].append(order["id"])

def trend(asset):
    prices = [point["price"] for point in asset["priceHistory"][-7:]]
    return 0 if len(prices) < 2 else (prices[-1] - prices[0]) / prices[0]

def npc_decision(market, profile, asset):
    active = sum(1 for order in market["orders"].values() if order["participantId"] == profile["id"] and order["status"] in ("queued", "open", "partial"))
    if active >= 12: return
    symbol, virtual = asset["definition"]["symbol"], market["accounts"][profile["id"]]
    value = asset["fairValue"] * (1 + profile["valuationBias"][symbol] + asset["transientShift"] * (0.55 * profile["sensitivity"] if profile["style"] == "news" else 0.12))
    quote, quantity, tick = quotes(market, symbol), random_int(market, 1, profile["maxOrderSize"]), asset["definition"]["tickSize"]
    reference = quote["mid"] if quote["mid"] is not None else asset["lastPrice"]
    skew = (virtual["positions"][symbol]["quantity"] - profile["targetInventory"][symbol]) / 500
    def submit(side, kind, price=None, size=quantity):
        queue_npc(market, {"participantId": profile["id"], "symbol": symbol, "side": side, "type": kind, "limitPrice": price, "quantity": size, "remaining": size})
    if profile["style"] == "market_maker":
        half = 0.0018 + asset["eventVolatility"] * 0.28 + random_between(market, 0.0004, 0.0014)
        center = value * (1 - skew * 0.35)
        bid, ask = round_price(center * (1 - half), tick), round_price(center * (1 + half), tick)
        if bid < ask:
            submit("buy", "limit", bid, max(1, js_round(quantity * (0.65 if skew > 0 else 1.1))))
            submit("sell", "limit", ask, max(1, js_round(quantity * (0.65 if skew < 0 else 1.1))))
        return
    signal = (value - reference) / max(reference, tick)
    if profile["style"] == "trend": signal = trend(asset) * profile["sensitivity"] * 2.6 + random_between(market, -0.004, 0.004)
    if profile["style"] == "news": signal += asset["transientShift"] * profile["sensitivity"] * 1.7
    if profile["style"] == "noise": signal = random_between(market, -0.012, 0.012) + asset["transientShift"] * 0.16
    side = "buy" if signal >= 0 else "sell"
    if abs(signal) > 0.018 and next_random(market) < 0.35 and ((side == "buy" and quote["bestAsk"] is not None) or (side == "sell" and quote["bestBid"] is not None)):
        submit(side, "market", None, max(1, min(quantity, 8)))
        return
    offset = random_between(market, 0.0002, 0.006 + asset["eventVolatility"] * 0.2)
    price = round_price((min(value, reference) * (1 - offset)) if side == "buy" else (max(value, reference) * (1 + offset)), tick)
    submit(side, "limit", max(tick, price))

def generate_npcs(market):
    profiles = list(market["profiles"].values())
    for _ in range(min(64, max(12, math.ceil(len(profiles) * 0.28)))):
        profile = profiles[random_int(market, 0, len(profiles) - 1)]
        asset = market["assets"][INSTRUMENTS[random_int(market, 0, len(INSTRUMENTS) - 1)]["symbol"]]
        npc_decision(market, profile, asset)

def metrics(market, player):
    value = sum(player["positions"][item["symbol"]]["quantity"] * market["assets"][item["symbol"]]["lastPrice"] for item in INSTRUMENTS)
    unrealized = sum(player["positions"][item["symbol"]]["quantity"] * (market["assets"][item["symbol"]]["lastPrice"] - player["positions"][item["symbol"]]["averageCost"]) for item in INSTRUMENTS)
    return {"positionValue": round_currency(value), "unrealized": round_currency(unrealized), "totalAsset": round_currency(player["cash"] + value)}

def capture_portfolio(market):
    player, data = market["accounts"]["player"], metrics(market, market["accounts"]["player"])
    total = data["totalAsset"]
    row = {"sim_time": sim_time(market), "tick": market["tick"], "total_asset": total, "cash_weight": player["cash"] / total if total else 0}
    for item in INSTRUMENTS:
        symbol = item["symbol"]
        row[f"weight_{symbol}"] = player["positions"][symbol]["quantity"] * market["assets"][symbol]["lastPrice"] / total if total else 0
    market["portfolio"].append(row)
`, String.raw`
def advance_tick(market):
    market["tick"] += 1
    for identifier in market["pending_cancel"]:
        order = market["orders"].get(identifier)
        if order and order["status"] not in ("filled", "cancelled"): cancel(market, order)
    market["pending_cancel"] = []
    for order in list(market["orders"].values()):
        if order["participantId"] != "player" and order["status"] in ("open", "partial") and market["tick"] - order["submittedTick"] >= 16:
            cancel(market, order)
    if market["tick"] >= market["next_event_tick"]: make_event(market)
    update_fair_values(market)
    generate_npcs(market)
    incoming = sorted((market["orders"][identifier] for identifier in market["pending"] if identifier in market["orders"]), key=lambda order: order["sequence"])
    market["pending"] = []
    for order in incoming: process_order(market, order)
    capture_portfolio(market)

def build_context(market, session):
    player, data, event = market["accounts"]["player"], metrics(market, market["accounts"]["player"]), market["latest_event"]
    assets, index = {}, market["tick"] // BAR_TICKS
    open_orders = [{"id": order["id"], "symbol": order["symbol"], "side": order["side"], "type": order["type"], "price": order["limitPrice"], "quantity": order["quantity"], "remaining": order["remaining"], "status": order["status"], "submitted_tick": order["submittedTick"], "reserved_cash": order["reservedCash"], "reserved_quantity": order["reservedQuantity"]} for order in sorted(market["orders"].values(), key=lambda row: row["sequence"]) if order["participantId"] == "player" and order["status"] in ("queued", "open", "partial", "pending_cancel")]
    for item in INSTRUMENTS:
        symbol, asset = item["symbol"], market["assets"][item["symbol"]]
        recent = [point["price"] for point in asset["priceHistory"] if point["tick"] > market["tick"] - BAR_TICKS] or [asset["lastPrice"]]
        prior = next((point["price"] for point in reversed(asset["priceHistory"]) if point["tick"] < market["tick"]), asset["previousClose"])
        five_back = next((point["price"] for point in reversed(asset["priceHistory"]) if point["tick"] <= market["tick"] - BAR_TICKS), asset["previousClose"])
        bids, asks, quote = levels(market, symbol, "buy"), levels(market, symbol, "sell"), quotes(market, symbol)
        bq, aq = sum(row["quantity"] for row in bids), sum(row["quantity"] for row in asks)
        m1 = (asset["lastPrice"] - prior) / prior if prior else 0
        m5 = (asset["lastPrice"] - five_back) / five_back if five_back else 0
        gap, imbalance = (asset["fairValue"] - asset["lastPrice"]) / asset["lastPrice"] if asset["lastPrice"] else 0, (bq - aq) / max(1, bq + aq)
        spread_bps = quote["spread"] / quote["mid"] * 10000 if quote["mid"] and quote["spread"] is not None else 0
        news = ((1 if event["direction"] == "bullish" else -1) * event["impact"] * (1 - event["permanentShare"])) if event and symbol in event["symbols"] else 0
        expected = round(0.45 * m1 + 0.7 * m5 + 0.85 * gap + 0.42 * imbalance + 0.55 * news - 0.03 * spread_bps / 100, 6)
        probability = round(1 / (1 + math.exp(-max(-12, min(12, expected * 18)))), 6)
        position = player["positions"][symbol]
        snapshot = {"sim_time": sim_time(market), "tick": market["tick"], "bar_index": index, "symbol": symbol, "open": recent[0], "high": max(recent), "low": min(recent), "close": asset["lastPrice"], "volume": asset["volume"] - session["last_volume"].get(symbol, 0), "best_bid": quote["bestBid"], "best_ask": quote["bestAsk"], "mid": quote["mid"], "spread": quote["spread"], "bid_quantity": bq, "ask_quantity": aq, "fair_value": asset["fairValue"], "fair_value_gap": gap, "momentum_1": m1, "momentum_5": m5, "book_imbalance": imbalance, "spread_bps": spread_bps, "event_signal": news, "up_probability": probability, "expected_return": expected, "position_quantity": position["quantity"], "available_quantity": position["quantity"] - position["reserved"], "reserved_quantity": position["reserved"], "average_cost": position["averageCost"], "account_cash": player["cash"], "account_available_cash": player["cash"] - player["reservedCash"], "account_frozen_cash": player["reservedCash"], "account_total_asset": data["totalAsset"], "account_position_value": data["positionValue"], "account_unrealized_pnl": data["unrealized"], "event_tick": event["tick"] if event else None, "event_direction": event["direction"] if event else None, "event_symbols": "|".join(event["symbols"]) if event else "", "event_impact": event["impact"] if event else None, "event_permanent_share": event["permanentShare"] if event else None, "open_orders_json": json.dumps(open_orders, separators=(",", ":"))}
        session["last_volume"][symbol] = asset["volume"]
        session["bars"].append(snapshot)
        prior_bars = [{key: bar[key] for key in ("tick", "open", "high", "low", "close", "volume")} for bar in session["bars"] if bar["symbol"] == symbol][-60:]
        assets[symbol] = {"bars": prior_bars, "bar": prior_bars[-1], "book": {"best_bid": quote["bestBid"], "best_ask": quote["bestAsk"], "mid": quote["mid"], "spread": quote["spread"], "bid_quantity": bq, "ask_quantity": aq}, "fair_value": asset["fairValue"], "position": {"quantity": position["quantity"], "available": position["quantity"] - position["reserved"], "reserved": position["reserved"], "average_cost": position["averageCost"]}, "model": {"version": "signal_v1", "up_probability": probability, "expected_return": expected, "momentum_1": m1, "momentum_5": m5, "fair_value_gap": gap, "book_imbalance": imbalance, "spread_bps": spread_bps, "event_signal": news}}
    return {"tick": market["tick"], "sim_time": sim_time(market), "bar_index": index, "bar_ticks": BAR_TICKS, "model_version": "signal_v1", "account": {"cash": player["cash"], "available_cash": player["cash"] - player["reservedCash"], "frozen_cash": player["reservedCash"], "total_asset": data["totalAsset"], "position_value": data["positionValue"], "unrealized_pnl": data["unrealized"]}, "open_orders": open_orders, "event": {"tick": event["tick"], "direction": event["direction"], "symbols": event["symbols"], "impact": event["impact"], "permanent_share": event["permanentShare"]} if event else None, "assets": assets}

def summary(market):
    player, data = market["accounts"]["player"], metrics(market, market["accounts"]["player"])
    return {"cash": player["cash"], "total_asset": data["totalAsset"], "position_value": data["positionValue"], "unrealized_pnl": data["unrealized"], "positions": {symbol: {"quantity": row["quantity"], "average_cost": row["averageCost"]} for symbol, row in player["positions"].items()}, "last_prices": {symbol: row["lastPrice"] for symbol, row in market["assets"].items()}}
`].join('');

export function downloadStrategyPackage(input: ReplayPackageInput): void {
  const replay = {
    engine_version: ENGINE_VERSION,
    model_version: MODEL_VERSION,
    strategy_bar_ticks: STRATEGY_BAR_TICKS,
    sim_start_ms: input.simStartMs,
    ticks: Math.max(1, Math.floor(input.ticks)),
    strategy_mode: input.dryRun ? 'dry_run' : 'live',
    initial_config: input.config,
  };
  const zip = createStoredZip([
    { name: 'README.md', content: packageReadme },
    { name: 'replay_config.json', content: `${JSON.stringify(replay, null, 2)}\n` },
    { name: 'strategy.py', content: input.code },
    { name: 'run.py', content: pythonRunner },
    { name: 'market_engine.py', content: pythonEngine },
  ]);
  download('finpub-python-replay.zip', zip);
}
