from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path
from urllib.parse import urlparse
import json
import math
import random
import threading


# --------------------------------------------------
# Strategie-Konfiguration
# --------------------------------------------------

EMA_FAST_PERIOD = 9
EMA_SLOW_PERIOD = 21
RSI_PERIOD = 14
ATR_PERIOD = 14

MIN_HISTORY = 30
MAX_HISTORY = 300

ATR_STOP_MULTIPLIER = 1.25
ATR_TARGET_MULTIPLIER = 2.00

MIN_REWARD_RISK_RATIO = 1.25
MAX_RISK_BALANCE_PERCENT = 12.0
MIN_PROTECTION_GAP_PERCENT = 0.0005

MIN_ATR_PERCENT = 0.0010
MAX_ATR_PERCENT = 0.0500

ENTRY_THRESHOLD = 0.62
MIN_DIRECTION_EDGE = 0.12

LEARNING_RATE = 0.018
WEIGHT_DECAY = 0.0002

START_EXPLORATION = 0.025
MIN_EXPLORATION = 0.002
EXPLORATION_DECAY_TRADES = 500

WIN_REWARD = 1.0
LOSS_REWARD = -1.35

MAX_TRADE_CANDLES = 40

COOLDOWN_AFTER_WIN = 2
COOLDOWN_AFTER_LOSS = 5

MODEL_SAVE_EVERY = 1

MODEL_VERSION = 2


# --------------------------------------------------
# Modell-Datei
# --------------------------------------------------

MODEL_PATH = (
    Path(__file__)
    .resolve()
    .parent
    / "rl_bot_model.json"
)

CONFIG_PATH = (
    Path(__file__)
    .resolve()
    .parent
    / "rl_bot_config.json"
)

DEFAULT_CONFIG = {
    "minNetProfitPercent": 0.20,
    "brokerFeePercent": 0.07,
    "minRewardRiskRatio": MIN_REWARD_RISK_RATIO,
    "maxRiskBalancePercent": MAX_RISK_BALANCE_PERCENT,
    "atrTargetMultiplier": ATR_TARGET_MULTIPLIER,
    "atrStopMultiplier": ATR_STOP_MULTIPLIER,
}


def load_bot_config():
    config = dict(DEFAULT_CONFIG)

    if CONFIG_PATH.exists():
        try:
            stored = json.loads(
                CONFIG_PATH.read_text(
                    encoding="utf-8"
                )
            )

            if isinstance(
                stored,
                dict,
            ):
                for key, default_value in DEFAULT_CONFIG.items():
                    value = stored.get(
                        key
                    )

                    if isinstance(
                        value,
                        (
                            int,
                            float,
                            str,
                        ),
                    ):
                        try:
                            config[
                                key
                            ] = max(
                                0.0,
                                float(
                                    value
                                ),
                            )
                        except ValueError:
                            config[
                                key
                            ] = default_value

        except Exception:
            pass

    return config


def save_bot_config(config):
    clean_config = {}

    for key, default_value in DEFAULT_CONFIG.items():
        value = config.get(key, default_value)
        try:
            clean_config[key] = max(0.0, float(value))
        except (TypeError, ValueError):
            clean_config[key] = default_value

    temporary_path = CONFIG_PATH.with_suffix(".tmp")
    temporary_path.write_text(
        json.dumps(
            clean_config,
            indent=2,
            sort_keys=True,
        ),
        encoding="utf-8",
    )
    temporary_path.replace(CONFIG_PATH)
    return clean_config


def build_health_payload(handler):
    config = load_bot_config()
    trades = (
        MODEL.trades
    )

    win_rate = (
        MODEL.wins
        / trades
        if trades > 0
        else 0.0
    )

    return {
        "ok": True,
        "name": (
            "adaptive_long_short_bot"
        ),
        "version": (
            MODEL_VERSION
        ),
        "samples": (
            MODEL.samples
        ),
        "trades": (
            MODEL.trades
        ),
        "wins": (
            MODEL.wins
        ),
        "losses": (
            MODEL.losses
        ),
        "ambiguous": (
            MODEL.ambiguous
        ),
        "expired": (
            MODEL.expired
        ),
        "winRate": round(
            win_rate,
            4,
        ),
        "reward": round(
            MODEL.total_reward,
            4,
        ),
        "modelPath": str(
            MODEL_PATH
        ),
        "modelExists": (
            MODEL_PATH.exists()
        ),
        "unsavedUpdates": (
            MODEL.updates_since_save
        ),
        "lastDecision": (
            MODEL.last_decision
        ),
        "lastOutcome": (
            MODEL.last_outcome
        ),
        "openLearningTrades": (
            len(
                handler.active_learning_trade
            )
        ),
        "cooldowns": (
            len(
                handler.cooldown_until
            )
        ),
        "config": config,
        "configPath": str(CONFIG_PATH),
    }


