from http.server import BaseHTTPRequestHandler, HTTPServer
import json
import time


STATE = {
    "initialized": False,
    "last_close": None,
    "inventory": {},
    "recent_orders": {}
}

GRID_PREFIX = "crt-grid"
RECENT_ORDER_TTL_SECONDS = 30


def to_float(value, fallback=0.0):
    try:
        return float(value)
    except (TypeError, ValueError):
        return fallback


def candle_path(candle):
    open_price = to_float(candle.get("open"))
    high = to_float(candle.get("high"))
    low = to_float(candle.get("low"))
    close = to_float(candle.get("close"))
    previous_close = to_float(candle.get("previousClose"))
    if high <= 0 or low <= 0 or close <= 0:
        return None

    start_price = previous_close if previous_close > 0 else open_price if open_price > 0 else close
    path_low = min(value for value in (low, open_price, start_price) if value > 0)
    path_high = max(value for value in (high, open_price, start_price) if value > 0)
    return {
        "close": close,
        "start": start_price,
        "low": path_low,
        "high": path_high,
    }


def normalize_grid_trigger(trigger):
    price = to_float(trigger.get("price"))
    if price <= 0:
        return None
    return {
        "price": price,
        "index": trigger.get("index"),
    }


def sorted_triggers(triggers):
    items = []
    for trigger in triggers:
        normalized = normalize_grid_trigger(trigger)
        if normalized:
            items.append(normalized)
    return sorted(items, key=lambda item: item["price"])


def build_grid_from_settings(settings):
    price_from = to_float(settings.get("priceFrom"))
    price_to = to_float(settings.get("priceTo"))
    grid_count = int(max(0, to_float(settings.get("gridCount"), 0)))
    if price_from <= 0 or price_to <= 0 or grid_count < 2:
        return []

    low = min(price_from, price_to)
    high = max(price_from, price_to)
    step = (high - low) / (grid_count - 1)
    if step <= 0:
        return []

    return [
        {"price": round(low + index * step, 6), "index": index}
        for index in range(grid_count)
    ]


def make_grid_client_order_id(symbol, side, entry_price, grid_index):
    symbol_part = str(symbol or "SYM").upper().replace(" ", "").replace("-", "").replace("_", "")[:14]
    side_part = "S" if str(side).lower() in ("sell",) else "B"
    index_value = int(grid_index) if isinstance(grid_index, (int, float)) else "X"
    price_part = str(int(round(float(entry_price) * 1_000_000))).replace("-", "")[:12]
    return f"{GRID_PREFIX}-{symbol_part}-{side_part}-{index_value}-{price_part}"[:40]


def grid_lines(triggers, settings):
    lines = sorted_triggers(triggers)
    if lines:
        return lines
    return build_grid_from_settings(settings)


def quantity_for_grid(entry, settings):
    amount_mode = str(settings.get("amountMode") or "asset").lower()
    amount_value = to_float(settings.get("amountValue"), 0.0)
    if amount_value > 0:
        if amount_mode == "usdt":
            if entry <= 0:
                return None
            return round(amount_value / entry, 4)
        return round(amount_value, 4)

    investment = to_float(settings.get("investment"), 0.0)
    grid_count = max(1, int(to_float(settings.get("gridCount"), 1)))
    if entry <= 0 or investment <= 0:
        return None
    return round((investment / grid_count) / entry, 4)


def grid_market_type(settings):
    market_type = str(settings.get("marketType") or "spot").lower()
    return "future" if market_type == "future" else "spot"


def grid_margin_mode(settings):
    margin_mode = str(settings.get("marginMode") or "cross").lower()
    return "isolated" if margin_mode == "isolated" else "cross"


def grid_order_type(settings):
    order_type = str(settings.get("orderType") or "limit").lower()
    return "market" if order_type == "market" else "limit"


def grid_stop_loss_enabled(settings):
    return grid_market_type(settings) == "future" and bool(settings.get("stopLossEnabled"))


