import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import {
  CandlestickSeries,
  createChart,
  CrosshairMode,
  IChartApi,
  ISeriesApi,
  LineSeries,
  LineStyle,
  Logical,
  Time
} from "lightweight-charts";
import Papa from "papaparse";
import {
  BookOpen,
  Clipboard,
  Lock,
  LockOpen,
  Save,
  Minus,
  MoveHorizontal,
  MousePointer2,
  Focus,
  FileDown,
  FileUp,
  Palette,
  Pause,
  Play,
  RotateCcw,
  Send,
  SkipForward,
  Square,
  Trash2
} from "lucide-react";
import "./styles.css";

type Candle = {
  time: Time;
  open: number;
  high: number;
  low: number;
  close: number;
  volume?: number;
};

type Side = "buy" | "sell";
type OrderStatus = "pending" | "active" | "closed" | "canceled";

type TradeOrder = {
  id: string;
  phemexOrderId?: string;
  phemexClOrdId?: string;
  phemexTakeProfitOrderId?: string;
  phemexStopLossOrderId?: string;
  side: Side;
  quantity: number;
  entry: number;
  takeProfit?: number;
  stopLoss?: number;
  status: OrderStatus;
  openedAt: Time;
  closedAt?: Time;
  closePrice?: number;
  result?: "TP" | "SL" | "CANCEL";
};

type CsvRow = Record<string, string | number | undefined>;
type PhemexOpenOrderRow = Record<string, string | number | boolean | undefined>;

const defaultCandles: Candle[] = [
  { time: "2026-01-01" as Time, open: 102, high: 106, low: 100, close: 104, volume: 1200 },
  { time: "2026-01-02" as Time, open: 104, high: 108, low: 103, close: 107, volume: 1320 },
  { time: "2026-01-03" as Time, open: 107, high: 109, low: 101, close: 103, volume: 1510 },
  { time: "2026-01-04" as Time, open: 103, high: 105, low: 98, close: 99, volume: 1650 },
  { time: "2026-01-05" as Time, open: 99, high: 104, low: 97, close: 102, volume: 1420 },
  { time: "2026-01-06" as Time, open: 102, high: 111, low: 101, close: 110, volume: 1880 },
  { time: "2026-01-07" as Time, open: 110, high: 112, low: 106, close: 108, volume: 1710 },
  { time: "2026-01-08" as Time, open: 108, high: 115, low: 107, close: 114, volume: 1970 }
];

const numberFrom = (value: unknown) => {
  const normalized = String(value ?? "").replace(",", ".").trim();
  const parsed = Number(normalized);
  return Number.isFinite(parsed) ? parsed : undefined;
};

const findValue = (row: CsvRow, keys: string[]) => {
  const match = Object.keys(row).find((key) => keys.includes(key.trim().toLowerCase()));
  return match ? row[match] : undefined;
};

const normalizeTime = (value: unknown, unit?: "ms" | "s"): Time | undefined => {
  if (value === undefined || value === null || value === "") return undefined;
  const raw = String(value).trim();
  const unix = Number(raw);
  if (Number.isFinite(unix)) {
    if (unit === "ms") return Math.floor(unix / 1000) as Time;
    if (unit === "s") return unix as Time;
    if (raw.length >= 13) return Math.floor(unix / 1000) as Time;
    if (raw.length >= 10) return unix as Time;
  }
  return raw as Time;
};

const rowsToCandles = (rows: CsvRow[]) => {
  return rows
    .map((row) => {
      const timestampMs = findValue(row, ["timestamp_ms", "timestampms", "open_time_ms"]);
      const timestamp = findValue(row, ["timestamp", "time", "date", "datetime", "open_time"]);
      const time = timestampMs !== undefined ? normalizeTime(timestampMs, "ms") : normalizeTime(timestamp);
      const open = numberFrom(findValue(row, ["open", "o"]));
      const high = numberFrom(findValue(row, ["high", "h"]));
      const low = numberFrom(findValue(row, ["low", "l"]));
      const close = numberFrom(findValue(row, ["close", "c"]));
      const volume = numberFrom(findValue(row, ["volume", "vol", "v"]));
      if (!time || open === undefined || high === undefined || low === undefined || close === undefined) {
        return undefined;
      }
      return { time, open, high, low, close, volume };
    })
    .filter(Boolean) as Candle[];
};

const parseCsvCandles = (file: File, onDone: (candles: Candle[]) => void, onError: (message: string) => void) => {
  Papa.parse<CsvRow>(file, {
    header: true,
    dynamicTyping: false,
    skipEmptyLines: true,
    complete: (result) => {
      const candles = rowsToCandles(result.data);

      if (!candles.length) {
        onError("CSV braucht Spalten wie timestamp_ms/time/date, open, high, low, close.");
        return;
      }
      onDone(candles);
    },
    error: (error) => onError(error.message)
  });
};

const parseCsvTextCandles = (text: string) => {
  const result = Papa.parse<CsvRow>(text, {
    header: true,
    dynamicTyping: false,
    skipEmptyLines: true
  });
  return rowsToCandles(result.data);
};

const upsertLiveCandle = (candles: Candle[], price: number, timestampMs: number, resolutionSeconds: number) => {
  const bucketTime = Math.floor(timestampMs / 1000 / resolutionSeconds) * resolutionSeconds;
  const last = candles.at(-1);
  if (last && Number(last.time) === bucketTime) {
    return [
      ...candles.slice(0, -1),
      {
        ...last,
        high: Math.max(last.high, price),
        low: Math.min(last.low, price),
        close: price
      }
    ];
  }
  return [
    ...candles,
    {
      time: bucketTime as Time,
      open: last?.close ?? price,
      high: Math.max(last?.close ?? price, price),
      low: Math.min(last?.close ?? price, price),
      close: price,
      volume: 0
    }
  ];
};

const timeframeFromResolution = (resolution: string | number) => {
  const seconds = Number(resolution || 300);
  if (seconds % 86400 === 0) return `${seconds / 86400}d`;
  if (seconds % 3600 === 0) return `${seconds / 3600}h`;
  return `${seconds / 60}m`;
};

const pollMsFromSettings = (settings: Pick<PhemexSettings, "pollSeconds">) => {
  const seconds = Number(settings.pollSeconds || 10);
  return Math.max(1, Number.isFinite(seconds) ? seconds : 10) * 1000;
};

const chartTimeToNumber = (time: Time | undefined) => {
  if (time === undefined) return undefined;
  if (typeof time === "number") return time;
  if (typeof time === "string") {
    const parsed = Date.parse(time);
    return Number.isFinite(parsed) ? Math.floor(parsed / 1000) : undefined;
  }
  return Date.UTC(time.year, time.month - 1, time.day) / 1000;
};

const candleTimeStep = (candles: Candle[]) => {
  if (candles.length < 2) return 60;
  for (let index = candles.length - 2; index >= 0; index -= 1) {
    const current = chartTimeToNumber(candles[index]?.time);
    const next = chartTimeToNumber(candles[index + 1]?.time);
    if (current !== undefined && next !== undefined && next > current) return next - current;
  }
  return 60;
};

const logicalToChartTime = (candles: Candle[], logical: number): Time | undefined => {
  if (!candles.length || !Number.isFinite(logical)) return undefined;
  const step = candleTimeStep(candles);
  if (logical <= 0) {
    const firstTime = chartTimeToNumber(candles[0]?.time);
    return firstTime === undefined ? candles[0]?.time : Math.round(firstTime + logical * step) as Time;
  }
  if (logical >= candles.length - 1) {
    const lastTime = chartTimeToNumber(candles.at(-1)?.time);
    return lastTime === undefined ? candles.at(-1)?.time : Math.round(lastTime + (logical - (candles.length - 1)) * step) as Time;
  }
  const lowerIndex = Math.max(0, Math.min(candles.length - 1, Math.floor(logical)));
  const upperIndex = Math.max(0, Math.min(candles.length - 1, Math.ceil(logical)));
  const lowerTime = chartTimeToNumber(candles[lowerIndex]?.time);
  const upperTime = chartTimeToNumber(candles[upperIndex]?.time);
  if (lowerTime === undefined) return candles[lowerIndex]?.time;
  if (upperIndex === lowerIndex || upperTime === undefined) return candles[lowerIndex]?.time;
  const ratio = logical - lowerIndex;
  return Math.round(lowerTime + (upperTime - lowerTime) * ratio) as Time;
};

const chartTimeToLogical = (candles: Candle[], time: Time | undefined) => {
  const target = chartTimeToNumber(time);
  if (target === undefined || !candles.length) return undefined;
  const times = candles.map((candle) => chartTimeToNumber(candle.time));
  const exactIndex = times.findIndex((value) => value === target);
  if (exactIndex >= 0) return exactIndex;
  for (let index = 0; index < times.length - 1; index += 1) {
    const current = times[index];
    const next = times[index + 1];
    if (current === undefined || next === undefined) continue;
    if (target >= current && target <= next) {
      const span = next - current;
      return span === 0 ? index : index + (target - current) / span;
    }
  }
  const first = times[0];
  const last = times.at(-1);
  const step = candleTimeStep(candles);
  if (first !== undefined && target < first) return (target - first) / step;
  if (last !== undefined && target > last) return candles.length - 1 + (target - last) / step;
  return undefined;
};

const formatPrice = (value?: number) => (value === undefined ? "-" : value.toFixed(2));

const clampProtectionPrice = (order: TradeOrder, field: "takeProfit" | "stopLoss", price: number) => {
  const minGap = Math.max(order.entry * 0.0001, 0.0001);
  if (order.side === "buy") {
    return field === "takeProfit" ? Math.max(price, order.entry + minGap) : Math.min(price, order.entry - minGap);
  }
  return field === "takeProfit" ? Math.min(price, order.entry - minGap) : Math.max(price, order.entry + minGap);
};

const isProtectionPriceValid = (order: TradeOrder, field: "takeProfit" | "stopLoss", price: number) => {
  if (order.side === "buy") {
    return field === "takeProfit" ? price > order.entry : price < order.entry;
  }
  return field === "takeProfit" ? price < order.entry : price > order.entry;
};

const isProtectionDockedAtEntry = (order: TradeOrder, price: number) => {
  return Math.abs(price - order.entry) <= Math.max(order.entry * 0.001, 0.01);
};

const delay = (ms: number) => new Promise((resolveDelay) => window.setTimeout(resolveDelay, ms));

const normalizeProtectionAfterEntryMove = (order: TradeOrder, nextEntry: number): TradeOrder => {
  const tpValid =
    order.takeProfit === undefined ||
    (order.side === "buy" ? order.takeProfit > nextEntry : order.takeProfit < nextEntry);
  const slValid =
    order.stopLoss === undefined ||
    (order.side === "buy" ? order.stopLoss < nextEntry : order.stopLoss > nextEntry);

  return {
    ...order,
    entry: nextEntry,
    takeProfit: tpValid ? order.takeProfit : undefined,
    stopLoss: slValid ? order.stopLoss : undefined
  };
};

const phemexOrderToTradeOrder = (row: PhemexOpenOrderRow, fallbackTime: Time): TradeOrder | undefined => {
  const entry = numberFrom(row.priceRp ?? row.price);
  const quantity = numberFrom(row.orderQtyRq ?? row.orderQty ?? row.qty);
  const side = String(row.side || "").toLowerCase() === "sell" ? "sell" : "buy";
  const phemexOrderId = String(row.orderID || "").trim();
  const phemexClOrdId = String(row.clOrdID || "").trim();
  const id = phemexOrderId || phemexClOrdId;
  if (!id || entry === undefined || quantity === undefined) return undefined;
  const importedTakeProfit = numberFrom(row.takeProfitRp ?? row.tpPxRp);
  const importedStopLoss = numberFrom(row.stopLossRp ?? row.slPxRp);
  const takeProfit = importedTakeProfit !== undefined && importedTakeProfit > 0 ? importedTakeProfit : undefined;
  const stopLoss = importedStopLoss !== undefined && importedStopLoss > 0 ? importedStopLoss : undefined;
  return {
    id,
    phemexOrderId: phemexOrderId || undefined,
    phemexClOrdId: phemexClOrdId || undefined,
    side,
    quantity,
    entry,
    takeProfit,
    stopLoss,
    status: "pending",
    openedAt: fallbackTime
  };
};

const phemexPositionSize = (row: Record<string, unknown>) => {
  const size =
    numberFrom(row.sizeRq) ??
    numberFrom(row.size) ??
    numberFrom(row.posSizeRq) ??
    numberFrom(row.positionSizeRq) ??
    numberFrom(row.positionQtyRq) ??
    numberFrom(row.qty);
  return size ?? 0;
};

type ChartMenu = {
  x: number;
  y: number;
  price: number;
};

type DraggableOrderField = "entry" | "takeProfit" | "stopLoss";

type DraggedOrderLine = {
  orderId: string;
  field: DraggableOrderField;
};

type PendingOrderMove = {
  target: DraggedOrderLine | { orderId: string; field: "takeProfit" | "stopLoss" };
  price: number;
  fromChip: boolean;
};

type DrawingTool = "cursor" | "line" | "horizontal" | "ray" | "rect" | "zigzag";

type DrawingPoint = {
  logical: number;
  price: number;
  time?: Time;
};

type DrawingShape = {
  id: string;
  tool: Exclude<DrawingTool, "cursor">;
  start: DrawingPoint;
  end: DrawingPoint;
  points?: DrawingPoint[];
  strokeColor: string;
  fillColor: string;
  lineWidth: number;
  borderWidth: number;
  locked?: boolean;
};

type DraggedDrawing = {
  id: string;
  startPoint: DrawingPoint;
  original: DrawingShape;
  handle?: "move" | "start" | "end" | "topLeft" | "topRight" | "bottomRight" | "bottomLeft";
  pointIndex?: number;
};

type DrawingMenu = {
  id: string;
  x: number;
  y: number;
};

type ProtectionConfirm = {
  orderId: string;
  x: number;
  y: number;
  originalEntry: number;
  originalTakeProfit?: number;
  originalStopLoss?: number;
};

type ExchangeDebugPopup = {
  title: string;
  message: string;
  details?: string;
};

type OrderbookConfirm = {
  title: string;
  message: string;
};

type CsvBuilderState = {
  coin: string;
  quote: string;
  timeframe: string;
  startYear: string;
  startMonth: string;
  months: string;
  testnet: boolean;
};

type OrderLineField = "entry" | "takeProfit" | "stopLoss";

type ChartTheme = {
  upColor: string;
  downColor: string;
  upWickColor: string;
  downWickColor: string;
  upBorderColor: string;
  downBorderColor: string;
  backgroundColor: string;
  gridColor: string;
  textColor: string;
  showGrid: boolean;
  showLastPriceLine: boolean;
  showCrosshair: boolean;
  allowMouseWheel: boolean;
  allowDrag: boolean;
  orderControlsSide: "left" | "right";
  drawingSize: number;
};

type Language = "de" | "en";
type SettingsTab = "colors" | "chart" | "orders" | "drawings" | "phemex" | "language";

type PhemexSettings = {
  exchange: "phemex" | "binance";
  apiKey: string;
  apiSecret: string;
  testnet: boolean;
  symbol: string;
  pollSeconds: string;
  resolution: string;
  limit: string;
  mode: "replay" | "live";
  liveOrdersEnabled: boolean;
  allowMainnetOrders: boolean;
  marginMode: "cross" | "isolated";
  leverage: string;
};

const defaultTheme: ChartTheme = {
  upColor: "#2fbf71",
  downColor: "#e05252",
  upWickColor: "#45d089",
  downWickColor: "#eb6b6b",
  upBorderColor: "#2fbf71",
  downBorderColor: "#e05252",
  backgroundColor: "#0f151d",
  gridColor: "#243040",
  textColor: "#d5deea",
  showGrid: true,
  showLastPriceLine: true,
  showCrosshair: true,
  allowMouseWheel: true,
  allowDrag: true,
  orderControlsSide: "right",
  drawingSize: 1.4
};

const drawingsStorageKey = "chart-replay-tool-drawings";
const pendingOrdersStorageKey = "chart-replay-tool-pending-orders";
const chartThemeStorageKey = "chart-replay-tool-chart-theme";
const appOptionsStorageKey = "chart-replay-tool-options";
const exchangeOptionsStorageKey = "chart-replay-tool-exchange-options";
const coinFavoritesStorageKey = "chart-replay-tool-coin-favorites";
const defaultDrawingStrokeColor = "#7db8ff";
const defaultDrawingFillColor = "#7db8ff";
const rightPriceScaleOffset = 64;
const phemexOrderIdPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const loadStoredChartTheme = (): ChartTheme => {
  try {
    const raw = window.localStorage.getItem(chartThemeStorageKey);
    if (!raw) return defaultTheme;
    return { ...defaultTheme, ...JSON.parse(raw) };
  } catch {
    return defaultTheme;
  }
};

const loadStoredAppOptions = () => {
  try {
    const raw = window.localStorage.getItem(appOptionsStorageKey);
    const parsed = raw ? JSON.parse(raw) : {};
    return {
      language: parsed.language === "en" ? "en" as Language : "de" as Language,
      autoScalePrice: Boolean(parsed.autoScalePrice),
      autoFocusChart: Boolean(parsed.autoFocusChart)
    };
  } catch {
    return {
      language: "de" as Language,
      autoScalePrice: false,
      autoFocusChart: false
    };
  }
};

const loadStoredExchangeOptions = () => {
  try {
    const raw = window.localStorage.getItem(exchangeOptionsStorageKey);
    return raw ? JSON.parse(raw) as Partial<PhemexSettings> : {};
  } catch {
    return {};
  }
};

const loadStoredCoinFavorites = () => {
  try {
    const raw = window.localStorage.getItem(coinFavoritesStorageKey);
    const parsed = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed.filter((value) => typeof value === "string") : [];
  } catch {
    return [];
  }
};

const loadStoredDrawings = (): DrawingShape[] => {
  try {
    const raw = window.localStorage.getItem(drawingsStorageKey);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((item) =>
        item &&
      ["line", "horizontal", "ray", "rect", "zigzag"].includes(item.tool) &&
        Number.isFinite(item.start?.logical) &&
        Number.isFinite(item.start?.price) &&
        Number.isFinite(item.end?.logical) &&
        Number.isFinite(item.end?.price)
      )
      .map((item) => ({
        ...item,
        start: {
          ...item.start,
          time: item.start?.time
        },
        end: {
          ...item.end,
          time: item.end?.time
        },
        points: Array.isArray(item.points) ? item.points.map((point: DrawingPoint) => ({ ...point, time: point.time })) : undefined,
        strokeColor:
          typeof item.strokeColor === "string"
            ? item.strokeColor
            : typeof item.color === "string"
              ? item.color
              : defaultDrawingStrokeColor,
        fillColor:
          typeof item.fillColor === "string"
            ? item.fillColor
            : typeof item.color === "string"
              ? item.color
              : defaultDrawingFillColor,
        lineWidth: Number.isFinite(item.lineWidth) ? item.lineWidth : 1.4,
        borderWidth: Number.isFinite(item.borderWidth) ? item.borderWidth : 1.4,
        locked: Boolean(item.locked)
      }));
  } catch {
    return [];
  }
};

const loadStoredPendingOrders = (): TradeOrder[] => {
  try {
    const raw = window.localStorage.getItem(pendingOrdersStorageKey);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    const localPendingOrders = parsed.filter((item) =>
      item &&
      item.status === "pending" &&
      (item.side === "buy" || item.side === "sell") &&
      typeof item.id === "string" &&
      !item.phemexOrderId &&
      !item.phemexClOrdId &&
      Number.isFinite(item.quantity) &&
      Number.isFinite(item.entry)
    );
    if (localPendingOrders.length !== parsed.length) {
      window.localStorage.setItem(pendingOrdersStorageKey, JSON.stringify(localPendingOrders));
    }
    return localPendingOrders;
  } catch {
    return [];
  }
};