def build_dashboard_html():
    return """<!doctype html>
<html lang="de">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>RL Bot Status</title>
  <style>
    :root {
      color: #d8dadd;
      background: #0d0f12;
      font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    }
    body { margin: 0; padding: 24px; background: #0d0f12; }
    main { max-width: 1120px; margin: 0 auto; }
    header {
      display: flex; justify-content: space-between; gap: 16px; align-items: center;
      padding: 18px 20px; border: 1px solid #2a3038; border-radius: 10px; background: #15181d;
    }
    h1 { margin: 0; font-size: 22px; }
    .muted { color: #9ca3ad; }
    .dot { width: 10px; height: 10px; border-radius: 50%; background: #2fbf71; box-shadow: 0 0 14px rgba(47,191,113,.75); display: inline-block; }
    .status { display: inline-flex; align-items: center; gap: 10px; border: 1px solid rgba(47,191,113,.45); border-radius: 999px; padding: 8px 12px; }
    .grid { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 12px; margin-top: 16px; }
    .card, .wide {
      border: 1px solid #2a3038; border-radius: 10px; background: #11151b; padding: 16px;
    }
    .wide { margin-top: 12px; }
    .label { color: #9ca3ad; font-size: 12px; text-transform: uppercase; }
    .value { margin-top: 8px; font-size: 24px; font-weight: 700; }
    pre { white-space: pre-wrap; word-break: break-word; color: #d8dadd; margin: 10px 0 0; font-size: 13px; }
    a, button {
      border: 1px solid #343b46; border-radius: 8px; background: #1c2027; color: #f0f2f4;
      padding: 9px 12px; cursor: pointer; text-decoration: none; display: inline-flex;
    }
    button:active { transform: translateY(1px); filter: brightness(1.12); }
    @media (max-width: 850px) { .grid { grid-template-columns: repeat(2, minmax(0, 1fr)); } header { align-items: flex-start; flex-direction: column; } }
  </style>
</head>
<body>
<main>
  <header>
    <div>
      <h1>RL Bot Status</h1>
      <div class="muted">Eigenstaendige Bot-Diagnose. Das Chart Replay Tool bleibt getrennt.</div>
    </div>
    <div class="status"><span class="dot"></span><strong id="state">lade...</strong></div>
  </header>
  <section class="grid">
    <div class="card"><div class="label">Samples</div><div class="value" id="samples">-</div></div>
    <div class="card"><div class="label">Trades gelernt</div><div class="value" id="trades">-</div></div>
    <div class="card"><div class="label">Trefferquote</div><div class="value" id="winRate">-</div></div>
    <div class="card"><div class="label">Reward</div><div class="value" id="reward">-</div></div>
  </section>
  <section class="wide">
    <div class="label">Modell</div>
    <pre id="model">-</pre>
  </section>
  <section class="wide">
    <div class="label">Letzte Entscheidung</div>
    <pre id="decision">-</pre>
  </section>
  <section class="wide">
    <div class="label">Letzter Lern-Ausgang</div>
    <pre id="outcome">-</pre>
  </section>
  <section class="wide">
    <a href="/setup">Setup</a>
    <button type="button" onclick="loadStatus()">Aktualisieren</button>
  </section>
</main>
<script>
async function loadStatus() {
  const response = await fetch('/health', { cache: 'no-store' });
  const data = await response.json();
  document.getElementById('state').textContent = data.ok ? 'Bot erreichbar' : 'Fehler';
  document.getElementById('samples').textContent = data.samples ?? '-';
  document.getElementById('trades').textContent = data.trades ?? '-';
  document.getElementById('winRate').textContent = (((data.winRate ?? 0) * 100).toFixed(1)) + ' %';
  document.getElementById('reward').textContent = Number(data.reward ?? 0).toFixed(4);
  document.getElementById('model').textContent = JSON.stringify({
    path: data.modelPath,
    exists: data.modelExists,
    unsavedUpdates: data.unsavedUpdates,
    openLearningTrades: data.openLearningTrades,
    cooldowns: data.cooldowns,
    wins: data.wins,
    losses: data.losses,
    ambiguous: data.ambiguous,
    expired: data.expired
  }, null, 2);
  document.getElementById('decision').textContent = JSON.stringify(data.lastDecision || {}, null, 2);
  document.getElementById('outcome').textContent = JSON.stringify(data.lastOutcome || {}, null, 2);
}
loadStatus();
setInterval(loadStatus, 2000);
</script>
</body>
</html>"""


def build_setup_html():
    config = load_bot_config()
    return f"""<!doctype html>
<html lang="de">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>RL Bot Setup</title>
  <style>
    :root {{
      color: #d8dadd;
      background: #0d0f12;
      font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    }}
    body {{ margin: 0; padding: 24px; background: #0d0f12; }}
    main {{ max-width: 860px; margin: 0 auto; }}
    header, section {{
      border: 1px solid #2a3038;
      border-radius: 10px;
      background: #15181d;
      padding: 18px 20px;
      margin-bottom: 14px;
    }}
    h1 {{ margin: 0; font-size: 22px; }}
    .muted {{ color: #9ca3ad; margin-top: 6px; }}
    .grid {{ display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 12px; }}
    label {{ display: grid; gap: 7px; color: #b6beca; }}
    input {{
      border: 1px solid #343b46;
      border-radius: 8px;
      background: #0f1319;
      color: #f0f2f4;
      padding: 10px 11px;
      font: inherit;
    }}
    button, a {{
      border: 1px solid #343b46;
      border-radius: 8px;
      background: #1c2027;
      color: #f0f2f4;
      padding: 10px 13px;
      cursor: pointer;
      text-decoration: none;
      display: inline-flex;
      align-items: center;
      justify-content: center;
    }}
    button.primary {{
      border-color: rgba(47,191,113,.45);
      background: rgba(47,191,113,.14);
    }}
    button:active, a:active {{ transform: translateY(1px); filter: brightness(1.12); }}
    .actions {{ display: flex; gap: 10px; margin-top: 14px; }}
    pre {{
      white-space: pre-wrap;
      word-break: break-word;
      color: #d8dadd;
      background: #0f1319;
      border: 1px solid #2a3038;
      border-radius: 8px;
      padding: 12px;
    }}
    @media (max-width: 700px) {{ .grid {{ grid-template-columns: 1fr; }} }}
  </style>
</head>
<body>
<main>
  <header>
    <h1>RL Bot Setup</h1>
    <div class="muted">Eigenstaendige Bot-Konfiguration. Diese Seite gehoert zum Bot-Server, nicht zum Chart Replay Tool.</div>
  </header>
  <section>
    <div class="grid">
      <label>Mindest-Profit %
        <input id="minNetProfitPercent" type="number" step="0.01" min="0" value="{config["minNetProfitPercent"]}">
      </label>
      <label>Broker-Gebuehr %
        <input id="brokerFeePercent" type="number" step="0.001" min="0" value="{config["brokerFeePercent"]}">
      </label>
      <label>Mindest Chance/Risiko
        <input id="minRewardRiskRatio" type="number" step="0.05" min="0" value="{config["minRewardRiskRatio"]}">
      </label>
      <label>Max Risiko Konto %
        <input id="maxRiskBalancePercent" type="number" step="0.1" min="0" value="{config["maxRiskBalancePercent"]}">
      </label>
      <label>ATR TP Multiplikator
        <input id="atrTargetMultiplier" type="number" step="0.05" min="0" value="{config["atrTargetMultiplier"]}">
      </label>
      <label>ATR SL Multiplikator
        <input id="atrStopMultiplier" type="number" step="0.05" min="0" value="{config["atrStopMultiplier"]}">
      </label>
    </div>
    <div class="actions">
      <button class="primary" type="button" onclick="saveConfig()">Speichern</button>
      <a href="/">Status</a>
    </div>
  </section>
  <section>
    <div class="muted">Antwort</div>
    <pre id="result">Noch nicht gespeichert.</pre>
  </section>
</main>
<script>
const fields = [
  'minNetProfitPercent',
  'brokerFeePercent',
  'minRewardRiskRatio',
  'maxRiskBalancePercent',
  'atrTargetMultiplier',
  'atrStopMultiplier'
];

async function saveConfig() {{
  const payload = {{}};
  for (const field of fields) {{
    payload[field] = Number(document.getElementById(field).value);
  }}
  const response = await fetch('/config', {{
    method: 'POST',
    headers: {{ 'Content-Type': 'application/json' }},
    body: JSON.stringify(payload)
  }});
  const data = await response.json();
  document.getElementById('result').textContent = JSON.stringify(data, null, 2);
}}
</script>
</body>
</html>"""


# --------------------------------------------------
# Aktionen
# --------------------------------------------------

ACTION_HOLD = "hold"
ACTION_LONG = "long"
ACTION_SHORT = "short"

ACTIONS = [
    ACTION_HOLD,
    ACTION_LONG,
    ACTION_SHORT,
]


# --------------------------------------------------
# Features
# --------------------------------------------------

FEATURE_NAMES = [
    "bias",
    "ret1",
    "ret3",
    "ret6",
    "ema_gap",
    "ema_fast_gap",
    "ema_slope",
    "rsi",
    "atr",
    "body",
    "upper_wick",
    "lower_wick",
    "volume",
]


