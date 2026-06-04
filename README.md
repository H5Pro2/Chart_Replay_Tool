# Chart_Replay_Tool

Browser-App für Candle-Replay, Ordervergabe und ein internes Orderbook.

Beim Start wird automatisch diese Datei geladen:

```text
chart_data/1-12_2023_5m_SOLUSDT.csv
```

## Start

```bash
npm.cmd install
npm.cmd run dev
```

URL: http://127.0.0.1:8788/

Port `8787` wird bewusst nicht benutzt.

## CSV-Format

Die vorhandene Datei nutzt diese Struktur:

```csv
timestamp_ms,symbol,timeframe,open,high,low,close,volume
1672531200000,SOLUSDT,5m,9.97,10.02,9.95,10.0,25797.23
```

Unterstützte Spaltennamen:

```csv
time,open,high,low,close,volume
2026-01-01,102,106,100,104,1200
```

Auch `date`, `datetime`, `timestamp` oder `timestamp_ms` für Zeit sowie `o,h,l,c,v` sind möglich.

## Funktionen

- CSV laden
- Kerzen Schritt für Schritt abspielen
- Replay-Geschwindigkeit einstellen
- Buy/Sell Order setzen
- automatische Order-ID
- Entry, TP und SL als Chart-Linien
- Orderbook mit Clear-Button
- Replay-Reset inklusive Orderbook
- Trade-Historie