def adjacent_grid_lines(trigger, lines):
    if len(lines) < 2:
        return {"lower": None, "upper": None}

    trigger_index = trigger.get("index")
    trigger_line = None
    if trigger_index is not None:
        trigger_line = next((line for line in lines if line.get("index") == trigger_index), None)
    if trigger_line is None:
        trigger_line = min(lines, key=lambda line: abs(line["price"] - trigger["price"]))

    lower_line = next((line for line in reversed(lines) if line["price"] < trigger_line["price"]), None)
    upper_line = next((line for line in lines if line["price"] > trigger_line["price"]), None)
    return {"lower": lower_line, "upper": upper_line}


def initial_buy_trigger(path, lines, open_orders):
    if not path or not lines:
        return None
    open_prices = open_entry_prices(open_orders)
    close = path["close"]
    lower_or_current = [
        line for line in lines
        if line["price"] <= close and not has_open_entry(
            line["price"],
            open_prices,
            _grid_level_tolerance(lines, line["price"], line.get("index"))
        )
    ]
    if not lower_or_current:
        return None
    trigger = max(lower_or_current, key=lambda line: line["price"])
    neighbors = adjacent_grid_lines(trigger, lines)
    if not neighbors["upper"]:
        return None
    return {
        "price": trigger["price"],
        "index": trigger.get("index"),
        "distance": abs(close - trigger["price"]),
    }


def build_buy_order(symbol, trigger, lines, settings, status="active", live_mode=False, bot_mode="paper", open_orders=None):
    if should_skip_duplicate(
        symbol,
        trigger,
        lines,
        open_orders or [],
        live_mode=live_mode,
        bot_mode=bot_mode
    ):
        return None, "duplicate"

    entry = trigger["price"]
    quantity = quantity_for_grid(entry, settings)
    if quantity is None or quantity <= 0:
        return None, "quantity"

    neighbors = adjacent_grid_lines(trigger, lines)
    take_profit = neighbors["upper"]["price"] if neighbors["upper"] else None
    if take_profit is None or take_profit <= entry:
        return None, "target"

    market_type = grid_market_type(settings)
    order_type = grid_order_type(settings)
    stop_loss = None
    if grid_stop_loss_enabled(settings):
        lower_line = neighbors["lower"]["price"] if neighbors["lower"] else None
        fallback_sl_percent = max(0.0, to_float(settings.get("stopLossPercent"), 0.98)) / 100
        stop_loss = lower_line if lower_line and lower_line < entry else entry * (1 - fallback_sl_percent)
        stop_loss = round(stop_loss, 6) if stop_loss and stop_loss > 0 else None

    return {
        "side": "buy",
        "entry": entry,
        "quantity": quantity,
        "takeProfit": round(take_profit, 6),
        "stopLoss": stop_loss,
        "status": "active" if order_type == "market" else status,
        "orderType": order_type,
        "marginMode": grid_margin_mode(settings),
        "leverage": max(1.0, to_float(settings.get("leverage"), 1.0)),
        "gridIndex": trigger.get("index"),
        "spotGrid": market_type == "spot",
        "gridBot": True,
        "gridMarketType": market_type,
        "mechanic": "spot_grid" if market_type == "spot" else "grid_bot",
        "clientOrderId": make_grid_client_order_id(symbol, "buy", entry, trigger.get("index")),
    }, None


def open_entry_prices(open_orders):
    prices = []
    for order in open_orders:
        status = str(order.get("status", "")).lower()
        if status not in ("pending", "active"):
            continue
        entry = to_float(order.get("entry"))
        if entry > 0:
            prices.append(entry)
    return prices


def has_open_entry(price, open_prices, tolerance=0.000001):
    return any(abs(price - open_price) <= tolerance for open_price in open_prices)


def _closest_grid_line(lines, entry_price, index_value=None):
    if not lines:
        return None
    if index_value is not None:
        for line in lines:
            if line.get("index") == index_value:
                return line
    return min(lines, key=lambda line: abs(line["price"] - entry_price))


