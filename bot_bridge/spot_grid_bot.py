from http.server import BaseHTTPRequestHandler, HTTPServer
import json
import time


COOLDOWN_SECONDS = 2.0

STATE = {
    "initialized": False,
    "last_close": None,
    "last_trigger_key": None,
    "last_trigger_at": 0.0,
    "trigger_cooldowns": {},
    "inventory": {},
}


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

    panel_quantity = to_float(settings.get("quantity"), 0.0)
    if panel_quantity > 0:
        return round(panel_quantity, 4)

    investment = to_float(settings.get("investment"), 0.0)
    grid_count = max(1, int(to_float(settings.get("gridCount"), 1)))
    if entry <= 0 or investment <= 0:
        return None
    return round((investment / grid_count) / entry, 4)


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
        if line["price"] <= close and not has_open_entry(line["price"], open_prices)
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


def build_buy_order(symbol, trigger, lines, settings, status="active"):
    if should_skip_duplicate(symbol, trigger):
        return None, "duplicate"

    entry = trigger["price"]
    quantity = quantity_for_grid(entry, settings)
    if quantity is None or quantity <= 0:
        return None, "quantity"

    neighbors = adjacent_grid_lines(trigger, lines)
    take_profit = neighbors["upper"]["price"] if neighbors["upper"] else None
    if take_profit is None or take_profit <= entry:
        return None, "target"

    return {
        "side": "buy",
        "entry": entry,
        "quantity": quantity,
        "takeProfit": round(take_profit, 6),
        "stopLoss": None,
        "status": status,
        "gridIndex": trigger.get("index"),
        "spotGrid": True,
        "mechanic": "spot_grid",
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


def find_spot_buy_triggers(candle, lines, open_orders):
    path = candle_path(candle)
    if not path:
        return []

    candidates = []
    open_prices = open_entry_prices(open_orders)
    for line in lines:
        price = line["price"]
        # Spot grid buys only when price crosses a grid line downward.
        if path["start"] > price and path["low"] <= price and not has_open_entry(price, open_prices):
            candidates.append({
                "price": price,
                "index": line.get("index"),
                "distance": abs(path["start"] - price),
            })

    return sorted(candidates, key=lambda item: item["distance"])


def should_skip_duplicate(symbol, trigger):
    key = f"{symbol}:spot-buy:{trigger['price']}"
    now = time.time()
    cooldowns = STATE.setdefault("trigger_cooldowns", {})
    last_trigger_at = cooldowns.get(key, 0.0)
    if now - last_trigger_at < COOLDOWN_SECONDS:
        return True
    cooldowns[key] = now
    STATE["last_trigger_key"] = key
    STATE["last_trigger_at"] = now
    return False


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
                "spotGrid": True,
                "mechanic": "spot_grid",
                "note": "No valid spot grid levels available."
            })
            return

        if path and not STATE["initialized"]:
            STATE["initialized"] = True
            STATE["last_close"] = path["close"]
            trigger = initial_buy_trigger(path, lines, open_orders)
            if trigger:
                order, skipped_reason = build_buy_order(symbol, trigger, lines, settings, status="pending")
                if order:
                    self._send_json({
                        "ok": True,
                        "action": "place_order" if bot_mode == "paper" else "signal_buy",
                        "side": order["side"],
                        "entry": order["entry"],
                        "quantity": order["quantity"],
                        "takeProfit": order["takeProfit"],
                        "stopLoss": None,
                        "orders": [order],
                        "symbol": symbol,
                        "mode": mode,
                        "botMode": bot_mode,
                        "gridIndex": order.get("gridIndex"),
                        "spotGrid": True,
                        "mechanic": "spot_grid",
                        "initializedPrice": STATE["last_close"],
                        "note": "Spot grid initialized with one lower-grid buy order."
                    })
                    return
                self._send_json({
                    "ok": True,
                    "action": "hold",
                    "symbol": symbol,
                    "mode": mode,
                    "botMode": bot_mode,
                    "spotGrid": True,
                    "mechanic": "spot_grid",
                    "initializedPrice": STATE["last_close"],
                    "skippedReason": skipped_reason,
                    "note": "Spot grid initialized, but the first buy order was not allowed."
                })
                return
            self._send_json({
                "ok": True,
                "action": "hold",
                "symbol": symbol,
                "mode": mode,
                "botMode": bot_mode,
                "spotGrid": True,
                "mechanic": "spot_grid",
                "initializedPrice": STATE["last_close"],
                "note": "Spot grid initialized. No lower grid level is available for the first buy."
            })
            return

        triggers_to_buy = find_spot_buy_triggers(candle, lines, open_orders)
        if not triggers_to_buy:
            self._send_json({
                "ok": True,
                "action": "hold",
                "symbol": symbol,
                "mode": mode,
                "botMode": bot_mode,
                "spotGrid": True,
                "mechanic": "spot_grid",
                "note": "No downward spot grid crossing."
            })
            return

        orders = []
        skipped_duplicates = 0
        skipped_without_target = 0
        skipped_without_quantity = 0
        for trigger in triggers_to_buy:
            order, skipped_reason = build_buy_order(symbol, trigger, lines, settings)
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
                "spotGrid": True,
                "mechanic": "spot_grid",
                "skippedDuplicates": skipped_duplicates,
                "skippedWithoutTarget": skipped_without_target,
                "skippedWithoutQuantity": skipped_without_quantity,
                "note": "Spot grid crossed levels, but no new buy order was allowed."
            })
            return

        first_order = orders[0]
        payload = {
            "ok": True,
            "action": "place_orders" if len(orders) > 1 and bot_mode == "paper" else "place_order" if bot_mode == "paper" else "signal_buy",
            "side": first_order["side"],
            "entry": first_order["entry"],
            "quantity": first_order["quantity"],
            "takeProfit": first_order["takeProfit"],
            "stopLoss": None,
            "orders": orders,
            "symbol": symbol,
            "mode": mode,
            "botMode": bot_mode,
            "gridIndex": first_order.get("gridIndex"),
            "spotGrid": True,
            "mechanic": "spot_grid",
            "note": "Spot grid buy order(s) placed. Each upper grid line is the sell target."
        }
        self._send_json(payload)


def run(host="127.0.0.1", port=8790):
    server = HTTPServer((host, port), BotHandler)
    print(f"Spot grid bot listening on http://{host}:{port}/tick")
    server.serve_forever()


if __name__ == "__main__":
    run()