# --------------------------------------------------
# Hilfsfunktionen
# --------------------------------------------------

def clamp(
    value,
    minimum,
    maximum,
):
    return max(
        minimum,
        min(
            maximum,
            value,
        ),
    )


def safe_divide(
    numerator,
    denominator,
    default=0.0,
):
    if denominator == 0:
        return default

    return (
        numerator
        / denominator
    )


def number_from(
    value,
    default=None,
):
    try:
        if value is None:
            return default

        if isinstance(
            value,
            str,
        ):
            value = (
                value
                .strip()
                .replace(",", ".")
            )

            if value == "":
                return default

        number = float(
            value
        )

        if not math.isfinite(
            number
        ):
            return default

        return number

    except (
        TypeError,
        ValueError,
    ):
        return default


def extract_order_quantity(
    tick,
):
    grid_settings = (
        tick.get("gridSettings")
        or {}
    )

    for value in (
        tick.get("quantity"),
        tick.get("qty"),
        tick.get("size"),
        grid_settings.get("quantity"),
        grid_settings.get("size"),
    ):
        quantity = number_from(
            value
        )

        if (
            quantity is not None
            and quantity > 0
        ):
            return quantity

    return None


def extract_account_balance(
    tick,
):
    balance = tick.get(
        "balance"
    )

    if isinstance(
        balance,
        dict,
    ):
        for key in (
            "usdt",
            "USDT",
            "available",
            "availableUsdt",
            "accountBalance",
        ):
            value = number_from(
                balance.get(key)
            )

            if (
                value is not None
                and value > 0
            ):
                return value

    return number_from(
        balance,
        0.0,
    )


def build_protected_order(
    side,
    entry,
    atr,
    quantity,
    balance,
):
    config = load_bot_config()
    min_gap = max(
        entry
        * MIN_PROTECTION_GAP_PERCENT,
        0.0001,
    )

    target_distance = max(
        atr
        * config["atrTargetMultiplier"],
        min_gap,
    )

    stop_distance = max(
        atr
        * config["atrStopMultiplier"],
        min_gap,
    )

    if side == ACTION_LONG:
        take_profit = (
            entry
            + target_distance
        )
        stop_loss = (
            entry
            - stop_distance
        )

    else:
        take_profit = (
            entry
            - target_distance
        )
        stop_loss = (
            entry
            + stop_distance
        )

    risk_usdt = (
        abs(entry - stop_loss)
        * quantity
    )
    reward_usdt = (
        abs(take_profit - entry)
        * quantity
    )
    fee_usdt = (
        (
            abs(entry * quantity)
            + abs(take_profit * quantity)
        )
        * config["brokerFeePercent"]
        / 100.0
    )
    net_reward_usdt = (
        reward_usdt
        - fee_usdt
    )
    position_value_usdt = abs(
        entry
        * quantity
    )
    net_reward_percent = (
        safe_divide(
            net_reward_usdt,
            position_value_usdt,
            0.0,
        )
        * 100.0
    )
    reward_risk_ratio = safe_divide(
        reward_usdt,
        risk_usdt,
        0.0,
    )
    risk_balance_percent = (
        safe_divide(
            risk_usdt,
            balance,
            0.0,
        )
        * 100.0
        if balance
        and balance > 0
        else 0.0
    )

    if (
        risk_usdt <= 0
        or reward_usdt <= 0
    ):
        return (
            None,
            "Ungültiges Risiko/Ziel.",
        )

    if (
        reward_risk_ratio
        < config["minRewardRiskRatio"]
    ):
        return (
            None,
            (
                "Chance/Risiko blockiert: "
                f"{reward_risk_ratio:.2f} < "
                f"{config['minRewardRiskRatio']:.2f}"
            ),
        )

    if (
        net_reward_percent
        < config["minNetProfitPercent"]
    ):
        return (
            None,
            (
                "Profit blockiert: "
                f"{net_reward_percent:.4f}% < "
                f"{config['minNetProfitPercent']:.4f}%"
            ),
        )

    if (
        balance
        and balance > 0
        and risk_balance_percent
        > config["maxRiskBalancePercent"]
    ):
        return (
            None,
            (
                "Risiko zu groß: "
                f"{risk_balance_percent:.2f}% > "
                f"{config['maxRiskBalancePercent']:.2f}%"
            ),
        )

    return (
        {
            "takeProfit": take_profit,
            "stopLoss": stop_loss,
            "riskUsdt": risk_usdt,
            "rewardUsdt": reward_usdt,
            "feeUsdt": fee_usdt,
            "netRewardUsdt": net_reward_usdt,
            "netRewardPercent": net_reward_percent,
            "rewardRiskRatio": reward_risk_ratio,
            "riskBalancePercent": risk_balance_percent,
        },
        None,
    )


# --------------------------------------------------
# EMA
# --------------------------------------------------

def calculate_ema(
    values,
    period,
):
    if len(values) < period:
        return None

    multiplier = (
        2.0
        / (period + 1.0)
    )

    ema = (
        sum(values[:period])
        / period
    )

    for value in values[period:]:
        ema += (
            value - ema
        ) * multiplier

    return ema


# --------------------------------------------------
# RSI
# --------------------------------------------------

def calculate_rsi(
    values,
    period=RSI_PERIOD,
):
    if len(values) < period + 1:
        return None

    gains = 0.0
    losses = 0.0

    start_index = (
        len(values)
        - period
    )

    for index in range(
        start_index,
        len(values),
    ):
        change = (
            values[index]
            - values[index - 1]
        )

        if change > 0:
            gains += change

        elif change < 0:
            losses += abs(
                change
            )

    average_gain = (
        gains / period
    )

    average_loss = (
        losses / period
    )

    if (
        average_gain == 0
        and average_loss == 0
    ):
        return 50.0

    if average_loss == 0:
        return 100.0

    rs = (
        average_gain
        / average_loss
    )

    return (
        100.0
        - (
            100.0
            / (1.0 + rs)
        )
    )


# --------------------------------------------------
# ATR
# --------------------------------------------------

def calculate_atr(
    candles,
    period=ATR_PERIOD,
):
    if len(candles) < period + 1:
        return None

    true_ranges = []

    start_index = (
        len(candles)
        - period
    )

    for index in range(
        start_index,
        len(candles),
    ):
        current = (
            candles[index]
        )

        previous = (
            candles[index - 1]
        )

        high = (
            current["high"]
        )

        low = (
            current["low"]
        )

        previous_close = (
            previous["close"]
        )

        true_range = max(
            high - low,
            abs(
                high
                - previous_close
            ),
            abs(
                low
                - previous_close
            ),
        )

        true_ranges.append(
            true_range
        )

    return (
        sum(true_ranges)
        / len(true_ranges)
    )


# --------------------------------------------------
# Softmax
# --------------------------------------------------

