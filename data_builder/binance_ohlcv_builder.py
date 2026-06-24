import os
import csv
import io
import zipfile
import requests
import numpy as np

# ==========================================================
# OHLCV DB BUILDER
# ==========================================================
# Ziel:
# - Binance Monatsdaten laden
# - JEDE Kerze 1:1 speichern
# - NUR: timestamp, OHLCV
# - KEINE Ableitungen
# ==========================================================

COIN = "SOL"
QUOTE = "USDT"
TIMEFRAME = "5m"

START_YEAR = 2026
START_MONTH = 3
MONTHS = 2

DATA_DIR = "data"
STRIDE = 1

# --------------------------------------------------
# Hilfsfunktionen Datum
# --------------------------------------------------
def get_year_month(start_year: int, start_month: int, offset: int):
    month = start_month + offset
    year = start_year + (month - 1) // 12
    month = ((month - 1) % 12) + 1
    return year, month

# --------------------------------------------------
# Binance Monatsdaten laden
# --------------------------------------------------
def download_month_csv(symbol: str, tf: str, date_yyyy_mm: str, data_dir: str):
    os.makedirs(data_dir, exist_ok=True)
    csv_path = os.path.join(data_dir, f"{symbol}_{tf}_{date_yyyy_mm}.csv")

    if os.path.exists(csv_path):
        return csv_path

    url = (
        "https://data.binance.vision/data/spot/monthly/klines/"
        f"{symbol}/{tf}/{symbol}-{tf}-{date_yyyy_mm}.zip"
    )

    r = requests.get(url, timeout=60)
    if r.status_code != 200:
        print(f"[SKIP] Monat nicht verfügbar: {date_yyyy_mm}")
        return None

    with zipfile.ZipFile(io.BytesIO(r.content)) as z:
        name = z.namelist()[0]
        with z.open(name) as f_in, open(csv_path, "wb") as f_out:
            f_out.write(f_in.read())

    return csv_path

def load_month_candles(symbol: str, tf: str, date_yyyy_mm: str, data_dir: str) -> np.ndarray:
    csv_path = download_month_csv(symbol, tf, date_yyyy_mm, data_dir)
    if csv_path is None:
        return np.empty((0, 6))

    candles = []
    with open(csv_path, newline="") as f:
        reader = csv.reader(f)
        for row in reader:
            candles.append([
                int(row[0]),    # timestamp_ms
                float(row[1]),  # open
                float(row[2]),  # high
                float(row[3]),  # low
                float(row[4]),  # close
                float(row[5]),  # volume
            ])

    return np.array(candles, dtype=np.float64)

# --------------------------------------------------
# CSV Writer
# --------------------------------------------------
def year_db_path(symbol: str, tf: str, year: int, data_dir: str) -> str:
    os.makedirs(data_dir, exist_ok=True)
    return os.path.join(data_dir, f"{START_MONTH}-{MONTHS+START_MONTH-1}_{year}_{tf}_{symbol}.csv")

def append_rows(path: str, rows):
    file_exists = os.path.exists(path)
    with open(path, "a", newline="") as f:
        w = csv.writer(f)
        if not file_exists:
            w.writerow([
                "timestamp_ms",
                "symbol",
                "timeframe",
                "open",
                "high",
                "low",
                "close",
                "volume",
            ])
        for r in rows:
            w.writerow(r)

# --------------------------------------------------
# Runner
# --------------------------------------------------
def run():
    symbol = f"{COIN}{QUOTE}"
    year_rows = {}

    for m in range(MONTHS):
        y, mo = get_year_month(START_YEAR, START_MONTH, m)
        date = f"{y}-{mo:02d}"

        candles = load_month_candles(symbol, TIMEFRAME, date, DATA_DIR)
        if len(candles) == 0:
            continue

        rows = []
        for i in range(0, len(candles), STRIDE):
            ts, o, h, l, c, v = candles[i]
            rows.append([
                int(ts),
                symbol,
                TIMEFRAME,
                float(o),
                float(h),
                float(l),
                float(c),
                float(v),
            ])

        year_rows.setdefault(y, []).extend(rows)

    for y in sorted(year_rows.keys()):
        out_path = year_db_path(symbol, TIMEFRAME, y, DATA_DIR)
        append_rows(out_path, year_rows[y])

    print("[DONE] OHLCV database build complete")

# --------------------------------------------------
# ENTRYPOINT
# --------------------------------------------------
if __name__ == "__main__":
    run()