const translations = {
  de: {
    appTitle: "Chart_Replay_Tool",
    csvLoad: "CSV laden",
    csvCreate: "CSV erstellen",
    csvBuilderTitle: "Binance CSV erstellen",
    csvBuilderHint: "Erstellt Binance-Futures-Kerzen im bestehenden chart_data CSV-Format.",
    csvDownload: "Download",
    coin: "Coin",
    quote: "Quote",
    startYear: "Startjahr",
    startMonth: "Startmonat",
    months: "Monate",
    csvBuilderDone: (path: string) => `Binance CSV erstellt: ${path}`,
    csvBuilderFailed: "Binance CSV konnte nicht erstellt werden.",
    candles: "Kerzen",
    last: "Last",
    high: "High",
    low: "Low",
    futuresBalance: "Futures USDT",
    liveModeLabel: "Live Mode",
    accountBalance: "Account Balance",
    timeCounter: "Time Counter",
    chartLoaded: "Chart",
    autoScale: "Auto-Skala",
    autoFocus: "Auto-Fokus",
    options: "Optionen",
    priceScaleTitle: "Preisachse automatisch skalieren",
    autoFocusTitle: "Chart automatisch auf sichtbare Kerzen fokussieren",
    chartOptionsTitle: "Chart-Design einstellen",
    cursorTool: "Cursor",
    lineTool: "Linie",
    horizontalTool: "Horizontale Linie",
    rayTool: "Halbe Linie",
    rectTool: "Rechteck",
    zigzagTool: "Zig Zag",
    clearDrawings: "Zeichnungen löschen",
    chartDesign: "Chart-Design",
    colors: "Farben",
    chart: "Chart",
    orders: "Orders",
    drawings: "Zeichnungen",
    exchange: "Exchange",
    candlesSection: "Kerzen",
    chartArea: "Chart-Fläche",
    behavior: "Verhalten",
    orderDisplay: "Order-Anzeige",
    drawingDisplay: "Zeichenwerkzeuge",
    drawingSize: "Größe",
    phemexConnection: "Phemex-Anbindung",
    connectionSection: "Verbindung",
    dataModeSection: "Datenmodus",
    apiKey: "API Key",
    apiSecret: "API Secret",
    testnet: "Testnet",
    mainnet: "Mainnet",
    allowMainnetOrders: "Mainnet-Orders erlauben",
    allowMainnetOrdersHint: "Erlaubt echte Live-Orders auf Mainnet.",
    symbol: "Symbol",
    timeframe: "Timeframe",
    candleLimit: "Kerzenanzahl",
    exchangeMode: "Modus",
    replayMode: "Replay",
    liveMode: "Live",
    pollSeconds: "Preisabruf in Sekunden",
    liveStatus: "Live-Status",
    liveInactive: "Live aus",
    liveRunning: "Live läuft",
    liveWaiting: "Wartet",
    exchangeLoading: "Lädt",
    exchangeError: "Fehler",
    lastFetch: "Letzter Abruf",
    nextFetch: "Nächster Abruf",
    saveApiSettings: "API speichern",
    applySettings: "Übernehmen",
    testConnection: "Verbindung testen",
    loadReplayData: "Replay-Daten laden",
    startLive: "Live starten",
    stopLive: "Live stoppen",
    syncExchange: "Abgleich",
    syncExchangeDone: "Phemex-Abgleich abgeschlossen.",
    syncExchangeFailed: "Phemex-Abgleich fehlgeschlagen.",
    liveOrders: "Phemex Live-Order",
    marginMode: "Margin-Modus",
    cross: "Cross",
    isolated: "Isoliert",
    leverage: "Hebel",
    limitPrice: "Limitpreis",
    lastPrice: "Letzter",
    size: "Größe",
    available: "Available",
    cost: "Kosten",
    estimatedLiquidation: "Geschätz. Liq. Preis",
    openLong: "Long",
    openShort: "Short",
    useLastPrice: "Letzten Preis übernehmen",
    apiSaved: "Phemex API-Einstellungen in .env.local gespeichert.",
    settingsApplied: (symbol: string, timeframe: string) => `Exchange-Einstellungen übernommen: ${symbol} ${timeframe}.`,
    apiSaveFailed: "Phemex API-Einstellungen konnten nicht gespeichert werden.",
    connectionOk: (symbol: string, price: string) => `Phemex-Verbindung ok: ${symbol} bei ${price}.`,
    connectionFailed: "Phemex-Verbindung konnte nicht geprüft werden.",
    phemexChartLoaded: (count: number, path: string) => `${count} Phemex-Kerzen geladen und in ${path} gespeichert.`,
    phemexChartFailed: "Phemex-Chart konnte nicht geladen werden.",
    phemexOrderPlaced: (id: string) => `Phemex Live-Order gesendet: ${id}.`,
    phemexOrderFailed: (reason?: string) => `Phemex Live-Order konnte nicht gesendet werden${reason ? `: ${reason}` : "."}`,
    phemexLiveOrdersDisabled: "Phemex Live-Order ist aus. Aktiviere den Schalter, bevor du eine echte Order sendest.",
    phemexOrdersSynced: (count: number) => `${count} offene Phemex-Orders übernommen.`,
    phemexOrderAmended: (id: string) => `Phemex Order ${id} aktualisiert.`,
    phemexOrderAmendFailed: (reason?: string) => `Phemex Order konnte nicht aktualisiert werden${reason ? `: ${reason}` : "."}`,
    phemexOrderCanceled: (id: string) => `Phemex Order ${id} storniert.`,
    phemexOrderCancelFailed: (reason?: string) => `Phemex Order konnte nicht storniert werden${reason ? `: ${reason}` : "."}`,
    livePriceUpdated: (price: string) => `Live-Preis aktualisiert: ${price}`,
    language: "Sprache",
    german: "Deutsch",
    english: "English",
    bodyUp: "Körper hoch",
    bodyDown: "Körper runter",
    wickUp: "Docht hoch",
    wickDown: "Docht runter",
    borderUp: "Rahmen hoch",
    borderDown: "Rahmen runter",
    background: "Hintergrund",
    grid: "Grid",
    text: "Text",
    priceLine: "Preislinie",
    crosshair: "Crosshair",
    mouseWheel: "Mausrad",
    drag: "Ziehen",
    orderControlsRight: "Order rechts",
    orderControlsLeft: "Order links",
    resetDefault: "Standard",
    copyPrice: "Preis kopieren",
    useEntry: "Als Entry übernehmen",
    useTp: "Als TP übernehmen",
    useSl: "Als SL übernehmen",
    buyOrderHere: "Buy Order hier",
    sellOrderHere: "Sell Order hier",
    play: "Play",
    pause: "Pause",
    step: "Step",
    replayDelay: "Ablaufzeit",
    reset: "Reset",
    order: "Order",
    quantity: "Menge",
    takeProfit: "Take Profit",
    stopLoss: "Stop Loss",
    submitOrder: "Order setzen",
    orderbook: "Orderbook",
    clearOrderbook: "Orderbook leeren",
    noOpenOrders: "Keine offenen Orders",
    pending: "pending",
    active: "active",
    tradesHistory: "Trades / Historie",
    action: "Aktion",
    cancel: "Cancel",
    close: "Schließen",
    saveProtection: "TP/SL speichern",
    demoLoaded: "Demo-Daten geladen. CSV kann oben importiert werden.",
    csvInvalid: "CSV braucht Spalten wie timestamp_ms/time/date, open, high, low, close.",
    chartCsvInvalid: "chart_data CSV konnte nicht gelesen werden.",
    chartCsvLoaded: (count: number) => `${count} SOLUSDT 5m Kerzen aus chart_data geladen.`,
    orderNeedsInput: "Order braucht eine gültige Menge und Entry.",
    orderPlaced: (id: string, orderSide: Side, price: string) => `${id} ${orderSide.toUpperCase()} bei ${price} gesetzt.`,
    orderCanceled: (id: string) => `${id} storniert.`,
    orderDeleted: (id: string) => `${id} gelöscht.`,
    invalidProtection: "TP/SL braucht einen gültigen Preis.",
    protectionUpdated: (id: string) => `${id} TP/SL aktualisiert.`,
    priceUsed: (price: string) => `Preis ${price} übernommen.`,
    priceCopied: (price: string) => `Preis ${price} kopiert.`,
    candlesLoaded: (count: number) => `${count} Kerzen geladen.`,
    replayReset: "Replay und Orderbook zurückgesetzt.",
    themeReset: "Chart-Design zurückgesetzt."
  },
  en: {
    appTitle: "Chart_Replay_Tool",
    csvLoad: "Load CSV",
    csvCreate: "Create CSV",
    csvBuilderTitle: "Create Binance CSV",
    csvBuilderHint: "Creates Binance futures candles in the existing chart_data CSV format.",
    csvDownload: "Download",
    coin: "Coin",
    quote: "Quote",
    startYear: "Start Year",
    startMonth: "Start Month",
    months: "Months",
    csvBuilderDone: (path: string) => `Binance CSV created: ${path}`,
    csvBuilderFailed: "Binance CSV could not be created.",
    candles: "Candles",
    last: "Last",
    high: "High",
    low: "Low",
    futuresBalance: "Futures USDT",
    liveModeLabel: "Live Mode",
    accountBalance: "Account Balance",
    timeCounter: "Time Counter",
    chartLoaded: "Chart",
    autoScale: "Auto Scale",
    autoFocus: "Auto Focus",
    options: "Options",
    priceScaleTitle: "Automatically scale price axis",
    autoFocusTitle: "Automatically focus visible candles",
    chartOptionsTitle: "Configure chart design",
    cursorTool: "Cursor",
    lineTool: "Line",
    horizontalTool: "Horizontal Line",
    rayTool: "Ray",
    rectTool: "Rectangle",
    zigzagTool: "Zig Zag",
    clearDrawings: "Clear drawings",
    chartDesign: "Chart Design",
    colors: "Colors",
    chart: "Chart",
    orders: "Orders",
    drawings: "Drawings",
    exchange: "Exchange",
    candlesSection: "Candles",
    chartArea: "Chart Area",
    behavior: "Behavior",
    orderDisplay: "Order Display",
    drawingDisplay: "Drawing Tools",
    drawingSize: "Size",
    phemexConnection: "Phemex Connection",
    connectionSection: "Connection",
    dataModeSection: "Data Mode",
    apiKey: "API Key",
    apiSecret: "API Secret",
    testnet: "Testnet",
    mainnet: "Mainnet",
    allowMainnetOrders: "Allow Mainnet Orders",
    allowMainnetOrdersHint: "Allows real live orders on Mainnet.",
    symbol: "Symbol",
    timeframe: "Timeframe",
    candleLimit: "Candle Limit",
    exchangeMode: "Mode",
    replayMode: "Replay",
    liveMode: "Live",
    pollSeconds: "Price Poll Seconds",
    liveStatus: "Live Status",
    liveInactive: "Live off",
    liveRunning: "Live running",
    liveWaiting: "Waiting",
    exchangeLoading: "Loading",
    exchangeError: "Error",
    lastFetch: "Last Fetch",
    nextFetch: "Next Fetch",
    saveApiSettings: "Save API",
    applySettings: "Apply",
    testConnection: "Test Connection",
    loadReplayData: "Load Replay Data",
    startLive: "Start Live",
    stopLive: "Stop Live",
    syncExchange: "Sync",
    syncExchangeDone: "Phemex sync complete.",
    syncExchangeFailed: "Phemex sync failed.",
    liveOrders: "Phemex Live Order",
    marginMode: "Margin Mode",
    cross: "Cross",
    isolated: "Isolated",
    leverage: "Leverage",
    limitPrice: "Limit Price",
    lastPrice: "Last",
    size: "Size",
    available: "Available",
    cost: "Cost",
    estimatedLiquidation: "Estimated Liq. Price",
    openLong: "Long",
    openShort: "Short",
    useLastPrice: "Use last price",
    apiSaved: "Phemex API settings saved to .env.local.",
    settingsApplied: (symbol: string, timeframe: string) => `Exchange settings applied: ${symbol} ${timeframe}.`,
    apiSaveFailed: "Phemex API settings could not be saved.",
    connectionOk: (symbol: string, price: string) => `Phemex connection ok: ${symbol} at ${price}.`,
    connectionFailed: "Phemex connection could not be checked.",
    phemexChartLoaded: (count: number, path: string) => `${count} Phemex candles loaded and saved to ${path}.`,
    phemexChartFailed: "Phemex chart could not be loaded.",
    phemexOrderPlaced: (id: string) => `Phemex live order sent: ${id}.`,
    phemexOrderFailed: (reason?: string) => `Phemex live order could not be sent${reason ? `: ${reason}` : "."}`,
    phemexLiveOrdersDisabled: "Phemex live order is off. Enable the switch before sending a real order.",
    phemexOrdersSynced: (count: number) => `${count} open Phemex orders imported.`,
    phemexOrderAmended: (id: string) => `Phemex order ${id} updated.`,
    phemexOrderAmendFailed: (reason?: string) => `Phemex order could not be updated${reason ? `: ${reason}` : "."}`,
    phemexOrderCanceled: (id: string) => `Phemex order ${id} canceled.`,
    phemexOrderCancelFailed: (reason?: string) => `Phemex order could not be canceled${reason ? `: ${reason}` : "."}`,
    livePriceUpdated: (price: string) => `Live price updated: ${price}`,
    language: "Language",
    german: "Deutsch",
    english: "English",
    bodyUp: "Body Up",
    bodyDown: "Body Down",
    wickUp: "Wick Up",
    wickDown: "Wick Down",
    borderUp: "Border Up",
    borderDown: "Border Down",
    background: "Background",
    grid: "Grid",
    text: "Text",
    priceLine: "Price Line",
    crosshair: "Crosshair",
    mouseWheel: "Mouse Wheel",
    drag: "Drag",
    orderControlsRight: "Orders Right",
    orderControlsLeft: "Orders Left",
    resetDefault: "Default",
    copyPrice: "Copy Price",
    useEntry: "Use as Entry",
    useTp: "Use as TP",
    useSl: "Use as SL",
    buyOrderHere: "Buy Order here",
    sellOrderHere: "Sell Order here",
    play: "Play",
    pause: "Pause",
    step: "Step",
    replayDelay: "Replay Delay",
    reset: "Reset",
    order: "Order",
    quantity: "Quantity",
    takeProfit: "Take Profit",
    stopLoss: "Stop Loss",
    submitOrder: "Place Order",
    orderbook: "Orderbook",
    clearOrderbook: "Clear orderbook",
    noOpenOrders: "No open orders",
    pending: "pending",
    active: "active",
    tradesHistory: "Trades / History",
    action: "Action",
    cancel: "Cancel",
    close: "Close",
    saveProtection: "Save TP/SL",
    demoLoaded: "Demo data loaded. CSV can be imported above.",
    csvInvalid: "CSV needs columns like timestamp_ms/time/date, open, high, low, close.",
    chartCsvInvalid: "chart_data CSV could not be read.",
    chartCsvLoaded: (count: number) => `${count} SOLUSDT 5m candles loaded from chart_data.`,
    orderNeedsInput: "Order needs a valid quantity and entry.",
    orderPlaced: (id: string, orderSide: Side, price: string) => `${id} ${orderSide.toUpperCase()} placed at ${price}.`,
    orderCanceled: (id: string) => `${id} canceled.`,
    orderDeleted: (id: string) => `${id} deleted.`,
    invalidProtection: "TP/SL needs a valid price.",
    protectionUpdated: (id: string) => `${id} TP/SL updated.`,
    priceUsed: (price: string) => `Price ${price} applied.`,
    priceCopied: (price: string) => `Price ${price} copied.`,
    candlesLoaded: (count: number) => `${count} candles loaded.`,
    replayReset: "Replay and orderbook reset.",
    themeReset: "Chart design reset."
  }
};