def softmax(scores):
    maximum = max(
        scores.values()
    )

    values = {}

    for action in ACTIONS:
        values[action] = math.exp(
            clamp(
                scores[action]
                - maximum,
                -30.0,
                30.0,
            )
        )

    total = sum(
        values.values()
    )

    if total <= 0:
        return {
            action: (
                1.0
                / len(ACTIONS)
            )
            for action
            in ACTIONS
        }

    return {
        action: (
            values[action]
            / total
        )
        for action
        in ACTIONS
    }


# --------------------------------------------------
# Features erzeugen
# --------------------------------------------------

def build_features(history):
    if (
        len(history)
        < MIN_HISTORY
    ):
        return None, None

    closes = [
        candle["close"]
        for candle
        in history
    ]

    volumes = [
        candle["volume"]
        for candle
        in history
    ]

    current = (
        history[-1]
    )

    close = (
        current["close"]
    )

    if close <= 0:
        return None, None

    ema_fast = calculate_ema(
        closes,
        EMA_FAST_PERIOD,
    )

    ema_slow = calculate_ema(
        closes,
        EMA_SLOW_PERIOD,
    )

    previous_ema_fast = (
        calculate_ema(
            closes[:-1],
            EMA_FAST_PERIOD,
        )
    )

    rsi = calculate_rsi(
        closes,
        RSI_PERIOD,
    )

    atr = calculate_atr(
        history,
        ATR_PERIOD,
    )

    if (
        ema_fast is None
        or ema_slow is None
        or previous_ema_fast
        is None
        or rsi is None
        or atr is None
        or atr <= 0
    ):
        return None, None

    candle_range = max(
        current["high"]
        - current["low"],
        0.00000001,
    )

    body = (
        current["close"]
        - current["open"]
    )

    upper_wick = (
        current["high"]
        - max(
            current["open"],
            current["close"],
        )
    )

    lower_wick = (
        min(
            current["open"],
            current["close"],
        )
        - current["low"]
    )

    volume_window = (
        volumes[-20:]
    )

    average_volume = (
        sum(volume_window)
        / len(volume_window)
    )

    ret1 = (
        safe_divide(
            close,
            closes[-2],
            1.0,
        )
        - 1.0
    )

    ret3 = (
        safe_divide(
            close,
            closes[-4],
            1.0,
        )
        - 1.0
    )

    ret6 = (
        safe_divide(
            close,
            closes[-7],
            1.0,
        )
        - 1.0
    )

    atr_percent = (
        atr / close
    )

    features = {
        "bias": 1.0,

        "ret1": clamp(
            ret1 * 100.0,
            -3.0,
            3.0,
        ),

        "ret3": clamp(
            ret3 * 50.0,
            -3.0,
            3.0,
        ),

        "ret6": clamp(
            ret6 * 35.0,
            -3.0,
            3.0,
        ),

        "ema_gap": clamp(
            safe_divide(
                ema_fast
                - ema_slow,
                close,
            )
            * 100.0,
            -3.0,
            3.0,
        ),

        "ema_fast_gap": clamp(
            safe_divide(
                close
                - ema_fast,
                close,
            )
            * 100.0,
            -3.0,
            3.0,
        ),

        "ema_slope": clamp(
            safe_divide(
                ema_fast
                - previous_ema_fast,
                close,
            )
            * 1000.0,
            -3.0,
            3.0,
        ),

        "rsi": clamp(
            (
                rsi - 50.0
            )
            / 20.0,
            -2.5,
            2.5,
        ),

        "atr": clamp(
            atr_percent
            * 100.0,
            0.0,
            5.0,
        ),

        "body": clamp(
            body
            / candle_range,
            -1.0,
            1.0,
        ),

        "upper_wick": clamp(
            upper_wick
            / candle_range,
            0.0,
            1.0,
        ),

        "lower_wick": clamp(
            lower_wick
            / candle_range,
            0.0,
            1.0,
        ),

        "volume": clamp(
            (
                safe_divide(
                    current["volume"],
                    average_volume,
                    1.0,
                )
                - 1.0
            ),
            -2.0,
            3.0,
        ),
    }

    return (
        features,
        {
            "atr": atr,
            "atrPercent": (
                atr_percent
            ),
            "emaFast": (
                ema_fast
            ),
            "emaSlow": (
                ema_slow
            ),
            "rsi": rsi,
        },
    )


# --------------------------------------------------
# Adaptive Modell
# --------------------------------------------------