def _grid_level_span(lines, entry_price, index_value=None):
    sorted_lines = sorted(lines, key=lambda item: item["price"])
    line = _closest_grid_line(sorted_lines, entry_price, index_value)
    if line is None:
        return 0.0
    index = sorted_lines.index(line)
    lower = sorted_lines[index - 1] if index > 0 else None
    upper = sorted_lines[index + 1] if index + 1 < len(sorted_lines) else None

    if lower is not None and upper is not None:
        return min(line["price"] - lower["price"], upper["price"] - line["price"])
    if lower is not None:
        return line["price"] - lower["price"]
    if upper is not None:
        return upper["price"] - line["price"]
    return 0.0


def _grid_level_tolerance(lines, entry_price, index_value=None):
    span = _grid_level_span(lines, entry_price, index_value)
    fallback = max(0.000001, abs(to_float(entry_price)) * 0.0005)
    if span <= 0:
        return fallback
    return max(span / 2, fallback)


def find_grid_buy_triggers(candle, lines, open_orders):
    path = candle_path(candle)
    if not path:
        return []

    candidates = []
    open_prices = open_entry_prices(open_orders)
    for line in lines:
        price = line["price"]
        if has_open_entry(
            price,
            open_prices,
            _grid_level_tolerance(lines, price, line.get("index"))
        ):
            continue
        neighbors = adjacent_grid_lines(line, lines)
        if not neighbors["upper"]:
            continue
        crossed_down = path["start"] > price and path["low"] <= price
        pending_below_price = price < path["close"]
        if crossed_down or pending_below_price:
            candidates.append({
                "price": price,
                "index": line.get("index"),
                "status": "active" if crossed_down else "pending",
                "distance": abs(path["close"] - price),
            })

    if not candidates:
        return []
    candidates = sorted(candidates, key=lambda item: (item["status"] != "active", item["distance"]))
    # Return only the single closest missing level for this tick to avoid
    # firing multiple reorders at once and to keep replacement behavior explicit.
    return [candidates[0]]


def should_skip_duplicate(symbol, trigger, lines, open_orders, live_mode=False, bot_mode="paper"):
    if not live_mode or str(bot_mode).lower() == "paper":
        return False
    open_prices = open_entry_prices(open_orders)
    if has_open_entry(
        float(trigger.get("price", 0.0)),
        open_prices,
        _grid_level_tolerance(lines, trigger.get("price", 0.0), trigger.get("index"))
    ):
        return True

    client_order_id = make_grid_client_order_id(symbol, "buy", trigger.get("price", 0), trigger.get("index"))
    guard = STATE["recent_orders"].get(symbol) or {}
    expired_at = guard.get(client_order_id)
    if expired_at is not None and time.time() < expired_at:
        return True

    return False


def record_recent_grid_order(symbol, client_order_id):
    now = time.time()
    symbol_guard = STATE["recent_orders"].setdefault(symbol, {})
    symbol_guard[client_order_id] = now + RECENT_ORDER_TTL_SECONDS
    cutoff = now - RECENT_ORDER_TTL_SECONDS * 2
    STATE["recent_orders"] = {
        symbol_key: {
            order_id: expires_at
            for order_id, expires_at in symbol_guard.items()
            if expires_at > cutoff
        }
        for symbol_key, symbol_guard in STATE["recent_orders"].items()
    }


def update_inventory_from_orders(open_orders):
    inventory = {}
    for order in open_orders:
        if str(order.get("side", "")).lower() != "buy":
            continue
        status = str(order.get("status", "")).lower()
        if status not in ("pending", "active"):
            continue
        entry = to_float(order.get("entry"))
        quantity = to_float(order.get("quantity"))
        if entry > 0 and quantity > 0:
            inventory[str(round(entry, 6))] = quantity
    STATE["inventory"] = inventory


