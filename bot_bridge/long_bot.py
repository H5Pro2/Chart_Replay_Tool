from http.server import BaseHTTPRequestHandler, HTTPServer
import json


TP_PERCENT = 0.01
SL_PERCENT = 0.01


def build_long_protection(entry):
    return {
        "takeProfit": round(entry * (1 + TP_PERCENT), 4),
        "stopLoss": round(entry * (1 - SL_PERCENT), 4),
    }


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
            self._send_json({"ok": True, "name": "long_bot"})
            return
        self._send_json({"ok": False, "message": "Not found"}, 404)

    def do_POST(self):
        if self.path != "/tick":
            self._send_json({"ok": False, "message": "Not found"}, 404)
            return

        length = int(self.headers.get("Content-Length", "0"))
        raw_body = self.rfile.read(length).decode("utf-8")
        tick = json.loads(raw_body or "{}")
        candle = tick.get("candle") or {}
        open_orders = tick.get("openOrders") or []

        # Minimal safe default: observe only. Replace this block with strategy logic.
        action = "hold"
        if not open_orders and candle.get("close") and candle.get("open"):
            action = "signal_buy" if candle["close"] > candle["open"] else "hold"

        # In paper mode you can return a simulated order for the tool:
        # {
        #   "action": "place_order",
        #   "side": "buy",
        #   "entry": 62.05,
        #   "quantity": 1,
        #   "takeProfit": 63.2,
        #   "stopLoss": 61.4
        # }
        if tick.get("botMode") == "paper" and not open_orders and candle.get("close"):
            close = float(candle["close"])
            protection = build_long_protection(close)
            action_payload = {
                "ok": True,
                "action": "place_order",
                "side": "buy",
                "entry": close,
                "quantity": 1,
                "takeProfit": protection["takeProfit"],
                "stopLoss": protection["stopLoss"],
                "symbol": tick.get("symbol"),
                "mode": tick.get("mode"),
                "botMode": tick.get("botMode"),
                "note": "Long paper order."
            }
            self._send_json(action_payload)
            return

        close = float(candle.get("close") or 0)
        protection = build_long_protection(close) if action == "signal_buy" and close > 0 else {}
        self._send_json({
            "ok": True,
            "action": action,
            "side": "buy" if action == "signal_buy" else None,
            **protection,
            "symbol": tick.get("symbol"),
            "mode": tick.get("mode"),
            "botMode": tick.get("botMode"),
            "note": "Long bot returns buy signals only."
        })


def run(host="127.0.0.1", port=8790):
    server = HTTPServer((host, port), BotHandler)
    print(f"Long bot listening on http://{host}:{port}/tick")
    server.serve_forever()


if __name__ == "__main__":
    run()
