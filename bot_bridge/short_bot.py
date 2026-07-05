from http.server import BaseHTTPRequestHandler, HTTPServer
import json


TP_PERCENT = 0.01
SL_PERCENT = 0.01


def build_short_protection(entry):
    return {
        "takeProfit": round(entry * (1 - TP_PERCENT), 4),
        "stopLoss": round(entry * (1 + SL_PERCENT), 4),
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
            self._send_json({"ok": True, "name": "short_bot"})
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
        close = float(candle.get("close") or 0)

        if tick.get("botMode") == "paper" and not open_orders and close > 0:
            protection = build_short_protection(close)
            self._send_json({
                "ok": True,
                "action": "place_order",
                "side": "sell",
                "entry": close,
                "quantity": 1,
                "takeProfit": protection["takeProfit"],
                "stopLoss": protection["stopLoss"],
                "symbol": tick.get("symbol"),
                "mode": tick.get("mode"),
                "botMode": tick.get("botMode"),
                "note": "Short paper order."
            })
            return

        action = "signal_sell" if not open_orders else "hold"
        protection = build_short_protection(close) if action == "signal_sell" and close > 0 else {}
        self._send_json({
            "ok": True,
            "action": action,
            "side": "sell" if action == "signal_sell" else None,
            **protection,
            "symbol": tick.get("symbol"),
            "mode": tick.get("mode"),
            "botMode": tick.get("botMode"),
            "note": "Short bot returns sell signals."
        })


def run(host="127.0.0.1", port=8790):
    server = HTTPServer((host, port), BotHandler)
    print(f"Short bot listening on http://{host}:{port}/tick")
    server.serve_forever()


if __name__ == "__main__":
    run()
