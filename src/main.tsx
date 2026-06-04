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

type DrawingTool = "cursor" | "line" | "horizontal" | "ray" | "rect" | "zigzag";

type DrawingPoint = {
  logical: number;
  price: number;
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
type SettingsTab = "colors" | "chart" | "orders" | "drawings" | "language";

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
const defaultDrawingStrokeColor = "#7db8ff";
const defaultDrawingFillColor = "#7db8ff";
const rightPriceScaleOffset = 64;

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
        points: Array.isArray(item.points) ? item.points : undefined,
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
    return parsed.filter((item) =>
      item &&
      item.status === "pending" &&
      (item.side === "buy" || item.side === "sell") &&
      typeof item.id === "string" &&
      Number.isFinite(item.quantity) &&
      Number.isFinite(item.entry)
    );
  } catch {
    return [];
  }
};

const translations = {
  de: {
    appTitle: "Chart_Replay_Tool",
    csvLoad: "CSV laden",
    candles: "Kerzen",
    last: "Last",
    high: "High",
    low: "Low",
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
    candlesSection: "Kerzen",
    chartArea: "Chart-Fläche",
    behavior: "Verhalten",
    orderDisplay: "Order-Anzeige",
    drawingDisplay: "Zeichenwerkzeuge",
    drawingSize: "Größe",
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
    buyHere: "Buy Order hier",
    sellHere: "Sell Order hier",
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
    candles: "Candles",
    last: "Last",
    high: "High",
    low: "Low",
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
    candlesSection: "Candles",
    chartArea: "Chart Area",
    behavior: "Behavior",
    orderDisplay: "Order Display",
    drawingDisplay: "Drawing Tools",
    drawingSize: "Size",
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
    buyHere: "Buy Order Here",
    sellHere: "Sell Order Here",
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
  const chartElement = useRef<HTMLDivElement | null>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const candleSeriesRef = useRef<ISeriesApi<"Candlestick"> | null>(null);
  const lineSeriesRef = useRef<Map<string, ISeriesApi<"Line">>>(new Map());
  const shouldFitContentRef = useRef(true);
  const shouldFitPriceRef = useRef(true);
  const previousVisibleCountRef = useRef(0);
  const previousCandleSetRef = useRef<Candle[] | null>(null);
  const overlayRefreshFrameRef = useRef(0);
  const overlayRefreshFollowUpFrameRef = useRef(0);
  const hasChartOverlaysRef = useRef(false);
  const ordersRef = useRef<TradeOrder[]>([]);
  const draggedLineRef = useRef<DraggedOrderLine | null>(null);
  const draggedChipRef = useRef<{ orderId: string; field: "takeProfit" | "stopLoss" } | null>(null);
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
  const [quantity, setQuantity] = useState(1);
  const [entry, setEntry] = useState("");
  const [takeProfit, setTakeProfit] = useState("");
  const [stopLoss, setStopLoss] = useState("");
  const [chartMenu, setChartMenu] = useState<ChartMenu | null>(null);
  const [autoScalePrice, setAutoScalePrice] = useState(false);
  const [autoFocusChart, setAutoFocusChart] = useState(false);
  const [showChartOptions, setShowChartOptions] = useState(false);
  const [settingsTab, setSettingsTab] = useState<SettingsTab>("colors");
  const [chartTheme, setChartTheme] = useState<ChartTheme>(defaultTheme);
  const [drawingTool, setDrawingTool] = useState<DrawingTool>("cursor");
  const [drawings, setDrawings] = useState<DrawingShape[]>(() => loadStoredDrawings());
  const [drawingDraft, setDrawingDraft] = useState<DrawingShape | null>(null);
  const [zigZagDraftPoints, setZigZagDraftPoints] = useState<DrawingPoint[]>([]);
  const [selectedDrawingId, setSelectedDrawingId] = useState<string | null>(null);
  const [drawingMenu, setDrawingMenu] = useState<DrawingMenu | null>(null);
  const [chartViewVersion, setChartViewVersion] = useState(0);
  const [language, setLanguage] = useState<Language>("de");
  const t = translations[language];
  const [message, setMessage] = useState(translations.de.demoLoaded);
  const [messageKind, setMessageKind] = useState<"demo" | "chartCsv" | "custom">("demo");

  const visibleCandles = useMemo(() => allCandles.slice(0, visibleCount), [allCandles, visibleCount]);
  const lastCandle = visibleCandles.at(-1);
  const openOrders = useMemo(
    () => orders.filter((order) => order.status === "pending" || order.status === "active"),
    [orders]
  );
  const closedOrders = useMemo(() => orders.filter((order) => order.status === "closed"), [orders]);
  const canceledOrders = useMemo(() => orders.filter((order) => order.status === "canceled"), [orders]);

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
      return { logical: candleIndex, price: snappedPrice };
    }

    return { logical: Number(logical), price };
  }, [visibleCandles]);

  const drawingPointToScreen = useCallback((point: DrawingPoint) => {
    const chart = chartRef.current;
    const series = candleSeriesRef.current;
    const x = chart?.timeScale().logicalToCoordinate(point.logical as Logical);
    const y = series?.priceToCoordinate(point.price);
    if (x === null || x === undefined || y === null || y === undefined) return null;
    return { x, y };
  }, []);

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

  const scheduleOverlayRefresh = useCallback((withFollowUp = false) => {
    window.cancelAnimationFrame(overlayRefreshFrameRef.current);
    if (withFollowUp) window.cancelAnimationFrame(overlayRefreshFollowUpFrameRef.current);
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
    };
  }, []);

  useEffect(() => {
    window.localStorage.setItem(drawingsStorageKey, JSON.stringify(drawings));
  }, [drawings]);

  useEffect(() => {
    const pendingOrders = orders.filter((order) => order.status === "pending");
    window.localStorage.setItem(pendingOrdersStorageKey, JSON.stringify(pendingOrders));
  }, [orders]);

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
      scheduleOverlayRefresh();
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
    const canAppendSingleCandle = !candleSetChanged && visibleCount === previousVisibleCountRef.current + 1;
    const keepManualRange = !autoFocusChart && !shouldFitContentRef.current;
    const visibleRange = keepManualRange ? chart?.timeScale().getVisibleLogicalRange() : null;

    if (candleSeries) {
      if (canAppendSingleCandle && autoFocusChart) {
        const nextCandle = allCandles[visibleCount - 1];
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

    if (autoFocusChart || shouldFitContentRef.current) {
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
      const controls = openOrders
        .filter((order) => order.status === "pending" && (order.takeProfit === undefined || order.stopLoss === undefined))
        .map((order) => {
          const y = series.priceToCoordinate(order.entry);
          const orderIndex = allCandles.findIndex((candle) => candle.time === order.openedAt);
          const logical = (orderIndex >= 0 ? orderIndex : visibleCandles.length - 1) as Logical;
          const coordinate = chartRef.current?.timeScale().logicalToCoordinate(logical);
          const x = coordinate === null || coordinate === undefined ? chartWidth * 0.58 : coordinate;
          const paneWidth = Math.max(0, chartWidth - rightPriceScaleOffset);
          const controlWidth = 286;
          const controlsX = Math.max(12, paneWidth - controlWidth + 66);
          return y === null ? undefined : { order, y, x, controlsX };
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
          if (y !== null) {
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
      setDrawings((current) =>
        current.map((drawing) => {
          if (drawing.id !== drag.id) return drawing;
          if (drawing.locked) return drawing;
          if (drawing.tool === "zigzag" && drag.pointIndex !== undefined) {
            const points = drawing.points?.map((existingPoint, index) =>
              index === drag.pointIndex ? point : existingPoint
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
            if (drag.handle === "topLeft") return { ...drawing, start: point };
            if (drag.handle === "bottomRight") return { ...drawing, end: point };
            if (drag.handle === "topRight") {
              return {
                ...drawing,
                start: { ...drawing.start, price: point.price },
                end: { ...drawing.end, logical: point.logical }
              };
            }
            if (drag.handle === "bottomLeft") {
              return {
                ...drawing,
                start: { ...drawing.start, logical: point.logical },
                end: { ...drawing.end, price: point.price }
              };
            }
          }
          if (drag.handle === "start") {
            if (drawing.tool === "ray" || drawing.tool === "horizontal") {
              return {
                ...drawing,
                start: point,
                end: { ...drawing.end, price: point.price }
              };
            }
            return { ...drawing, start: point };
          }
          if (drag.handle === "end") {
            if (drawing.tool === "ray" || drawing.tool === "horizontal") {
              return {
                ...drawing,
                end: { logical: point.logical, price: drawing.start.price }
              };
            }
            return { ...drawing, end: point };
          }
          return {
            ...drag.original,
            start: {
              logical: drag.original.start.logical + logicalDelta,
              price: drag.original.start.price + priceDelta
            },
            end: {
              logical: drag.original.end.logical + logicalDelta,
              price: drag.original.end.price + priceDelta
            },
            points: drag.original.points?.map((point) => ({
              logical: point.logical + logicalDelta,
              price: point.price + priceDelta
            }))
          };
        })
      );
    };

    const handleMouseUp = () => {
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
        chartNode.classList.toggle("line-hover", findOrderLineAt(mouseY) !== null);
        return;
      }

      event.preventDefault();
      event.stopPropagation();
      const price = candleSeriesRef.current?.coordinateToPrice(mouseY);
      if (price === null || price === undefined) return;
      const target = activeLine ?? activeChip;
      if (!target) return;

      setOrders((current) =>
        current.map((order) =>
          order.id === target.orderId && (order.status === "pending" || order.status === "active")
            ? {
                ...(target.field === "entry"
                  ? normalizeProtectionAfterEntryMove(order, Number(price.toFixed(4)))
                  : {
                      ...order,
                      [target.field]: isProtectionDockedAtEntry(order, price)
                        ? undefined
                        : activeChip && !isProtectionPriceValid(order, target.field, price)
                          ? order[target.field]
                          : Number(clampProtectionPrice(order, target.field, price).toFixed(4))
                    })
              }
            : order
        )
      );
    };

    const handleMouseUp = () => {
      scheduleOverlayRefresh(true);
      if (!draggedLineRef.current && !draggedChipRef.current) return;
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
      if (orderId) setMessage(t.protectionUpdated(orderId));
    };

    const handleWheel = () => {
      scheduleOverlayRefresh(true);
    };

    const closeMenu = () => {
      setChartMenu(null);
      setDrawingMenu(null);
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
  }, [scheduleOverlayRefresh, t]);

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

  const createOrder = (orderSide: Side, orderEntry: number, options?: { keepInputs?: boolean }) => {
    if (!lastCandle) return;
    const parsedTp = takeProfit ? Number(takeProfit) : undefined;
    const parsedSl = stopLoss ? Number(stopLoss) : undefined;

    if (!Number.isFinite(orderEntry) || !Number.isFinite(quantity) || quantity <= 0) {
      setMessage(t.orderNeedsInput);
      return;
    }

    const nextNumber = orders.length + 1;
    const order: TradeOrder = {
      id: `ORD-${String(nextNumber).padStart(4, "0")}`,
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

  const submitOrder = () => {
    if (!lastCandle) return;
    const parsedEntry = entry ? Number(entry) : lastCandle.close;
    createOrder(side, parsedEntry);
  };

  const cancelOrder = (orderId: string) => {
    setOrders((current) =>
      current.map((order) =>
        (order.id === orderId && (order.status === "pending" || order.status === "active"))
          ? { ...order, status: "canceled", closedAt: lastCandle?.time, result: "CANCEL" }
          : order
      )
    );
    setMessage(t.orderCanceled(orderId));
  };

  const deleteOrder = (orderId: string) => {
    setOrders((current) => current.filter((order) => order.id !== orderId));
    setMessage(t.orderDeleted(orderId));
  };

  const updateOrderProtection = (orderId: string, field: "takeProfit" | "stopLoss", value: string) => {
    const parsed = value === "" ? undefined : Number(value);
    if (value !== "" && !Number.isFinite(parsed)) {
      setMessage(t.invalidProtection);
      return;
    }

    setOrders((current) =>
      current.map((order) =>
        order.id === orderId && (order.status === "pending" || order.status === "active")
          ? {
              ...order,
              [field]: parsed === undefined ? undefined : Number(clampProtectionPrice(order, field, parsed).toFixed(4))
            }
          : order
      )
    );
  };

  const confirmOrderProtection = (orderId: string) => {
    setMessage(t.protectionUpdated(orderId));
  };

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
          ? { logical: point.logical, price: draft.start.price }
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
        <div>
          <h1>{t.appTitle}</h1>
          <p>{message}</p>
        </div>
        <label className="file-button">
          <FileUp size={18} />
          {t.csvLoad}
          <input type="file" accept=".csv,text/csv" onChange={(event) => handleCsv(event.target.files?.[0])} />
        </label>
      </section>

      <section className="workspace">
        <div className="chart-zone">
          <div className="market-strip">
            <span>{t.candles} {visibleCount}/{allCandles.length}</span>
            <strong>{t.last} {formatPrice(lastCandle?.close)}</strong>
            <span>{t.high} {formatPrice(lastCandle?.high)}</span>
            <span>{t.low} {formatPrice(lastCandle?.low)}</span>
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
                <button className="buy-action" onClick={() => createOrder("buy", chartMenu.price, { keepInputs: true })}>
                  {t.buyHere}
                </button>
                <button className="sell-action" onClick={() => createOrder("sell", chartMenu.price, { keepInputs: true })}>
                  {t.sellHere}
                </button>
              </div>
            )}
          </div>
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
        </div>

        <aside className="side-panel">
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
            <button className="submit" onClick={submitOrder}>
              <Send size={18} />
              {t.submitOrder}
            </button>
          </div>

          <div className="panel-block orderbook">
            <div className="panel-title">
              <BookOpen size={18} />
              {t.orderbook}
              <button className="icon-button" onClick={() => setOrders([])} title={t.clearOrderbook}>
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
                  <button className="small" onClick={() => confirmOrderProtection(order.id)} title={t.saveProtection}>
                    <Save size={14} />
                  </button>
                  <button className="small danger" onClick={() => cancelOrder(order.id)}>
                    {t.cancel}
                  </button>
                </>
              )}
              <button className="small" onClick={() => deleteOrder(order.id)}>
                <Trash2 size={14} />
              </button>
            </span>
          </div>
        ))}
      </section>
    </main>
  );
}

createRoot(document.getElementById("root")!).render(<TradingApp />);