class BotHandler(BaseHTTPRequestHandler):
    def _send_json(self, payload, status=200):
        body = json.dumps(payload).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        if self.path == "/health":
            self._send_json({"ok": True, "name": "spot_grid_bot", "mechanic": "spot_grid"})
            return
        self._send_json({"ok": False, "message": "Not found"}, 404)

    def do_POST(self):
        if self.path != "/tick":
            self._send_json({"ok": False, "message": "Not found"}, 404)
            return

        length = int(self.headers.get("Content-Length", "0"))
        tick = json.loads(self.rfile.read(length).decode("utf-8") or "{}")
        candle = tick.get("candle") or {}
        open_orders = tick.get("openOrders") or []
        triggers = tick.get("gridTriggers") or []
        settings = tick.get("gridSettings") or {}
        symbol = tick.get("symbol")
        mode = tick.get("mode")
        bot_mode = tick.get("botMode")
        live_mode = str(mode).lower() == "live"
        market_type = grid_market_type(settings)
        mechanic = "spot_grid" if market_type == "spot" else "grid_bot"
        path = candle_path(candle)
        lines = grid_lines(triggers, settings)
        update_inventory_from_orders(open_orders)

        if not lines:
            self._send_json({
                "ok": True,
                "action": "hold",
                "symbol": symbol,
                "mode": mode,
                "botMode": bot_mode,
                "spotGrid": market_type == "spot",
                "gridBot": True,
                "gridMarketType": market_type,
                "mechanic": mechanic,
                "note": "No valid grid levels available."
            })
            return

        if path and not STATE["initialized"]:
            STATE["initialized"] = True
            STATE["last_close"] = path["close"]

        triggers_to_buy = find_grid_buy_triggers(candle, lines, open_orders)
        if not triggers_to_buy:
            self._send_json({
                "ok": True,
                "action": "hold",
                "symbol": symbol,
                "mode": mode,
                "botMode": bot_mode,
                "spotGrid": market_type == "spot",
                "gridBot": True,
                "gridMarketType": market_type,
                "mechanic": mechanic,
                "note": "No missing grid buy levels."
            })
            return

        orders = []
        skipped_duplicates = 0
        skipped_without_target = 0
        skipped_without_quantity = 0
        for trigger in triggers_to_buy:
            order, skipped_reason = build_buy_order(
                symbol,
                trigger,
                lines,
                settings,
                status=trigger.get("status", "active"),
                live_mode=live_mode,
                bot_mode=bot_mode,
                open_orders=open_orders,
            )
            if skipped_reason == "quantity":
                skipped_without_quantity += 1
                continue
            if skipped_reason == "target":
                skipped_without_target += 1
                continue
            if skipped_reason == "duplicate":
                skipped_duplicates += 1
                continue
            if order:
                orders.append(order)

        if not orders:
            self._send_json({
                "ok": True,
                "action": "hold",
                "symbol": symbol,
                "mode": mode,
                "botMode": bot_mode,
                "spotGrid": market_type == "spot",
                "gridBot": True,
                "gridMarketType": market_type,
                "mechanic": mechanic,
                "skippedDuplicates": skipped_duplicates,
                "skippedWithoutTarget": skipped_without_target,
                "skippedWithoutQuantity": skipped_without_quantity,
                "note": "Gridbot found missing levels, but no new buy order was allowed."
            })
            return

        first_order = orders[0]
        client_order_id = first_order.get("clientOrderId")
        if client_order_id:
            record_recent_grid_order(symbol, client_order_id)
        payload = {
            "ok": True,
            "action": "place_order",
            "side": first_order["side"],
            "entry": first_order["entry"],
            "quantity": first_order["quantity"],
            "takeProfit": first_order["takeProfit"],
            "stopLoss": first_order["stopLoss"],
            "orders": [first_order],
            "symbol": symbol,
            "mode": mode,
            "botMode": bot_mode,
            "gridIndex": first_order.get("gridIndex"),
            "spotGrid": market_type == "spot",
            "gridBot": True,
            "gridMarketType": market_type,
            "mechanic": mechanic,
            "note": "Gridbot buy order placed. The nearest missing level was selected first."
        }
        self._send_json(payload)


def run(host="127.0.0.1", port=8790):
    server = HTTPServer((host, port), BotHandler)
    print(f"Gridbot listening on http://{host}:{port}/tick")
    server.serve_forever()


if __name__ == "__main__":
    run()