class AdaptiveModel:
    def __init__(self):
        self.weights = {
            action: {
                feature: 0.0
                for feature
                in FEATURE_NAMES
            }
            for action
            in ACTIONS
        }

        self.samples = 0
        self.trades = 0
        self.wins = 0
        self.losses = 0
        self.ambiguous = 0
        self.expired = 0
        self.total_reward = 0.0
        self.updates_since_save = 0
        self.last_decision = {}
        self.last_outcome = {}

        self._seed_weights()
        self._load()

    # --------------------------------------------------
    # Startgewichte
    # --------------------------------------------------

    def _seed_weights(self):
        self.weights[
            ACTION_HOLD
        ]["bias"] = 0.60

        self.weights[
            ACTION_LONG
        ].update({
            "bias": -0.10,
            "ema_gap": 0.45,
            "ema_fast_gap": 0.15,
            "ema_slope": 0.25,
            "rsi": 0.15,
            "ret1": 0.08,
            "ret3": 0.15,
            "body": 0.08,
            "lower_wick": 0.05,
        })

        self.weights[
            ACTION_SHORT
        ].update({
            "bias": -0.10,
            "ema_gap": -0.45,
            "ema_fast_gap": -0.15,
            "ema_slope": -0.25,
            "rsi": -0.15,
            "ret1": -0.08,
            "ret3": -0.15,
            "body": -0.08,
            "upper_wick": 0.05,
        })

    # --------------------------------------------------
    # Modell laden
    # --------------------------------------------------

    def _load(self):
        if not MODEL_PATH.exists():
            return

        try:
            data = json.loads(
                MODEL_PATH.read_text(
                    encoding="utf-8"
                )
            )

            if (
                int(
                    data.get(
                        "version",
                        0,
                    )
                )
                != MODEL_VERSION
            ):
                return

            stored_weights = (
                data.get(
                    "weights"
                )
            )

            if isinstance(
                stored_weights,
                dict,
            ):
                for action in ACTIONS:
                    action_weights = (
                        stored_weights.get(
                            action,
                            {},
                        )
                    )

                    for feature in FEATURE_NAMES:
                        value = (
                            action_weights.get(
                                feature
                            )
                        )

                        if isinstance(
                            value,
                            (
                                int,
                                float,
                            ),
                        ):
                            self.weights[
                                action
                            ][
                                feature
                            ] = float(
                                value
                            )

            self.samples = int(
                data.get(
                    "samples",
                    0,
                )
            )

            self.trades = int(
                data.get(
                    "trades",
                    0,
                )
            )

            self.wins = int(
                data.get(
                    "wins",
                    0,
                )
            )

            self.losses = int(
                data.get(
                    "losses",
                    0,
                )
            )

            self.ambiguous = int(
                data.get(
                    "ambiguous",
                    0,
                )
            )

            self.expired = int(
                data.get(
                    "expired",
                    0,
                )
            )

            self.total_reward = float(
                data.get(
                    "totalReward",
                    0.0,
                )
            )

            last_decision = data.get(
                "lastDecision",
                {},
            )

            if isinstance(
                last_decision,
                dict,
            ):
                self.last_decision = last_decision

            last_outcome = data.get(
                "lastOutcome",
                {},
            )

            if isinstance(
                last_outcome,
                dict,
            ):
                self.last_outcome = last_outcome

        except Exception:
            return

    # --------------------------------------------------
    # Speichern
    # --------------------------------------------------

    def save(self):
        data = {
            "version": (
                MODEL_VERSION
            ),
            "samples": (
                self.samples
            ),
            "trades": (
                self.trades
            ),
            "wins": (
                self.wins
            ),
            "losses": (
                self.losses
            ),
            "ambiguous": (
                self.ambiguous
            ),
            "expired": (
                self.expired
            ),
            "totalReward": (
                self.total_reward
            ),
            "lastDecision": (
                self.last_decision
            ),
            "lastOutcome": (
                self.last_outcome
            ),
            "weights": (
                self.weights
            ),
        }

        temporary_path = (
            MODEL_PATH.with_suffix(
                ".tmp"
            )
        )

        temporary_path.write_text(
            json.dumps(
                data,
                separators=(
                    ",",
                    ":",
                ),
            ),
            encoding="utf-8",
        )

        temporary_path.replace(
            MODEL_PATH
        )

        self.updates_since_save = 0

    # --------------------------------------------------
    # Scores
    # --------------------------------------------------

    def scores(self, features):
        output = {}

        for action in ACTIONS:
            score = 0.0

            for feature in FEATURE_NAMES:
                score += (
                    self.weights[
                        action
                    ][
                        feature
                    ]
                    * features[
                        feature
                    ]
                )

            output[action] = score

        return output

    # --------------------------------------------------
    # Wahrscheinlichkeiten
    # --------------------------------------------------

    def probabilities(
        self,
        features,
    ):
        return softmax(
            self.scores(
                features
            )
        )

    # --------------------------------------------------
    # Exploration
    # --------------------------------------------------

    def exploration_rate(self):
        progress = clamp(
            self.trades
            / EXPLORATION_DECAY_TRADES,
            0.0,
            1.0,
        )

        return (
            START_EXPLORATION
            + (
                MIN_EXPLORATION
                - START_EXPLORATION
            )
            * progress
        )

    # --------------------------------------------------
    # Entscheidung
    # --------------------------------------------------

    def choose(
        self,
        features,
    ):
        probabilities = (
            self.probabilities(
                features
            )
        )

        long_probability = (
            probabilities[
                ACTION_LONG
            ]
        )

        short_probability = (
            probabilities[
                ACTION_SHORT
            ]
        )

        exploration = (
            self.exploration_rate()
        )

        if (
            random.random()
            < exploration
        ):
            if (
                long_probability
                > short_probability
            ):
                exploratory_action = (
                    ACTION_LONG
                )

            else:
                exploratory_action = (
                    ACTION_SHORT
                )

            return (
                exploratory_action,
                probabilities,
                True,
            )

        if (
            long_probability
            >= ENTRY_THRESHOLD
            and (
                long_probability
                - short_probability
            )
            >= MIN_DIRECTION_EDGE
        ):
            return (
                ACTION_LONG,
                probabilities,
                False,
            )

        if (
            short_probability
            >= ENTRY_THRESHOLD
            and (
                short_probability
                - long_probability
            )
            >= MIN_DIRECTION_EDGE
        ):
            return (
                ACTION_SHORT,
                probabilities,
                False,
            )

        return (
            ACTION_HOLD,
            probabilities,
            False,
        )

    # --------------------------------------------------
    # Lernen
    # --------------------------------------------------

    def learn(
        self,
        features,
        action,
        reward,
        outcome=None,
    ):
        probabilities = (
            self.probabilities(
                features
            )
        )

        target_action = (
            action
            if reward > 0
            else ACTION_HOLD
        )

        reward_strength = clamp(
            abs(reward),
            0.25,
            2.0,
        )

        for model_action in ACTIONS:
            expected = (
                1.0
                if model_action
                == target_action
                else 0.0
            )

            error = (
                expected
                - probabilities[
                    model_action
                ]
            )

            for feature in FEATURE_NAMES:
                old_weight = (
                    self.weights[
                        model_action
                    ][
                        feature
                    ]
                )

                gradient = (
                    LEARNING_RATE
                    * reward_strength
                    * error
                    * features[
                        feature
                    ]
                )

                decay = (
                    old_weight
                    * WEIGHT_DECAY
                )

                self.weights[
                    model_action
                ][
                    feature
                ] = clamp(
                    old_weight
                    + gradient
                    - decay,
                    -5.0,
                    5.0,
                )

        self.samples += 1
        self.trades += 1
        self.total_reward += (
            reward
        )

        if reward > 0:
            self.wins += 1

        else:
            self.losses += 1

        self.updates_since_save += 1

        if isinstance(
            outcome,
            dict,
        ):
            self.last_outcome = outcome

        if (
            self.updates_since_save
            >= MODEL_SAVE_EVERY
        ):
            self.save()


# --------------------------------------------------
# Globales Modell
# --------------------------------------------------

MODEL = AdaptiveModel()

try:
    MODEL.save()

except Exception:
    pass

# --------------------------------------------------
# HTTP Bot Handler
# --------------------------------------------------