function TradingApp() {
  const storedAppOptions = useMemo(() => loadStoredAppOptions(), []);
  const storedExchangeOptions = useMemo(() => loadStoredExchangeOptions(), []);
  const chartElement = useRef<HTMLDivElement | null>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const candleSeriesRef = useRef<ISeriesApi<"Candlestick"> | null>(null);
  const lineSeriesRef = useRef<Map<string, ISeriesApi<"Line">>>(new Map());
  const shouldFitContentRef = useRef(true);
  const shouldFitPriceRef = useRef(true);
  const shouldJumpToLatestRef = useRef(false);
  const previousVisibleCountRef = useRef(0);
  const previousCandleSetRef = useRef<Candle[] | null>(null);
  const overlayRefreshFrameRef = useRef(0);
  const overlayRefreshFollowUpFrameRef = useRef(0);
  const storageWriteTimersRef = useRef<Record<string, number>>({});
  const drawingDragFrameRef = useRef(0);
  const orderDragFrameRef = useRef(0);
  const pendingDrawingMoveRef = useRef<{
    drag: DraggedDrawing;
    point: DrawingPoint;
    logicalDelta: number;
    priceDelta: number;
  } | null>(null);
  const pendingOrderMoveRef = useRef<PendingOrderMove | null>(null);
  const hasChartOverlaysRef = useRef(false);
  const ordersRef = useRef<TradeOrder[]>([]);
  const canceledPhemexOrderKeysRef = useRef<Set<string>>(new Set());
  const openPhemexOrderKeysRef = useRef<Set<string>>(new Set());
  const lastPhemexOrderStatusSyncAtRef = useRef(0);
  const lastLivePriceErrorPopupAtRef = useRef(0);
  const livePriceBackoffUntilRef = useRef(0);
  const refreshLivePhemexPriceRef = useRef<(settingsOverride?: PhemexSettings) => Promise<void>>(async () => undefined);
  const draggedLineRef = useRef<DraggedOrderLine | null>(null);
  const draggedChipRef = useRef<{ orderId: string; field: "takeProfit" | "stopLoss" } | null>(null);
  const draggedProtectionOriginalRef = useRef<{ orderId: string; entry: number; takeProfit?: number; stopLoss?: number } | null>(null);
  const blockedProtectionDragRef = useRef(false);
  const protectionEditOriginalsRef = useRef<Record<string, { entry: number; takeProfit?: number; stopLoss?: number }>>({});
  const drawingDraftRef = useRef<DrawingShape | null>(null);
  const draggedDrawingRef = useRef<DraggedDrawing | null>(null);
  const chipDragFinishedRef = useRef(false);
  const [lineControls, setLineControls] = useState<Array<{ order: TradeOrder; y: number; x: number; controlsX: number }>>([]);
  const [orderLineLabels, setOrderLineLabels] = useState<
    Array<{ order: TradeOrder; field: DraggableOrderField; y: number; price: number; x?: number }>
  >([]);

  const [allCandles, setAllCandles] = useState<Candle[]>(defaultCandles);
  const [visibleCount, setVisibleCount] = useState(4);
  const [isPlaying, setIsPlaying] = useState(false);
  const [speedMs, setSpeedMs] = useState(800);
  const [orders, setOrders] = useState<TradeOrder[]>(() => loadStoredPendingOrders());
  const [side, setSide] = useState<Side>("buy");
  const [quantity, setQuantity] = useState(0);
  const [entry, setEntry] = useState("");
  const [takeProfit, setTakeProfit] = useState("");
  const [stopLoss, setStopLoss] = useState("");
  const [liveCapitalPercent, setLiveCapitalPercent] = useState(0);
  const [chartMenu, setChartMenu] = useState<ChartMenu | null>(null);
  const [autoScalePrice, setAutoScalePrice] = useState(storedAppOptions.autoScalePrice);
  const [autoFocusChart, setAutoFocusChart] = useState(storedAppOptions.autoFocusChart);
  const [showChartOptions, setShowChartOptions] = useState(false);
  const [settingsTab, setSettingsTab] = useState<SettingsTab>("colors");
  const [chartTheme, setChartTheme] = useState<ChartTheme>(() => loadStoredChartTheme());
  const [drawingTool, setDrawingTool] = useState<DrawingTool>("cursor");
  const [drawings, setDrawings] = useState<DrawingShape[]>(() => loadStoredDrawings());
  const [drawingDraft, setDrawingDraft] = useState<DrawingShape | null>(null);
  const [zigZagDraftPoints, setZigZagDraftPoints] = useState<DrawingPoint[]>([]);
  const [selectedDrawingId, setSelectedDrawingId] = useState<string | null>(null);
  const [drawingMenu, setDrawingMenu] = useState<DrawingMenu | null>(null);
  const [chartViewVersion, setChartViewVersion] = useState(0);
  const [language, setLanguage] = useState<Language>(storedAppOptions.language);
  const [liveLastPrice, setLiveLastPrice] = useState<number | null>(null);
  const [liveLastFetchAt, setLiveLastFetchAt] = useState<number | null>(null);
  const [liveNextFetchAt, setLiveNextFetchAt] = useState<number | null>(null);
  const [liveCountdownSeconds, setLiveCountdownSeconds] = useState<number | null>(null);
  const [futuresBalance, setFuturesBalance] = useState<number | null>(null);
  const [isLiveRunning, setIsLiveRunning] = useState(false);
  const [liveSettingsVersion, setLiveSettingsVersion] = useState(0);
  const [exchangeRequestState, setExchangeRequestState] = useState<"idle" | "loading" | "error">("idle");
  const [coinOptions, setCoinOptions] = useState<string[]>(["BTCUSDT", "ETHUSDT", "SOLUSDT"]);
  const [coinFavorites, setCoinFavorites] = useState<string[]>(() => loadStoredCoinFavorites());
  const [isCoinDropdownOpen, setIsCoinDropdownOpen] = useState(false);
  const [isMarketFavoritesOpen, setIsMarketFavoritesOpen] = useState(false);
  const [pendingProtectionSyncIds, setPendingProtectionSyncIds] = useState<string[]>([]);
  const [protectionConfirm, setProtectionConfirm] = useState<ProtectionConfirm | null>(null);
  const [exchangeDebugPopup, setExchangeDebugPopup] = useState<ExchangeDebugPopup | null>(null);
  const [orderbookConfirm, setOrderbookConfirm] = useState<OrderbookConfirm | null>(null);
  const [showCsvBuilder, setShowCsvBuilder] = useState(false);
  const [phemexSettings, setPhemexSettings] = useState<PhemexSettings>({
    exchange: storedExchangeOptions.exchange === "binance" ? "binance" : "phemex",
    apiKey: "",
    apiSecret: "",
    testnet: storedExchangeOptions.testnet ?? true,
    symbol: storedExchangeOptions.symbol || "SOLUSDT",
    pollSeconds: storedExchangeOptions.pollSeconds || "10",
    resolution: storedExchangeOptions.resolution || "300",
    limit: storedExchangeOptions.limit || "500",
    mode: storedExchangeOptions.mode === "live" ? "live" : "replay",
    liveOrdersEnabled: Boolean(storedExchangeOptions.liveOrdersEnabled),
    allowMainnetOrders: Boolean(storedExchangeOptions.allowMainnetOrders),
    marginMode: storedExchangeOptions.marginMode === "isolated" ? "isolated" : "cross",
    leverage: storedExchangeOptions.leverage || "10"
  });
  const [activePhemexSettings, setActivePhemexSettings] = useState<PhemexSettings>(() => ({
    exchange: storedExchangeOptions.exchange === "binance" ? "binance" : "phemex",
    apiKey: "",
    apiSecret: "",
    testnet: storedExchangeOptions.testnet ?? true,
    symbol: storedExchangeOptions.symbol || "SOLUSDT",
    pollSeconds: storedExchangeOptions.pollSeconds || "10",
    resolution: storedExchangeOptions.resolution || "300",
    limit: storedExchangeOptions.limit || "500",
    mode: storedExchangeOptions.mode === "live" ? "live" : "replay",
    liveOrdersEnabled: Boolean(storedExchangeOptions.liveOrdersEnabled),
    allowMainnetOrders: Boolean(storedExchangeOptions.allowMainnetOrders),
    marginMode: storedExchangeOptions.marginMode === "isolated" ? "isolated" : "cross",
    leverage: storedExchangeOptions.leverage || "10"
  }));
  const [csvBuilder, setCsvBuilder] = useState<CsvBuilderState>(() => ({
    coin: "SOL",
    quote: "USDT",
    timeframe: "5m",
    startYear: "2026",
    startMonth: "3",
    months: "2",
    testnet: storedExchangeOptions.testnet ?? true
  }));
  const t = translations[language];
  const [message, setMessage] = useState(translations.de.demoLoaded);
  const [messageKind, setMessageKind] = useState<"demo" | "chartCsv" | "custom">("demo");
  const isExchangeLive = activePhemexSettings.mode === "live";
  const showLiveStatus = isExchangeLive && isLiveRunning;
  const showPhemexConnected = showLiveStatus && futuresBalance !== null;
  const isExchangeBusy = exchangeRequestState === "loading";
  const exchangeStatusText =
    exchangeRequestState === "loading"
      ? t.exchangeLoading
      : exchangeRequestState === "error"
        ? t.exchangeError
        : showLiveStatus
          ? t.liveRunning
          : t.liveInactive;

  const visibleCandles = useMemo(() => allCandles.slice(0, visibleCount), [allCandles, visibleCount]);
  const lastCandle = visibleCandles.at(-1);
  const openOrders = useMemo(
    () => orders.filter((order) => order.status === "pending" || order.status === "active"),
    [orders]
  );
  const closedOrders = useMemo(() => orders.filter((order) => order.status === "closed"), [orders]);
  const canceledOrders = useMemo(() => orders.filter((order) => order.status === "canceled"), [orders]);
  const liveOrderPrice = entry ? Number(entry) : liveLastPrice ?? lastCandle?.close;
  const liveOrderNotional = Number.isFinite(liveOrderPrice) ? Number(quantity || 0) * Number(liveOrderPrice) : undefined;
  const leverageValue = Math.max(1, Number(phemexSettings.leverage || 1));
  const liveOrderMargin = liveOrderNotional === undefined ? undefined : liveOrderNotional / leverageValue;
  const baseAsset = activePhemexSettings.symbol.replace(/USDT$/i, "") || activePhemexSettings.symbol;
  const sortedCoinOptions = useMemo(() => {
    const uniqueCoins = Array.from(new Set(coinOptions));
    return uniqueCoins.sort((left, right) => {
      const leftFavorite = coinFavorites.includes(left);
      const rightFavorite = coinFavorites.includes(right);
      if (leftFavorite !== rightFavorite) return leftFavorite ? -1 : 1;
      return left.localeCompare(right);
    });
  }, [coinFavorites, coinOptions]);
  const favoriteCoinOptions = useMemo(
    () => sortedCoinOptions.filter((symbol) => coinFavorites.includes(symbol)),
    [coinFavorites, sortedCoinOptions]
  );

  const screenToDrawingPoint = useCallback((x: number, y: number, snapToCandle = false): DrawingPoint | null => {
    const chart = chartRef.current;
    const series = candleSeriesRef.current;
    const logical = chart?.timeScale().coordinateToLogical(x);
    const price = series?.coordinateToPrice(y);
    if (logical === null || logical === undefined || price === null || price === undefined) return null;

    if (snapToCandle && visibleCandles.length) {
      const candleIndex = Math.max(0, Math.min(visibleCandles.length - 1, Math.round(Number(logical))));
      const candle = visibleCandles[candleIndex];
      const highY = series?.priceToCoordinate(candle.high);
      const lowY = series?.priceToCoordinate(candle.low);
      const snappedPrice =
        highY !== null &&
        highY !== undefined &&
        lowY !== null &&
        lowY !== undefined &&
        Math.abs(y - highY) <= Math.abs(y - lowY)
          ? candle.high
          : candle.low;
      return { logical: candleIndex, price: snappedPrice, time: candle.time };
    }

    return {
      logical: Number(logical),
      price,
      time: logicalToChartTime(visibleCandles, Number(logical))
    };
  }, [visibleCandles]);

  const drawingPointToScreen = useCallback((point: DrawingPoint) => {
    const chart = chartRef.current;
    const series = candleSeriesRef.current;
    const resolvedLogical = point.time !== undefined ? chartTimeToLogical(visibleCandles, point.time) : point.logical;
    const x = resolvedLogical === undefined ? null : chart?.timeScale().logicalToCoordinate(resolvedLogical as Logical);
    const y = series?.priceToCoordinate(point.price);
    if (x === null || x === undefined || y === null || y === undefined) return null;
    return { x, y };
  }, [visibleCandles]);

  const makeDrawingPoint = useCallback((logical: number, price: number): DrawingPoint => ({
    logical,
    price,
    time: logicalToChartTime(visibleCandles, logical)
  }), [visibleCandles]);

  const resolveDrawingLogical = useCallback((point: DrawingPoint) =>
    point.time !== undefined ? chartTimeToLogical(visibleCandles, point.time) ?? point.logical : point.logical,
  [visibleCandles]);

  const moveDrawingPoint = useCallback((point: DrawingPoint, logicalDelta: number, priceDelta: number): DrawingPoint =>
    makeDrawingPoint(resolveDrawingLogical(point) + logicalDelta, point.price + priceDelta), [makeDrawingPoint, resolveDrawingLogical]);

  const addMissingDrawingTimes = useCallback((drawing: DrawingShape): DrawingShape => {
    const withTime = (point: DrawingPoint): DrawingPoint =>
      point.time !== undefined ? point : { ...point, time: logicalToChartTime(visibleCandles, point.logical) };
    return {
      ...drawing,
      start: withTime(drawing.start),
      end: withTime(drawing.end),
      points: drawing.points?.map(withTime)
    };
  }, [visibleCandles]);

  const preserveDrawingTimes = useCallback(() => {
    setDrawings((current) => current.map(addMissingDrawingTimes));
    setDrawingDraft((current) => current ? addMissingDrawingTimes(current) : current);
    drawingDraftRef.current = drawingDraftRef.current ? addMissingDrawingTimes(drawingDraftRef.current) : null;
    setZigZagDraftPoints((current) => current.map((point) =>
      point.time !== undefined ? point : { ...point, time: logicalToChartTime(visibleCandles, point.logical) }
    ));
  }, [addMissingDrawingTimes, visibleCandles]);

  const projectedDrawings = useMemo(() => {
    void chartViewVersion;
    const chartWidth = chartElement.current?.clientWidth ?? 0;
    const drawingPaneWidth = Math.max(0, chartWidth - rightPriceScaleOffset);
    const zigZagDraft =
      zigZagDraftPoints.length >= 2
        ? {
            id: "ZIGZAG-DRAFT",
            tool: "zigzag" as const,
            start: zigZagDraftPoints[0],
            end: zigZagDraftPoints.at(-1) ?? zigZagDraftPoints[0],
            points: zigZagDraftPoints,
            strokeColor: defaultDrawingStrokeColor,
            fillColor: defaultDrawingFillColor,
            lineWidth: chartTheme.drawingSize,
            borderWidth: chartTheme.drawingSize
          }
        : null;
    return [...drawings, ...(drawingDraft ? [drawingDraft] : []), ...(zigZagDraft ? [zigZagDraft] : [])]
      .map((drawing) => {
        const points = drawing.points
          ?.map((point) => drawingPointToScreen(point))
          .filter(Boolean) as Array<{ x: number; y: number }> | undefined;
        const start = drawingPointToScreen(drawing.start);
        const end = drawingPointToScreen(drawing.end);
        if (!start || !end) return undefined;
        if (drawing.tool === "zigzag") return { drawing, start, end, points };
        if (drawing.tool === "horizontal") {
          return {
            drawing,
            start: { x: 0, y: start.y },
            end: { x: drawingPaneWidth, y: start.y }
          };
        }
        if (drawing.tool === "ray") {
          const dx = end.x - start.x;
          const dy = end.y - start.y;
          const rayEndX = drawingPaneWidth;
          const rayEndY = dx === 0 ? end.y : start.y + (dy / dx) * (rayEndX - start.x);
          return { drawing, start, end: { x: rayEndX, y: rayEndY } };
        }
        return { drawing, start, end };
      })
      .filter(Boolean) as Array<{ drawing: DrawingShape; start: { x: number; y: number }; end: { x: number; y: number }; points?: Array<{ x: number; y: number }> }>;
  }, [chartTheme.drawingSize, chartViewVersion, drawingDraft, drawingPointToScreen, drawings, zigZagDraftPoints]);

  const scheduleOverlayRefresh = useCallback((withFollowUp = false, immediate = false) => {
    window.cancelAnimationFrame(overlayRefreshFrameRef.current);
    if (withFollowUp) window.cancelAnimationFrame(overlayRefreshFollowUpFrameRef.current);
    if (immediate) {
      queueMicrotask(() => setChartViewVersion((version) => version + 1));
      if (withFollowUp) {
        overlayRefreshFollowUpFrameRef.current = window.requestAnimationFrame(() => {
          setChartViewVersion((version) => version + 1);
        });
      }
      return;
    }
    overlayRefreshFrameRef.current = window.requestAnimationFrame(() => {
      setChartViewVersion((version) => version + 1);
      if (withFollowUp) {
        overlayRefreshFollowUpFrameRef.current = window.requestAnimationFrame(() => {
          setChartViewVersion((version) => version + 1);
        });
      }
    });
  }, []);

  useEffect(() => {
    ordersRef.current = orders;
  }, [orders]);

  useEffect(() => {
    hasChartOverlaysRef.current = drawings.length > 0 || openOrders.length > 0;
  }, [drawings.length, openOrders.length]);

  useEffect(() => {
    return () => {
      window.cancelAnimationFrame(overlayRefreshFrameRef.current);
      window.cancelAnimationFrame(overlayRefreshFollowUpFrameRef.current);
      window.cancelAnimationFrame(drawingDragFrameRef.current);
      window.cancelAnimationFrame(orderDragFrameRef.current);
      Object.values(storageWriteTimersRef.current).forEach((timer) => window.clearTimeout(timer));
    };
  }, []);

  const scheduleStorageWrite = useCallback((key: string, value: unknown) => {
    window.clearTimeout(storageWriteTimersRef.current[key]);
    storageWriteTimersRef.current[key] = window.setTimeout(() => {
      window.localStorage.setItem(key, JSON.stringify(value));
      delete storageWriteTimersRef.current[key];
    }, 180);
  }, []);

  const applyPendingOrderMove = useCallback((pending: PendingOrderMove) => {
    blockedProtectionDragRef.current = false;
    setOrders((current) =>
      current.map((order) =>
        order.id === pending.target.orderId && (order.status === "pending" || order.status === "active")
          ? {
              ...(pending.target.field === "entry"
                ? normalizeProtectionAfterEntryMove(order, Number(pending.price.toFixed(4)))
                : (() => {
                    const docked = isProtectionDockedAtEntry(order, pending.price);
                    const invalidChipMove =
                      pending.fromChip && !docked && !isProtectionPriceValid(order, pending.target.field, pending.price);
                    if (invalidChipMove) {
                      blockedProtectionDragRef.current = true;
                    }
                    return {
                      ...order,
                      [pending.target.field]: docked
                        ? undefined
                        : invalidChipMove
                          ? order[pending.target.field]
                          : Number(clampProtectionPrice(order, pending.target.field, pending.price).toFixed(4))
                    };
                  })())
            }
          : order
      )
    );
  }, []);

  useEffect(() => {
    scheduleStorageWrite(drawingsStorageKey, drawings);
  }, [drawings, scheduleStorageWrite]);

  useEffect(() => {
    scheduleStorageWrite(chartThemeStorageKey, chartTheme);
  }, [chartTheme, scheduleStorageWrite]);

  useEffect(() => {
    scheduleStorageWrite(appOptionsStorageKey, {
      language,
      autoScalePrice,
      autoFocusChart
    });
  }, [autoFocusChart, autoScalePrice, language, scheduleStorageWrite]);

  useEffect(() => {
    scheduleStorageWrite(exchangeOptionsStorageKey, {
      exchange: phemexSettings.exchange,
      testnet: phemexSettings.testnet,
      symbol: phemexSettings.symbol,
      pollSeconds: phemexSettings.pollSeconds,
      resolution: phemexSettings.resolution,
      limit: phemexSettings.limit,
      mode: phemexSettings.mode,
      liveOrdersEnabled: phemexSettings.liveOrdersEnabled,
      allowMainnetOrders: phemexSettings.allowMainnetOrders,
      marginMode: phemexSettings.marginMode,
      leverage: phemexSettings.leverage
    });
  }, [
    phemexSettings.exchange,
    phemexSettings.limit,
    phemexSettings.mode,
    phemexSettings.liveOrdersEnabled,
    phemexSettings.allowMainnetOrders,
    phemexSettings.marginMode,
    phemexSettings.leverage,
    phemexSettings.pollSeconds,
    phemexSettings.resolution,
    phemexSettings.symbol,
    phemexSettings.testnet,
    scheduleStorageWrite
  ]);

  useEffect(() => {
    scheduleStorageWrite(coinFavoritesStorageKey, coinFavorites);
  }, [coinFavorites, scheduleStorageWrite]);

  useEffect(() => {
    fetch("/api/coin-list")
      .then((response) => response.ok ? response.json() : undefined)
      .then((result) => {
        if (Array.isArray(result?.symbols) && result.symbols.length) {
          setCoinOptions(result.symbols);
        }
      })
      .catch(() => undefined);
  }, []);

  useEffect(() => {
    const requestedExchange = storedExchangeOptions.exchange === "binance" || storedExchangeOptions.exchange === "phemex"
      ? storedExchangeOptions.exchange
      : undefined;
    const settingsUrl = requestedExchange
      ? `/api/phemex-settings?exchange=${encodeURIComponent(requestedExchange)}`
      : "/api/phemex-settings";

    fetch(settingsUrl)
      .then((response) => response.ok ? response.json() : undefined)
      .then((settings) => {
        if (!settings) return;
        const settingsExchange = settings.exchange === "binance" ? "binance" : "phemex";
        const activeExchange = requestedExchange || settingsExchange;
        const credentialsBelongToActiveExchange = settingsExchange === activeExchange;
        const mergeSettings = (current: PhemexSettings) => ({
          ...current,
          exchange: activeExchange,
          apiKey: credentialsBelongToActiveExchange ? settings.apiKey || "" : "",
          apiSecret: credentialsBelongToActiveExchange && settings.hasSecret ? "********" : "",
          testnet: storedExchangeOptions.testnet !== undefined ? current.testnet : settings.testnet !== false,
          symbol: storedExchangeOptions.symbol ? current.symbol : settings.symbol || "SOLUSDT",
          pollSeconds: storedExchangeOptions.pollSeconds ? current.pollSeconds : settings.pollSeconds || "10",
          resolution: storedExchangeOptions.resolution ? current.resolution : settings.resolution || "300",
          limit: storedExchangeOptions.limit ? current.limit : settings.limit || "500",
          mode: storedExchangeOptions.mode ? current.mode : settings.mode === "live" ? "live" : "replay",
          liveOrdersEnabled: current.liveOrdersEnabled,
          allowMainnetOrders: storedExchangeOptions.allowMainnetOrders !== undefined ? current.allowMainnetOrders : Boolean(settings.allowMainnetOrders),
          marginMode: current.marginMode,
          leverage: current.leverage
        });
        setPhemexSettings(mergeSettings);
        setActivePhemexSettings(mergeSettings);
      })
      .catch(() => undefined);
  }, [storedExchangeOptions]);

  useEffect(() => {
    const pendingOrders = orders.filter((order) => order.status === "pending" && !order.phemexOrderId && !order.phemexClOrdId);
    scheduleStorageWrite(pendingOrdersStorageKey, pendingOrders);
  }, [orders, scheduleStorageWrite]);

  useEffect(() => {
    if (!chartElement.current) return;

    const chart = createChart(chartElement.current, {
      layout: { background: { color: defaultTheme.backgroundColor }, textColor: defaultTheme.textColor },
      grid: { vertLines: { color: defaultTheme.gridColor }, horzLines: { color: defaultTheme.gridColor } },
      crosshair: { mode: CrosshairMode.Normal },
      handleScale: {
        axisPressedMouseMove: {
          price: true,
          time: true
        },
        mouseWheel: true,
        pinch: true
      },
      handleScroll: {
        horzTouchDrag: true,
        mouseWheel: true,
        pressedMouseMove: true,
        vertTouchDrag: true
      },
      rightPriceScale: {
        autoScale: false,
        borderColor: "#2d3748"
      },
      timeScale: { borderColor: "#2d3748", timeVisible: true },
      width: chartElement.current.clientWidth,
      height: chartElement.current.clientHeight
    });

    const candleSeries = chart.addSeries(CandlestickSeries, {
      upColor: defaultTheme.upColor,
      downColor: defaultTheme.downColor,
      borderUpColor: defaultTheme.upColor,
      borderDownColor: defaultTheme.downColor,
      wickUpColor: defaultTheme.upColor,
      wickDownColor: defaultTheme.downColor
    });

    chartRef.current = chart;
    candleSeriesRef.current = candleSeries;

    const observer = new ResizeObserver(() => {
      if (chartElement.current) {
        chart.resize(chartElement.current.clientWidth, chartElement.current.clientHeight);
        scheduleOverlayRefresh(true);
      }
    });
    observer.observe(chartElement.current);
    const handleVisibleRangeChange = () => {
      scheduleOverlayRefresh(false, true);
    };
    chart.timeScale().subscribeVisibleLogicalRangeChange(handleVisibleRangeChange);

    return () => {
      observer.disconnect();
      chart.timeScale().unsubscribeVisibleLogicalRangeChange(handleVisibleRangeChange);
      lineSeriesRef.current.clear();
      chart.remove();
    };
  }, [scheduleOverlayRefresh]);

  useEffect(() => {
    chartRef.current?.applyOptions({
      layout: {
        background: { color: chartTheme.backgroundColor },
        textColor: chartTheme.textColor
      },
      grid: {
        vertLines: { color: chartTheme.gridColor, visible: chartTheme.showGrid },
        horzLines: { color: chartTheme.gridColor, visible: chartTheme.showGrid }
      },
      crosshair: {
        mode: chartTheme.showCrosshair ? CrosshairMode.Normal : CrosshairMode.Hidden
      },
      handleScale: {
        axisPressedMouseMove: {
          price: chartTheme.allowDrag,
          time: chartTheme.allowDrag
        },
        mouseWheel: chartTheme.allowMouseWheel,
        pinch: chartTheme.allowMouseWheel
      },
      handleScroll: {
        horzTouchDrag: chartTheme.allowDrag,
        mouseWheel: chartTheme.allowMouseWheel,
        pressedMouseMove: chartTheme.allowDrag,
        vertTouchDrag: chartTheme.allowDrag
      }
    });

    candleSeriesRef.current?.applyOptions({
      upColor: chartTheme.upColor,
      downColor: chartTheme.downColor,
      borderUpColor: chartTheme.upBorderColor,
      borderDownColor: chartTheme.downBorderColor,
      wickUpColor: chartTheme.upWickColor,
      wickDownColor: chartTheme.downWickColor,
      priceLineVisible: chartTheme.showLastPriceLine
    });
  }, [chartTheme]);

  useEffect(() => {
    fetch("/chart_data/1-12_2023_5m_SOLUSDT.csv")
      .then((response) => {
        if (!response.ok) throw new Error("CSV nicht gefunden");
        return response.text();
      })
      .then((text) => {
        const candles = parseCsvTextCandles(text);
        if (!candles.length) {
          setMessage(t.chartCsvInvalid);
          setMessageKind("custom");
          return;
        }
        setAllCandles(candles);
        setVisibleCount(Math.min(60, candles.length));
        shouldFitContentRef.current = true;
        shouldFitPriceRef.current = true;
        setIsPlaying(false);
        setMessage(t.chartCsvLoaded(candles.length));
        setMessageKind("chartCsv");
      })
      .catch(() => {
        setMessage(t.demoLoaded);
        setMessageKind("demo");
      });
  }, []);

  useEffect(() => {
    if (messageKind === "demo") {
      setMessage(t.demoLoaded);
    }
    if (messageKind === "chartCsv") {
      setMessage(t.chartCsvLoaded(allCandles.length));
    }
  }, [allCandles.length, messageKind, t]);

  useEffect(() => {
    const candleSeries = candleSeriesRef.current;
    const chart = chartRef.current;
    const candleSetChanged = previousCandleSetRef.current !== allCandles;
    const previousCandles = previousCandleSetRef.current;
    const canAppendSingleCandle = !candleSetChanged && visibleCount === previousVisibleCountRef.current + 1;
    const canUpdateLastLiveCandle =
      candleSetChanged &&
      previousCandles !== null &&
      previousCandles.length === allCandles.length &&
      visibleCount === previousVisibleCountRef.current &&
      previousCandles.at(-1)?.time === allCandles.at(-1)?.time;
    const keepManualRange = !autoFocusChart && !shouldFitContentRef.current;
    const visibleRange = keepManualRange ? chart?.timeScale().getVisibleLogicalRange() : null;

    if (candleSeries) {
      if (canAppendSingleCandle && autoFocusChart) {
        const nextCandle = allCandles[visibleCount - 1];
        if (nextCandle) candleSeries.update(nextCandle);
      } else if (canUpdateLastLiveCandle) {
        const nextCandle = allCandles.at(-1);
        if (nextCandle) candleSeries.update(nextCandle);
      } else if (candleSetChanged || visibleCount !== previousVisibleCountRef.current) {
        candleSeries.setData(visibleCandles);
      }
      previousCandleSetRef.current = allCandles;
      previousVisibleCountRef.current = visibleCount;
    }

    if (visibleRange && keepManualRange) {
      chart?.timeScale().setVisibleLogicalRange(visibleRange);
      window.requestAnimationFrame(() => {
        chart?.timeScale().setVisibleLogicalRange(visibleRange);
      });
    }

    if (shouldJumpToLatestRef.current) {
      const lastLogical = Math.max(0, visibleCandles.length - 1);
      chartRef.current?.timeScale().setVisibleLogicalRange({
        from: Math.max(0, lastLogical - 60) as Logical,
        to: (lastLogical + 4) as Logical
      });
      shouldJumpToLatestRef.current = false;
      shouldFitContentRef.current = false;
      if (shouldFitPriceRef.current) {
        chartRef.current?.priceScale("right").setAutoScale(true);
        window.requestAnimationFrame(() => {
          chartRef.current?.priceScale("right").setAutoScale(autoScalePrice);
        });
        shouldFitPriceRef.current = false;
      }
    } else if (autoFocusChart || shouldFitContentRef.current) {
      chartRef.current?.timeScale().fitContent();
      if (shouldFitPriceRef.current) {
        chartRef.current?.priceScale("right").setAutoScale(true);
        window.requestAnimationFrame(() => {
          chartRef.current?.priceScale("right").setAutoScale(autoScalePrice);
        });
        shouldFitPriceRef.current = false;
      } else {
        chartRef.current?.priceScale("right").setAutoScale(autoScalePrice);
      }
      shouldFitContentRef.current = false;
    }
  }, [autoFocusChart, autoScalePrice, visibleCandles]);

  useEffect(() => {
    chartRef.current?.priceScale("right").setAutoScale(autoScalePrice);
  }, [autoScalePrice]);

  useEffect(() => {
    const chart = chartRef.current;
    if (!chart || !visibleCandles.length) return;

    const activeKeys = new Set<string>();
    const start = visibleCandles[0].time;
    const end = visibleCandles.at(-1)?.time ?? start;

    const upsertLine = (
      order: TradeOrder,
      field: OrderLineField,
      price: number,
      color: string,
      style = LineStyle.Solid
    ) => {
      const key = `${order.id}-${field}`;
      activeKeys.add(key);
      let series = lineSeriesRef.current.get(key);
      if (!series) {
        series = chart.addSeries(LineSeries, {
          color,
          lineWidth: 2,
          lineStyle: style,
          priceLineVisible: false,
          title: ""
        });
        lineSeriesRef.current.set(key, series);
      } else {
        series.applyOptions({ color, lineStyle: style, lineWidth: 2 });
      }
      series.setData([
        { time: start, value: price },
        { time: end, value: price }
      ]);
    };

    openOrders.forEach((order) => {
      const entryColor = order.status === "active" ? "#facc15" : order.side === "buy" ? "#38bdf8" : "#fb923c";
      upsertLine(order, "entry", order.entry, entryColor, order.status === "active" ? LineStyle.LargeDashed : LineStyle.Solid);
      if (order.takeProfit !== undefined) upsertLine(order, "takeProfit", order.takeProfit, "#2fbf71", LineStyle.Dashed);
      if (order.stopLoss !== undefined) upsertLine(order, "stopLoss", order.stopLoss, "#e05252", LineStyle.Dashed);
    });

    lineSeriesRef.current.forEach((series, key) => {
      if (activeKeys.has(key)) return;
      chart.removeSeries(series);
      lineSeriesRef.current.delete(key);
    });
  }, [chartViewVersion, openOrders, visibleCandles]);

  useEffect(() => {
    const updateLineControls = () => {
      const series = candleSeriesRef.current;
      if (!series) return;
      const chartWidth = chartElement.current?.clientWidth ?? 0;
      const chartHeight = chartElement.current?.clientHeight ?? 0;
      const isVisibleY = (value: number) => value >= 0 && value <= chartHeight;
      const controls = openOrders
        .filter((order) => order.status === "pending" && (order.takeProfit === undefined || order.stopLoss === undefined))
        .map((order) => {
          const y = series.priceToCoordinate(order.entry);
          if (y === null || !isVisibleY(y)) return undefined;
          const orderIndex = allCandles.findIndex((candle) => candle.time === order.openedAt);
          const logical = (orderIndex >= 0 ? orderIndex : visibleCandles.length - 1) as Logical;
          const coordinate = chartRef.current?.timeScale().logicalToCoordinate(logical);
          const x = coordinate === null || coordinate === undefined ? chartWidth * 0.58 : coordinate;
          const paneWidth = Math.max(0, chartWidth - rightPriceScaleOffset);
          const controlWidth = 286;
          const controlsX = Math.max(12, paneWidth - controlWidth + 66);
          return { order, y, x, controlsX };
        })
        .filter(Boolean) as Array<{ order: TradeOrder; y: number; x: number; controlsX: number }>;
      setLineControls(controls);

      const labels = openOrders.flatMap((order) => {
        const rows: Array<{ order: TradeOrder; field: DraggableOrderField; y: number; price: number; x?: number }> = [];
        const candidates: Array<[DraggableOrderField, number | undefined]> = [
          ["entry", order.entry],
          ["takeProfit", order.takeProfit],
          ["stopLoss", order.stopLoss]
        ];
        candidates.forEach(([field, price]) => {
          if (price === undefined) return;
          const y = series.priceToCoordinate(price);
          if (y !== null && isVisibleY(y)) {
            const matchingControl = controls.find((control) => control.order.id === order.id);
            const labelX =
              field === "entry" && matchingControl
                ? Math.max(8, matchingControl.controlsX - 104)
                : undefined;
            rows.push({ order, field, y, price, x: labelX });
          }
        });
        return rows;
      });
      setOrderLineLabels(labels);
    };

    updateLineControls();
    const frame = window.requestAnimationFrame(updateLineControls);
    return () => window.cancelAnimationFrame(frame);
  }, [allCandles, chartTheme.orderControlsSide, chartViewVersion, openOrders, visibleCandles]);

  useEffect(() => {
    if (!isPlaying) return;
    if (visibleCount >= allCandles.length) {
      setIsPlaying(false);
      return;
    }

    const timer = window.setTimeout(() => stepForward(), speedMs);
    return () => window.clearTimeout(timer);
  }, [isPlaying, visibleCount, allCandles.length, speedMs]);

  useEffect(() => {
    const handleMouseMove = (event: MouseEvent) => {
      const drag = draggedDrawingRef.current;
      const chartNode = chartElement.current;
      if (!drag || !chartNode) return;
      const rect = chartNode.getBoundingClientRect();
      const point = screenToDrawingPoint(event.clientX - rect.left, event.clientY - rect.top, event.ctrlKey);
      if (!point) return;
      const logicalDelta = point.logical - drag.startPoint.logical;
      const priceDelta = point.price - drag.startPoint.price;
      pendingDrawingMoveRef.current = { drag, point, logicalDelta, priceDelta };
      if (drawingDragFrameRef.current) return;
      drawingDragFrameRef.current = window.requestAnimationFrame(() => {
        drawingDragFrameRef.current = 0;
        const pending = pendingDrawingMoveRef.current;
        if (!pending) return;
        pendingDrawingMoveRef.current = null;
        setDrawings((current) =>
          current.map((drawing) => {
            if (drawing.id !== pending.drag.id) return drawing;
            if (drawing.locked) return drawing;
            if (drawing.tool === "zigzag" && pending.drag.pointIndex !== undefined) {
              const points = drawing.points?.map((existingPoint, index) =>
                index === pending.drag.pointIndex ? pending.point : existingPoint
              );
              if (!points?.length) return drawing;
              return {
                ...drawing,
                points,
                start: points[0],
                end: points.at(-1) ?? points[0]
              };
            }
            if (drawing.tool === "rect") {
              if (pending.drag.handle === "topLeft") return { ...drawing, start: pending.point };
              if (pending.drag.handle === "bottomRight") return { ...drawing, end: pending.point };
              if (pending.drag.handle === "topRight") {
                return {
                  ...drawing,
                  start: { ...drawing.start, price: pending.point.price },
                  end: makeDrawingPoint(pending.point.logical, drawing.end.price)
                };
              }
              if (pending.drag.handle === "bottomLeft") {
                return {
                  ...drawing,
                  start: makeDrawingPoint(pending.point.logical, drawing.start.price),
                  end: { ...drawing.end, price: pending.point.price }
                };
              }
            }
            if (pending.drag.handle === "start") {
              if (drawing.tool === "ray" || drawing.tool === "horizontal") {
                return {
                  ...drawing,
                  start: pending.point,
                  end: { ...drawing.end, price: pending.point.price }
                };
              }
              return { ...drawing, start: pending.point };
            }
            if (pending.drag.handle === "end") {
              if (drawing.tool === "ray" || drawing.tool === "horizontal") {
                return {
                  ...drawing,
                  end: makeDrawingPoint(pending.point.logical, drawing.start.price)
                };
              }
              return { ...drawing, end: pending.point };
            }
            return {
              ...pending.drag.original,
              start: moveDrawingPoint(pending.drag.original.start, pending.logicalDelta, pending.priceDelta),
              end: moveDrawingPoint(pending.drag.original.end, pending.logicalDelta, pending.priceDelta),
              points: pending.drag.original.points?.map((point) => moveDrawingPoint(point, pending.logicalDelta, pending.priceDelta))
            };
          })
        );
      });
    };

    const handleMouseUp = (event: MouseEvent) => {
      draggedDrawingRef.current = null;
    };

    const handleKeyDown = (event: KeyboardEvent) => {
      if ((event.key !== "Delete" && event.key !== "Backspace") || !selectedDrawingId) return;
      const selectedDrawing = drawings.find((drawing) => drawing.id === selectedDrawingId);
      if (selectedDrawing?.locked) return;
      setDrawings((current) => current.filter((drawing) => drawing.id !== selectedDrawingId));
      setSelectedDrawingId(null);
      setDrawingMenu(null);
    };

    window.addEventListener("mousemove", handleMouseMove);
    window.addEventListener("mouseup", handleMouseUp);
    window.addEventListener("keydown", handleKeyDown);
    return () => {
      window.removeEventListener("mousemove", handleMouseMove);
      window.removeEventListener("mouseup", handleMouseUp);
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [drawings, screenToDrawingPoint, selectedDrawingId]);

  useEffect(() => {
    const chartNode = chartElement.current;
    if (!chartNode) return;

    const findOrderLineAt = (mouseY: number): DraggedOrderLine | null => {
      const series = candleSeriesRef.current;
      if (!series) return null;
      const threshold = 8;

      for (const order of ordersRef.current) {
        if (order.status !== "pending" && order.status !== "active") continue;
        const candidates: Array<[DraggableOrderField, number | undefined]> = [
          ["takeProfit", order.takeProfit],
          ["stopLoss", order.stopLoss]
        ];
        if (order.status === "pending") {
          candidates.unshift(["entry", order.entry]);
        }

        for (const [field, price] of candidates) {
          if (price === undefined) continue;
          const lineY = series.priceToCoordinate(price);
          if (lineY === null) continue;
          if (Math.abs(lineY - mouseY) <= threshold) {
            return { orderId: order.id, field };
          }
        }
      }

      return null;
    };

    const handleContextMenu = (event: MouseEvent) => {
      event.preventDefault();
      const series = candleSeriesRef.current;
      const rect = chartNode.getBoundingClientRect();
      const y = event.clientY - rect.top;
      const price = series?.coordinateToPrice(y);
      if (price === null || price === undefined) return;
      setChartMenu({
        x: event.clientX - rect.left,
        y,
        price
      });
    };

    const handleMouseDown = (event: MouseEvent) => {
      if (event.button !== 0) return;
      const rect = chartNode.getBoundingClientRect();
      const mouseY = event.clientY - rect.top;
      const line = findOrderLineAt(mouseY);
      if (!line) return;
      event.preventDefault();
      event.stopPropagation();
      draggedLineRef.current = line;
      rememberProtectionBeforeDrag(line.orderId, line.field);
      chartRef.current?.applyOptions({
        handleScale: {
          axisPressedMouseMove: {
            price: false,
            time: false
          },
          mouseWheel: chartTheme.allowMouseWheel,
          pinch: chartTheme.allowMouseWheel
        },
        handleScroll: {
          horzTouchDrag: false,
          mouseWheel: false,
          pressedMouseMove: false,
          vertTouchDrag: false
        }
      });
      chartNode.classList.add("dragging-line");
      setChartMenu(null);
    };

    const handleMouseMove = (event: MouseEvent) => {
      const rect = chartNode.getBoundingClientRect();
      const mouseY = event.clientY - rect.top;
      const mouseX = event.clientX - rect.left;
      const activeLine = draggedLineRef.current;
      const activeChip = draggedChipRef.current;
      const isPriceScaleInteraction = mouseX > rect.width - 74 && event.buttons === 1;
      const isDrawingInteraction = draggedDrawingRef.current !== null || drawingDraftRef.current !== null;

      if (hasChartOverlaysRef.current && (isPriceScaleInteraction || isDrawingInteraction || activeLine || activeChip)) {
        scheduleOverlayRefresh();
      }

      if (!activeLine && !activeChip) {
        if (hasChartOverlaysRef.current) {
          chartNode.classList.toggle("line-hover", findOrderLineAt(mouseY) !== null);
        } else {
          chartNode.classList.remove("line-hover");
        }
        return;
      }

      event.preventDefault();
      event.stopPropagation();
      const price = candleSeriesRef.current?.coordinateToPrice(mouseY);
      if (price === null || price === undefined) return;
      const target = activeLine ?? activeChip;
      if (!target) return;

      pendingOrderMoveRef.current = { target, price, fromChip: Boolean(activeChip) };
      if (orderDragFrameRef.current) return;
      orderDragFrameRef.current = window.requestAnimationFrame(() => {
        orderDragFrameRef.current = 0;
        const pending = pendingOrderMoveRef.current;
        if (!pending) return;
        pendingOrderMoveRef.current = null;
        applyPendingOrderMove(pending);
      });
    };

    const handleMouseUp = (event: MouseEvent) => {
      scheduleOverlayRefresh(true);
      if (pendingOrderMoveRef.current) {
        const pending = pendingOrderMoveRef.current;
        pendingOrderMoveRef.current = null;
        window.cancelAnimationFrame(orderDragFrameRef.current);
        orderDragFrameRef.current = 0;
        applyPendingOrderMove(pending);
      }
      if (!draggedLineRef.current && !draggedChipRef.current) return;
      const draggedField = draggedLineRef.current?.field ?? draggedChipRef.current?.field;
      const orderId = draggedLineRef.current?.orderId ?? draggedChipRef.current?.orderId;
      if (draggedChipRef.current) {
        chipDragFinishedRef.current = true;
        window.setTimeout(() => {
          chipDragFinishedRef.current = false;
        }, 0);
      }
      draggedLineRef.current = null;
      draggedChipRef.current = null;
      chartRef.current?.applyOptions({
        handleScale: {
          axisPressedMouseMove: {
            price: chartTheme.allowDrag,
            time: chartTheme.allowDrag
          },
          mouseWheel: chartTheme.allowMouseWheel,
          pinch: chartTheme.allowMouseWheel
        },
        handleScroll: {
          horzTouchDrag: chartTheme.allowDrag,
          mouseWheel: chartTheme.allowMouseWheel,
          pressedMouseMove: chartTheme.allowDrag,
          vertTouchDrag: chartTheme.allowDrag
        }
      });
      chartNode.classList.remove("dragging-line");
      chartNode.classList.remove("line-hover");
      if (orderId) {
        setMessage(t.protectionUpdated(orderId));
        if (draggedField === "entry" || draggedField === "takeProfit" || draggedField === "stopLoss") {
          const original = draggedProtectionOriginalRef.current;
          const wasBlockedProtectionDrag = blockedProtectionDragRef.current;
          blockedProtectionDragRef.current = false;
          const changedOrder = ordersRef.current.find((order) => order.id === orderId);
          const invalidProtectionMove =
            changedOrder &&
            (draggedField === "takeProfit" || draggedField === "stopLoss") &&
            changedOrder[draggedField] !== undefined &&
            !isProtectionPriceValid(changedOrder, draggedField, changedOrder[draggedField]);
          if ((wasBlockedProtectionDrag || invalidProtectionMove) && original?.orderId === orderId) {
            setOrders((current) =>
              current.map((order) =>
                order.id === orderId
                  ? {
                      ...order,
                      entry: original.entry,
                      takeProfit: original.takeProfit,
                      stopLoss: original.stopLoss
                    }
                  : order
              )
            );
          } else if (original?.orderId === orderId) {
            const rect = chartNode.getBoundingClientRect();
            setProtectionConfirm({
              orderId,
              x: Math.min(Math.max(12, event.clientX - rect.left), Math.max(12, rect.width - 260)),
              y: Math.min(Math.max(12, event.clientY - rect.top), Math.max(12, rect.height - 116)),
              originalEntry: original.entry,
              originalTakeProfit: original.takeProfit,
              originalStopLoss: original.stopLoss
            });
          }
        }
      }
      draggedProtectionOriginalRef.current = null;
    };

    const handleWheel = () => {
      scheduleOverlayRefresh(true, true);
    };

    const closeMenu = (event?: MouseEvent | KeyboardEvent) => {
      if (!(event instanceof MouseEvent)) {
        setChartMenu(null);
        setDrawingMenu(null);
        setShowChartOptions(false);
        setIsCoinDropdownOpen(false);
        setIsMarketFavoritesOpen(false);
        return;
      }

      const target = event.target instanceof Element ? event.target : null;
      if (!target?.closest(".chart-context-menu")) setChartMenu(null);
      if (!target?.closest(".drawing-context-menu")) setDrawingMenu(null);
      if (!target?.closest(".chart-style-panel, .chart-options, .topbar-button")) setShowChartOptions(false);
      if (!target?.closest(".coin-dropdown")) setIsCoinDropdownOpen(false);
      if (!target?.closest(".market-favorite-dropdown, .market-favorite-toggle")) setIsMarketFavoritesOpen(false);
    };

    chartNode.addEventListener("contextmenu", handleContextMenu);
    chartNode.addEventListener("mousedown", handleMouseDown);
    chartNode.addEventListener("mousemove", handleMouseMove);
    chartNode.addEventListener("wheel", handleWheel);
    window.addEventListener("mouseup", handleMouseUp);
    window.addEventListener("click", closeMenu);
    window.addEventListener("keydown", closeMenu);

    return () => {
      chartNode.removeEventListener("contextmenu", handleContextMenu);
      chartNode.removeEventListener("mousedown", handleMouseDown);
      chartNode.removeEventListener("mousemove", handleMouseMove);
      chartNode.removeEventListener("wheel", handleWheel);
      window.removeEventListener("mouseup", handleMouseUp);
      window.removeEventListener("click", closeMenu);
      window.removeEventListener("keydown", closeMenu);
    };
  }, [applyPendingOrderMove, scheduleOverlayRefresh, t]);

  const evaluateOrders = useCallback((candle: Candle) => {
    setOrders((current) =>
      current.map((order) => {
        if (order.status !== "pending" && order.status !== "active") return order;

        if (order.status === "pending") {
          const hitEntry = order.side === "buy" ? candle.low <= order.entry : candle.high >= order.entry;
          if (!hitEntry) return order;
          return {
            ...order,
            status: "active"
          };
        }

        const hitTp =
          order.takeProfit !== undefined &&
          (order.side === "buy" ? candle.high >= order.takeProfit : candle.low <= order.takeProfit);
        const hitSl =
          order.stopLoss !== undefined &&
          (order.side === "buy" ? candle.low <= order.stopLoss : candle.high >= order.stopLoss);

        if (!hitTp && !hitSl) return order;

        const result = hitSl ? "SL" : "TP";
        const closePrice = result === "TP" ? order.takeProfit : order.stopLoss;
        return {
          ...order,
          status: "closed",
          closedAt: candle.time,
          closePrice,
          result
        };
      })
    );
  }, []);

  const stepForward = useCallback(() => {
    setVisibleCount((count) => {
      const next = Math.min(count + 1, allCandles.length);
      const nextCandle = allCandles[next - 1];
      if (nextCandle) evaluateOrders(nextCandle);
      return next;
    });
  }, [allCandles, evaluateOrders]);

  const createOrder = (
    orderSide: Side,
    orderEntry: number,
    options?: { keepInputs?: boolean; externalId?: string; phemexOrderId?: string; phemexClOrdId?: string }
  ) => {
    if (!lastCandle) return;
    if (!options?.externalId && ordersRef.current.some((order) => order.status === "pending" || order.status === "active")) {
      const text = `Für ${activePhemexSettings.symbol} ist bereits eine offene Order vorhanden. Bitte erst Cancel oder Schließen verwenden.`;
      setMessage(text);
      setMessageKind("custom");
      return;
    }
    const parsedTp = takeProfit ? Number(takeProfit) : undefined;
    const parsedSl = stopLoss ? Number(stopLoss) : undefined;

    if (!Number.isFinite(orderEntry) || !Number.isFinite(quantity) || quantity <= 0) {
      setMessage(t.orderNeedsInput);
      return;
    }

    const nextNumber = orders.length + 1;
    const order: TradeOrder = {
      id: options?.externalId || `ORD-${String(nextNumber).padStart(4, "0")}`,
      phemexOrderId: options?.phemexOrderId,
      phemexClOrdId: options?.phemexClOrdId,
      side: orderSide,
      quantity,
      entry: orderEntry,
      takeProfit: Number.isFinite(parsedTp) ? parsedTp : undefined,
      stopLoss: Number.isFinite(parsedSl) ? parsedSl : undefined,
      status: "pending",
      openedAt: lastCandle.time
    };

    setOrders((current) => [order, ...current]);
    if (!options?.keepInputs) {
      setEntry("");
      setTakeProfit("");
      setStopLoss("");
    }
    setChartMenu(null);
    setMessage(t.orderPlaced(order.id, orderSide, formatPrice(orderEntry)));
  };

  const useLiveLastPrice = () => {
    const price = liveLastPrice ?? lastCandle?.close;
    if (price === undefined) return;
    setEntry(price.toFixed(2));
    setMessage(t.priceUsed(formatPrice(price)));
  };

  const toggleCoinFavorite = (symbol: string) => {
    setCoinFavorites((current) =>
      current.includes(symbol)
        ? current.filter((favorite) => favorite !== symbol)
        : [symbol, ...current]
    );
  };

  const rememberProtectionBeforeDrag = (orderId: string, field: DraggableOrderField) => {
    if (field !== "entry" && field !== "takeProfit" && field !== "stopLoss") return;
    const order = ordersRef.current.find((item) => item.id === orderId);
    if (!order) return;
    draggedProtectionOriginalRef.current = {
      orderId,
      entry: order.entry,
      takeProfit: order.takeProfit,
      stopLoss: order.stopLoss
    };
  };

  const updateLiveCapitalPercent = (percent: number) => {
    const nextPercent = Math.max(0, percent);
    setLiveCapitalPercent(nextPercent);
    const price = liveOrderPrice;
    if (nextPercent <= 0) {
      setQuantity(0);
      return;
    }
    if (!futuresBalance || !Number.isFinite(price) || !price) {
      setQuantity(0);
      return;
    }
    const margin = futuresBalance * (nextPercent / 100);
    const notional = margin * leverageValue;
    const calculatedQuantity = notional / Number(price);
    setQuantity(Number(calculatedQuantity.toFixed(4)));
  };

  const showExchangeDebug = (title: string, text: string, details?: unknown) => {
    const detailText =
      typeof details === "string"
        ? details
        : details
          ? JSON.stringify(details, null, 2)
          : undefined;
    setExchangeDebugPopup({ title, message: text, details: detailText });
    setMessage(text);
    setMessageKind("custom");
  };

  const submitOrder = async (forcedSide?: Side) => {
    if (!lastCandle) return;
    const orderSide = forcedSide ?? side;
    const parsedEntry = entry ? Number(entry) : lastCandle.close;
    const existingOpenOrder = ordersRef.current.find((order) => order.status === "pending" || order.status === "active");
    if (existingOpenOrder) {
      const text = `Für ${activePhemexSettings.symbol} ist bereits eine offene Order vorhanden. Bitte erst Cancel oder Schließen verwenden.`;
      showExchangeDebug("Eine Order pro Asset", text, {
        symbol: activePhemexSettings.symbol,
        existingOrderId: existingOpenOrder.id,
        existingStatus: existingOpenOrder.status
      });
      return;
    }
    if (isLiveRunning) {
      const parsedTp = takeProfit ? Number(takeProfit) : undefined;
      const parsedSl = stopLoss ? Number(stopLoss) : undefined;
      setExchangeRequestState("loading");
      try {
        const response = await fetch("/api/phemex-order", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            symbol: activePhemexSettings.symbol,
            side: orderSide,
            quantity,
            price: parsedEntry,
            takeProfit: Number.isFinite(parsedTp) ? parsedTp : undefined,
            stopLoss: Number.isFinite(parsedSl) ? parsedSl : undefined,
            exchange: activePhemexSettings.exchange,
            testnet: activePhemexSettings.testnet
          })
        });
        const result = await response.json();
        if (!response.ok || !result.ok) throw new Error(result.message || "Phemex order failed");
        createOrder(orderSide, parsedEntry, {
          externalId: result.orderID || result.clOrdID,
          phemexOrderId: result.orderID,
          phemexClOrdId: result.clOrdID
        });
        setMessage(t.phemexOrderPlaced(result.orderID || result.clOrdID || "OK"));
        setMessageKind("custom");
        setExchangeRequestState("idle");
        return;
      } catch (error) {
        const reason = error instanceof Error ? error.message : undefined;
        showExchangeDebug("Phemex Order", t.phemexOrderFailed(reason), {
          reason,
          symbol: activePhemexSettings.symbol,
          side: orderSide,
          quantity,
          price: parsedEntry,
          testnet: activePhemexSettings.testnet
        });
        setExchangeRequestState("error");
        return;
      }
    }
    createOrder(orderSide, parsedEntry);
  };

  const cancelOrder = async (orderId: string) => {
    const order = ordersRef.current.find((item) => item.id === orderId);
    if (!order) return;
    const exchangeOrderId = order.phemexOrderId || (phemexOrderIdPattern.test(order.id) ? order.id : undefined);
    if (isLiveRunning && (exchangeOrderId || order.phemexClOrdId)) {
      setExchangeRequestState("loading");
      try {
        const response = await fetch("/api/phemex-cancel-order", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            symbol: activePhemexSettings.symbol,
            orderID: exchangeOrderId,
            clOrdID: order.phemexClOrdId,
            exchange: activePhemexSettings.exchange,
            testnet: activePhemexSettings.testnet
          })
        });
        const result = await response.json();
        if (!response.ok || !result.ok) throw new Error(result.message || "Phemex cancel failed");
        [order.id, exchangeOrderId, order.phemexOrderId, order.phemexClOrdId, result.orderID, result.clOrdID]
          .filter(Boolean)
          .forEach((key) => canceledPhemexOrderKeysRef.current.add(String(key)));
        setOrders((current) =>
          order.status === "pending"
            ? current.filter((item) => item.id !== orderId)
            : current.map((item) =>
                item.id === orderId
                  ? { ...item, status: "closed" as OrderStatus, closedAt: lastCandle?.time, result: "CANCEL" as const, closePrice: lastCandle?.close }
                  : item
              )
        );
        setMessage(t.phemexOrderCanceled(orderId));
        setMessageKind("custom");
        setExchangeRequestState("idle");
        window.setTimeout(() => {
          syncPhemexOpenOrders(activePhemexSettings).catch(() => undefined);
        }, 2500);
        return;
      } catch (error) {
        const reason = error instanceof Error ? error.message : undefined;
        showExchangeDebug("Phemex Cancel", t.phemexOrderCancelFailed(reason), {
          reason,
          symbol: activePhemexSettings.symbol,
          orderID: exchangeOrderId,
          clOrdID: order.phemexClOrdId,
          testnet: activePhemexSettings.testnet
        });
        setExchangeRequestState("error");
        return;
      }
    }
    setOrders((current) =>
      order.status === "pending"
        ? current.filter((item) => item.id !== orderId)
        : current.map((item) =>
            item.id === orderId && item.status === "active"
              ? { ...item, status: "closed" as OrderStatus, closedAt: lastCandle?.time, result: "CANCEL" as const, closePrice: lastCandle?.close }
              : item
          )
    );
    setMessage(t.orderCanceled(orderId));
  };

  const closeActiveOrder = (orderId: string) => {
    const order = ordersRef.current.find((item) => item.id === orderId);
    if (!order) return;
    if (isLiveRunning && (order.phemexOrderId || order.phemexClOrdId)) {
      setMessage("Aktive Position lokal geschlossen. Phemex Positions-Close folgt als eigener Schritt.");
      setMessageKind("custom");
    }
    setOrders((current) =>
      current.map((item) =>
        item.id === orderId && item.status === "active"
          ? { ...item, status: "closed" as OrderStatus, closedAt: lastCandle?.time, result: "CANCEL" as const, closePrice: lastCandle?.close }
          : item
      )
    );
  };

  const recreatePendingPhemexOrder = async (order: TradeOrder) => {
    const exchangeOrderId = order.phemexOrderId || (phemexOrderIdPattern.test(order.id) ? order.id : undefined);
    if (!exchangeOrderId && !order.phemexClOrdId) {
      throw new Error("Keine Phemex Order-ID für Recreate vorhanden.");
    }

    const cancelResponse = await fetch("/api/phemex-cancel-order", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        symbol: activePhemexSettings.symbol,
        orderID: exchangeOrderId,
        clOrdID: order.phemexClOrdId,
        exchange: activePhemexSettings.exchange,
        testnet: activePhemexSettings.testnet
      })
    });
    const cancelResult = await cancelResponse.json();
    if (!cancelResponse.ok || !cancelResult.ok) {
      if (cancelResult.payload?.code === 10002 || cancelResult.message?.includes("OM_ORDER_NOT_FOUND")) {
        setOrders((current) =>
          current.map((item) =>
            item.id === order.id
              ? {
                  ...item,
                  status: "active" as OrderStatus
                }
              : item
          )
        );
        return { becameActive: true, cancelResult, createResult: null };
      }
      throw new Error(cancelResult.message || "Phemex cancel before recreate failed");
    }

    [order.id, exchangeOrderId, order.phemexOrderId, order.phemexClOrdId, cancelResult.orderID, cancelResult.clOrdID]
      .filter(Boolean)
      .forEach((key) => canceledPhemexOrderKeysRef.current.add(String(key)));

    const createResponse = await fetch("/api/phemex-order", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        symbol: activePhemexSettings.symbol,
        side: order.side,
        quantity: order.quantity,
        price: order.entry,
        takeProfit: order.takeProfit,
        stopLoss: order.stopLoss,
        exchange: activePhemexSettings.exchange,
        testnet: activePhemexSettings.testnet
      })
    });
    const createResult = await createResponse.json();
    if (!createResponse.ok || !createResult.ok) {
      throw new Error(createResult.message || "Phemex recreate order failed");
    }

    setOrders((current) =>
      current.map((item) =>
        item.id === order.id
          ? {
              ...item,
              id: createResult.orderID || createResult.clOrdID || item.id,
              phemexOrderId: createResult.orderID,
              phemexClOrdId: createResult.clOrdID
            }
          : item
      )
    );

    return { becameActive: false, cancelResult, createResult };
  };

  const deleteOrder = (orderId: string) => {
    const order = ordersRef.current.find((item) => item.id === orderId);
    const exchangeOrderId = order ? order.phemexOrderId || (phemexOrderIdPattern.test(order.id) ? order.id : undefined) : undefined;
    if (isLiveRunning && order && (order.status === "pending" || order.status === "active") && (exchangeOrderId || order.phemexClOrdId)) {
      void cancelOrder(orderId);
      return;
    }
    setOrders((current) => current.filter((order) => order.id !== orderId));
    setMessage(t.orderDeleted(orderId));
  };

  const requestClearOrderbook = () => {
    const livePendingCount = openOrders.filter((order) => order.status === "pending" && (order.phemexOrderId || phemexOrderIdPattern.test(order.id) || order.phemexClOrdId)).length;
    setOrderbookConfirm({
      title: "Orderbook leeren?",
      message: livePendingCount > 0
        ? `${livePendingCount} offene Phemex-Order(s) werden auf der Exchange storniert und aus dem Tool entfernt.`
        : "Alle offenen lokalen Orders werden aus dem Tool entfernt."
    });
  };

  const confirmClearOrderbook = async () => {
    setOrderbookConfirm(null);
    const pendingOrdersToCancel = ordersRef.current.filter((order) => order.status === "pending");
    const livePendingOrders = pendingOrdersToCancel.filter((order) =>
      isLiveRunning && (order.phemexOrderId || phemexOrderIdPattern.test(order.id) || order.phemexClOrdId)
    );
    for (const order of livePendingOrders) {
      await cancelOrder(order.id);
    }
    setOrders((current) => current.filter((order) => order.status !== "pending" && order.status !== "active"));
    setMessage(t.clearOrderbook);
    setMessageKind("custom");
  };

  const updateOrderProtection = (orderId: string, field: "takeProfit" | "stopLoss", value: string) => {
    const parsed = value === "" ? undefined : Number(value);
    if (value !== "" && !Number.isFinite(parsed)) {
      setMessage(t.invalidProtection);
      return;
    }

    setOrders((current) =>
      current.map((order) => {
        if (order.id !== orderId || (order.status !== "pending" && order.status !== "active")) return order;
        if (!protectionEditOriginalsRef.current[orderId]) {
          protectionEditOriginalsRef.current[orderId] = {
            entry: order.entry,
            takeProfit: order.takeProfit,
            stopLoss: order.stopLoss
          };
        }
        const nextValue =
          parsed === undefined || isProtectionDockedAtEntry(order, parsed)
            ? undefined
            : Number(clampProtectionPrice(order, field, parsed).toFixed(4));
        return {
          ...order,
          [field]: nextValue
        };
      })
    );
  };

  const confirmOrderProtection = async (orderId: string) => {
    const order = ordersRef.current.find((item) => item.id === orderId);
    if (!order) return;
    if (isLiveRunning && order.status === "active") {
      setExchangeRequestState("loading");
      try {
        const response = await fetch("/api/phemex-position-protection", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            symbol: activePhemexSettings.symbol,
            side: order.side,
            quantity: order.quantity,
            takeProfit: order.takeProfit,
            stopLoss: order.stopLoss,
            exchange: activePhemexSettings.exchange,
            testnet: activePhemexSettings.testnet
          })
        });
        const result = await response.json();
        if (!response.ok || !result.ok) {
          showExchangeDebug("Phemex Positions-TP/SL", t.phemexOrderAmendFailed(result.message), {
            reason: result.message,
            symbol: activePhemexSettings.symbol,
            side: order.side,
            quantity: order.quantity,
            sentTakeProfit: order.takeProfit,
            sentStopLoss: order.stopLoss,
            request: result.request,
            phemexResponse: result.payload
          });
          setExchangeRequestState("error");
          return;
        }
        setOrders((current) =>
          current.map((item) =>
            item.id === orderId
              ? {
                  ...item,
                  phemexTakeProfitOrderId: result.takeProfit?.orderID || item.phemexTakeProfitOrderId,
                  phemexStopLossOrderId: result.stopLoss?.orderID || item.phemexStopLossOrderId
                }
              : item
          )
        );
        setMessage("Phemex Positions-TP/SL wurde gesetzt.");
        setMessageKind("custom");
        setExchangeRequestState("idle");
      } catch (error) {
        const reason = error instanceof Error ? error.message : undefined;
        showExchangeDebug("Phemex Positions-TP/SL", t.phemexOrderAmendFailed(reason), {
          reason,
          symbol: activePhemexSettings.symbol,
          side: order.side,
          quantity: order.quantity,
          sentTakeProfit: order.takeProfit,
          sentStopLoss: order.stopLoss,
          testnet: activePhemexSettings.testnet
        });
        setExchangeRequestState("error");
      }
      return;
    }
    if (isLiveRunning && (order.phemexOrderId || order.phemexClOrdId)) {
      setExchangeRequestState("loading");
      if (order.status === "pending") {
        try {
          const result = await recreatePendingPhemexOrder(order);
          if (result.becameActive) {
            setMessage("Phemex Order ist nicht mehr offen. Sie wurde lokal als aktiv markiert.");
            setMessageKind("custom");
            setExchangeRequestState("idle");
            return;
          }
          setMessage(`Phemex Order ${order.id} mit neuem TP/SL ersetzt.`);
          setMessageKind("custom");
          setExchangeRequestState("idle");
          await delay(900);
          await syncPhemexOpenOrders(activePhemexSettings).catch(() => undefined);
          return;
        } catch (error) {
          const reason = error instanceof Error ? error.message : undefined;
          showExchangeDebug("Phemex Recreate", t.phemexOrderAmendFailed(reason), {
            reason,
            symbol: activePhemexSettings.symbol,
            orderID: order.phemexOrderId,
            clOrdID: order.phemexClOrdId,
            quantity: order.quantity,
            entry: order.entry,
            sentTakeProfit: order.takeProfit,
            sentStopLoss: order.stopLoss,
            testnet: activePhemexSettings.testnet
          });
          setExchangeRequestState("error");
          return;
        }
      }
      try {
        const response = await fetch("/api/phemex-amend-order", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            symbol: activePhemexSettings.symbol,
            orderID: order.phemexOrderId,
            origClOrdID: order.phemexClOrdId,
            side: order.side,
            quantity: order.quantity,
            price: order.entry,
            takeProfit: order.takeProfit,
            stopLoss: order.stopLoss,
            exchange: activePhemexSettings.exchange,
            testnet: activePhemexSettings.testnet
          })
        });
        const result = await response.json();
        if (!response.ok || !result.ok) {
          showExchangeDebug("Phemex Änderung", t.phemexOrderAmendFailed(result.message), {
            reason: result.message,
            symbol: activePhemexSettings.symbol,
            orderID: order.phemexOrderId,
            clOrdID: order.phemexClOrdId,
            quantity: order.quantity,
            entry: order.entry,
            sentTakeProfit: order.takeProfit,
            sentStopLoss: order.stopLoss,
            testnet: activePhemexSettings.testnet,
            request: result.request,
            phemexResponse: result.payload
          });
          setExchangeRequestState("error");
          return;
        }
        setOrders((current) =>
          current.map((item) =>
            item.id === orderId
              ? {
                  ...item,
                  phemexOrderId: result.orderID || item.phemexOrderId,
                  phemexClOrdId: result.clOrdID || item.phemexClOrdId
                }
              : item
          )
        );
        setMessage(t.phemexOrderAmended(orderId));
        setMessageKind("custom");
        setExchangeRequestState("idle");
        if (order.takeProfit !== undefined || order.stopLoss !== undefined) {
          showExchangeDebug("Phemex TP/SL Debug", "Phemex Amend wurde gesendet. Prüfe unten, ob Phemex TP/SL in der Antwort bestätigt.", {
            sent: {
              orderID: order.phemexOrderId,
              clOrdID: order.phemexClOrdId,
              entry: order.entry,
              takeProfit: order.takeProfit,
              stopLoss: order.stopLoss
            },
            request: result.request,
            phemexResponse: {
              code: result.payload?.code,
              msg: result.payload?.msg,
              bizError: result.payload?.data?.bizError,
              execStatus: result.payload?.data?.execStatus,
              orderID: result.payload?.data?.orderID,
              takeProfitRp: result.payload?.data?.takeProfitRp,
              stopLossRp: result.payload?.data?.stopLossRp,
              tpPxRp: result.payload?.data?.tpPxRp,
              slPxRp: result.payload?.data?.slPxRp
            }
          });
        }
        await delay(900);
        await syncPhemexOpenOrders(activePhemexSettings).catch(() => undefined);
        return;
      } catch (error) {
        const reason = error instanceof Error ? error.message : undefined;
        showExchangeDebug("Phemex Änderung", t.phemexOrderAmendFailed(reason), {
          reason,
          symbol: activePhemexSettings.symbol,
          orderID: order.phemexOrderId,
          clOrdID: order.phemexClOrdId,
          quantity: order.quantity,
          entry: order.entry,
          sentTakeProfit: order.takeProfit,
          sentStopLoss: order.stopLoss,
          testnet: activePhemexSettings.testnet
        });
        setExchangeRequestState("error");
        return;
      }
    }
    setMessage(t.protectionUpdated(orderId));
  };

  const requestProtectionConfirm = (orderId: string) => {
    const order = ordersRef.current.find((item) => item.id === orderId);
    if (!order) return;
    const original = protectionEditOriginalsRef.current[orderId] ?? {
      entry: order.entry,
      takeProfit: order.takeProfit,
      stopLoss: order.stopLoss
    };
    const chartRect = chartElement.current?.getBoundingClientRect();
    setProtectionConfirm({
      orderId,
      x: chartRect ? Math.max(12, chartRect.width - 292) : 24,
      y: chartRect ? Math.max(12, Math.min(120, chartRect.height - 116)) : 24,
      originalEntry: original.entry,
      originalTakeProfit: original.takeProfit,
      originalStopLoss: original.stopLoss
    });
  };

  const sendProtectionConfirm = () => {
    if (!protectionConfirm) return;
    const orderId = protectionConfirm.orderId;
    setProtectionConfirm(null);
    delete protectionEditOriginalsRef.current[orderId];
    if (isLiveRunning) {
      setPendingProtectionSyncIds((current) => current.includes(orderId) ? current : [...current, orderId]);
      return;
    }
    void confirmOrderProtection(orderId);
  };

  const cancelProtectionConfirm = () => {
    if (!protectionConfirm) return;
    const confirm = protectionConfirm;
    setProtectionConfirm(null);
    setOrders((current) =>
      current.map((order) =>
        order.id === confirm.orderId
          ? { ...order, entry: confirm.originalEntry, takeProfit: confirm.originalTakeProfit, stopLoss: confirm.originalStopLoss }
          : order
      )
    );
    delete protectionEditOriginalsRef.current[confirm.orderId];
    setMessage(t.protectionUpdated(confirm.orderId));
  };

  useEffect(() => {
    if (!pendingProtectionSyncIds.length || !isLiveRunning) return;
    const ids = pendingProtectionSyncIds;
    setPendingProtectionSyncIds([]);
    ids.forEach((orderId) => {
      void confirmOrderProtection(orderId);
    });
  }, [pendingProtectionSyncIds, isLiveRunning, orders]);

  const addOrderProtection = (orderId: string, field: "takeProfit" | "stopLoss") => {
    setOrders((current) =>
      current.map((order) => {
        if (order.id !== orderId || order.status !== "pending") return order;
        const distance = Math.max(order.entry * 0.01, 0.1);
        const price =
          field === "takeProfit"
            ? order.side === "buy"
              ? order.entry + distance
              : order.entry - distance
            : order.side === "buy"
              ? order.entry - distance
              : order.entry + distance;

        return {
          ...order,
          [field]: Number(price.toFixed(4))
        };
      })
    );
    setMessage(t.protectionUpdated(orderId));
  };

  const startProtectionDrag = (
    event: React.MouseEvent<HTMLButtonElement>,
    orderId: string,
    field: "takeProfit" | "stopLoss"
  ) => {
    event.preventDefault();
    event.stopPropagation();
    draggedChipRef.current = { orderId, field };
    rememberProtectionBeforeDrag(orderId, field);
    chartRef.current?.applyOptions({
      handleScale: {
        axisPressedMouseMove: {
          price: false,
          time: false
        },
        mouseWheel: chartTheme.allowMouseWheel,
        pinch: chartTheme.allowMouseWheel
      },
      handleScroll: {
        horzTouchDrag: false,
        mouseWheel: false,
        pressedMouseMove: false,
        vertTouchDrag: false
      }
    });
    chartElement.current?.classList.add("dragging-line");
  };

  const handleProtectionChipClick = (orderId: string, field: "takeProfit" | "stopLoss") => {
    if (chipDragFinishedRef.current) return;
    addOrderProtection(orderId, field);
  };

  const startDrawing = (event: React.MouseEvent<SVGSVGElement>) => {
    if (drawingTool === "cursor" || event.button !== 0) return;
    const rect = event.currentTarget.getBoundingClientRect();
    const point = screenToDrawingPoint(event.clientX - rect.left, event.clientY - rect.top, event.ctrlKey);
    if (!point) return;
    event.preventDefault();
    if (drawingTool === "zigzag") {
      setZigZagDraftPoints((current) => (current.length ? [...current.slice(0, -1), point, point] : [point, point]));
      setDrawingMenu(null);
      setChartMenu(null);
      return;
    }
    const shape: DrawingShape = {
      id: `DRAW-${Date.now()}`,
      tool: drawingTool,
      start: point,
      end: point,
      strokeColor: defaultDrawingStrokeColor,
      fillColor: defaultDrawingFillColor,
      lineWidth: chartTheme.drawingSize,
      borderWidth: chartTheme.drawingSize,
      locked: false
    };
    drawingDraftRef.current = shape;
    setDrawingDraft(shape);
    setDrawingMenu(null);
    setChartMenu(null);
  };

  const startDrawingMove = (event: React.MouseEvent<SVGElement>, drawing: DrawingShape) => {
    if (drawingTool !== "cursor" || event.button !== 0) return;
    if (drawing.locked) {
      setSelectedDrawingId(drawing.id);
      return;
    }
    const chartNode = chartElement.current;
    if (!chartNode) return;
    const rect = chartNode.getBoundingClientRect();
    const point = screenToDrawingPoint(event.clientX - rect.left, event.clientY - rect.top, event.ctrlKey);
    if (!point) return;
    event.preventDefault();
    event.stopPropagation();
    setSelectedDrawingId(drawing.id);
    draggedDrawingRef.current = {
      id: drawing.id,
      startPoint: point,
      original: drawing,
      handle: "move"
    };
    setDrawingMenu(null);
    setChartMenu(null);
  };

  const startDrawingResize = (
    event: React.MouseEvent<SVGElement>,
    drawing: DrawingShape,
    handle: NonNullable<DraggedDrawing["handle"]>
  ) => {
    if (drawingTool !== "cursor" || event.button !== 0) return;
    if (drawing.locked) return;
    const chartNode = chartElement.current;
    if (!chartNode) return;
    const rect = chartNode.getBoundingClientRect();
    const point = screenToDrawingPoint(event.clientX - rect.left, event.clientY - rect.top, event.ctrlKey);
    if (!point) return;
    event.preventDefault();
    event.stopPropagation();
    setSelectedDrawingId(drawing.id);
    draggedDrawingRef.current = {
      id: drawing.id,
      startPoint: point,
      original: drawing,
      handle
    };
    setDrawingMenu(null);
    setChartMenu(null);
  };

  const startZigZagPointMove = (
    event: React.MouseEvent<SVGElement>,
    drawing: DrawingShape,
    pointIndex: number
  ) => {
    if (drawingTool !== "cursor" || event.button !== 0 || drawing.locked) return;
    const chartNode = chartElement.current;
    if (!chartNode) return;
    const rect = chartNode.getBoundingClientRect();
    const point = screenToDrawingPoint(event.clientX - rect.left, event.clientY - rect.top, event.ctrlKey);
    if (!point) return;
    event.preventDefault();
    event.stopPropagation();
    setSelectedDrawingId(drawing.id);
    draggedDrawingRef.current = {
      id: drawing.id,
      startPoint: point,
      original: drawing,
      pointIndex
    };
    setDrawingMenu(null);
    setChartMenu(null);
  };

  const openDrawingContextMenu = (event: React.MouseEvent<SVGElement>, drawing: DrawingShape) => {
    event.preventDefault();
    event.stopPropagation();
    const chartNode = chartElement.current;
    if (!chartNode) return;
    const rect = chartNode.getBoundingClientRect();
    setSelectedDrawingId(drawing.id);
    setDrawingMenu({
      id: drawing.id,
      x: event.clientX - rect.left,
      y: event.clientY - rect.top
    });
    setChartMenu(null);
  };

  const deleteDrawing = (drawingId: string) => {
    setDrawings((current) => current.filter((drawing) => drawing.id !== drawingId || drawing.locked));
    setSelectedDrawingId((current) => (current === drawingId ? null : current));
    setDrawingMenu(null);
  };

  const toggleDrawingLock = (drawingId: string) => {
    setDrawings((current) =>
      current.map((drawing) =>
        drawing.id === drawingId ? { ...drawing, locked: !drawing.locked } : drawing
      )
    );
    setDrawingMenu(null);
  };

  const updateDrawingColor = (drawingId: string, field: "strokeColor" | "fillColor", color: string) => {
    setDrawings((current) =>
      current.map((drawing) => (drawing.id === drawingId ? { ...drawing, [field]: color } : drawing))
    );
  };

  const updateDrawingNumber = (drawingId: string, field: "lineWidth" | "borderWidth", value: number) => {
    setDrawings((current) =>
      current.map((drawing) => (drawing.id === drawingId ? { ...drawing, [field]: value } : drawing))
    );
  };

  const updateDrawing = (event: React.MouseEvent<SVGSVGElement>) => {
    if (drawingTool === "zigzag" && zigZagDraftPoints.length) {
      const rect = event.currentTarget.getBoundingClientRect();
      const point = screenToDrawingPoint(event.clientX - rect.left, event.clientY - rect.top, event.ctrlKey);
      if (!point) return;
      setZigZagDraftPoints((current) => [...current.slice(0, -1), point]);
      return;
    }
    const draft = drawingDraftRef.current;
    if (!draft) return;
    const rect = event.currentTarget.getBoundingClientRect();
    const point = screenToDrawingPoint(event.clientX - rect.left, event.clientY - rect.top, event.ctrlKey);
    if (!point) return;
    const next = {
      ...draft,
      end:
        draft.tool === "ray" || draft.tool === "horizontal"
          ? makeDrawingPoint(point.logical, draft.start.price)
          : point
    };
    drawingDraftRef.current = next;
    setDrawingDraft(next);
  };

  const finishDrawing = () => {
    if (drawingTool === "zigzag") return;
    const draft = drawingDraftRef.current;
    if (!draft) return;
    drawingDraftRef.current = null;
    setDrawingDraft(null);
    setDrawingTool("cursor");
    const start = drawingPointToScreen(draft.start);
    const end = drawingPointToScreen(draft.end);
    if (!start || !end || Math.hypot(end.x - start.x, end.y - start.y) < 6) return;
    setDrawings((current) => [...current, draft]);
    setSelectedDrawingId(draft.id);
  };

  const finishZigZagDrawing = useCallback(() => {
    if (zigZagDraftPoints.length < 3) {
      setZigZagDraftPoints([]);
      setDrawingTool("cursor");
      return;
    }
    const points = zigZagDraftPoints.slice(0, -1);
    const shape: DrawingShape = {
      id: `DRAW-${Date.now()}`,
      tool: "zigzag",
      start: points[0],
      end: points.at(-1) ?? points[0],
      points,
      strokeColor: defaultDrawingStrokeColor,
      fillColor: defaultDrawingFillColor,
      lineWidth: chartTheme.drawingSize,
      borderWidth: chartTheme.drawingSize,
      locked: false
    };
    setDrawings((current) => [...current, shape]);
    setSelectedDrawingId(shape.id);
    setZigZagDraftPoints([]);
    setDrawingTool("cursor");
  }, [chartTheme.drawingSize, zigZagDraftPoints]);

  const finishDrawingWithContextMenu = (event: React.MouseEvent<SVGSVGElement>) => {
    if (drawingTool === "cursor") return;
    event.preventDefault();
    event.stopPropagation();
    if (drawingTool === "zigzag") {
      finishZigZagDrawing();
      return;
    }
    finishDrawing();
  };

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (drawingTool !== "zigzag") return;
      if (event.key === "Enter") {
        event.preventDefault();
        finishZigZagDrawing();
      }
      if (event.key === "Escape") {
        event.preventDefault();
        setZigZagDraftPoints([]);
        setDrawingTool("cursor");
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [drawingTool, finishZigZagDrawing]);

  const useChartPrice = (target: "entry" | "tp" | "sl") => {
    if (!chartMenu) return;
    const value = chartMenu.price.toFixed(2);
    if (target === "entry") setEntry(value);
    if (target === "tp") setTakeProfit(value);
    if (target === "sl") setStopLoss(value);
    setMessage(t.priceUsed(value));
    setChartMenu(null);
  };

  const copyChartPrice = async () => {
    if (!chartMenu) return;
    const value = chartMenu.price.toFixed(2);
    await navigator.clipboard?.writeText(value);
    setMessage(t.priceCopied(value));
    setChartMenu(null);
  };

  const updateTheme = (key: keyof ChartTheme, value: string) => {
    setChartTheme((current) => ({ ...current, [key]: value }));
  };

  const loadSavedExchangeCredentials = async (exchange: PhemexSettings["exchange"]) => {
    try {
      const response = await fetch(`/api/phemex-settings?exchange=${encodeURIComponent(exchange)}`);
      const settings = response.ok ? await response.json() : undefined;
      setPhemexSettings((current) => {
        if (current.exchange !== exchange || !settings) return current;
        return {
          ...current,
          apiKey: settings.apiKey || "",
          apiSecret: settings.hasSecret ? "********" : "",
          testnet: settings.testnet !== false,
          allowMainnetOrders: Boolean(settings.allowMainnetOrders)
        };
      });
    } catch {
      setPhemexSettings((current) => current.exchange === exchange ? { ...current, apiKey: "", apiSecret: "" } : current);
    }
  };

  const updatePhemexSetting = (key: keyof PhemexSettings, value: string | boolean) => {
    if (key === "exchange") {
      const exchange = value as PhemexSettings["exchange"];
      setPhemexSettings((current) => ({
        ...current,
        exchange,
        apiKey: "",
        apiSecret: ""
      }));
      void loadSavedExchangeCredentials(exchange);
      return;
    }
    setPhemexSettings((current) => ({ ...current, [key]: value }));
    if (isLiveRunning && key === "liveOrdersEnabled") {
      setActivePhemexSettings((current) => ({ ...current, liveOrdersEnabled: Boolean(value) }));
    }
  };

  const jumpChartToLatest = useCallback((totalCandles?: number) => {
    const setLatestRange = () => {
      const timeScale = chartRef.current?.timeScale();
      const lastLogical = Math.max(0, (totalCandles ?? visibleCount) - 1);
      timeScale?.scrollToRealTime();
      timeScale?.setVisibleLogicalRange({
        from: Math.max(0, lastLogical - 60) as Logical,
        to: (lastLogical + 4) as Logical
      });
      scheduleOverlayRefresh(true);
    };
    setLatestRange();
    window.requestAnimationFrame(() => {
      setLatestRange();
      window.requestAnimationFrame(setLatestRange);
    });
    window.setTimeout(setLatestRange, 80);
    window.setTimeout(setLatestRange, 180);
    window.setTimeout(setLatestRange, 320);
  }, [scheduleOverlayRefresh, visibleCount]);

  const savePhemexSettings = async () => {
    try {
      const response = await fetch("/api/phemex-settings", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ...phemexSettings,
          apiKey: phemexSettings.apiKey === "********" ? "" : phemexSettings.apiKey,
          apiSecret: phemexSettings.apiSecret === "********" ? "" : phemexSettings.apiSecret
        })
      });
      if (!response.ok) throw new Error("Save failed");
      setMessage(t.apiSaved);
    } catch {
      setMessage(t.apiSaveFailed);
    }
  };

  const loadPhemexBalance = useCallback(async (settingsOverride?: PhemexSettings) => {
    const settings = settingsOverride ?? activePhemexSettings;
    try {
      const response = await fetch("/api/phemex-balance", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          symbol: settings.symbol,
          exchange: settings.exchange,
          testnet: settings.testnet
        })
      });
      const result = await response.json();
      const balance = Number(result.accountBalance);
      if (!response.ok || !result.ok || !Number.isFinite(balance)) throw new Error("Phemex balance failed");
      setFuturesBalance(balance);
    } catch {
      setFuturesBalance(null);
    }
  }, [activePhemexSettings.exchange, activePhemexSettings.symbol, activePhemexSettings.testnet]);

  useEffect(() => {
    if (!activePhemexSettings.apiKey || !activePhemexSettings.apiSecret) return;
    loadPhemexBalance();
  }, [loadPhemexBalance, activePhemexSettings.apiKey, activePhemexSettings.apiSecret]);

  const syncPhemexPositionStatus = useCallback(async (settingsOverride?: PhemexSettings) => {
    const settings = settingsOverride ?? activePhemexSettings;
    const response = await fetch("/api/phemex-balance", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        symbol: settings.symbol,
        exchange: settings.exchange,
        testnet: settings.testnet
      })
    });
    const result = await response.json();
    const balance = Number(result.accountBalance);
    if (response.ok && result.ok && Number.isFinite(balance)) {
      setFuturesBalance(balance);
    }
    if (!response.ok || !result.ok) {
      throw new Error(result.message || "Phemex positions failed");
    }

    const positions = Array.isArray(result.payload?.data?.positions) ? result.payload.data.positions : [];
    const livePosition = positions.find((position: Record<string, unknown>) => Math.abs(phemexPositionSize(position)) > 0) as Record<string, unknown> | undefined;
    if (!livePosition) {
      let removedCount = 0;
      setOrders((current) =>
        current.filter((order) => {
          if (order.status !== "pending" || (!order.phemexOrderId && !order.phemexClOrdId)) return true;
          const keys = [order.id, order.phemexOrderId, order.phemexClOrdId].filter(Boolean) as string[];
          const isStillOpen = keys.some((key) => openPhemexOrderKeysRef.current.has(key));
          if (!isStillOpen) removedCount += 1;
          return isStillOpen;
        })
      );
      if (removedCount > 0) {
        setMessage(`${removedCount} extern gelöschte Phemex-Order entfernt.`);
        setMessageKind("custom");
      }
      return false;
    }
    const positionSize = Math.abs(phemexPositionSize(livePosition));
    const positionEntry = numberFrom(livePosition.avgEntryPriceRp ?? livePosition.avgEntryPrice);
    const positionSide: Side = String(livePosition.side || "").toLowerCase() === "sell" ? "sell" : "buy";

    setOrders((current) =>
      current.map((order) => {
        if (order.status !== "pending" || (!order.phemexOrderId && !order.phemexClOrdId)) return order;
        const keys = [order.id, order.phemexOrderId, order.phemexClOrdId].filter(Boolean) as string[];
        const isStillOpen = keys.some((key) => openPhemexOrderKeysRef.current.has(key));
        return isStillOpen
          ? order
          : {
              ...order,
              status: "active" as OrderStatus,
              side: positionSide,
              quantity: positionSize || order.quantity,
              entry: positionEntry ?? order.entry
            };
      })
    );
    return true;
  }, [activePhemexSettings]);

  const syncPhemexOpenOrders = useCallback(async (settingsOverride?: PhemexSettings, silent = false) => {
    const settings = settingsOverride ?? activePhemexSettings;
    const fallbackTime = lastCandle?.time ?? visibleCandles.at(-1)?.time;
    if (!fallbackTime) return 0;
    const response = await fetch("/api/phemex-open-orders", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        symbol: settings.symbol,
        exchange: settings.exchange,
        testnet: settings.testnet
      })
    });
    const result = await response.json();
    if (!response.ok || !result.ok || !Array.isArray(result.rows)) {
      throw new Error(result.message || "Phemex open orders failed");
    }
    const importedOrders = result.rows
      .map((row: PhemexOpenOrderRow) => phemexOrderToTradeOrder(row, fallbackTime))
      .filter(Boolean)
      .filter((order: TradeOrder) => {
        const keys = [order.id, order.phemexOrderId, order.phemexClOrdId].filter(Boolean) as string[];
        return !keys.some((key) => canceledPhemexOrderKeysRef.current.has(key));
      }) as TradeOrder[];
    openPhemexOrderKeysRef.current = new Set(
      importedOrders.flatMap((order) =>
        [order.id, order.phemexOrderId, order.phemexClOrdId].filter(Boolean) as string[]
      )
    );
    setOrders((current) => {
      const openLocal = current.filter((order) => order.status === "pending" || order.status === "active");
      const closedLocal = current.filter((order) => order.status !== "pending" && order.status !== "active");
      const importedKeys = new Set(
        importedOrders.flatMap((order) =>
          [order.id, order.phemexOrderId, order.phemexClOrdId].filter(Boolean) as string[]
        )
      );
      const keptLocal = openLocal.filter((order) => {
        const keys = [order.id, order.phemexOrderId, order.phemexClOrdId].filter(Boolean) as string[];
        return !keys.some((key) => importedKeys.has(key));
      });
      return [...importedOrders, ...keptLocal, ...closedLocal];
    });
    if (!silent) {
      setMessage(t.phemexOrdersSynced(importedOrders.length));
      setMessageKind("custom");
    }
    return importedOrders.length;
  }, [activePhemexSettings, lastCandle?.time, t, visibleCandles]);

  const syncPhemexOrderStatusThrottled = useCallback(async (settingsOverride?: PhemexSettings, force = false) => {
    const settings = settingsOverride ?? activePhemexSettings;
    const now = Date.now();
    const minIntervalMs = pollMsFromSettings(settings);
    if (!force && now - lastPhemexOrderStatusSyncAtRef.current < minIntervalMs) return;
    lastPhemexOrderStatusSyncAtRef.current = now;
    await syncPhemexOpenOrders(settings, true);
    await syncPhemexPositionStatus(settings);
  }, [activePhemexSettings, syncPhemexOpenOrders, syncPhemexPositionStatus]);

  const syncPhemexExchangeState = useCallback(async (settingsOverride?: PhemexSettings) => {
    const settings = settingsOverride ?? (isLiveRunning ? activePhemexSettings : phemexSettings);
    setExchangeRequestState("loading");
    try {
      lastPhemexOrderStatusSyncAtRef.current = Date.now();
      await syncPhemexOpenOrders(settings, true);
      await syncPhemexPositionStatus(settings);
      setExchangeRequestState("idle");
      setMessage(t.syncExchangeDone);
      setMessageKind("custom");
    } catch (error) {
      const reason = error instanceof Error ? error.message : t.syncExchangeFailed;
      setExchangeRequestState("error");
      showExchangeDebug("Phemex Abgleich", reason, {
        symbol: settings.symbol,
        testnet: settings.testnet
      });
    }
  }, [
    activePhemexSettings,
    isLiveRunning,
    phemexSettings,
    syncPhemexOpenOrders,
    syncPhemexPositionStatus,
    t.syncExchangeDone,
    t.syncExchangeFailed
  ]);

  const testPhemexConnection = async () => {
    setExchangeRequestState("loading");
    try {
      const response = await fetch("/api/phemex-price", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          symbol: phemexSettings.symbol,
          exchange: phemexSettings.exchange,
          testnet: phemexSettings.testnet
        })
      });
      const result = await response.json();
      const price = Number(result.price);
      if (!response.ok || !result.ok || !Number.isFinite(price)) throw new Error("Phemex test failed");

      setLiveLastPrice(price);
      setLiveLastFetchAt(Date.now());
      loadPhemexBalance();
      setExchangeRequestState("idle");
      setMessage(t.connectionOk(result.symbol || phemexSettings.symbol, formatPrice(price)));
      setMessageKind("custom");
    } catch {
      setExchangeRequestState("error");
      showExchangeDebug("Phemex Verbindung", t.connectionFailed, {
        symbol: phemexSettings.symbol,
        exchange: phemexSettings.exchange,
        testnet: phemexSettings.testnet
      });
    }
  };

  const loadPhemexChart = async (settingsOverride?: PhemexSettings) => {
    setExchangeRequestState("loading");
    const settings = settingsOverride ?? (isLiveRunning ? activePhemexSettings : phemexSettings);
    try {
      const response = await fetch("/api/phemex-chart", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          symbol: settings.symbol,
          resolution: Number(settings.resolution || 300),
          limit: Number(settings.limit || 500),
          exchange: settings.exchange,
          testnet: settings.testnet
        })
      });
      const result = await response.json();
      if (!response.ok || !result.ok || typeof result.csv !== "string") throw new Error("Phemex chart failed");

      const candles = parseCsvTextCandles(result.csv);
      if (!candles.length) throw new Error("Phemex CSV invalid");

      setAllCandles(candles);
      setVisibleCount(Math.min(60, candles.length));
      shouldFitContentRef.current = !shouldJumpToLatestRef.current;
      shouldFitPriceRef.current = true;
      setOrders([]);
      setIsPlaying(false);
      setMessage(t.phemexChartLoaded(candles.length, result.path));
      setMessageKind("custom");
      setExchangeRequestState("idle");
      return candles.length;
    } catch {
      showExchangeDebug("Phemex Chart", t.phemexChartFailed, {
        symbol: settings.symbol,
        exchange: settings.exchange,
        resolution: settings.resolution,
        limit: settings.limit,
        testnet: settings.testnet
      });
      setExchangeRequestState("error");
      return false;
    }
  };

  const startLiveMode = async () => {
    shouldJumpToLatestRef.current = true;
    setActivePhemexSettings(phemexSettings);
    const loadedCount = await loadPhemexChart(phemexSettings);
    if (!loadedCount) {
      shouldJumpToLatestRef.current = false;
      return;
    }
    setIsPlaying(false);
    setIsLiveRunning(true);
    setVisibleCount(loadedCount);
    setLiveLastPrice(null);
    setLiveLastFetchAt(null);
    loadPhemexBalance(phemexSettings);
    syncPhemexOpenOrders(phemexSettings).catch((error) => {
      const reason = error instanceof Error ? error.message : "Phemex open orders failed";
      showExchangeDebug("Phemex Open Orders", reason, {
        symbol: phemexSettings.symbol,
        testnet: phemexSettings.testnet
      });
    });
    syncPhemexPositionStatus(phemexSettings).catch(() => undefined);
    lastPhemexOrderStatusSyncAtRef.current = Date.now();
    const pollMs = pollMsFromSettings(phemexSettings);
    setLiveNextFetchAt(Date.now() + pollMs);
    jumpChartToLatest(loadedCount);
    setShowChartOptions(false);
  };

  const stopLiveMode = () => {
    setIsLiveRunning(false);
    setLiveNextFetchAt(null);
    setLiveCountdownSeconds(null);
    setExchangeRequestState("idle");
    setOrders((current) => current.filter((order) => !order.phemexOrderId && !order.phemexClOrdId));
  };

  const applyExchangeSettings = async () => {
    setExchangeRequestState("loading");
    setMessage(t.settingsApplied(phemexSettings.symbol, timeframeFromResolution(phemexSettings.resolution)));
    setMessageKind("custom");
    setActivePhemexSettings(phemexSettings);
    if (isLiveRunning) {
      const pollMs = pollMsFromSettings(phemexSettings);
      setLiveNextFetchAt(Date.now() + pollMs);
      shouldJumpToLatestRef.current = true;
      const loadedCount = await loadPhemexChart(phemexSettings);
      if (loadedCount) {
        setVisibleCount(loadedCount);
        jumpChartToLatest(loadedCount);
      }
      setLiveSettingsVersion((version) => version + 1);
      await Promise.allSettled([loadPhemexBalance(phemexSettings), refreshLivePhemexPrice(phemexSettings)]);
      await syncPhemexOpenOrders(phemexSettings).catch((error) => {
        const reason = error instanceof Error ? error.message : "Phemex open orders failed";
        showExchangeDebug("Phemex Open Orders", reason, {
          symbol: phemexSettings.symbol,
          testnet: phemexSettings.testnet
        });
      });
      await syncPhemexPositionStatus(phemexSettings).catch(() => undefined);
      lastPhemexOrderStatusSyncAtRef.current = Date.now();
    } else {
      await loadPhemexBalance(phemexSettings);
    }
    setExchangeRequestState("idle");
  };

  const changeMarketTimeframe = async (resolution: string) => {
    preserveDrawingTimes();
    const nextSettings = { ...phemexSettings, resolution };
    setPhemexSettings(nextSettings);
    setActivePhemexSettings(nextSettings);
    setMessage(t.settingsApplied(nextSettings.symbol, timeframeFromResolution(nextSettings.resolution)));
    setMessageKind("custom");

    if (!isLiveRunning) return;

    const pollMs = pollMsFromSettings(nextSettings);
    setLiveNextFetchAt(Date.now() + pollMs);
    shouldJumpToLatestRef.current = true;
    const loadedCount = await loadPhemexChart(nextSettings);
    if (loadedCount) {
      setVisibleCount(loadedCount);
      jumpChartToLatest(loadedCount);
    }
    setLiveSettingsVersion((version) => version + 1);
    await Promise.allSettled([loadPhemexBalance(nextSettings), refreshLivePhemexPrice(nextSettings)]);
    await syncPhemexOrderStatusThrottled(nextSettings, true).catch(() => undefined);
  };

  const changeMarketSymbol = async (symbol: string) => {
    preserveDrawingTimes();
    const nextSettings = { ...phemexSettings, symbol };
    setPhemexSettings(nextSettings);
    setActivePhemexSettings(nextSettings);
    setMessage(t.settingsApplied(nextSettings.symbol, timeframeFromResolution(nextSettings.resolution)));
    setMessageKind("custom");

    if (!isLiveRunning) return;

    const pollMs = pollMsFromSettings(nextSettings);
    setLiveNextFetchAt(Date.now() + pollMs);
    shouldJumpToLatestRef.current = true;
    const loadedCount = await loadPhemexChart(nextSettings);
    if (loadedCount) {
      setVisibleCount(loadedCount);
      jumpChartToLatest(loadedCount);
    }
    setLiveSettingsVersion((version) => version + 1);
    await Promise.allSettled([loadPhemexBalance(nextSettings), refreshLivePhemexPrice(nextSettings)]);
    await syncPhemexOrderStatusThrottled(nextSettings, true).catch(() => undefined);
  };

  const refreshLivePhemexPrice = useCallback(async (settingsOverride?: PhemexSettings) => {
    const settings = settingsOverride ?? activePhemexSettings;
    const now = Date.now();
    if (livePriceBackoffUntilRef.current > now) {
      setLiveNextFetchAt(livePriceBackoffUntilRef.current);
      setLiveCountdownSeconds(Math.max(0, Math.ceil((livePriceBackoffUntilRef.current - now) / 1000)));
      return;
    }
    let failureDetails: unknown = {
      symbol: settings.symbol,
      exchange: settings.exchange,
      testnet: settings.testnet
    };
    let failureMessage = "Phemex Live-Preis konnte nicht geladen werden.";
    try {
      const response = await fetch("/api/phemex-price", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          symbol: settings.symbol,
          exchange: settings.exchange,
          testnet: settings.testnet
        })
      });
      const result = await response.json();
      const price = Number(result.price);
      if (!response.ok || !result.ok || !Number.isFinite(price)) {
        failureMessage = result.message || failureMessage;
        failureDetails = {
          symbol: settings.symbol,
          exchange: settings.exchange,
          testnet: settings.testnet,
          status: result.status,
          payload: result.payload
        };
        throw new Error(failureMessage);
      }

      const resolutionSeconds = Number(settings.resolution || 300);
      const timestampMs = Number(result.timestampMs || Date.now());
      const nextFetchAt = Date.now() + pollMsFromSettings(settings);
      setAllCandles((current) => {
        const next = upsertLiveCandle(current, price, timestampMs, resolutionSeconds);
        setVisibleCount((count) => Math.max(count, next.length));
        return next;
      });
      setLiveLastPrice(price);
      setLiveLastFetchAt(Date.now());
      setLiveNextFetchAt(nextFetchAt);
      setLiveCountdownSeconds(Math.max(0, Math.ceil((nextFetchAt - Date.now()) / 1000)));
      setMessage(t.livePriceUpdated(formatPrice(price)));
      setMessageKind("custom");
      livePriceBackoffUntilRef.current = 0;
      await syncPhemexOrderStatusThrottled(settings).catch(() => undefined);
      setExchangeRequestState("idle");
    } catch {
      const status = typeof failureDetails === "object" && failureDetails && "status" in failureDetails ? Number((failureDetails as { status?: unknown }).status) : undefined;
      const isBlocked = status === 403 || status === 429;
      const nextFetchAt = Date.now() + (isBlocked ? 60_000 : pollMsFromSettings(settings));
      if (isBlocked) livePriceBackoffUntilRef.current = nextFetchAt;
      setLiveNextFetchAt(nextFetchAt);
      setLiveCountdownSeconds(Math.max(0, Math.ceil((nextFetchAt - Date.now()) / 1000)));
      if (Date.now() - lastLivePriceErrorPopupAtRef.current > 60_000) {
        lastLivePriceErrorPopupAtRef.current = Date.now();
        showExchangeDebug("Phemex Live-Preis", failureMessage, failureDetails);
      } else {
        setMessage(`${failureMessage} Nächster Versuch läuft automatisch.`);
        setMessageKind("custom");
      }
      setExchangeRequestState("error");
    }
  }, [
    activePhemexSettings,
    syncPhemexOrderStatusThrottled,
    t
  ]);

  useEffect(() => {
    refreshLivePhemexPriceRef.current = refreshLivePhemexPrice;
  }, [refreshLivePhemexPrice]);

  useEffect(() => {
    if (activePhemexSettings.mode !== "live") stopLiveMode();
  }, [activePhemexSettings.mode]);

  useEffect(() => {
    if (!isLiveRunning || activePhemexSettings.mode !== "live") return;
    const pollMs = pollMsFromSettings(activePhemexSettings);
    setLiveNextFetchAt(Date.now() + pollMs);
    const runRefresh = () => {
      void refreshLivePhemexPriceRef.current(activePhemexSettings);
    };
    runRefresh();
    const timer = window.setInterval(runRefresh, pollMs);
    return () => window.clearInterval(timer);
  }, [activePhemexSettings, isLiveRunning, liveSettingsVersion]);

  useEffect(() => {
    if (!liveNextFetchAt || !showLiveStatus) {
      setLiveCountdownSeconds(null);
      return;
    }
    const updateCountdown = () => {
      setLiveCountdownSeconds(Math.max(0, Math.ceil((liveNextFetchAt - Date.now()) / 1000)));
    };
    updateCountdown();
    const timer = window.setInterval(updateCountdown, 1000);
    return () => window.clearInterval(timer);
  }, [showLiveStatus, liveNextFetchAt]);

  const toggleTheme = (key: keyof ChartTheme) => {
    setChartTheme((current) => {
      const value = current[key];
      if (typeof value !== "boolean") return current;
      return { ...current, [key]: !value };
    });
  };

  const resetTheme = () => {
    setChartTheme(defaultTheme);
    setMessage(t.themeReset);
  };

  const handleCsv = (file?: File | null) => {
    if (!file) return;
    parseCsvCandles(
      file,
      (candles) => {
        setAllCandles(candles);
        setVisibleCount(Math.min(60, candles.length));
        shouldFitContentRef.current = true;
        shouldFitPriceRef.current = true;
        setOrders([]);
        setIsPlaying(false);
        setMessage(t.candlesLoaded(candles.length));
      },
      () => setMessage(t.csvInvalid)
    );
  };

  const downloadBinanceCsv = async () => {
    setExchangeRequestState("loading");
    try {
      const response = await fetch("/api/binance-csv-build", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          coin: csvBuilder.coin,
          quote: csvBuilder.quote,
          timeframe: csvBuilder.timeframe,
          startYear: Number(csvBuilder.startYear || 2026),
          startMonth: Number(csvBuilder.startMonth || 1),
          months: Number(csvBuilder.months || 1),
          testnet: csvBuilder.testnet
        })
      });
      const result = await response.json();
      if (!response.ok || !result.ok || typeof result.csv !== "string") {
        throw new Error(result.message || t.csvBuilderFailed);
      }
      const fallbackName = `${csvBuilder.startMonth}-${Number(csvBuilder.startMonth || 1) + Number(csvBuilder.months || 1) - 1}_${csvBuilder.startYear}_${csvBuilder.timeframe}_${csvBuilder.coin}${csvBuilder.quote}.csv`;
      const fileName = String(result.path || fallbackName).split("/").pop() || fallbackName;
      const blob = new Blob([result.csv], { type: "text/csv;charset=utf-8" });
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = fileName;
      document.body.appendChild(link);
      link.click();
      link.remove();
      URL.revokeObjectURL(url);
      setMessage(t.csvBuilderDone(result.path || fileName));
      setMessageKind("custom");
      setExchangeRequestState("idle");
    } catch (error) {
      const reason = error instanceof Error ? error.message : t.csvBuilderFailed;
      showExchangeDebug(t.csvBuilderTitle, reason, {
        exchange: "binance",
        coin: csvBuilder.coin,
        quote: csvBuilder.quote,
        timeframe: csvBuilder.timeframe,
        startYear: csvBuilder.startYear,
        startMonth: csvBuilder.startMonth,
        months: csvBuilder.months,
        testnet: csvBuilder.testnet
      });
      setExchangeRequestState("error");
    }
  };

  const resetReplay = () => {
    setVisibleCount(Math.min(4, allCandles.length));
    shouldFitContentRef.current = true;
    shouldFitPriceRef.current = true;
    setIsPlaying(false);
    setOrders([]);
    setMessage(t.replayReset);
  };

  const menuDrawing = drawingMenu ? drawings.find((drawing) => drawing.id === drawingMenu.id) : undefined;

  return (
    <main className="app-shell">
      <section className="topbar">
        <div className="topbar-title">
          <h1>{t.appTitle}</h1>
          <p>{message}</p>
        </div>
        <div className="topbar-actions">
          <button
            type="button"
            className="topbar-button"
            onClick={() => {
              setSettingsTab("phemex");
              setShowChartOptions(true);
            }}
          >
            <BookOpen size={18} />
            {t.exchange}
          </button>
          {!showLiveStatus && (
            <>
              <button
                type="button"
                className="topbar-button"
                onClick={() => setShowCsvBuilder(true)}
              >
                <FileDown size={18} />
                {t.csvCreate}
              </button>
              <label className="file-button">
                <FileUp size={18} />
                {t.csvLoad}
                <input type="file" accept=".csv,text/csv" onChange={(event) => handleCsv(event.target.files?.[0])} />
              </label>
            </>
          )}
        </div>
      </section>
      {exchangeDebugPopup && (
        <div className="exchange-debug-backdrop" onClick={() => setExchangeDebugPopup(null)}>
          <div className="exchange-debug-popup" onClick={(event) => event.stopPropagation()}>
            <div className="exchange-debug-title">
              <strong>{exchangeDebugPopup.title}</strong>
              <button className="small" onClick={() => setExchangeDebugPopup(null)}>×</button>
            </div>
            <p>{exchangeDebugPopup.message}</p>
            {exchangeDebugPopup.details && <pre>{exchangeDebugPopup.details}</pre>}
            <button className="small primary" onClick={() => setExchangeDebugPopup(null)}>OK</button>
          </div>
        </div>
      )}
      {orderbookConfirm && (
        <div className="exchange-debug-backdrop" onClick={() => setOrderbookConfirm(null)}>
          <div className="exchange-debug-popup" onClick={(event) => event.stopPropagation()}>
            <div className="exchange-debug-title">
              <strong>{orderbookConfirm.title}</strong>
              <button className="small" onClick={() => setOrderbookConfirm(null)}>×</button>
            </div>
            <p>{orderbookConfirm.message}</p>
            <div className="confirm-actions">
              <button className="small" onClick={() => setOrderbookConfirm(null)}>Abbrechen</button>
              <button className="small danger" onClick={confirmClearOrderbook}>Orderbook leeren</button>
            </div>
          </div>
        </div>
      )}
      {showCsvBuilder && (
        <div className="exchange-debug-backdrop" onClick={() => setShowCsvBuilder(false)}>
          <div className="csv-builder-modal" onClick={(event) => event.stopPropagation()}>
            <div className="exchange-debug-title">
              <strong>{t.csvBuilderTitle}</strong>
              <button className="small" onClick={() => setShowCsvBuilder(false)}>×</button>
            </div>
            <p>{t.csvBuilderHint}</p>
            <div className="csv-builder-grid">
              <label>
                {t.coin}
                <select
                  value={csvBuilder.coin}
                  onChange={(event) => setCsvBuilder((current) => ({ ...current, coin: event.target.value }))}
                >
                  {coinOptions.map((symbol) => {
                    const coin = symbol.replace(/USDT$/i, "");
                    return <option key={coin} value={coin}>{coin}</option>;
                  })}
                </select>
              </label>
              <label>
                {t.quote}
                <select
                  value={csvBuilder.quote}
                  onChange={(event) => setCsvBuilder((current) => ({ ...current, quote: event.target.value }))}
                >
                  <option value="USDT">USDT</option>
                  <option value="USDC">USDC</option>
                  <option value="BUSD">BUSD</option>
                </select>
              </label>
              <label>
                {t.timeframe}
                <select
                  value={csvBuilder.timeframe}
                  onChange={(event) => setCsvBuilder((current) => ({ ...current, timeframe: event.target.value }))}
                >
                  <option value="1m">1m</option>
                  <option value="5m">5m</option>
                  <option value="15m">15m</option>
                  <option value="30m">30m</option>
                  <option value="1h">1h</option>
                  <option value="4h">4h</option>
                  <option value="1d">1d</option>
                </select>
              </label>
              <label>
                {t.startYear}
                <input
                  type="number"
                  min="2017"
                  max="2100"
                  value={csvBuilder.startYear}
                  onChange={(event) => setCsvBuilder((current) => ({ ...current, startYear: event.target.value }))}
                />
              </label>
              <label>
                {t.startMonth}
                <input
                  type="number"
                  min="1"
                  max="12"
                  value={csvBuilder.startMonth}
                  onChange={(event) => setCsvBuilder((current) => ({ ...current, startMonth: event.target.value }))}
                />
              </label>
              <label>
                {t.months}
                <input
                  type="number"
                  min="1"
                  max="24"
                  value={csvBuilder.months}
                  onChange={(event) => setCsvBuilder((current) => ({ ...current, months: event.target.value }))}
                />
              </label>
              <div className="style-switches compact">
                <button className={csvBuilder.testnet ? "switch active" : "switch"} onClick={() => setCsvBuilder((current) => ({ ...current, testnet: true }))}>{t.testnet}</button>
                <button className={!csvBuilder.testnet ? "switch active" : "switch"} onClick={() => setCsvBuilder((current) => ({ ...current, testnet: false }))}>{t.mainnet}</button>
              </div>
            </div>
            <div className="csv-builder-actions">
              <button className="small" onClick={() => setShowCsvBuilder(false)}>{t.cancel}</button>
              <button className="small primary" onClick={downloadBinanceCsv} disabled={isExchangeBusy}>
                <FileDown size={16} />
                {t.csvDownload}
              </button>
            </div>
          </div>
        </div>
      )}

      {showLiveStatus && (
        <section className="live-status-bar">
          {showPhemexConnected && (
            <span className="phemex-status-mark" title="Phemex verbunden">
              <i>PX</i>
              <em>Phemex</em>
            </span>
          )}
          <span><strong>{t.chartLoaded}</strong><em>{activePhemexSettings.symbol} {timeframeFromResolution(activePhemexSettings.resolution)}</em></span>
          <span><strong>{t.liveModeLabel}</strong><em>Active</em></span>
          <span><strong>{t.accountBalance}</strong><em>{futuresBalance === null ? "-" : `${futuresBalance.toFixed(2)} USDT`}</em></span>
          <span><strong>{t.timeCounter}</strong><em>{liveCountdownSeconds !== null ? `${liveCountdownSeconds}s` : "-"}</em></span>
          <button className="small sync-button" onClick={() => syncPhemexExchangeState()} disabled={isExchangeBusy}>
            {t.syncExchange}
          </button>
        </section>
      )}

      <section className="workspace">
        <div className={showLiveStatus ? "chart-zone live-mode" : "chart-zone"}>
          <div className="market-strip">
          {showLiveStatus ? (
            <div className="market-favorite-dropdown">
              <button
                className="market-favorite-trigger"
                onClick={() => setIsMarketFavoritesOpen((value) => !value)}
                type="button"
              >
                <span>★</span>
                {activePhemexSettings.symbol}
                <small>Favoriten</small>
              </button>
              {isMarketFavoritesOpen && (
                <div className="market-favorite-menu">
              {favoriteCoinOptions.length ? (
                favoriteCoinOptions.map((symbol) => (
                  <button
                    key={symbol}
                    className={symbol === activePhemexSettings.symbol ? "active" : ""}
                    onClick={() => {
                      setIsMarketFavoritesOpen(false);
                      void changeMarketSymbol(symbol);
                    }}
                    type="button"
                  >
                    <span>★</span>
                    {symbol}
                  </button>
                ))
              ) : (
                <div className="market-empty-favorites">Keine Token-Favoriten</div>
              )}
                </div>
              )}
            </div>
          ) : (
            <>
              <span>{t.candles} {visibleCount}/{allCandles.length}</span>
              <strong>{t.last} {formatPrice(lastCandle?.close)}</strong>
              <span>{t.high} {formatPrice(lastCandle?.high)}</span>
              <span>{t.low} {formatPrice(lastCandle?.low)}</span>
            </>
          )}
          {showLiveStatus && (
            <select
              className="market-timeframe-select"
              value={activePhemexSettings.resolution}
              onChange={(event) => {
                void changeMarketTimeframe(event.target.value);
              }}
              title={t.timeframe}
            >
              <option value="60">1m</option>
              <option value="300">5m</option>
              <option value="900">15m</option>
              <option value="1800">30m</option>
              <option value="3600">1h</option>
              <option value="14400">4h</option>
            </select>
          )}
          <div className="chart-options">
              <button
                className={autoScalePrice ? "toggle active" : "toggle"}
                onClick={() => setAutoScalePrice((value) => !value)}
                title={t.priceScaleTitle}
              >
                <Focus size={15} />
                {t.autoScale}
              </button>
              <button
                className={autoFocusChart ? "toggle active" : "toggle"}
                onClick={() => setAutoFocusChart((value) => !value)}
                title={t.autoFocusTitle}
              >
                <Focus size={15} />
                {t.autoFocus}
              </button>
              <button
                className={showChartOptions ? "toggle active" : "toggle"}
                onClick={() => setShowChartOptions((value) => !value)}
                title={t.chartOptionsTitle}
              >
                <Palette size={15} />
                {t.options}
              </button>
            </div>
          </div>
          <div className="chart-wrap">
            <div className="chart" ref={chartElement} />
            <div className="drawing-toolbar" aria-label="Chart tools">
              <button
                className={drawingTool === "cursor" ? "active" : ""}
                onClick={() => setDrawingTool("cursor")}
                title={t.cursorTool}
              >
                <MousePointer2 size={16} />
              </button>
              <button
                className={drawingTool === "line" ? "active" : ""}
                onClick={() => setDrawingTool("line")}
                title={t.lineTool}
              >
                <Minus size={17} />
              </button>
              <button
                className={drawingTool === "horizontal" ? "active" : ""}
                onClick={() => setDrawingTool("horizontal")}
                title={t.horizontalTool}
              >
                <MoveHorizontal size={17} />
              </button>
              <button
                className={drawingTool === "ray" ? "active" : ""}
                onClick={() => setDrawingTool("ray")}
                title={t.rayTool}
              >
                <span className="ray-icon" />
              </button>
              <button
                className={drawingTool === "rect" ? "active" : ""}
                onClick={() => setDrawingTool("rect")}
                title={t.rectTool}
              >
                <Square size={16} />
              </button>
              <button
                className={drawingTool === "zigzag" ? "active" : ""}
                onClick={() => {
                  setZigZagDraftPoints([]);
                  setDrawingTool("zigzag");
                }}
                title={t.zigzagTool}
              >
                <span className="zigzag-icon" />
              </button>
              <button
                onClick={() => setDrawings([])}
                title={t.clearDrawings}
                disabled={!drawings.length}
              >
                <Trash2 size={16} />
              </button>
            </div>
            <svg
              className={drawingTool === "cursor" ? "drawing-layer" : "drawing-layer active"}
              onMouseDown={startDrawing}
              onMouseMove={updateDrawing}
              onMouseUp={finishDrawing}
              onMouseLeave={finishDrawing}
              onContextMenuCapture={finishDrawingWithContextMenu}
              onDoubleClick={(event) => {
                event.preventDefault();
                finishZigZagDrawing();
              }}
            >
              {projectedDrawings.map(({ drawing, start, end }) => {
                const isSelected = selectedDrawingId === drawing.id;
                if (drawing.tool === "zigzag" && drawing.points?.length) {
                  const pointString = drawing.points
                    .map((point) => drawingPointToScreen(point))
                    .filter(Boolean)
                    .map((point) => `${point?.x},${point?.y}`)
                    .join(" ");
                  if (!pointString) return null;
                  return (
                    <React.Fragment key={drawing.id}>
                      <polyline
                        className="drawing-hit-area"
                        points={pointString}
                        onMouseDown={(event) => startDrawingMove(event, drawing)}
                        onContextMenu={(event) => openDrawingContextMenu(event, drawing)}
                      />
                      <polyline
                        className={[
                          drawing.id === "ZIGZAG-DRAFT" ? "drawing-shape draft" : "drawing-shape zigzag",
                          isSelected ? "selected" : "",
                          drawing.locked ? "locked" : ""
                        ].join(" ")}
                        points={pointString}
                        style={{ stroke: drawing.strokeColor, strokeWidth: drawing.lineWidth }}
                        onMouseDown={(event) => startDrawingMove(event, drawing)}
                        onContextMenu={(event) => openDrawingContextMenu(event, drawing)}
                      />
                      {isSelected && !drawing.locked && drawing.id !== "ZIGZAG-DRAFT" && drawing.points.map((point, index) => {
                        const screenPoint = drawingPointToScreen(point);
                        if (!screenPoint) return null;
                        return (
                          <circle
                            key={`${drawing.id}-point-${index}`}
                            className="drawing-handle"
                            cx={screenPoint.x}
                            cy={screenPoint.y}
                            r={5}
                            onMouseDown={(event) => startZigZagPointMove(event, drawing, index)}
                            onContextMenu={(event) => openDrawingContextMenu(event, drawing)}
                          />
                        );
                      })}
                    </React.Fragment>
                  );
                }
                if (drawing.tool === "rect") {
                  const x = Math.min(start.x, end.x);
                  const y = Math.min(start.y, end.y);
                  const topLeft = { x, y };
                  const topRight = { x: x + Math.abs(end.x - start.x), y };
                  const bottomRight = { x: topRight.x, y: y + Math.abs(end.y - start.y) };
                  const bottomLeft = { x, y: bottomRight.y };
                  return (
                    <React.Fragment key={drawing.id}>
                      <rect
                        className="drawing-hit-area rect-hit"
                        onMouseDown={(event) => startDrawingMove(event, drawing)}
                        onContextMenu={(event) => openDrawingContextMenu(event, drawing)}
                        x={x}
                        y={y}
                        width={Math.abs(end.x - start.x)}
                        height={Math.abs(end.y - start.y)}
                      />
                      <rect
                        className={[
                          drawingDraft?.id === drawing.id ? "drawing-shape draft" : "drawing-shape rect",
                        isSelected ? "selected" : "",
                        drawing.locked ? "locked" : ""
                        ].join(" ")}
                        style={{
                          fill: `${drawing.fillColor}22`,
                          stroke: drawing.strokeColor,
                          strokeWidth: drawing.borderWidth
                        }}
                        onMouseDown={(event) => startDrawingMove(event, drawing)}
                        onContextMenu={(event) => openDrawingContextMenu(event, drawing)}
                        x={x}
                        y={y}
                        width={Math.abs(end.x - start.x)}
                        height={Math.abs(end.y - start.y)}
                      />
                      {isSelected && !drawing.locked && (
                        <>
                          <circle className="drawing-handle" cx={topLeft.x} cy={topLeft.y} r={5} onMouseDown={(event) => startDrawingResize(event, drawing, "topLeft")} onContextMenu={(event) => openDrawingContextMenu(event, drawing)} />
                          <circle className="drawing-handle" cx={topRight.x} cy={topRight.y} r={5} onMouseDown={(event) => startDrawingResize(event, drawing, "topRight")} onContextMenu={(event) => openDrawingContextMenu(event, drawing)} />
                          <circle className="drawing-handle" cx={bottomRight.x} cy={bottomRight.y} r={5} onMouseDown={(event) => startDrawingResize(event, drawing, "bottomRight")} onContextMenu={(event) => openDrawingContextMenu(event, drawing)} />
                          <circle className="drawing-handle" cx={bottomLeft.x} cy={bottomLeft.y} r={5} onMouseDown={(event) => startDrawingResize(event, drawing, "bottomLeft")} onContextMenu={(event) => openDrawingContextMenu(event, drawing)} />
                        </>
                      )}
                    </React.Fragment>
                  );
                }
                return (
                  <React.Fragment key={drawing.id}>
                    <line
                      className="drawing-hit-area"
                      onMouseDown={(event) => startDrawingMove(event, drawing)}
                      onContextMenu={(event) => openDrawingContextMenu(event, drawing)}
                      x1={start.x}
                      y1={start.y}
                      x2={end.x}
                      y2={end.y}
                    />
                    <line
                      className={[
                        drawingDraft?.id === drawing.id ? "drawing-shape draft" : `drawing-shape ${drawing.tool}`,
                      isSelected ? "selected" : "",
                      drawing.locked ? "locked" : ""
                      ].join(" ")}
                      style={{ stroke: drawing.strokeColor, strokeWidth: drawing.lineWidth }}
                      onMouseDown={(event) => startDrawingMove(event, drawing)}
                      onContextMenu={(event) => openDrawingContextMenu(event, drawing)}
                      x1={start.x}
                      y1={start.y}
                      x2={end.x}
                      y2={end.y}
                    />
                    {isSelected && !drawing.locked && (
                      <>
                        <circle className="drawing-handle" cx={start.x} cy={start.y} r={5} onMouseDown={(event) => startDrawingResize(event, drawing, "start")} onContextMenu={(event) => openDrawingContextMenu(event, drawing)} />
                        <circle className="drawing-handle" cx={end.x} cy={end.y} r={5} onMouseDown={(event) => startDrawingResize(event, drawing, "end")} onContextMenu={(event) => openDrawingContextMenu(event, drawing)} />
                      </>
                    )}
                  </React.Fragment>
                );
              })}
            </svg>
            {lineControls.map(({ order, y, x, controlsX }) => (
              <React.Fragment key={order.id}>
                <div
                  className={`entry-line-connector ${order.side}`}
                  style={{
                    top: y,
                    left: Math.min(x, controlsX),
                    width: Math.abs(controlsX - x)
                  }}
                />
              <div
                className="entry-line-controls"
                style={{ top: y, left: controlsX }}
              >
                {order.takeProfit === undefined && (
                  <button
                    className="line-chip tp"
                    onClick={() => handleProtectionChipClick(order.id, "takeProfit")}
                    onMouseDown={(event) => startProtectionDrag(event, order.id, "takeProfit")}
                  >
                    TP
                  </button>
                )}
                {order.stopLoss === undefined && (
                  <button
                    className="line-chip sl"
                    onClick={() => handleProtectionChipClick(order.id, "stopLoss")}
                    onMouseDown={(event) => startProtectionDrag(event, order.id, "stopLoss")}
                  >
                    SL
                  </button>
                )}
                <span className="line-order-size">{order.quantity}</span>
                <span className="line-order-label">{order.side === "buy" ? "Buy Limit" : "Sell Limit"}</span>
              </div>
              </React.Fragment>
            ))}
            {orderLineLabels.map(({ order, field, y, price, x }) => (
              <React.Fragment key={`${order.id}-${field}`}>
                {x === undefined && <div className={`order-label-connector ${field}`} style={{ top: y }} />}
                <div className={`order-line-label ${field}`} style={{ top: y, left: x, right: x === undefined ? undefined : "auto" }}>
                  <span>
                    {field === "entry" ? "ENTRY" : field === "takeProfit" ? "TP" : "SL"}
                  </span>
                  <strong>{formatPrice(price)}</strong>
                </div>
              </React.Fragment>
            ))}
            {drawingMenu && menuDrawing && (
              <div
                className="drawing-context-menu"
                style={{ left: drawingMenu.x, top: drawingMenu.y }}
                onClick={(event) => event.stopPropagation()}
              >
                <button onClick={() => toggleDrawingLock(drawingMenu.id)}>
                  {menuDrawing.locked ? <LockOpen size={15} /> : <Lock size={15} />}
                  {menuDrawing.locked ? "Entsperren" : "Fixieren"}
                </button>
                <label className="drawing-color-control">
                  <span>{menuDrawing.tool === "rect" ? "Rahmen" : "Farbe"}</span>
                  <input
                    type="color"
                    value={menuDrawing.strokeColor}
                    onChange={(event) => updateDrawingColor(drawingMenu.id, "strokeColor", event.target.value)}
                  />
                </label>
                {menuDrawing.tool === "rect" && (
                  <label className="drawing-color-control">
                    <span>Körper</span>
                    <input
                      type="color"
                      value={menuDrawing.fillColor}
                      onChange={(event) => updateDrawingColor(drawingMenu.id, "fillColor", event.target.value)}
                    />
                  </label>
                )}
                {menuDrawing.tool !== "rect" && (
                  <label className="drawing-range-control">
                    <span>Linienstärke</span>
                    <input
                      type="range"
                      min="1"
                      max="8"
                      step="0.2"
                      value={menuDrawing.lineWidth}
                      onChange={(event) => updateDrawingNumber(drawingMenu.id, "lineWidth", Number(event.target.value))}
                    />
                    <strong>{menuDrawing.lineWidth.toFixed(1)}</strong>
                  </label>
                )}
                {menuDrawing.tool === "rect" && (
                  <label className="drawing-range-control">
                    <span>Rahmenstärke</span>
                    <input
                      type="range"
                      min="1"
                      max="8"
                      step="0.2"
                      value={menuDrawing.borderWidth}
                      onChange={(event) => updateDrawingNumber(drawingMenu.id, "borderWidth", Number(event.target.value))}
                    />
                    <strong>{menuDrawing.borderWidth.toFixed(1)}</strong>
                  </label>
                )}
                <button onClick={() => deleteDrawing(drawingMenu.id)} disabled={menuDrawing.locked}>
                  <Trash2 size={15} />
                  Löschen
                </button>
              </div>
            )}
            {showChartOptions && (
              <div className="chart-style-panel">
                <div className="style-panel-title">
                  <Palette size={16} />
                  {t.chartDesign}
                </div>

                <div className="settings-tabs">
                  <button className={settingsTab === "colors" ? "tab active" : "tab"} onClick={() => setSettingsTab("colors")}>{t.colors}</button>
                  <button className={settingsTab === "chart" ? "tab active" : "tab"} onClick={() => setSettingsTab("chart")}>{t.chart}</button>
                  <button className={settingsTab === "orders" ? "tab active" : "tab"} onClick={() => setSettingsTab("orders")}>{t.orders}</button>
                  <button className={settingsTab === "drawings" ? "tab active" : "tab"} onClick={() => setSettingsTab("drawings")}>{t.drawings}</button>
                  <button className={settingsTab === "phemex" ? "tab active" : "tab"} onClick={() => setSettingsTab("phemex")}>{t.exchange}</button>
                  <button className={settingsTab === "language" ? "tab active" : "tab"} onClick={() => setSettingsTab("language")}>{t.language}</button>
                </div>

                {settingsTab === "colors" && (
                  <>
                    <div className="style-section">
                      <div className="style-section-title">{t.candlesSection}</div>
                      <div className="style-grid">
                        <label>{t.bodyUp}<input type="color" value={chartTheme.upColor} onChange={(event) => updateTheme("upColor", event.target.value)} /></label>
                        <label>{t.bodyDown}<input type="color" value={chartTheme.downColor} onChange={(event) => updateTheme("downColor", event.target.value)} /></label>
                        <label>{t.wickUp}<input type="color" value={chartTheme.upWickColor} onChange={(event) => updateTheme("upWickColor", event.target.value)} /></label>
                        <label>{t.wickDown}<input type="color" value={chartTheme.downWickColor} onChange={(event) => updateTheme("downWickColor", event.target.value)} /></label>
                        <label>{t.borderUp}<input type="color" value={chartTheme.upBorderColor} onChange={(event) => updateTheme("upBorderColor", event.target.value)} /></label>
                        <label>{t.borderDown}<input type="color" value={chartTheme.downBorderColor} onChange={(event) => updateTheme("downBorderColor", event.target.value)} /></label>
                      </div>
                    </div>
                    <div className="style-section">
                      <div className="style-section-title">{t.chartArea}</div>
                      <div className="style-grid">
                        <label>{t.background}<input type="color" value={chartTheme.backgroundColor} onChange={(event) => updateTheme("backgroundColor", event.target.value)} /></label>
                        <label>{t.grid}<input type="color" value={chartTheme.gridColor} onChange={(event) => updateTheme("gridColor", event.target.value)} /></label>
                        <label>{t.text}<input type="color" value={chartTheme.textColor} onChange={(event) => updateTheme("textColor", event.target.value)} /></label>
                      </div>
                    </div>
                  </>
                )}

                {settingsTab === "chart" && (
                  <div className="style-section">
                    <div className="style-section-title">{t.behavior}</div>
                    <div className="style-switches">
                      <button className={chartTheme.showGrid ? "switch active" : "switch"} onClick={() => toggleTheme("showGrid")}>{t.grid}</button>
                      <button className={chartTheme.showLastPriceLine ? "switch active" : "switch"} onClick={() => toggleTheme("showLastPriceLine")}>{t.priceLine}</button>
                      <button className={chartTheme.showCrosshair ? "switch active" : "switch"} onClick={() => toggleTheme("showCrosshair")}>{t.crosshair}</button>
                      <button className={chartTheme.allowMouseWheel ? "switch active" : "switch"} onClick={() => toggleTheme("allowMouseWheel")}>{t.mouseWheel}</button>
                      <button className={chartTheme.allowDrag ? "switch active" : "switch"} onClick={() => toggleTheme("allowDrag")}>{t.drag}</button>
                    </div>
                  </div>
                )}

                {settingsTab === "orders" && (
                  <div className="style-section">
                    <div className="style-section-title">{t.orderDisplay}</div>
                    <div className="style-switches">
                      <button className={chartTheme.orderControlsSide === "right" ? "switch active" : "switch"} onClick={() => setChartTheme((current) => ({ ...current, orderControlsSide: "right" }))}>{t.orderControlsRight}</button>
                      <button className={chartTheme.orderControlsSide === "left" ? "switch active" : "switch"} onClick={() => setChartTheme((current) => ({ ...current, orderControlsSide: "left" }))}>{t.orderControlsLeft}</button>
                    </div>
                  </div>
                )}

                {settingsTab === "drawings" && (
                  <div className="style-section">
                    <div className="style-section-title">{t.drawingDisplay}</div>
                    <label className="range-setting">
                      <span>{t.drawingSize}</span>
                      <input
                        type="range"
                        min="1"
                        max="5"
                        step="0.2"
                        value={chartTheme.drawingSize}
                        onChange={(event) => setChartTheme((current) => ({ ...current, drawingSize: Number(event.target.value) }))}
                      />
                      <strong>{chartTheme.drawingSize.toFixed(1)}</strong>
                    </label>
                  </div>
                )}

                {settingsTab === "phemex" && (
                  <div className="style-section">
                    <div className="style-section-title">{t.phemexConnection}</div>
                    <div className="exchange-subsection">
                      <div className="subsection-title">{t.connectionSection}</div>
                      <label className="exchange-select-card">
                        <span>Exchange</span>
                        <select
                          value={phemexSettings.exchange}
                          onChange={(event) => updatePhemexSetting("exchange", event.target.value as PhemexSettings["exchange"])}
                        >
                          <option value="phemex">Phemex</option>
                          <option value="binance">Binance</option>
                        </select>
                      </label>
                      <div className="api-settings-grid">
                        <label>
                          {t.apiKey}
                          <input
                            type="password"
                            value={phemexSettings.apiKey}
                            onChange={(event) => updatePhemexSetting("apiKey", event.target.value)}
                            autoComplete="off"
                          />
                        </label>
                        <label>
                          {t.apiSecret}
                          <input
                            type="password"
                            value={phemexSettings.apiSecret}
                            onChange={(event) => updatePhemexSetting("apiSecret", event.target.value)}
                            autoComplete="off"
                          />
                        </label>
                      </div>
                      <div className="api-actions connection-actions">
                        <button className="small" onClick={savePhemexSettings} disabled={isExchangeBusy}>{t.saveApiSettings}</button>
                        <button className="small" onClick={testPhemexConnection} disabled={isExchangeBusy}>{t.testConnection}</button>
                      </div>
                      <div className="style-switches compact">
                        <button className={phemexSettings.testnet ? "switch active" : "switch"} onClick={() => updatePhemexSetting("testnet", true)}>{t.testnet}</button>
                        <button className={!phemexSettings.testnet ? "switch active" : "switch"} onClick={() => updatePhemexSetting("testnet", false)}>{t.mainnet}</button>
                      </div>
                      <label className={phemexSettings.testnet ? "checkbox-row muted" : "checkbox-row warning"}>
                        <input
                          type="checkbox"
                          checked={phemexSettings.allowMainnetOrders}
                          onChange={(event) => updatePhemexSetting("allowMainnetOrders", event.target.checked)}
                          disabled={phemexSettings.testnet}
                        />
                        <span>
                          <strong>{t.allowMainnetOrders}</strong>
                          <small>{t.allowMainnetOrdersHint}</small>
                        </span>
                      </label>
                    </div>
                    <div className="exchange-subsection">
                      <div className="subsection-title">{t.dataModeSection}</div>
                      <div className="api-settings-grid">
                        <label>
                          {t.symbol}
                          <div className="coin-dropdown">
                            <button
                              type="button"
                              className="coin-dropdown-trigger"
                              onClick={() => setIsCoinDropdownOpen((value) => !value)}
                            >
                              <span>{phemexSettings.symbol}</span>
                              <small>{coinFavorites.includes(phemexSettings.symbol) ? "★" : "☆"}</small>
                            </button>
                            {isCoinDropdownOpen && (
                              <div className="coin-dropdown-menu">
                                {coinOptions.includes(phemexSettings.symbol) ? null : (
                                  <button
                                    type="button"
                                    className="coin-option selected"
                                    onClick={() => setIsCoinDropdownOpen(false)}
                                  >
                                    <span>{phemexSettings.symbol}</span>
                                    <small>☆</small>
                                  </button>
                                )}
                                {sortedCoinOptions.map((symbol) => {
                                  const isFavorite = coinFavorites.includes(symbol);
                                  return (
                                    <button
                                      type="button"
                                      className={symbol === phemexSettings.symbol ? "coin-option selected" : "coin-option"}
                                      key={symbol}
                                      onClick={() => {
                                        updatePhemexSetting("symbol", symbol);
                                        setIsCoinDropdownOpen(false);
                                      }}
                                    >
                                      <span>{symbol}</span>
                                      <small
                                        aria-label={`${symbol} Favorit`}
                                        onClick={(event) => {
                                          event.stopPropagation();
                                          toggleCoinFavorite(symbol);
                                        }}
                                      >
                                        {isFavorite ? "★" : "☆"}
                                      </small>
                                    </button>
                                  );
                                })}
                              </div>
                            )}
                          </div>
                        </label>
                        <label>
                          {t.exchangeMode}
                          <select
                            value={phemexSettings.mode}
                            onChange={(event) => updatePhemexSetting("mode", event.target.value as "replay" | "live")}
                          >
                            <option value="replay">{t.replayMode}</option>
                            <option value="live">{t.liveMode}</option>
                          </select>
                        </label>
                        <label>
                          {t.timeframe}
                          <select
                            value={phemexSettings.resolution}
                            onChange={(event) => updatePhemexSetting("resolution", event.target.value)}
                          >
                            <option value="60">1m</option>
                            <option value="300">5m</option>
                            <option value="900">15m</option>
                            <option value="1800">30m</option>
                            <option value="3600">1h</option>
                            <option value="14400">4h</option>
                          </select>
                        </label>
                        <label>
                          {t.candleLimit}
                          <select
                            value={phemexSettings.limit}
                            onChange={(event) => updatePhemexSetting("limit", event.target.value)}
                          >
                            <option value="100">100</option>
                            <option value="500">500</option>
                            <option value="1000">1000</option>
                          </select>
                        </label>
                        <label>
                          {t.pollSeconds}
                          <input
                            type="number"
                            min="1"
                            step="1"
                            value={phemexSettings.pollSeconds}
                            onChange={(event) => updatePhemexSetting("pollSeconds", event.target.value)}
                          />
                        </label>
                      </div>
                    </div>
                    <div className="exchange-status">
                      <div className={showLiveStatus ? "status-dot live" : exchangeRequestState === "error" ? "status-dot error" : "status-dot"} />
                      <div>
                        <strong>{t.liveStatus}: {exchangeStatusText}</strong>
                        <span>
                          {t.lastFetch}: {liveLastFetchAt ? new Date(liveLastFetchAt).toLocaleTimeString() : t.liveWaiting}
                          {showLiveStatus && liveCountdownSeconds !== null ? ` · ${t.nextFetch}: ${liveCountdownSeconds}s` : ""}
                        </span>
                      </div>
                    </div>
                    <div className="api-actions-group">
                      <div className="api-actions data-actions">
                        <button className="small primary" onClick={applyExchangeSettings} disabled={isExchangeBusy}>{t.applySettings}</button>
                        <button className="small" onClick={() => syncPhemexExchangeState()} disabled={isExchangeBusy}>{t.syncExchange}</button>
                        <button className="small primary" onClick={() => loadPhemexChart()} disabled={isExchangeBusy || isLiveRunning}>{t.loadReplayData}</button>
                        {isLiveRunning ? (
                          <button className="small danger" onClick={stopLiveMode} disabled={isExchangeBusy}>{t.stopLive}</button>
                        ) : (
                          <button className="small primary" onClick={startLiveMode} disabled={phemexSettings.mode !== "live" || isExchangeBusy}>{t.startLive}</button>
                        )}
                      </div>
                    </div>
                  </div>
                )}

                {settingsTab === "language" && (
                  <div className="style-section">
                    <div className="style-section-title">{t.language}</div>
                    <div className="style-switches">
                      <button className={language === "de" ? "switch active" : "switch"} onClick={() => setLanguage("de")}>{t.german}</button>
                      <button className={language === "en" ? "switch active" : "switch"} onClick={() => setLanguage("en")}>{t.english}</button>
                    </div>
                  </div>
                )}

                <button className="small" onClick={resetTheme}>{t.resetDefault}</button>
              </div>
            )}
            {chartMenu && (
              <div
                className="chart-context-menu"
                style={{ left: chartMenu.x, top: chartMenu.y }}
                onClick={(event) => event.stopPropagation()}
              >
                <div className="context-price">
                  <MousePointer2 size={16} />
                  {formatPrice(chartMenu.price)}
                </div>
                <button onClick={copyChartPrice}>
                  <Clipboard size={16} />
                  {t.copyPrice}
                </button>
                <button onClick={() => useChartPrice("entry")}>{t.useEntry}</button>
                <button onClick={() => useChartPrice("tp")}>{t.useTp}</button>
                <button onClick={() => useChartPrice("sl")}>{t.useSl}</button>
                {!isLiveRunning && (
                  <>
                    <button className="context-buy" onClick={() => createOrder("buy", chartMenu.price)}>
                      {t.buyOrderHere}
                    </button>
                    <button className="context-sell" onClick={() => createOrder("sell", chartMenu.price)}>
                      {t.sellOrderHere}
                    </button>
                  </>
                )}
              </div>
            )}
            {protectionConfirm && (
              <div
                className="protection-confirm"
                style={{ left: protectionConfirm.x, top: protectionConfirm.y }}
                onClick={(event) => event.stopPropagation()}
              >
                <strong>Änderung an Phemex senden?</strong>
                <span>{protectionConfirm.orderId}</span>
                <div>
                  <button className="small primary" onClick={sendProtectionConfirm}>Senden</button>
                  <button className="small" onClick={cancelProtectionConfirm}>Abbrechen</button>
                </div>
              </div>
            )}
          </div>
          {!showLiveStatus && (
            <div className="replay-controls">
              <button onClick={() => setIsPlaying((value) => !value)}>
                {isPlaying ? <Pause size={18} /> : <Play size={18} />}
                {isPlaying ? t.pause : t.play}
              </button>
              <button onClick={stepForward} disabled={visibleCount >= allCandles.length}>
                <SkipForward size={18} />
                {t.step}
              </button>
              <label>
                {t.replayDelay}
                <input
                  type="range"
                  min="100"
                  max="2500"
                  step="100"
                  value={speedMs}
                  onChange={(event) => setSpeedMs(Number(event.target.value))}
                />
                <span>{speedMs} ms</span>
              </label>
              <button onClick={resetReplay}>
                <RotateCcw size={18} />
                {t.reset}
              </button>
            </div>
          )}
        </div>

        <aside className="side-panel">
          {showLiveStatus ? (
            <div className="panel-block live-order-panel">
              <div className="live-order-top">
                <div className="live-order-switch">
                  <button
                    className={phemexSettings.marginMode === "cross" ? "active" : ""}
                    onClick={() => updatePhemexSetting("marginMode", "cross")}
                  >
                    {t.cross}
                  </button>
                  <button
                    className={phemexSettings.marginMode === "isolated" ? "active" : ""}
                    onClick={() => updatePhemexSetting("marginMode", "isolated")}
                  >
                    {t.isolated}
                  </button>
                </div>
                <label className="leverage-input">
                  {t.leverage}
                  <span>
                    <input
                      type="number"
                      min="1"
                      max="100"
                      step="1"
                      value={phemexSettings.leverage}
                      onChange={(event) => updatePhemexSetting("leverage", event.target.value)}
                    />
                    x
                  </span>
                </label>
              </div>

              <div className="live-order-type">Limit</div>

              <label className="live-field">
                {t.limitPrice}
                <div className="live-input-row">
                  <input
                    type="number"
                    value={entry}
                    placeholder={formatPrice(liveLastPrice ?? lastCandle?.close)}
                    onChange={(event) => setEntry(event.target.value)}
                  />
                  <button type="button" onClick={useLiveLastPrice} title={t.useLastPrice}>{t.lastPrice}</button>
                  <span>USDT</span>
                </div>
              </label>

              <label className="live-field">
                {t.size}
                <div className="live-input-row">
                  <input
                    type="number"
                    min="0.01"
                    step="0.01"
                    placeholder={`Min 0.01 ${baseAsset}`}
                    value={quantity}
                    onChange={(event) => {
                      setLiveCapitalPercent(0);
                      setQuantity(Number(event.target.value));
                    }}
                  />
                  <span>{baseAsset}</span>
                </div>
              </label>

              <div className="live-protection-grid">
                <label className="live-field">
                  {t.takeProfit}
                  <input
                    type="number"
                    value={takeProfit}
                    placeholder="TP"
                    onChange={(event) => setTakeProfit(event.target.value)}
                  />
                </label>
                <label className="live-field">
                  {t.stopLoss}
                  <input
                    type="number"
                    value={stopLoss}
                    placeholder="SL"
                    onChange={(event) => setStopLoss(event.target.value)}
                  />
                </label>
              </div>

              <div className="live-size-slider">
                <input
                  type="range"
                  min="0"
                  max="100"
                  step="1"
                  value={Math.min(liveCapitalPercent, 100)}
                  onChange={(event) => updateLiveCapitalPercent(Number(event.target.value))}
                />
                <label className="percent-input" title="Kapital in Prozent frei eingeben">
                  <input
                    type="number"
                    min="0"
                    step="0.1"
                    value={liveCapitalPercent}
                    onChange={(event) => updateLiveCapitalPercent(Number(event.target.value))}
                  />
                  <span>%</span>
                </label>
              </div>

              <div className="live-available">
                {t.available}: <strong>{futuresBalance === null ? "0.0000" : futuresBalance.toFixed(4)} USDT</strong>
              </div>

              <div className="live-order-summary">
                <span>{t.size}</span>
                <strong>{Number(quantity || 0).toFixed(4)} {baseAsset}</strong>
                <span>{t.cost}</span>
                <strong>
                  <em>{liveOrderMargin === undefined ? "0.0000" : liveOrderMargin.toFixed(4)}</em>
                  {" / "}
                  <b>{liveOrderNotional === undefined ? "0.0000" : liveOrderNotional.toFixed(4)}</b> USDT
                </strong>
                <span>{t.estimatedLiquidation}</span>
                <strong>-- / -- USDT</strong>
              </div>

              <div className="live-action-row">
                <button className="live-long" onClick={() => submitOrder("buy")} disabled={isExchangeBusy}>
                  {t.openLong}
                </button>
                <button className="live-short" onClick={() => submitOrder("sell")} disabled={isExchangeBusy}>
                  {t.openShort}
                </button>
              </div>
            </div>
          ) : (
            <div className="panel-block">
              <div className="panel-title">
                <Send size={18} />
                {t.order}
              </div>
              <div className="segmented">
                <button className={side === "buy" ? "active buy" : ""} onClick={() => setSide("buy")}>Buy</button>
                <button className={side === "sell" ? "active sell" : ""} onClick={() => setSide("sell")}>Sell</button>
              </div>
              <label>
                {t.quantity}
                <input type="number" min="0.01" step="0.01" value={quantity} onChange={(event) => setQuantity(Number(event.target.value))} />
              </label>
              <label>
                Entry
                <input type="number" placeholder={`Market ${formatPrice(lastCandle?.close)}`} value={entry} onChange={(event) => setEntry(event.target.value)} />
              </label>
              <label>
                {t.takeProfit}
                <input type="number" value={takeProfit} onChange={(event) => setTakeProfit(event.target.value)} />
              </label>
              <label>
                {t.stopLoss}
                <input type="number" value={stopLoss} onChange={(event) => setStopLoss(event.target.value)} />
              </label>
              <button className="submit" onClick={() => submitOrder()}>
                <Send size={18} />
                {t.submitOrder}
              </button>
            </div>
          )}

          <div className="panel-block orderbook">
            <div className="panel-title">
              <BookOpen size={18} />
              {t.orderbook}
              <button className="icon-button" onClick={requestClearOrderbook} title={t.clearOrderbook}>
                <Trash2 size={16} />
              </button>
            </div>
            <div className="book-list">
              {openOrders.length === 0 && <span className="empty">{t.noOpenOrders}</span>}
              {openOrders.map((order) => (
                <div className={`book-row ${order.status}-order`} key={order.id}>
                  <span className={order.side}>{order.side.toUpperCase()}</span>
                  <strong>{order.id}</strong>
                  <span>{formatPrice(order.entry)}</span>
                  <small className={`status-badge ${order.status}`}>
                    {order.status === "active" ? t.active : t.pending}
                  </small>
                  <small>TP {formatPrice(order.takeProfit)} / SL {formatPrice(order.stopLoss)}</small>
                </div>
              ))}
            </div>
          </div>
        </aside>
      </section>

      <section className="bottom-table">
        <div className="table-header">{t.tradesHistory}</div>
        <div className="table-grid head">
          <span>ID</span><span>Side</span><span>Qty</span><span>Entry</span><span>TP</span><span>SL</span><span>Status</span><span>Result</span><span>{t.action}</span>
        </div>
        {[...openOrders, ...closedOrders, ...canceledOrders].map((order) => (
          <div className={`table-grid ${order.status}-order`} key={`${order.id}-${order.status}`}>
            <span>{order.id}</span>
            <span className={order.side}>{order.side.toUpperCase()}</span>
            <span>{order.quantity}</span>
            <span>{formatPrice(order.entry)}</span>
            <span>
              {order.status === "pending" || order.status === "active" ? (
                <input
                  className="table-input"
                  type="number"
                  value={order.takeProfit ?? ""}
                  placeholder="TP"
                  onChange={(event) => updateOrderProtection(order.id, "takeProfit", event.target.value)}
                />
              ) : (
                formatPrice(order.takeProfit)
              )}
            </span>
            <span>
              {order.status === "pending" || order.status === "active" ? (
                <input
                  className="table-input"
                  type="number"
                  value={order.stopLoss ?? ""}
                  placeholder="SL"
                  onChange={(event) => updateOrderProtection(order.id, "stopLoss", event.target.value)}
                />
              ) : (
                formatPrice(order.stopLoss)
              )}
            </span>
            <span className={`status-badge ${order.status}`}>
              {order.status === "active" ? t.active : order.status === "pending" ? t.pending : order.status}
            </span>
            <span>{order.result ?? "-"}</span>
            <span className="table-actions">
              {(order.status === "pending" || order.status === "active") && (
                <>
                  <button
                    className="small"
                    onClick={() =>
                      isLiveRunning && (order.phemexOrderId || order.phemexClOrdId)
                        ? requestProtectionConfirm(order.id)
                        : confirmOrderProtection(order.id)
                    }
                    title={t.saveProtection}
                  >
                    <Save size={14} />
                  </button>
                  <button
                    className="small danger"
                    onClick={() => order.status === "active" ? closeActiveOrder(order.id) : cancelOrder(order.id)}
                  >
                    {order.status === "active" ? t.close : t.cancel}
                  </button>
                </>
              )}
              {order.status !== "pending" && order.status !== "active" && (
                <button className="small" onClick={() => deleteOrder(order.id)}>
                  <Trash2 size={14} />
                </button>
              )}
            </span>
          </div>
        ))}
      </section>
    </main>
  );
}

createRoot(document.getElementById("root")!).render(<TradingApp />);

