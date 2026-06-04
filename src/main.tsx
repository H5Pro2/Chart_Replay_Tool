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
  Time
} from "lightweight-charts";
import Papa from "papaparse";
import {
  BookOpen,
  Clipboard,
  Save,
  MousePointer2,
  Focus,
  FileUp,
  Palette,
  Pause,
  Play,
  RotateCcw,
  Send,
  SkipForward,
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
};

type Language = "de" | "en";

const defaultTheme: ChartTheme = {
  upColor: "#22c55e",
  downColor: "#ef4444",
  upWickColor: "#22c55e",
  downWickColor: "#ef4444",
  upBorderColor: "#22c55e",
  downBorderColor: "#ef4444",
  backgroundColor: "#11151c",
  gridColor: "#222936",
  textColor: "#c7d0df",
  showGrid: true,
  showLastPriceLine: true,
  showCrosshair: true,
  allowMouseWheel: true,
  allowDrag: true,
  orderControlsSide: "right"
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
    chartDesign: "Chart-Design",
    candlesSection: "Kerzen",
    chartArea: "Chart-Fläche",
    behavior: "Verhalten",
    orderDisplay: "Order-Anzeige",
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
    chartDesign: "Chart Design",
    candlesSection: "Candles",
    chartArea: "Chart Area",
    behavior: "Behavior",
    orderDisplay: "Order Display",
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
  const lineSeriesRef = useRef<ISeriesApi<"Line">[]>([]);
  const shouldFitContentRef = useRef(true);
  const shouldFitPriceRef = useRef(true);
  const ordersRef = useRef<TradeOrder[]>([]);
  const draggedLineRef = useRef<DraggedOrderLine | null>(null);
  const draggedChipRef = useRef<{ orderId: string; field: "takeProfit" | "stopLoss" } | null>(null);
  const chipDragFinishedRef = useRef(false);
  const [lineControls, setLineControls] = useState<Array<{ order: TradeOrder; y: number }>>([]);

  const [allCandles, setAllCandles] = useState<Candle[]>(defaultCandles);
  const [visibleCount, setVisibleCount] = useState(4);
  const [isPlaying, setIsPlaying] = useState(false);
  const [speedMs, setSpeedMs] = useState(800);
  const [orders, setOrders] = useState<TradeOrder[]>([]);
  const [side, setSide] = useState<Side>("buy");
  const [quantity, setQuantity] = useState(1);
  const [entry, setEntry] = useState("");
  const [takeProfit, setTakeProfit] = useState("");
  const [stopLoss, setStopLoss] = useState("");
  const [chartMenu, setChartMenu] = useState<ChartMenu | null>(null);
  const [autoScalePrice, setAutoScalePrice] = useState(false);
  const [autoFocusChart, setAutoFocusChart] = useState(false);
  const [showChartOptions, setShowChartOptions] = useState(false);
  const [chartTheme, setChartTheme] = useState<ChartTheme>(defaultTheme);
  const [language, setLanguage] = useState<Language>("de");
  const t = translations[language];
  const [message, setMessage] = useState(translations.de.demoLoaded);
  const [messageKind, setMessageKind] = useState<"demo" | "chartCsv" | "custom">("demo");

  const visibleCandles = useMemo(() => allCandles.slice(0, visibleCount), [allCandles, visibleCount]);
  const lastCandle = visibleCandles.at(-1);
  const openOrders = orders.filter((order) => order.status === "pending" || order.status === "active");
  const closedOrders = orders.filter((order) => order.status === "closed");
  const canceledOrders = orders.filter((order) => order.status === "canceled");

  useEffect(() => {
    ordersRef.current = orders;
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
      }
    });
    observer.observe(chartElement.current);

    return () => {
      observer.disconnect();
      chart.remove();
    };
  }, []);

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
        setOrders([]);
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
    candleSeriesRef.current?.setData(visibleCandles);
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

    lineSeriesRef.current.forEach((series) => chart.removeSeries(series));
    lineSeriesRef.current = [];

    openOrders.forEach((order) => {
      const start = visibleCandles[0].time;
      const end = visibleCandles.at(-1)?.time ?? start;
      const addLine = (price: number, color: string, title: string, style = LineStyle.Solid) => {
        const series = chart.addSeries(LineSeries, {
          color,
          lineWidth: 2,
          lineStyle: style,
          priceLineVisible: false,
          title: ""
        });
        series.setData([
          { time: start, value: price },
          { time: end, value: price }
        ]);
        lineSeriesRef.current.push(series);
      };

      const entryColor = order.status === "active" ? "#facc15" : order.side === "buy" ? "#38bdf8" : "#f97316";
      const entryTitle = order.status === "active" ? `${order.id} ACTIVE Entry` : `${order.id} Pending Entry`;
      addLine(order.entry, entryColor, entryTitle, order.status === "active" ? LineStyle.LargeDashed : LineStyle.Solid);
      if (order.takeProfit !== undefined) addLine(order.takeProfit, "#22c55e", `${order.id} TP`, LineStyle.Dashed);
      if (order.stopLoss !== undefined) addLine(order.stopLoss, "#ef4444", `${order.id} SL`, LineStyle.Dashed);
    });
  }, [openOrders, visibleCandles]);

  useEffect(() => {
    const updateLineControls = () => {
      const series = candleSeriesRef.current;
      if (!series) return;
      const controls = openOrders
        .filter((order) => order.status === "pending" && (order.takeProfit === undefined || order.stopLoss === undefined))
        .map((order) => {
          const y = series.priceToCoordinate(order.entry);
          return y === null ? undefined : { order, y };
        })
        .filter(Boolean) as Array<{ order: TradeOrder; y: number }>;
      setLineControls(controls);
    };

    updateLineControls();
    const frame = window.requestAnimationFrame(updateLineControls);
    return () => window.cancelAnimationFrame(frame);
  }, [openOrders, visibleCandles]);

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
      const activeLine = draggedLineRef.current;
      const activeChip = draggedChipRef.current;

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
                ...order,
                [target.field]:
                  target.field === "entry"
                    ? Number(price.toFixed(4))
                    : activeChip && !isProtectionPriceValid(order, target.field, price)
                      ? order[target.field]
                      : Number(clampProtectionPrice(order, target.field, price).toFixed(4))
              }
            : order
        )
      );
    };

    const handleMouseUp = () => {
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

    const closeMenu = () => setChartMenu(null);

    chartNode.addEventListener("contextmenu", handleContextMenu);
    chartNode.addEventListener("mousedown", handleMouseDown);
    chartNode.addEventListener("mousemove", handleMouseMove);
    window.addEventListener("mouseup", handleMouseUp);
    window.addEventListener("click", closeMenu);
    window.addEventListener("keydown", closeMenu);

    return () => {
      chartNode.removeEventListener("contextmenu", handleContextMenu);
      chartNode.removeEventListener("mousedown", handleMouseDown);
      chartNode.removeEventListener("mousemove", handleMouseMove);
      window.removeEventListener("mouseup", handleMouseUp);
      window.removeEventListener("click", closeMenu);
      window.removeEventListener("keydown", closeMenu);
    };
  }, [t]);

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
            {lineControls.map(({ order, y }) => (
              <div
                className={`entry-line-controls ${chartTheme.orderControlsSide}`}
                style={{ top: y }}
                key={order.id}
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
            ))}
            {showChartOptions && (
              <div className="chart-style-panel">
                <div className="style-panel-title">
                  <Palette size={16} />
                  {t.chartDesign}
                </div>

                <div className="style-section">
                  <div className="style-section-title">{t.candlesSection}</div>
                  <div className="style-grid">
                    <label>
                      {t.bodyUp}
                      <input type="color" value={chartTheme.upColor} onChange={(event) => updateTheme("upColor", event.target.value)} />
                    </label>
                    <label>
                      {t.bodyDown}
                      <input type="color" value={chartTheme.downColor} onChange={(event) => updateTheme("downColor", event.target.value)} />
                    </label>
                    <label>
                      {t.wickUp}
                      <input type="color" value={chartTheme.upWickColor} onChange={(event) => updateTheme("upWickColor", event.target.value)} />
                    </label>
                    <label>
                      {t.wickDown}
                      <input type="color" value={chartTheme.downWickColor} onChange={(event) => updateTheme("downWickColor", event.target.value)} />
                    </label>
                    <label>
                      {t.borderUp}
                      <input type="color" value={chartTheme.upBorderColor} onChange={(event) => updateTheme("upBorderColor", event.target.value)} />
                    </label>
                    <label>
                      {t.borderDown}
                      <input type="color" value={chartTheme.downBorderColor} onChange={(event) => updateTheme("downBorderColor", event.target.value)} />
                    </label>
                  </div>
                </div>

                <div className="style-section">
                  <div className="style-section-title">{t.chartArea}</div>
                  <div className="style-grid">
                    <label>
                      {t.background}
                      <input type="color" value={chartTheme.backgroundColor} onChange={(event) => updateTheme("backgroundColor", event.target.value)} />
                    </label>
                    <label>
                      {t.grid}
                      <input type="color" value={chartTheme.gridColor} onChange={(event) => updateTheme("gridColor", event.target.value)} />
                    </label>
                    <label>
                      {t.text}
                      <input type="color" value={chartTheme.textColor} onChange={(event) => updateTheme("textColor", event.target.value)} />
                    </label>
                  </div>
                </div>

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

                <div className="style-section">
                  <div className="style-section-title">{t.orderDisplay}</div>
                  <div className="style-switches">
                    <button
                      className={chartTheme.orderControlsSide === "right" ? "switch active" : "switch"}
                      onClick={() => setChartTheme((current) => ({ ...current, orderControlsSide: "right" }))}
                    >
                      {t.orderControlsRight}
                    </button>
                    <button
                      className={chartTheme.orderControlsSide === "left" ? "switch active" : "switch"}
                      onClick={() => setChartTheme((current) => ({ ...current, orderControlsSide: "left" }))}
                    >
                      {t.orderControlsLeft}
                    </button>
                  </div>
                </div>

                <div className="style-section">
                  <div className="style-section-title">{t.language}</div>
                  <div className="style-switches">
                    <button className={language === "de" ? "switch active" : "switch"} onClick={() => setLanguage("de")}>{t.german}</button>
                    <button className={language === "en" ? "switch active" : "switch"} onClick={() => setLanguage("en")}>{t.english}</button>
                  </div>
                </div>

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
                <div className={order.status === "active" ? "book-row active-order" : "book-row"} key={order.id}>
                  <span className={order.side}>{order.side.toUpperCase()}</span>
                  <strong>{order.id}</strong>
                  <span>{formatPrice(order.entry)}</span>
                  <small className={order.status === "active" ? "status-active" : "status-pending"}>
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
          <div className={order.status === "active" ? "table-grid active-order" : "table-grid"} key={`${order.id}-${order.status}`}>
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
            <span className={order.status === "active" ? "status-active" : "status-pending"}>
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