class BotHandler(
    BaseHTTPRequestHandler
):
    candle_history = {}
    candle_counter = {}
    active_learning_trade = {}
    cooldown_until = {}

    # --------------------------------------------------
    # HTTP Logging
    # --------------------------------------------------

    def log_message(
        self,
        format,
        *args,
    ):
        return

    # --------------------------------------------------
    # JSON Antwort
    # --------------------------------------------------

    def _send_json(
        self,
        payload,
        status=200,
    ):
        body = json.dumps(
            payload,
            separators=(
                ",",
                ":",
            ),
        ).encode(
            "utf-8"
        )

        self.send_response(
            status
        )

        self.send_header(
            "Content-Type",
            "application/json",
        )

        self.send_header(
            "Content-Length",
            str(len(body)),
        )

        self.end_headers()

        self.wfile.write(
            body
        )

    def _send_html(
        self,
        html,
        status=200,
    ):
        body = html.encode(
            "utf-8"
        )

        self.send_response(
            status
        )

        self.send_header(
            "Content-Type",
            "text/html; charset=utf-8",
        )

        self.send_header(
            "Content-Length",
            str(len(body)),
        )

        self.end_headers()

        self.wfile.write(
            body
        )

    # --------------------------------------------------
    # Schlüssel
    # --------------------------------------------------

    def _key(
        self,
        symbol,
        timeframe,
    ):
        return (
            f"{symbol}:{timeframe}"
        )

    # --------------------------------------------------
    # Candle speichern
    # --------------------------------------------------

    def _store_candle(
        self,
        key,
        candle,
    ):
        history = (
            self.candle_history
            .setdefault(
                key,
                [],
            )
        )

        item = {
            "time": (
                candle.get(
                    "time"
                )
            ),
            "open": float(
                candle.get(
                    "open"
                )
                or 0
            ),
            "high": float(
                candle.get(
                    "high"
                )
                or 0
            ),
            "low": float(
                candle.get(
                    "low"
                )
                or 0
            ),
            "close": float(
                candle.get(
                    "close"
                )
                or 0
            ),
            "volume": float(
                candle.get(
                    "volume"
                )
                or 0
            ),
        }

        is_new_candle = True

        if (
            history
            and item["time"]
            is not None
            and history[-1]["time"]
            == item["time"]
        ):
            history[-1] = item
            is_new_candle = False

        else:
            history.append(
                item
            )

        if is_new_candle:
            self.candle_counter[
                key
            ] = (
                self.candle_counter.get(
                    key,
                    0,
                )
                + 1
            )

        if (
            len(history)
            > MAX_HISTORY
        ):
            del history[
                :-MAX_HISTORY
            ]

        return (
            history,
            is_new_candle,
        )

    # --------------------------------------------------
    # Aktiver Lerntrade eröffnen
    # --------------------------------------------------

    def _register_trade(
        self,
        key,
        side,
        entry,
        take_profit,
        stop_loss,
        features,
    ):
        self.active_learning_trade[
            key
        ] = {
            "side": side,
            "entry": entry,
            "takeProfit": (
                take_profit
            ),
            "stopLoss": (
                stop_loss
            ),
            "features": (
                dict(features)
            ),
            "openedCounter": (
                self.candle_counter.get(
                    key,
                    0,
                )
            ),
        }

    # --------------------------------------------------
    # Lerntrade auswerten
    # --------------------------------------------------

    def _evaluate_active_trade(
        self,
        key,
        candle,
        is_new_candle,
    ):
        trade = (
            self.active_learning_trade
            .get(
                key
            )
        )

        if trade is None:
            return None

        if not is_new_candle:
            return None

        side = (
            trade["side"]
        )

        take_profit = (
            trade["takeProfit"]
        )

        stop_loss = (
            trade["stopLoss"]
        )

        high = (
            candle["high"]
        )

        low = (
            candle["low"]
        )

        current_counter = (
            self.candle_counter.get(
                key,
                0,
            )
        )

        age = (
            current_counter
            - trade[
                "openedCounter"
            ]
        )

        # --------------------------------------------------
        # Long Treffer
        # --------------------------------------------------

        if side == ACTION_LONG:
            tp_hit = (
                high >= take_profit
            )

            sl_hit = (
                low <= stop_loss
            )

        # --------------------------------------------------
        # Short Treffer
        # --------------------------------------------------

        else:
            tp_hit = (
                low <= take_profit
            )

            sl_hit = (
                high >= stop_loss
            )

        # --------------------------------------------------
        # TP und SL in gleicher Candle
        # --------------------------------------------------

        if (
            tp_hit
            and sl_hit
        ):
            MODEL.ambiguous += 1
            MODEL.last_outcome = {
                "result": "ambiguous",
                "side": side,
                "age": age,
                "entry": trade["entry"],
                "takeProfit": take_profit,
                "stopLoss": stop_loss,
                "message": "TP und SL in gleicher Kerze",
            }
            MODEL.save()

            del self.active_learning_trade[
                key
            ]

            self.cooldown_until[
                key
            ] = (
                current_counter
                + COOLDOWN_AFTER_LOSS
            )

            return {
                "result": (
                    "ambiguous"
                ),
                "age": age,
            }

        # --------------------------------------------------
        # Gewinn
        # --------------------------------------------------

        if tp_hit:
            outcome = {
                "result": "TP",
                "side": side,
                "age": age,
                "entry": trade["entry"],
                "takeProfit": take_profit,
                "stopLoss": stop_loss,
                "reward": WIN_REWARD,
            }
            MODEL.learn(
                trade[
                    "features"
                ],
                side,
                WIN_REWARD,
                outcome,
            )

            del self.active_learning_trade[
                key
            ]

            self.cooldown_until[
                key
            ] = (
                current_counter
                + COOLDOWN_AFTER_WIN
            )

            return {
                "result": "TP",
                "reward": (
                    WIN_REWARD
                ),
                "age": age,
            }

        # --------------------------------------------------
        # Verlust
        # --------------------------------------------------

        if sl_hit:
            outcome = {
                "result": "SL",
                "side": side,
                "age": age,
                "entry": trade["entry"],
                "takeProfit": take_profit,
                "stopLoss": stop_loss,
                "reward": LOSS_REWARD,
            }
            MODEL.learn(
                trade[
                    "features"
                ],
                side,
                LOSS_REWARD,
                outcome,
            )

            del self.active_learning_trade[
                key
            ]

            self.cooldown_until[
                key
            ] = (
                current_counter
                + COOLDOWN_AFTER_LOSS
            )

            return {
                "result": "SL",
                "reward": (
                    LOSS_REWARD
                ),
                "age": age,
            }

        # --------------------------------------------------
        # Trade zu lange offen
        # --------------------------------------------------

        if (
            age
            >= MAX_TRADE_CANDLES
        ):
            MODEL.expired += 1
            MODEL.last_outcome = {
                "result": "expired",
                "side": side,
                "age": age,
                "entry": trade["entry"],
                "takeProfit": take_profit,
                "stopLoss": stop_loss,
                "message": "Trade ohne TP/SL-Treffer abgelaufen",
            }
            MODEL.save()

            del self.active_learning_trade[
                key
            ]

            self.cooldown_until[
                key
            ] = (
                current_counter
                + COOLDOWN_AFTER_LOSS
            )

            return {
                "result": (
                    "expired"
                ),
                "age": age,
            }

        return None

    # --------------------------------------------------
    # Cooldown
    # --------------------------------------------------

    def _cooldown_active(
        self,
        key,
    ):
        current_counter = (
            self.candle_counter.get(
                key,
                0,
            )
        )

        cooldown_until = (
            self.cooldown_until.get(
                key,
                0,
            )
        )

        return (
            current_counter
            < cooldown_until
        )

    # --------------------------------------------------
    # Health
    # --------------------------------------------------

    def do_GET(self):
        path = urlparse(
            self.path
        ).path

        if path == "/":
            self._send_html(
                build_dashboard_html()
            )

            return

        if path == "/setup":
            self._send_html(
                build_setup_html()
            )

            return

        if path == "/config":
            self._send_json({
                "ok": True,
                "config": load_bot_config(),
                "configPath": str(CONFIG_PATH),
            })

            return

        if path != "/health":
            self._send_json({
                "ok": False,
                "message": (
                    "Not found"
                ),
            }, 404)

            return

        self._send_json(
            build_health_payload(
                self
            )
        )

    # --------------------------------------------------
    # Tick
    # --------------------------------------------------

    def _read_json_body(self):
        length = int(
            self.headers.get(
                "Content-Length",
                "0",
            )
        )

        raw_body = (
            self.rfile
            .read(length)
            .decode(
                "utf-8"
            )
        )

        return json.loads(
            raw_body
            or "{}"
        )

    def do_POST(self):
        path = urlparse(
            self.path
        ).path

        if path == "/config":
            try:
                config = save_bot_config(
                    self._read_json_body()
                )

                self._send_json({
                    "ok": True,
                    "message": "Konfiguration gespeichert.",
                    "config": config,
                    "configPath": str(CONFIG_PATH),
                })

            except Exception as error:
                self._send_json({
                    "ok": False,
                    "message": str(error),
                }, 400)

            return

        if path != "/tick":
            self._send_json({
                "ok": False,
                "message": (
                    "Not found"
                ),
            }, 404)

            return

        try:
            tick = self._read_json_body()

            candle = (
                tick.get(
                    "candle"
                )
                or {}
            )

            open_orders = (
                tick.get(
                    "openOrders"
                )
                or []
            )

            symbol = str(
                tick.get(
                    "symbol"
                )
                or ""
            ).upper()

            timeframe = str(
                tick.get(
                    "timeframe"
                )
                or "unknown"
            )

            # --------------------------------------------------
            # Eingaben prüfen
            # --------------------------------------------------

            if not symbol:
                self._send_json({
                    "ok": True,
                    "action": "hold",
                    "note": (
                        "Missing symbol"
                    ),
                })

                return

            try:
                open_price = float(
                    candle.get(
                        "open"
                    )
                    or 0
                )

                high = float(
                    candle.get(
                        "high"
                    )
                    or 0
                )

                low = float(
                    candle.get(
                        "low"
                    )
                    or 0
                )

                close = float(
                    candle.get(
                        "close"
                    )
                    or 0
                )

            except (
                TypeError,
                ValueError,
            ):
                self._send_json({
                    "ok": True,
                    "action": "hold",
                    "note": (
                        "Invalid candle"
                    ),
                })

                return

            if (
                open_price <= 0
                or high <= 0
                or low <= 0
                or close <= 0
                or high < low
            ):
                self._send_json({
                    "ok": True,
                    "action": "hold",
                    "note": (
                        "Invalid candle"
                    ),
                })

                return

            quantity = extract_order_quantity(
                tick
            )
            balance = extract_account_balance(
                tick
            )

            if (
                quantity is None
                or quantity <= 0
            ):
                self._send_json({
                    "ok": True,
                    "action": "hold",
                    "symbol": symbol,
                    "note": (
                        "Missing quantity"
                    ),
                })

                return

            key = self._key(
                symbol,
                timeframe,
            )

            # --------------------------------------------------
            # Candle speichern
            # --------------------------------------------------

            (
                history,
                is_new_candle,
            ) = self._store_candle(
                key,
                candle,
            )

            current_candle = (
                history[-1]
            )

            # --------------------------------------------------
            # Aktiven Lerntrade prüfen
            # --------------------------------------------------

            learning_result = (
                self._evaluate_active_trade(
                    key,
                    current_candle,
                    is_new_candle,
                )
            )

            # --------------------------------------------------
            # Tool hat noch offene Order
            # --------------------------------------------------

            if open_orders:
                self._send_json({
                    "ok": True,
                    "action": "hold",
                    "symbol": symbol,
                    "learning": (
                        learning_result
                    ),
                    "note": (
                        "Open order"
                    ),
                })

                return

            # --------------------------------------------------
            # Interner Lerntrade noch aktiv
            # --------------------------------------------------

            if (
                key
                in self.active_learning_trade
            ):
                self._send_json({
                    "ok": True,
                    "action": "hold",
                    "symbol": symbol,
                    "note": (
                        "Learning trade active"
                    ),
                })

                return

            # --------------------------------------------------
            # Historie
            # --------------------------------------------------

            if (
                len(history)
                < MIN_HISTORY
            ):
                self._send_json({
                    "ok": True,
                    "action": "hold",
                    "symbol": symbol,
                    "history": (
                        len(history)
                    ),
                    "requiredHistory": (
                        MIN_HISTORY
                    ),
                    "note": (
                        "Building history"
                    ),
                })

                return

            # --------------------------------------------------
            # Cooldown
            # --------------------------------------------------

            if self._cooldown_active(
                key
            ):
                self._send_json({
                    "ok": True,
                    "action": "hold",
                    "symbol": symbol,
                    "note": (
                        "Cooldown"
                    ),
                })

                return

            # --------------------------------------------------
            # Nur neue Candle entscheiden
            # --------------------------------------------------

            if not is_new_candle:
                self._send_json({
                    "ok": True,
                    "action": "hold",
                    "symbol": symbol,
                    "note": (
                        "Same candle"
                    ),
                })

                return

            # --------------------------------------------------
            # Features
            # --------------------------------------------------

            (
                features,
                indicators,
            ) = build_features(
                history
            )

            if (
                features is None
                or indicators is None
            ):
                self._send_json({
                    "ok": True,
                    "action": "hold",
                    "symbol": symbol,
                    "note": (
                        "Features unavailable"
                    ),
                })

                return

            atr = (
                indicators["atr"]
            )

            atr_percent = (
                indicators[
                    "atrPercent"
                ]
            )

            # --------------------------------------------------
            # Volatilitätsfilter
            # --------------------------------------------------

            if (
                atr_percent
                < MIN_ATR_PERCENT
                or atr_percent
                > MAX_ATR_PERCENT
            ):
                self._send_json({
                    "ok": True,
                    "action": "hold",
                    "symbol": symbol,
                    "atrPercent": round(
                        atr_percent
                        * 100.0,
                        4,
                    ),
                    "note": (
                        "Volatility filter"
                    ),
                })

                return

            # --------------------------------------------------
            # Modellentscheidung
            # --------------------------------------------------

            (
                decision,
                probabilities,
                explored,
            ) = MODEL.choose(
                features
            )

            decision_info = {
                "symbol": symbol,
                "timeframe": timeframe,
                "decision": decision,
                "long": round(
                    probabilities[
                        ACTION_LONG
                    ],
                    4,
                ),
                "short": round(
                    probabilities[
                        ACTION_SHORT
                    ],
                    4,
                ),
                "hold": round(
                    probabilities[
                        ACTION_HOLD
                    ],
                    4,
                ),
                "explored": explored,
                "atrPercent": round(
                    atr_percent
                    * 100.0,
                    4,
                ),
                "samples": MODEL.samples,
                "trades": MODEL.trades,
                "wins": MODEL.wins,
                "losses": MODEL.losses,
            }
            MODEL.last_decision = decision_info
            MODEL.save()

            # --------------------------------------------------
            # Hold
            # --------------------------------------------------

            if (
                decision
                == ACTION_HOLD
            ):
                self._send_json({
                    "ok": True,
                    "action": "hold",
                    "symbol": symbol,
                    "long": round(
                        probabilities[
                            ACTION_LONG
                        ],
                        4,
                    ),
                    "short": round(
                        probabilities[
                            ACTION_SHORT
                        ],
                        4,
                    ),
                    "hold": round(
                        probabilities[
                            ACTION_HOLD
                        ],
                        4,
                    ),
                    "trades": (
                        MODEL.trades
                    ),
                    "wins": (
                        MODEL.wins
                    ),
                    "losses": (
                        MODEL.losses
                    ),
                    "model": {
                        "path": str(
                            MODEL_PATH
                        ),
                        "exists": MODEL_PATH.exists(),
                        "samples": MODEL.samples,
                        "trades": MODEL.trades,
                        "wins": MODEL.wins,
                        "losses": MODEL.losses,
                        "lastOutcome": MODEL.last_outcome,
                    },
                    "decision": decision_info,
                    "note": (
                        "Adaptive hold"
                    ),
                })

                return

            # --------------------------------------------------
            # Long Order
            # --------------------------------------------------

            if (
                decision
                == ACTION_LONG
            ):
                protection, protection_error = build_protected_order(
                    ACTION_LONG,
                    close,
                    atr,
                    quantity,
                    balance,
                )

                if protection_error:
                    self._send_json({
                        "ok": True,
                        "action": "hold",
                        "symbol": symbol,
                        "direction": "long",
                        "quantity": quantity,
                        "balance": balance,
                        "note": (
                            protection_error
                        ),
                    })

                    return

                take_profit = (
                    protection["takeProfit"]
                )

                stop_loss = (
                    protection["stopLoss"]
                )

                self._register_trade(
                    key,
                    ACTION_LONG,
                    close,
                    take_profit,
                    stop_loss,
                    features,
                )

                self._send_json({
                    "ok": True,
                    "action": (
                        "place_order"
                    ),
                    "side": "buy",
                    "entry": round(
                        close,
                        4,
                    ),
                    "quantity": quantity,
                    "takeProfit": round(
                        take_profit,
                        4,
                    ),
                    "stopLoss": round(
                        stop_loss,
                        4,
                    ),
                    "riskUsdt": round(
                        protection["riskUsdt"],
                        4,
                    ),
                    "rewardUsdt": round(
                        protection["rewardUsdt"],
                        4,
                    ),
                    "estimatedFeeUsdt": round(
                        protection["feeUsdt"],
                        4,
                    ),
                    "netRewardUsdt": round(
                        protection["netRewardUsdt"],
                        4,
                    ),
                    "netRewardPercent": round(
                        protection["netRewardPercent"],
                        4,
                    ),
                    "rewardRiskRatio": round(
                        protection["rewardRiskRatio"],
                        4,
                    ),
                    "riskBalancePercent": round(
                        protection["riskBalancePercent"],
                        4,
                    ),
                    "symbol": symbol,
                    "direction": (
                        "long"
                    ),
                    "confidence": round(
                        probabilities[
                            ACTION_LONG
                        ],
                        4,
                    ),
                    "edge": round(
                        probabilities[
                            ACTION_LONG
                        ]
                        - probabilities[
                            ACTION_SHORT
                        ],
                        4,
                    ),
                    "explored": (
                        explored
                    ),
                    "note": (
                        "Adaptive long"
                    ),
                    "model": {
                        "path": str(
                            MODEL_PATH
                        ),
                        "exists": MODEL_PATH.exists(),
                        "samples": MODEL.samples,
                        "trades": MODEL.trades,
                        "wins": MODEL.wins,
                        "losses": MODEL.losses,
                        "lastOutcome": MODEL.last_outcome,
                    },
                    "decision": decision_info,
                })

                return

            # --------------------------------------------------
            # Short Order
            # --------------------------------------------------

            protection, protection_error = build_protected_order(
                ACTION_SHORT,
                close,
                atr,
                quantity,
                balance,
            )

            if protection_error:
                self._send_json({
                    "ok": True,
                    "action": "hold",
                    "symbol": symbol,
                    "direction": "short",
                    "quantity": quantity,
                    "balance": balance,
                    "note": (
                        protection_error
                    ),
                })

                return

            take_profit = (
                protection["takeProfit"]
            )

            stop_loss = (
                protection["stopLoss"]
            )

            self._register_trade(
                key,
                ACTION_SHORT,
                close,
                take_profit,
                stop_loss,
                features,
            )

            self._send_json({
                "ok": True,
                "action": (
                    "place_order"
                ),
                "side": "sell",
                "entry": round(
                    close,
                    4,
                ),
                "quantity": quantity,
                "takeProfit": round(
                    take_profit,
                    4,
                ),
                "stopLoss": round(
                    stop_loss,
                    4,
                ),
                "riskUsdt": round(
                    protection["riskUsdt"],
                    4,
                ),
                "rewardUsdt": round(
                    protection["rewardUsdt"],
                    4,
                ),
                "estimatedFeeUsdt": round(
                    protection["feeUsdt"],
                    4,
                ),
                "netRewardUsdt": round(
                    protection["netRewardUsdt"],
                    4,
                ),
                "netRewardPercent": round(
                    protection["netRewardPercent"],
                    4,
                ),
                "rewardRiskRatio": round(
                    protection["rewardRiskRatio"],
                    4,
                ),
                "riskBalancePercent": round(
                    protection["riskBalancePercent"],
                    4,
                ),
                "symbol": symbol,
                "direction": (
                    "short"
                ),
                "confidence": round(
                    probabilities[
                        ACTION_SHORT
                    ],
                    4,
                ),
                "edge": round(
                    probabilities[
                        ACTION_SHORT
                    ]
                    - probabilities[
                        ACTION_LONG
                    ],
                    4,
                ),
                "explored": (
                    explored
                ),
                "note": (
                    "Adaptive short"
                ),
                "model": {
                    "path": str(
                        MODEL_PATH
                    ),
                    "exists": MODEL_PATH.exists(),
                    "samples": MODEL.samples,
                    "trades": MODEL.trades,
                    "wins": MODEL.wins,
                    "losses": MODEL.losses,
                    "lastOutcome": MODEL.last_outcome,
                },
                "decision": decision_info,
            })

        except Exception as error:
            self._send_json({
                "ok": True,
                "action": "hold",
                "message": str(
                    error
                ),
                "note": (
                    "Bot error"
                ),
            })


# --------------------------------------------------
# Server
# --------------------------------------------------

def run(
    host="127.0.0.1",
    port=8790,
):
    MODEL.save()

    server = HTTPServer(
        (host, port),
        BotHandler,
    )

    print(
        "Adaptive Long/Short Bot: "
        f"http://{host}:{port}/tick"
    )

    server.serve_forever()


# --------------------------------------------------
# Start
# --------------------------------------------------

if __name__ == "__main__":
    try:
        run()

    finally:
        try:
            MODEL.save()

        except Exception:
            pass
