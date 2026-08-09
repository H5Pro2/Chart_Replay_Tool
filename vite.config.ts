import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { createHmac } from "node:crypto";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { basename, resolve } from "node:path";

const envPath = resolve(process.cwd(), ".env.local");
const phemexChartDir = resolve(process.cwd(), "chart_data", "phemex_chart");
const binanceChartDir = resolve(process.cwd(), "chart_data", "binance_chart");
const coinListPath = resolve(process.cwd(), "coin_liste.txt");
const botBridgeDir = resolve(process.cwd(), "bot_bridge");
const defaultBotScript = "long_bot.py";
let selectedBotScript = defaultBotScript;
let managedBotProcess: ChildProcessWithoutNullStreams | null = null;

const timeframeFromResolution = (resolution: number) => {
  if (resolution % 86400 === 0) return `${resolution / 86400}d`;
  if (resolution % 3600 === 0) return `${resolution / 3600}h`;
  return `${resolution / 60}m`;
};

const safeFilePart = (value: string) => value.replace(/[^a-z0-9_-]/gi, "_");
const cleanEnvValue = (value?: string) => String(value || "").trim();
const activeExchangeFromBody = (body: Record<string, unknown>, values: Record<string, string>) =>
  (String(body.exchange || values.EXCHANGE || values.PHEMEX_EXCHANGE || "phemex").toLowerCase() === "binance" ? "binance" : "phemex") as "phemex" | "binance";
type LiveOrderGuard = {
  inFlight: boolean;
  lastSentAt: number;
  lastOrderID?: string;
  lastClOrdID?: string;
};
const liveOrderGuardWindowMs = 20_000;
const liveOrderGuards = new Map<string, LiveOrderGuard>();
const liveOrderGuardKey = (exchange: "phemex" | "binance", symbol: string, testnet: boolean) =>
  `${exchange}:${testnet ? "testnet" : "mainnet"}:${symbol}`;
const lockLiveOrderGuard = (exchange: "phemex" | "binance", symbol: string, testnet: boolean) => {
  const key = liveOrderGuardKey(exchange, symbol, testnet);
  const now = Date.now();
  const current = liveOrderGuards.get(key);
  if (current?.inFlight || (current && now - current.lastSentAt < liveOrderGuardWindowMs)) {
    return {
      ok: false as const,
      key,
      guard: current,
      retryAfterMs: Math.max(0, liveOrderGuardWindowMs - (now - (current?.lastSentAt || now)))
    };
  }
  liveOrderGuards.set(key, { inFlight: true, lastSentAt: now });
  return { ok: true as const, key };
};
const markLiveOrderGuardSent = (key: string, orderID?: unknown, clOrdID?: unknown) => {
  liveOrderGuards.set(key, {
    inFlight: false,
    lastSentAt: Date.now(),
    lastOrderID: orderID ? String(orderID) : undefined,
    lastClOrdID: clOrdID ? String(clOrdID) : undefined
  });
};
const releaseLiveOrderGuard = (key?: string) => {
  if (key) liveOrderGuards.delete(key);
};
const binanceHost = (testnet: boolean) => testnet ? "https://testnet.binancefuture.com" : "https://fapi.binance.com";
const binanceIntervalFromResolution = (resolution: number) => {
  const map: Record<number, string> = {
    60: "1m",
    180: "3m",
    300: "5m",
    900: "15m",
    1800: "30m",
    3600: "1h",
    14400: "4h",
    86400: "1d"
  };
  return map[resolution] || "5m";
};
const binanceIntervalMs = (interval: string) => {
  const match = interval.match(/^(\d+)([mhd])$/);
  if (!match) return 5 * 60 * 1000;
  const value = Number(match[1]);
  const unit = match[2];
  if (unit === "m") return value * 60 * 1000;
  if (unit === "h") return value * 60 * 60 * 1000;
  return value * 24 * 60 * 60 * 1000;
};
const resolutionFromBinanceInterval = (interval: string) => {
  const match = interval.match(/^(\d+)([mhd])$/);
  if (!match) return 300;
  const value = Number(match[1]);
  const unit = match[2];
  if (unit === "m") return value * 60;
  if (unit === "h") return value * 3600;
  return value * 86400;
};
const monthRange = (startYear: number, startMonth: number, months: number) => {
  const start = Date.UTC(startYear, startMonth - 1, 1);
  const end = Date.UTC(startYear, startMonth - 1 + months, 1);
  return { start, end };
};
const signBinanceQuery = (query: string, apiSecret: string) =>
  createHmac("sha256", apiSecret).update(query).digest("hex");
const signedBinanceQuery = (params: Record<string, string | number | boolean | undefined>, apiSecret: string) => {
  const search = new URLSearchParams();
  Object.entries(params).forEach(([key, value]) => {
    if (value !== undefined && value !== "") search.set(key, String(value));
  });
  search.set("timestamp", String(Date.now()));
  search.set("recvWindow", search.get("recvWindow") || "5000");
  const query = search.toString();
  return `${query}&signature=${signBinanceQuery(query, apiSecret)}`;
};

const parseBody = (request: import("node:http").IncomingMessage) =>
  new Promise<Record<string, unknown>>((resolveBody, reject) => {
    let body = "";
    request.on("data", (chunk) => {
      body += chunk;
    });
    request.on("end", () => {
      try {
        resolveBody(JSON.parse(body || "{}"));
      } catch (error) {
        reject(error);
      }
    });
  });

const normalizeBotScriptName = (value?: unknown) => {
  const script = basename(String(value || defaultBotScript).trim());
  if (script === "grid_bot.py" || script === "phemex_grid_bot.py") return "spot_grid_bot.py";
  return /^[a-zA-Z0-9_.-]+\.py$/.test(script) ? script : defaultBotScript;
};

const botScriptPath = (script?: unknown) => resolve(botBridgeDir, normalizeBotScriptName(script));
const botTickUrl = "http://127.0.0.1:8790/tick";
const botHealthUrl = "http://127.0.0.1:8790/health";

const listBotScripts = async () => {
  await mkdir(botBridgeDir, { recursive: true });
  const entries = await readdir(botBridgeDir, { withFileTypes: true });
  const scripts = entries
    .filter((entry) => entry.isFile() && /^[a-zA-Z0-9_.-]+\.py$/.test(entry.name))
    .map((entry) => entry.name)
    .sort((left, right) => left.localeCompare(right));
  return scripts.includes(defaultBotScript) ? scripts : [defaultBotScript, ...scripts];
};

const isBotHealthy = async () => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 700);
  try {
    const response = await fetch(botHealthUrl, { signal: controller.signal });
    return response.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
};

const waitForBotHealth = async (timeoutMs = 3500) => {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await isBotHealthy()) return true;
    await new Promise((resolveWait) => setTimeout(resolveWait, 150));
  }
  return false;
};

const waitForBotShutdown = async (timeoutMs = 2500) => {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const processes = await listProjectBotProcesses();
    if (!processes.length && !(await isBotHealthy())) return true;
    await new Promise((resolveWait) => setTimeout(resolveWait, 150));
  }
  return false;
};

const fetchWithTimeout = async (url: string, init: RequestInit, timeoutMs = 8000) => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
};

const listProjectBotProcesses = () =>
  new Promise<Array<{ pid: number }>>((resolveList) => {
    const escapedDir = botBridgeDir.replace(/'/g, "''");
    const listProcess = spawn("powershell.exe", [
      "-NoProfile",
      "-ExecutionPolicy",
      "Bypass",
      "-Command",
      `$target = '${escapedDir}'; Get-CimInstance Win32_Process -Filter "name = 'python.exe'" | Where-Object { $_.CommandLine -like '*bot_bridge*' -and $_.CommandLine -like '*.py*' -and ($_.CommandLine -like '*MCM_TradingView*' -or $_.CommandLine -like "*$target*") } | Select-Object -ExpandProperty ProcessId`
    ], {
      windowsHide: true
    });
    let output = "";
    listProcess.stdout.on("data", (chunk) => {
      output += String(chunk);
    });
    listProcess.once("exit", () => {
      const processes = output
        .split(/\r?\n/)
        .map((line) => Number(line.trim()))
        .filter((pid) => Number.isFinite(pid) && pid > 0)
        .map((pid) => ({ pid }));
      resolveList(processes);
    });
    listProcess.once("error", () => resolveList([]));
  });

const managedBotStatus = async () => {
  let externalProcesses = await listProjectBotProcesses();
  if (externalProcesses.length > 1) {
    await cleanupProjectBotProcesses();
    managedBotProcess = null;
    externalProcesses = [];
  }
  const managedRunning = Boolean(managedBotProcess && managedBotProcess.exitCode === null && !managedBotProcess.killed);
  const pid = managedRunning ? managedBotProcess?.pid ?? null : externalProcesses[0]?.pid ?? null;
  const ready = await isBotHealthy();
  return {
    running: ready && (managedRunning || externalProcesses.length > 0),
    pid,
    processCount: externalProcesses.length,
    ready,
    script: selectedBotScript,
    url: botTickUrl
  };
};

const cleanupProjectBotProcesses = () =>
  new Promise<void>((resolveCleanup) => {
    const escapedDir = botBridgeDir.replace(/'/g, "''");
    const cleanupProcess = spawn("powershell.exe", [
      "-NoProfile",
      "-ExecutionPolicy",
      "Bypass",
      "-Command",
      `$target = '${escapedDir}'; Get-CimInstance Win32_Process -Filter "name = 'python.exe'" | Where-Object { $_.CommandLine -like '*bot_bridge*' -and $_.CommandLine -like '*.py*' -and ($_.CommandLine -like '*MCM_TradingView*' -or $_.CommandLine -like "*$target*") } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }`
    ], {
      stdio: "ignore",
      windowsHide: true
    });
    cleanupProcess.once("exit", () => resolveCleanup());
    cleanupProcess.once("error", () => resolveCleanup());
  });

const stopManagedBot = () =>
  new Promise<void>((resolveStop) => {
    if (!managedBotProcess || managedBotProcess.exitCode !== null || managedBotProcess.killed) {
      managedBotProcess = null;
      cleanupProjectBotProcesses().finally(resolveStop);
      return;
    }
    const processToStop = managedBotProcess;
    const timer = setTimeout(() => {
      try {
        processToStop.kill("SIGKILL");
      } catch {
        // ignore cleanup race
      }
      managedBotProcess = null;
      cleanupProjectBotProcesses().finally(resolveStop);
    }, 1500);
    processToStop.once("exit", () => {
      clearTimeout(timer);
      if (managedBotProcess === processToStop) managedBotProcess = null;
      cleanupProjectBotProcesses().finally(resolveStop);
    });
    processToStop.kill();
  });

const startManagedBot = async (script?: unknown) => {
  selectedBotScript = normalizeBotScriptName(script || selectedBotScript);
  const currentStatus = await managedBotStatus();
  if (currentStatus.running && currentStatus.ready && currentStatus.processCount === 1 && currentStatus.script === selectedBotScript) {
    return currentStatus;
  }
  await stopManagedBot();
  await cleanupProjectBotProcesses();
  managedBotProcess = spawn("python", [botScriptPath(selectedBotScript)], {
    cwd: process.cwd(),
    stdio: "pipe",
    windowsHide: true
  });
  managedBotProcess.once("exit", () => {
    managedBotProcess = null;
  });
  await waitForBotHealth();
  return managedBotStatus();
};

const openBotBridgeFolder = async () => {
  await mkdir(botBridgeDir, { recursive: true });
  const explorerProcess = spawn("powershell.exe", [
    "-NoProfile",
    "-ExecutionPolicy",
    "Bypass",
    "-Command",
    "Start-Process",
    "explorer.exe",
    "-ArgumentList",
    botBridgeDir
  ], {
    detached: true,
    stdio: "ignore",
    windowsHide: true
  });
  explorerProcess.unref();
};

const copyBotBridgePath = async () => {
  await mkdir(botBridgeDir, { recursive: true });
  const escapedPath = botBridgeDir.replace(/'/g, "''");
  const clipboardProcess = spawn("powershell.exe", [
    "-NoProfile",
    "-ExecutionPolicy",
    "Bypass",
    "-Command",
    `Set-Clipboard -Value '${escapedPath}'`
  ], {
    stdio: "ignore",
    windowsHide: true
  });
  await new Promise<void>((resolveCopy, rejectCopy) => {
    clipboardProcess.once("exit", (code) => {
      if (code === 0) resolveCopy();
      else rejectCopy(new Error(`Set-Clipboard failed with code ${code}`));
    });
    clipboardProcess.once("error", rejectCopy);
  });
};

const serializeEnv = (values: Record<string, string>) =>
  Object.entries(values)
    .map(([key, value]) => `${key}=${JSON.stringify(value ?? "")}`)
    .join("\n") + "\n";

const loadEnvValues = async () => {
  try {
    const content = await readFile(envPath, "utf-8");
    return Object.fromEntries(
      content
        .split(/\r?\n/)
        .map((line) => line.match(/^([A-Z0-9_]+)=(.*)$/))
        .filter(Boolean)
        .map((match) => {
          const [, key, rawValue] = match as RegExpMatchArray;
          try {
            return [key, JSON.parse(rawValue)];
          } catch {
            return [key, rawValue];
          }
        })
    ) as Record<string, string>;
  } catch {
    return {};
  }
};

const loadCoinList = async () => {
  try {
    const content = await readFile(coinListPath, "utf-8");
    return content
      .split(/\r?\n/)
      .map((line) => line.trim().toUpperCase())
      .filter((line) => line && !line.startsWith("#"));
  } catch {
    return ["BTCUSDT", "ETHUSDT", "SOLUSDT", "XRPUSDT", "BNBUSDT", "ADAUSDT", "DOGEUSDT", "AVAXUSDT"];
  }
};

const candleRowsToCsv = (rows: unknown[], symbol: string, resolution: number) => {
  const timeframe = timeframeFromResolution(resolution);
  const lines = ["timestamp_ms,symbol,timeframe,open,high,low,close,volume"];
  rows
    .filter((row): row is unknown[] => Array.isArray(row) && row.length >= 8)
    .sort((left, right) => Number(left[0]) - Number(right[0]))
    .forEach((row) => {
      const timestampMs = Number(row[0]) * 1000;
      const open = row[3];
      const high = row[4];
      const low = row[5];
      const close = row[6];
      const volume = row[7];
      lines.push([timestampMs, symbol, timeframe, open, high, low, close, volume].join(","));
    });
  return `${lines.join("\n")}\n`;
};

const binanceKlinesToCsv = (rows: unknown[], symbol: string, resolution: number) => {
  const timeframe = timeframeFromResolution(resolution);
  const lines = ["timestamp_ms,symbol,timeframe,open,high,low,close,volume"];
  rows
    .filter((row): row is unknown[] => Array.isArray(row) && row.length >= 6)
    .sort((left, right) => Number(left[0]) - Number(right[0]))
    .forEach((row) => {
      lines.push([Number(row[0]), symbol, timeframe, row[1], row[2], row[3], row[4], row[5]].join(","));
    });
  return `${lines.join("\n")}\n`;
};

const signPhemexRequest = (path: string, query: string, expiry: number, body: string, apiSecret: string) => {
  return createHmac("sha256", apiSecret)
    .update(`${path}${query}${expiry}${body}`)
    .digest("hex");
};

const phemexErrorMessage = (payload: any, fallback: string) => {
  const message = payload?.msg || payload?.message || fallback;
  const code = payload?.code && payload.code !== 0 ? `code ${payload.code}` : "";
  const bizError = payload?.data?.bizError && Number(payload.data.bizError) !== 0 ? `bizError ${payload.data.bizError}` : "";
  return [message, code, bizError].filter(Boolean).join(" / ");
};

const numberFromExchangeValue = (value: unknown) => {
  const parsed = Number(String(value ?? "").replace(",", "."));
  return Number.isFinite(parsed) ? parsed : undefined;
};

const positionSizeFromExchangeRow = (row: Record<string, unknown>) => {
  const size =
    numberFromExchangeValue(row.sizeRq) ??
    numberFromExchangeValue(row.size) ??
    numberFromExchangeValue(row.posSizeRq) ??
    numberFromExchangeValue(row.positionSizeRq) ??
    numberFromExchangeValue(row.positionQtyRq) ??
    numberFromExchangeValue(row.positionAmt) ??
    numberFromExchangeValue(row.positionQty) ??
    numberFromExchangeValue(row.posQty) ??
    numberFromExchangeValue(row.qty);
  return Math.abs(size ?? 0);
};

const phemexPositionRows = (payload: any) => {
  const data = payload?.data || {};
  const candidates = [
    data.positions,
    data.rows,
    data.account?.positions,
    data.accounts?.positions,
    data.account?.rows,
    data.position,
    data.account?.position
  ];
  return candidates.flatMap((candidate) => {
    if (Array.isArray(candidate)) return candidate;
    if (candidate && typeof candidate === "object") return [candidate];
    return [];
  }) as Record<string, unknown>[];
};

const assertNoExchangeExposure = async (
  exchange: "phemex" | "binance",
  symbol: string,
  testnet: boolean,
  apiKey: string,
  apiSecret: string
) => {
  if (exchange === "binance") {
    const openOrdersQuery = signedBinanceQuery({ symbol }, apiSecret);
    const openOrdersResponse = await fetch(`${binanceHost(testnet)}/fapi/v1/openOrders?${openOrdersQuery}`, {
      headers: { "X-MBX-APIKEY": apiKey }
    });
    const openOrdersPayload = await openOrdersResponse.json();
    if (!openOrdersResponse.ok || !Array.isArray(openOrdersPayload)) {
      throw new Error(openOrdersPayload.msg || "Binance open orders check failed");
    }

    const positionQuery = signedBinanceQuery({ symbol }, apiSecret);
    const positionResponse = await fetch(`${binanceHost(testnet)}/fapi/v3/positionRisk?${positionQuery}`, {
      headers: { "X-MBX-APIKEY": apiKey }
    });
    const positionPayload = await positionResponse.json();
    if (!positionResponse.ok || positionPayload.code) {
      throw new Error(positionPayload.msg || "Binance position check failed");
    }
    const positions = Array.isArray(positionPayload) ? positionPayload : [];
    const positionSize = positions.reduce((sum, row) => sum + positionSizeFromExchangeRow(row), 0);
    return {
      hasExposure: openOrdersPayload.length > 0 || positionSize > 0,
      openOrdersCount: openOrdersPayload.length,
      positionSize
    };
  }

  const host = testnet ? "https://testnet-api.phemex.com" : "https://api.phemex.com";
  const ordersPath = "/g-orders/activeList";
  const ordersQuery = `symbol=${encodeURIComponent(symbol)}`;
  const ordersExpiry = Math.floor(Date.now() / 1000) + 60;
  const ordersSignature = signPhemexRequest(ordersPath, ordersQuery, ordersExpiry, "", apiSecret);
  const ordersResponse = await fetch(`${host}${ordersPath}?${ordersQuery}`, {
    method: "GET",
    headers: {
      "x-phemex-access-token": apiKey,
      "x-phemex-request-expiry": String(ordersExpiry),
      "x-phemex-request-signature": ordersSignature
    }
  });
  const rawOrdersPayload = await ordersResponse.text();
  let ordersPayload: any;
  try {
    ordersPayload = JSON.parse(rawOrdersPayload);
  } catch {
    ordersPayload = { msg: rawOrdersPayload };
  }
  if (!(ordersPayload.code === 10002 && ordersPayload.msg === "OM_ORDER_NOT_FOUND") && (!ordersResponse.ok || ordersPayload.code !== 0)) {
    throw new Error(phemexErrorMessage(ordersPayload, "Phemex open orders check failed"));
  }
  const openRows = Array.isArray(ordersPayload.data?.rows) ? ordersPayload.data.rows : [];

  const positionPath = "/g-accounts/accountPositions";
  const positionQuery = `currency=USDT&symbol=${encodeURIComponent(symbol)}`;
  const positionExpiry = Math.floor(Date.now() / 1000) + 60;
  const positionSignature = signPhemexRequest(positionPath, positionQuery, positionExpiry, "", apiSecret);
  const positionResponse = await fetch(`${host}${positionPath}?${positionQuery}`, {
    method: "GET",
    headers: {
      "x-phemex-access-token": apiKey,
      "x-phemex-request-expiry": String(positionExpiry),
      "x-phemex-request-signature": positionSignature
    }
  });
  const rawPositionPayload = await positionResponse.text();
  let positionPayload: any;
  try {
    positionPayload = JSON.parse(rawPositionPayload);
  } catch {
    positionPayload = { msg: rawPositionPayload };
  }
  if (!positionResponse.ok || positionPayload.code !== 0) {
    throw new Error(phemexErrorMessage(positionPayload, "Phemex position check failed"));
  }
  const positionSize = phemexPositionRows(positionPayload)
    .reduce((sum, row) => sum + positionSizeFromExchangeRow(row), 0);

  return {
    hasExposure: openRows.length > 0 || positionSize > 0,
    openOrdersCount: openRows.length,
    positionSize
  };
};

const phemexSettingsPlugin = () => ({
  name: "phemex-settings",
  configureServer(server: import("vite").ViteDevServer) {
    server.middlewares.use("/api/coin-list", async (_request, response) => {
      try {
        response.setHeader("Content-Type", "application/json");
        response.end(JSON.stringify({ ok: true, symbols: await loadCoinList() }));
      } catch (error) {
        response.statusCode = 500;
        response.end(error instanceof Error ? error.message : "Unknown error");
      }
    });

    server.middlewares.use("/api/bot-tick", async (request, response) => {
      try {
        if (request.method !== "POST") {
          response.statusCode = 405;
          response.end("Method not allowed");
          return;
        }
        const body = await parseBody(request);
        const targetUrl = cleanEnvValue(body.url);
        if (!targetUrl || !/^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?\//i.test(targetUrl)) {
          response.statusCode = 400;
          response.setHeader("Content-Type", "application/json");
          response.end(JSON.stringify({ ok: false, message: "Bot URL must point to localhost or 127.0.0.1." }));
          return;
        }

        const tickPayload = {
          mode: body.mode || "replay",
          botMode: body.botMode || "signals",
          exchange: body.exchange || "phemex",
          symbol: body.symbol || "SOLUSDT",
          timeframe: body.timeframe || "5m",
          livePrice: body.livePrice,
          candle: body.candle,
          openOrders: body.openOrders || [],
          gridTriggers: body.gridTriggers || [],
          gridSettings: body.gridSettings || {},
          balance: body.balance,
          liveOrdersEnabled: body.liveOrdersEnabled === true
        };
        const canRestartManagedBot = /^https?:\/\/(127\.0\.0\.1|localhost):8790\/tick$/i.test(targetUrl);
        const postBotTick = () => fetchWithTimeout(targetUrl, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(tickPayload)
        });

        let botResponse: Response;
        try {
          if (canRestartManagedBot && !(await isBotHealthy())) {
            await stopManagedBot();
            const status = await startManagedBot(body.script);
            if (!status.ready) throw new Error("Bot process is not ready.");
          }
          botResponse = await postBotTick();
        } catch (error) {
          if (!canRestartManagedBot) throw error;
          await stopManagedBot();
          const status = await startManagedBot(body.script);
          if (!status.ready) throw new Error("Bot process started, but /health did not answer.");
          botResponse = await postBotTick();
        }
        const text = await botResponse.text();
        response.statusCode = botResponse.ok ? 200 : botResponse.status;
        response.setHeader("Content-Type", "application/json");
        response.end(JSON.stringify({
          ok: botResponse.ok,
          data: text ? JSON.parse(text) : null
        }));
      } catch (error) {
        response.statusCode = 500;
        response.setHeader("Content-Type", "application/json");
        response.end(JSON.stringify({
          ok: false,
          message: error instanceof Error ? error.message : "Bot tick failed"
        }));
      }
    });

    server.middlewares.use("/api/bot-process", async (request, response) => {
      try {
        if (request.method === "GET") {
          response.setHeader("Content-Type", "application/json");
          response.end(JSON.stringify({ ok: true, ...(await managedBotStatus()) }));
          return;
        }
        if (request.method !== "POST") {
          response.statusCode = 405;
          response.end("Method not allowed");
          return;
        }
        const body = await parseBody(request);
        const action = String(body.action || "status");
        if (action === "start") {
          const status = await startManagedBot(body.script);
          response.setHeader("Content-Type", "application/json");
          response.end(JSON.stringify({ ok: true, ...status }));
          return;
        }
        if (action === "stop") {
          await stopManagedBot();
          response.setHeader("Content-Type", "application/json");
          response.end(JSON.stringify({ ok: true, ...(await managedBotStatus()) }));
          return;
        }
        if (action === "reload") {
          await stopManagedBot();
          await cleanupProjectBotProcesses();
          await waitForBotShutdown();
          const status = await startManagedBot(body.script);
          response.setHeader("Content-Type", "application/json");
          response.end(JSON.stringify({ ok: true, ...status }));
          return;
        }
        response.statusCode = 400;
        response.setHeader("Content-Type", "application/json");
        response.end(JSON.stringify({ ok: false, message: "Unknown bot action." }));
      } catch (error) {
        response.statusCode = 500;
        response.setHeader("Content-Type", "application/json");
        response.end(JSON.stringify({
          ok: false,
          message: error instanceof Error ? error.message : "Bot process action failed"
        }));
      }
    });

    server.middlewares.use("/api/bot-scripts", async (request, response) => {
      try {
        if (request.method !== "GET") {
          response.statusCode = 405;
          response.end("Method not allowed");
          return;
        }
        const scripts = await listBotScripts();
        response.setHeader("Content-Type", "application/json");
        response.end(JSON.stringify({ ok: true, scripts, selected: selectedBotScript }));
      } catch (error) {
        response.statusCode = 500;
        response.setHeader("Content-Type", "application/json");
        response.end(JSON.stringify({
          ok: false,
          message: error instanceof Error ? error.message : "Bot scripts could not be loaded"
        }));
      }
    });

    server.middlewares.use("/api/bot-folder", async (request, response) => {
      try {
        if (request.method !== "POST") {
          response.statusCode = 405;
          response.end("Method not allowed");
          return;
        }
        await copyBotBridgePath();
        response.setHeader("Content-Type", "application/json");
        response.end(JSON.stringify({ ok: true, path: botBridgeDir }));
      } catch (error) {
        response.statusCode = 500;
        response.setHeader("Content-Type", "application/json");
        response.end(JSON.stringify({
          ok: false,
          message: error instanceof Error ? error.message : "Bot folder could not be opened"
        }));
      }
    });

    server.middlewares.use("/api/phemex-settings", async (request, response) => {
      try {
        if (request.method === "GET") {
          const values = await loadEnvValues();
          const url = new URL(request.url || "/api/phemex-settings", "http://127.0.0.1");
          const requestedExchange = url.searchParams.get("exchange");
          const exchange = String(requestedExchange || values.EXCHANGE || values.PHEMEX_EXCHANGE || "phemex").toLowerCase() === "binance" ? "binance" : "phemex";
          const isBinance = exchange === "binance";
          response.setHeader("Content-Type", "application/json");
          response.end(JSON.stringify({
            exchange,
            apiKey: (isBinance ? values.BINANCE_API_KEY : values.PHEMEX_API_KEY) ? "********" : "",
            hasSecret: Boolean(isBinance ? values.BINANCE_API_SECRET : values.PHEMEX_API_SECRET),
            testnet: (isBinance ? values.BINANCE_TESTNET : values.PHEMEX_TESTNET) !== "false",
            symbol: (isBinance ? values.BINANCE_SYMBOL : values.PHEMEX_SYMBOL) || "SOLUSDT",
            pollSeconds: (isBinance ? values.BINANCE_POLL_SECONDS : values.PHEMEX_POLL_SECONDS) || "10",
            resolution: (isBinance ? values.BINANCE_RESOLUTION : values.PHEMEX_RESOLUTION) || "300",
            limit: (isBinance ? values.BINANCE_LIMIT : values.PHEMEX_LIMIT) || "500",
            mode: (isBinance ? values.BINANCE_MODE : values.PHEMEX_MODE) === "live" ? "live" : "replay",
            liveOrdersEnabled: (isBinance ? values.BINANCE_LIVE_ORDERS_ENABLED : values.PHEMEX_LIVE_ORDERS_ENABLED) === "true",
            allowMainnetOrders: (isBinance ? values.BINANCE_ALLOW_MAINNET_ORDERS : values.PHEMEX_ALLOW_MAINNET_ORDERS) === "true"
          }));
          return;
        }

        if (request.method === "POST") {
          const body = await parseBody(request);
          const existing = await loadEnvValues();
          const exchange = String(body.exchange || existing.EXCHANGE || "phemex").toLowerCase() === "binance" ? "binance" : "phemex";
          const prefix = exchange === "binance" ? "BINANCE" : "PHEMEX";
          const next = {
            ...existing,
            EXCHANGE: exchange,
            [`${prefix}_API_KEY`]: body.apiKey || existing[`${prefix}_API_KEY`] || "",
            [`${prefix}_API_SECRET`]: body.apiSecret || existing[`${prefix}_API_SECRET`] || "",
            [`${prefix}_TESTNET`]: String(body.testnet !== false),
            [`${prefix}_SYMBOL`]: body.symbol || "SOLUSDT",
            [`${prefix}_POLL_SECONDS`]: body.pollSeconds || "10",
            [`${prefix}_RESOLUTION`]: body.resolution || "300",
            [`${prefix}_LIMIT`]: body.limit || "500",
            [`${prefix}_MODE`]: body.mode === "live" ? "live" : "replay",
            [`${prefix}_LIVE_ORDERS_ENABLED`]: String(body.liveOrdersEnabled === true),
            [`${prefix}_ALLOW_MAINNET_ORDERS`]: String(body.allowMainnetOrders === true)
          };
          await writeFile(envPath, serializeEnv(next), "utf-8");
          response.setHeader("Content-Type", "application/json");
          response.end(JSON.stringify({ ok: true }));
          return;
        }

        response.statusCode = 405;
        response.end("Method not allowed");
      } catch (error) {
        response.statusCode = 500;
        response.end(error instanceof Error ? error.message : "Unknown error");
      }
    });

    server.middlewares.use("/api/phemex-chart", async (request, response) => {
      try {
        if (request.method !== "POST") {
          response.statusCode = 405;
          response.end("Method not allowed");
          return;
        }

        const body = await parseBody(request);
        const symbol = String(body.symbol || "SOLUSDT").toUpperCase();
        const resolution = Number(body.resolution || 300);
        const limit = Number(body.limit || 500);
        const testnet = body.testnet !== false;
        const values = await loadEnvValues();
        const exchange = activeExchangeFromBody(body, values);
        if (exchange === "binance") {
          const interval = binanceIntervalFromResolution(resolution);
          const url = `${binanceHost(testnet)}/fapi/v1/klines?symbol=${encodeURIComponent(symbol)}&interval=${encodeURIComponent(interval)}&limit=${limit}`;
          const binanceResponse = await fetch(url);
          const payload = await binanceResponse.json();
          if (!binanceResponse.ok || !Array.isArray(payload)) {
            response.statusCode = 502;
            response.end(JSON.stringify({ ok: false, message: payload.msg || "Binance chart request failed", payload }));
            return;
          }
          const csv = binanceKlinesToCsv(payload, symbol, resolution);
          const filename = `${safeFilePart(symbol)}_${timeframeFromResolution(resolution)}_${limit}.csv`;
          await mkdir(binanceChartDir, { recursive: true });
          await writeFile(resolve(binanceChartDir, filename), csv, "utf-8");
          response.setHeader("Content-Type", "application/json");
          response.end(JSON.stringify({
            ok: true,
            count: payload.length,
            path: `chart_data/binance_chart/${filename}`,
            csv
          }));
          return;
        }
        const host = testnet ? "https://testnet-api.phemex.com" : "https://api.phemex.com";
        const url = `${host}/exchange/public/md/v2/kline/last?symbol=${encodeURIComponent(symbol)}&resolution=${resolution}&limit=${limit}`;
        const phemexResponse = await fetch(url);
        const payload = await phemexResponse.json();

        if (!phemexResponse.ok || payload.code !== 0 || !Array.isArray(payload.data?.rows)) {
          response.statusCode = 502;
          response.end(JSON.stringify({ ok: false, message: payload.msg || "Phemex chart request failed" }));
          return;
        }

        const csv = candleRowsToCsv(payload.data.rows, symbol, resolution);
        const filename = `${safeFilePart(symbol)}_${timeframeFromResolution(resolution)}_${limit}.csv`;
        await mkdir(phemexChartDir, { recursive: true });
        await writeFile(resolve(phemexChartDir, filename), csv, "utf-8");

        response.setHeader("Content-Type", "application/json");
        response.end(JSON.stringify({
          ok: true,
          count: payload.data.rows.length,
          path: `chart_data/phemex_chart/${filename}`,
          csv
        }));
      } catch (error) {
        response.statusCode = 500;
        response.end(error instanceof Error ? error.message : "Unknown error");
      }
    });

    server.middlewares.use("/api/binance-csv-build", async (request, response) => {
      try {
        if (request.method !== "POST") {
          response.statusCode = 405;
          response.end("Method not allowed");
          return;
        }

        const body = await parseBody(request);
        const coin = String(body.coin || "SOL").toUpperCase().replace(/[^A-Z0-9]/g, "");
        const quote = String(body.quote || "USDT").toUpperCase().replace(/[^A-Z0-9]/g, "");
        const symbol = `${coin}${quote}`;
        const interval = String(body.timeframe || "5m");
        const startYear = Number(body.startYear || 2026);
        const startMonth = Number(body.startMonth || 1);
        const months = Math.max(1, Math.min(24, Number(body.months || 1)));
        const testnet = body.testnet !== false;

        if (!Number.isInteger(startYear) || startYear < 2017 || startYear > 2100 || !Number.isInteger(startMonth) || startMonth < 1 || startMonth > 12) {
          response.statusCode = 400;
          response.end(JSON.stringify({ ok: false, message: "Invalid date range" }));
          return;
        }

        const { start, end } = monthRange(startYear, startMonth, months);
        const stepMs = binanceIntervalMs(interval);
        const rows: unknown[] = [];
        let cursor = start;
        while (cursor < end) {
          const url = `${binanceHost(testnet)}/fapi/v1/klines?symbol=${encodeURIComponent(symbol)}&interval=${encodeURIComponent(interval)}&limit=1500&startTime=${cursor}&endTime=${end - 1}`;
          const binanceResponse = await fetch(url);
          const payload = await binanceResponse.json();
          if (!binanceResponse.ok || !Array.isArray(payload)) {
            response.statusCode = 502;
            response.end(JSON.stringify({ ok: false, message: payload.msg || "Binance CSV build request failed", payload }));
            return;
          }
          if (!payload.length) break;
          rows.push(...payload);
          const lastOpenTime = Number(payload[payload.length - 1]?.[0]);
          const nextCursor = lastOpenTime + stepMs;
          if (!Number.isFinite(nextCursor) || nextCursor <= cursor) break;
          cursor = nextCursor;
          if (payload.length < 1500) break;
        }

        const csv = binanceKlinesToCsv(rows, symbol, resolutionFromBinanceInterval(interval));
        const endMonth = startMonth + months - 1;
        const filename = `${startMonth}-${endMonth}_${startYear}_${safeFilePart(interval)}_${safeFilePart(symbol)}.csv`;
        await mkdir(binanceChartDir, { recursive: true });
        await writeFile(resolve(binanceChartDir, filename), csv, "utf-8");
        response.setHeader("Content-Type", "application/json");
        response.end(JSON.stringify({
          ok: true,
          count: rows.length,
          path: `chart_data/binance_chart/${filename}`,
          csv
        }));
      } catch (error) {
        response.statusCode = 500;
        response.end(error instanceof Error ? error.message : "Unknown error");
      }
    });

    server.middlewares.use("/api/phemex-price", async (request, response) => {
      try {
        if (request.method !== "POST") {
          response.statusCode = 405;
          response.end("Method not allowed");
          return;
        }

        const body = await parseBody(request);
        const symbol = String(body.symbol || "SOLUSDT").toUpperCase();
        const testnet = body.testnet !== false;
        const values = await loadEnvValues();
        const exchange = activeExchangeFromBody(body, values);
        if (exchange === "binance") {
          const url = `${binanceHost(testnet)}/fapi/v2/ticker/price?symbol=${encodeURIComponent(symbol)}`;
          const binanceResponse = await fetch(url);
          const payload = await binanceResponse.json();
          const price = Number(payload.price);
          if (!binanceResponse.ok || !Number.isFinite(price)) {
            response.statusCode = 502;
            response.setHeader("Content-Type", "application/json");
            response.end(JSON.stringify({
              ok: false,
              message: payload.msg || "Binance price request failed",
              status: binanceResponse.status,
              payload
            }));
            return;
          }
          response.setHeader("Content-Type", "application/json");
          response.end(JSON.stringify({ ok: true, symbol, price, timestampMs: Date.now() }));
          return;
        }
        const host = testnet ? "https://testnet-api.phemex.com" : "https://api.phemex.com";
        const url = `${host}/md/v3/ticker/24hr?symbol=${encodeURIComponent(symbol)}`;
        const phemexResponse = await fetch(url);
        const rawPayload = await phemexResponse.text();
        let payload: any;
        try {
          payload = JSON.parse(rawPayload);
        } catch {
          payload = { msg: rawPayload.slice(0, 500) };
        }
        const price = Number(payload.result?.lastRp);

        if (!phemexResponse.ok || payload.error || !Number.isFinite(price)) {
          response.statusCode = 502;
          response.setHeader("Content-Type", "application/json");
          response.end(JSON.stringify({
            ok: false,
            message: payload.msg || "Phemex price request failed",
            status: phemexResponse.status,
            payload
          }));
          return;
        }

        response.setHeader("Content-Type", "application/json");
        response.end(JSON.stringify({
          ok: true,
          symbol,
          price,
          timestampMs: Date.now()
        }));
      } catch (error) {
        response.statusCode = 500;
        response.end(error instanceof Error ? error.message : "Unknown error");
      }
    });

    server.middlewares.use("/api/phemex-order", async (request, response) => {
      let orderGuardKey: string | undefined;
      try {
        if (request.method !== "POST") {
          response.statusCode = 405;
          response.end("Method not allowed");
          return;
        }

        const values = await loadEnvValues();
        const body = await parseBody(request);
        const exchange = activeExchangeFromBody(body, values);
        const apiKey = cleanEnvValue(exchange === "binance" ? values.BINANCE_API_KEY : values.PHEMEX_API_KEY);
        const apiSecret = cleanEnvValue(exchange === "binance" ? values.BINANCE_API_SECRET : values.PHEMEX_API_SECRET);
        if (!apiKey || !apiSecret) {
          response.statusCode = 401;
          response.end(JSON.stringify({ ok: false, message: `${exchange === "binance" ? "Binance" : "Phemex"} API key/secret missing` }));
          return;
        }
        const liveOrdersEnabled = typeof body.liveOrdersEnabled === "boolean"
          ? body.liveOrdersEnabled
          : exchange === "binance"
            ? values.BINANCE_LIVE_ORDERS_ENABLED === "true"
            : values.PHEMEX_LIVE_ORDERS_ENABLED === "true";
        if (!liveOrdersEnabled) {
          response.statusCode = 403;
          response.end(JSON.stringify({ ok: false, message: `${exchange === "binance" ? "Binance" : "Phemex"} live orders are disabled in Exchange settings.` }));
          return;
        }

        const testnet = body.testnet !== false;
        const symbol = String(body.symbol || "SOLUSDT").toUpperCase();
        const quantity = Number(body.quantity);
        const price = Number(body.price);
        const orderType = String(body.orderType || "limit").toLowerCase() === "market" ? "market" : "limit";
        if (exchange === "binance") {
          const allowMainnetOrders = typeof body.allowMainnetOrders === "boolean"
            ? body.allowMainnetOrders
            : values.BINANCE_ALLOW_MAINNET_ORDERS === "true";
          if (!testnet && !allowMainnetOrders) {
            response.statusCode = 403;
            response.end(JSON.stringify({ ok: false, message: "Mainnet orders are disabled. Enable Mainnet orders in Exchange settings." }));
            return;
          }
          const side = body.side === "sell" ? "SELL" : "BUY";
          if (!Number.isFinite(quantity) || quantity <= 0 || (orderType === "limit" && (!Number.isFinite(price) || price <= 0))) {
            response.statusCode = 400;
            response.end(JSON.stringify({ ok: false, message: orderType === "limit" ? "Order needs valid quantity and price" : "Market order needs valid quantity" }));
            return;
          }
          const guardLock = lockLiveOrderGuard(exchange, symbol, testnet);
          if (!guardLock.ok) {
            response.statusCode = 409;
            response.setHeader("Content-Type", "application/json");
            response.end(JSON.stringify({
              ok: false,
              message: "Live-Order blockiert: Fuer dieses Symbol wurde gerade bereits eine Order gesendet. Bitte erst Boersenabgleich abwarten.",
              duplicateGuard: {
                exchange,
                symbol,
                testnet,
                inFlight: guardLock.guard.inFlight,
                retryAfterMs: guardLock.retryAfterMs,
                lastSentAt: guardLock.guard.lastSentAt,
                lastOrderID: guardLock.guard.lastOrderID,
                lastClOrdID: guardLock.guard.lastClOrdID
              }
            }));
            return;
          }
          orderGuardKey = guardLock.key;
          const exposure = await assertNoExchangeExposure(exchange, symbol, testnet, apiKey, apiSecret);
          if (exposure.hasExposure) {
            releaseLiveOrderGuard(orderGuardKey);
            orderGuardKey = undefined;
            response.statusCode = 409;
            response.setHeader("Content-Type", "application/json");
            response.end(JSON.stringify({
              ok: false,
              message: "Live-Order blockiert: Auf der Boerse ist fuer dieses Symbol bereits eine offene Order oder Position vorhanden.",
              exposure
            }));
            return;
          }
          const binanceOrderParams: Record<string, string | number> = {
            symbol,
            side,
            type: orderType === "market" ? "MARKET" : "LIMIT",
            quantity,
            newClientOrderId: `crt-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
          };
          if (orderType === "limit") {
            binanceOrderParams.timeInForce = "GTC";
            binanceOrderParams.price = price;
          }
          const params = signedBinanceQuery(binanceOrderParams, apiSecret);
          const binanceResponse = await fetch(`${binanceHost(testnet)}/fapi/v1/order?${params}`, {
            method: "POST",
            headers: { "X-MBX-APIKEY": apiKey }
          });
          const payload = await binanceResponse.json();
          if (!binanceResponse.ok || payload.code) {
            releaseLiveOrderGuard(orderGuardKey);
            orderGuardKey = undefined;
            response.statusCode = 502;
            response.end(JSON.stringify({ ok: false, message: payload.msg || "Binance order failed", status: binanceResponse.status, payload }));
            return;
          }
          markLiveOrderGuardSent(orderGuardKey, payload.orderId, payload.clientOrderId);
          orderGuardKey = undefined;
          response.setHeader("Content-Type", "application/json");
          response.end(JSON.stringify({ ok: true, orderID: String(payload.orderId), clOrdID: payload.clientOrderId, payload }));
          return;
        }
        const allowMainnetOrders = typeof body.allowMainnetOrders === "boolean"
          ? body.allowMainnetOrders
          : values.PHEMEX_ALLOW_MAINNET_ORDERS === "true";
        if (!testnet && !allowMainnetOrders) {
          response.statusCode = 403;
          response.end(JSON.stringify({ ok: false, message: "Mainnet orders are disabled. Enable Mainnet orders in Exchange settings." }));
          return;
        }

        const side = body.side === "sell" ? "Sell" : "Buy";
        const takeProfit = Number(body.takeProfit);
        const stopLoss = Number(body.stopLoss);
        if (!Number.isFinite(quantity) || quantity <= 0 || (orderType === "limit" && (!Number.isFinite(price) || price <= 0))) {
          response.statusCode = 400;
          response.end(JSON.stringify({ ok: false, message: orderType === "limit" ? "Order needs valid quantity and price" : "Market order needs valid quantity" }));
          return;
        }
        const guardLock = lockLiveOrderGuard(exchange, symbol, testnet);
        if (!guardLock.ok) {
          response.statusCode = 409;
          response.setHeader("Content-Type", "application/json");
          response.end(JSON.stringify({
            ok: false,
            message: "Live-Order blockiert: Fuer dieses Symbol wurde gerade bereits eine Order gesendet. Bitte erst Boersenabgleich abwarten.",
            duplicateGuard: {
              exchange,
              symbol,
              testnet,
              inFlight: guardLock.guard.inFlight,
              retryAfterMs: guardLock.retryAfterMs,
              lastSentAt: guardLock.guard.lastSentAt,
              lastOrderID: guardLock.guard.lastOrderID,
              lastClOrdID: guardLock.guard.lastClOrdID
            }
          }));
          return;
        }
        orderGuardKey = guardLock.key;
        const exposure = await assertNoExchangeExposure(exchange, symbol, testnet, apiKey, apiSecret);
        if (exposure.hasExposure) {
          releaseLiveOrderGuard(orderGuardKey);
          orderGuardKey = undefined;
          response.statusCode = 409;
          response.setHeader("Content-Type", "application/json");
          response.end(JSON.stringify({
            ok: false,
            message: "Live-Order blockiert: Auf der Boerse ist fuer dieses Symbol bereits eine offene Order oder Position vorhanden.",
            exposure
          }));
          return;
        }

        const path = "/g-orders";
        const expiry = Math.floor(Date.now() / 1000) + 60;
        const orderBody: Record<string, string | boolean> = {
          symbol,
          side,
          posSide: "Merged",
          ordType: orderType === "market" ? "Market" : "Limit",
          timeInForce: orderType === "market" ? "ImmediateOrCancel" : "GoodTillCancel",
          orderQtyRq: String(quantity),
          clOrdID: `crt-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
          text: "Chart_Replay_Tool"
        };
        if (orderType === "limit") {
          orderBody.priceRp = String(price);
        }
        if (Number.isFinite(takeProfit) && takeProfit > 0) {
          orderBody.takeProfitRp = String(takeProfit);
        }
        if (Number.isFinite(stopLoss) && stopLoss > 0) {
          orderBody.stopLossRp = String(stopLoss);
        }

        const rawBody = JSON.stringify(orderBody);
        const signature = signPhemexRequest(path, "", expiry, rawBody, apiSecret);
        const host = testnet ? "https://testnet-api.phemex.com" : "https://api.phemex.com";
        const phemexResponse = await fetch(`${host}${path}`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "x-phemex-access-token": apiKey,
            "x-phemex-request-expiry": String(expiry),
            "x-phemex-request-signature": signature
          },
          body: rawBody
        });
        const rawPayload = await phemexResponse.text();
        let payload: any;
        try {
          payload = JSON.parse(rawPayload);
        } catch {
          payload = { msg: rawPayload };
        }
        if (!phemexResponse.ok || payload.code !== 0 || Number(payload.data?.bizError || 0) !== 0) {
          releaseLiveOrderGuard(orderGuardKey);
          orderGuardKey = undefined;
          response.statusCode = 502;
          response.end(JSON.stringify({
            ok: false,
            message: phemexErrorMessage(payload, "Phemex order failed"),
            status: phemexResponse.status,
            payload
          }));
          return;
        }

        markLiveOrderGuardSent(orderGuardKey, payload.data?.orderID, payload.data?.clOrdID);
        orderGuardKey = undefined;
        response.setHeader("Content-Type", "application/json");
        response.end(JSON.stringify({
          ok: true,
          orderID: payload.data?.orderID,
          clOrdID: payload.data?.clOrdID,
          payload
        }));
      } catch (error) {
        releaseLiveOrderGuard(orderGuardKey);
        response.statusCode = 500;
        response.end(error instanceof Error ? error.message : "Unknown error");
      }
    });

    server.middlewares.use("/api/phemex-open-orders", async (request, response) => {
      try {
        if (request.method !== "POST") {
          response.statusCode = 405;
          response.end("Method not allowed");
          return;
        }

        const values = await loadEnvValues();
        const body = await parseBody(request);
        const exchange = activeExchangeFromBody(body, values);
        const apiKey = cleanEnvValue(exchange === "binance" ? values.BINANCE_API_KEY : values.PHEMEX_API_KEY);
        const apiSecret = cleanEnvValue(exchange === "binance" ? values.BINANCE_API_SECRET : values.PHEMEX_API_SECRET);
        if (!apiKey || !apiSecret) {
          response.statusCode = 401;
          response.end(JSON.stringify({ ok: false, message: `${exchange === "binance" ? "Binance" : "Phemex"} API key/secret missing` }));
          return;
        }

        const symbol = String(body.symbol || (exchange === "binance" ? values.BINANCE_SYMBOL : values.PHEMEX_SYMBOL) || "SOLUSDT").toUpperCase();
        const testnet = body.testnet !== false;
        if (exchange === "binance") {
          const query = signedBinanceQuery({ symbol }, apiSecret);
          const binanceResponse = await fetch(`${binanceHost(testnet)}/fapi/v1/openOrders?${query}`, {
            headers: { "X-MBX-APIKEY": apiKey }
          });
          const payload = await binanceResponse.json();
          if (!binanceResponse.ok || !Array.isArray(payload)) {
            response.statusCode = 502;
            response.end(JSON.stringify({ ok: false, message: payload.msg || "Binance open orders request failed", status: binanceResponse.status, payload }));
            return;
          }
          const rows = payload.map((row: any) => ({
            orderID: String(row.orderId),
            clOrdID: row.clientOrderId,
            side: row.side === "SELL" ? "Sell" : "Buy",
            priceRp: row.price,
            orderQtyRq: row.origQty,
            takeProfitRp: row.type?.includes("TAKE_PROFIT") ? row.stopPrice : "0",
            stopLossRp: row.type?.includes("STOP") ? row.stopPrice : "0"
          }));
          response.setHeader("Content-Type", "application/json");
          response.end(JSON.stringify({ ok: true, symbol, rows, payload }));
          return;
        }
        const host = testnet ? "https://testnet-api.phemex.com" : "https://api.phemex.com";
        const path = "/g-orders/activeList";
        const query = `symbol=${encodeURIComponent(symbol)}`;
        const expiry = Math.floor(Date.now() / 1000) + 60;
        const signature = signPhemexRequest(path, query, expiry, "", apiSecret);
        const phemexResponse = await fetch(`${host}${path}?${query}`, {
          method: "GET",
          headers: {
            "x-phemex-access-token": apiKey,
            "x-phemex-request-expiry": String(expiry),
            "x-phemex-request-signature": signature
          }
        });
        const rawPayload = await phemexResponse.text();
        let payload: any;
        try {
          payload = JSON.parse(rawPayload);
        } catch {
          payload = { msg: rawPayload };
        }
        if (payload.code === 10002 && payload.msg === "OM_ORDER_NOT_FOUND") {
          response.setHeader("Content-Type", "application/json");
          response.end(JSON.stringify({
            ok: true,
            symbol,
            rows: [],
            payload
          }));
          return;
        }

        if (!phemexResponse.ok || payload.code !== 0) {
          response.statusCode = 502;
          response.end(JSON.stringify({
            ok: false,
            message: phemexErrorMessage(payload, "Phemex open orders request failed"),
            status: phemexResponse.status,
            payload
          }));
          return;
        }

        response.setHeader("Content-Type", "application/json");
        response.end(JSON.stringify({
          ok: true,
          symbol,
          rows: Array.isArray(payload.data?.rows) ? payload.data.rows : [],
          payload
        }));
      } catch (error) {
        response.statusCode = 500;
        response.end(error instanceof Error ? error.message : "Unknown error");
      }
    });

    server.middlewares.use("/api/phemex-amend-order", async (request, response) => {
      try {
        if (request.method !== "POST") {
          response.statusCode = 405;
          response.end("Method not allowed");
          return;
        }

        const values = await loadEnvValues();
        const body = await parseBody(request);
        const exchange = activeExchangeFromBody(body, values);
        const apiKey = cleanEnvValue(exchange === "binance" ? values.BINANCE_API_KEY : values.PHEMEX_API_KEY);
        const apiSecret = cleanEnvValue(exchange === "binance" ? values.BINANCE_API_SECRET : values.PHEMEX_API_SECRET);
        if (!apiKey || !apiSecret) {
          response.statusCode = 401;
          response.end(JSON.stringify({ ok: false, message: `${exchange === "binance" ? "Binance" : "Phemex"} API key/secret missing` }));
          return;
        }

        const testnet = body.testnet !== false;
        if (exchange === "binance") {
          response.statusCode = 400;
          response.end(JSON.stringify({ ok: false, message: "Binance amend is not used directly. Pending orders are recreated; active positions use protection orders." }));
          return;
        }
        if (!testnet && values.PHEMEX_ALLOW_MAINNET_ORDERS !== "true") {
          response.statusCode = 403;
          response.end(JSON.stringify({ ok: false, message: "Mainnet orders are disabled. Enable Mainnet orders in Exchange settings." }));
          return;
        }

        const symbol = String(body.symbol || "SOLUSDT").toUpperCase();
        const orderID = String(body.orderID || "");
        const origClOrdID = String(body.origClOrdID || "");
        const side = body.side === "sell" ? "Sell" : "Buy";
        const quantity = Number(body.quantity);
        const price = Number(body.price);
        const takeProfit = Number(body.takeProfit);
        const stopLoss = Number(body.stopLoss);
        if ((!orderID && !origClOrdID) || !Number.isFinite(quantity) || quantity <= 0 || !Number.isFinite(price) || price <= 0) {
          response.statusCode = 400;
          response.end(JSON.stringify({ ok: false, message: "Amend needs order id, quantity and price" }));
          return;
        }

        const path = "/g-orders/replace";
        const expiry = Math.floor(Date.now() / 1000) + 60;
        const nextClOrdID = `crt-amend-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        const replaceParams = new URLSearchParams({
          symbol,
          posSide: "Merged",
          clOrdID: nextClOrdID,
          priceRp: String(price),
          orderQtyRq: String(quantity)
        });
        if (orderID) {
          replaceParams.set("orderID", orderID);
        } else if (origClOrdID) {
          replaceParams.set("origClOrdID", origClOrdID);
        }
        if (Number.isFinite(takeProfit) && takeProfit > 0) {
          replaceParams.set("takeProfitRp", String(takeProfit));
        }
        if (Number.isFinite(stopLoss) && stopLoss > 0) {
          replaceParams.set("stopLossRp", String(stopLoss));
        }

        const query = replaceParams.toString();
        const signature = signPhemexRequest(path, query, expiry, "", apiSecret);
        const host = testnet ? "https://testnet-api.phemex.com" : "https://api.phemex.com";
        const phemexResponse = await fetch(`${host}${path}?${query}`, {
          method: "PUT",
          headers: {
            "x-phemex-access-token": apiKey,
            "x-phemex-request-expiry": String(expiry),
            "x-phemex-request-signature": signature
          }
        });
        const rawPayload = await phemexResponse.text();
        let payload: any;
        try {
          payload = JSON.parse(rawPayload);
        } catch {
          payload = { msg: rawPayload };
        }
        if (!phemexResponse.ok || payload.code !== 0 || Number(payload.data?.bizError || 0) !== 0) {
          response.statusCode = 502;
          response.end(JSON.stringify({
            ok: false,
            message: phemexErrorMessage(payload, "Phemex amend order failed"),
            status: phemexResponse.status,
            request: {
              path,
              params: Object.fromEntries(replaceParams.entries())
            },
            payload
          }));
          return;
        }

        response.setHeader("Content-Type", "application/json");
        response.end(JSON.stringify({
          ok: true,
          orderID: payload.data?.orderID || orderID,
          clOrdID: payload.data?.clOrdID || nextClOrdID,
          request: {
            path,
            params: Object.fromEntries(replaceParams.entries())
          },
          payload
        }));
      } catch (error) {
        response.statusCode = 500;
        response.end(error instanceof Error ? error.message : "Unknown error");
      }
    });

    server.middlewares.use("/api/phemex-position-protection", async (request, response) => {
      try {
        if (request.method !== "POST") {
          response.statusCode = 405;
          response.end("Method not allowed");
          return;
        }

        const values = await loadEnvValues();
        const body = await parseBody(request);
        const exchange = activeExchangeFromBody(body, values);
        const apiKey = cleanEnvValue(exchange === "binance" ? values.BINANCE_API_KEY : values.PHEMEX_API_KEY);
        const apiSecret = cleanEnvValue(exchange === "binance" ? values.BINANCE_API_SECRET : values.PHEMEX_API_SECRET);
        if (!apiKey || !apiSecret) {
          response.statusCode = 401;
          response.end(JSON.stringify({ ok: false, message: `${exchange === "binance" ? "Binance" : "Phemex"} API key/secret missing` }));
          return;
        }

        const testnet = body.testnet !== false;
        if (!testnet && (exchange === "binance" ? values.BINANCE_ALLOW_MAINNET_ORDERS : values.PHEMEX_ALLOW_MAINNET_ORDERS) !== "true") {
          response.statusCode = 403;
          response.end(JSON.stringify({ ok: false, message: "Mainnet orders are disabled. Enable Mainnet orders in Exchange settings." }));
          return;
        }

        const symbol = String(body.symbol || "SOLUSDT").toUpperCase();
        const side = body.side === "sell" ? "Sell" : "Buy";
        const closeSide = side === "Buy" ? "Sell" : "Buy";
        const quantity = Number(body.quantity);
        const takeProfit = Number(body.takeProfit);
        const stopLoss = Number(body.stopLoss);
        const takeProfitOrderID = String(body.takeProfitOrderID || "").trim();
        const stopLossOrderID = String(body.stopLossOrderID || "").trim();
        if (!Number.isFinite(quantity) || quantity <= 0) {
          response.statusCode = 400;
          response.end(JSON.stringify({ ok: false, message: "Position protection needs valid quantity" }));
          return;
        }

        if (exchange === "binance") {
          const host = binanceHost(testnet);
          const createConditionalOrder = async (kind: "takeProfit" | "stopLoss", triggerPrice: number) => {
            const query = signedBinanceQuery({
              symbol,
              side: closeSide === "Sell" ? "SELL" : "BUY",
              type: kind === "takeProfit" ? "TAKE_PROFIT_MARKET" : "STOP_MARKET",
              quantity,
              stopPrice: triggerPrice,
              reduceOnly: true,
              workingType: "CONTRACT_PRICE",
              newClientOrderId: `crt-${kind}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
            }, apiSecret);
            const binanceResponse = await fetch(`${host}/fapi/v1/order?${query}`, {
              method: "POST",
              headers: { "X-MBX-APIKEY": apiKey }
            });
            const payload = await binanceResponse.json();
            if (!binanceResponse.ok || payload.code) {
              throw {
                message: payload.msg || `Binance ${kind} order failed`,
                status: binanceResponse.status,
                request: { path: "/fapi/v1/order", params: Object.fromEntries(new URLSearchParams(query).entries()) },
                payload
              };
            }
            return {
              orderID: String(payload.orderId),
              clOrdID: payload.clientOrderId,
              request: { path: "/fapi/v1/order" },
              payload
            };
          };

          const result: Record<string, unknown> = {};
          if (Number.isFinite(takeProfit) && takeProfit > 0) {
            result.takeProfit = await createConditionalOrder("takeProfit", takeProfit);
          }
          if (Number.isFinite(stopLoss) && stopLoss > 0) {
            result.stopLoss = await createConditionalOrder("stopLoss", stopLoss);
          }

          response.setHeader("Content-Type", "application/json");
          response.end(JSON.stringify({ ok: true, ...result }));
          return;
        }

        const host = testnet ? "https://testnet-api.phemex.com" : "https://api.phemex.com";
        const applyOrderReference = (params: URLSearchParams, orderReference: string) => {
          if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(orderReference)) {
            params.set("orderID", orderReference);
          } else {
            params.set("origClOrdID", orderReference);
          }
        };
        const cancelExistingProtection = async (orderID: string) => {
          if (!orderID) return undefined;
          const path = "/g-orders/cancel";
          const expiry = Math.floor(Date.now() / 1000) + 60;
          const params = new URLSearchParams({
            symbol,
            posSide: "Merged"
          });
          applyOrderReference(params, orderID);
          const query = params.toString();
          const signature = signPhemexRequest(path, query, expiry, "", apiSecret);
          const phemexResponse = await fetch(`${host}${path}?${query}`, {
            method: "DELETE",
            headers: {
              "x-phemex-access-token": apiKey,
              "x-phemex-request-expiry": String(expiry),
              "x-phemex-request-signature": signature
            }
          });
          const rawPayload = await phemexResponse.text();
          let payload: any;
          try {
            payload = JSON.parse(rawPayload);
          } catch {
            payload = { msg: rawPayload };
          }
          if (!phemexResponse.ok || (payload.code !== 0 && payload.code !== 10002)) {
            throw {
              message: phemexErrorMessage(payload, "Phemex old protection cancel failed"),
              status: phemexResponse.status,
              request: { path, params: Object.fromEntries(params.entries()) },
              payload
            };
          }
          return {
            orderID,
            request: { path, params: Object.fromEntries(params.entries()) },
            payload
          };
        };

        const replaceExistingProtection = async (kind: "takeProfit" | "stopLoss", orderID: string, triggerPrice: number) => {
          const path = "/g-orders/replace";
          const expiry = Math.floor(Date.now() / 1000) + 60;
          const params = new URLSearchParams({
            symbol,
            posSide: "Merged",
            clOrdID: `crt-${kind}-replace-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
            orderQtyRq: String(quantity),
            stopPxRp: String(triggerPrice),
            triggerType: "ByLastPrice",
            ordType: kind === "takeProfit" ? "MarketIfTouched" : "Stop",
            timeInForce: "ImmediateOrCancel"
          });
          applyOrderReference(params, orderID);
          const query = params.toString();
          const signature = signPhemexRequest(path, query, expiry, "", apiSecret);
          const phemexResponse = await fetch(`${host}${path}?${query}`, {
            method: "PUT",
            headers: {
              "x-phemex-access-token": apiKey,
              "x-phemex-request-expiry": String(expiry),
              "x-phemex-request-signature": signature
            }
          });
          const rawPayload = await phemexResponse.text();
          let payload: any;
          try {
            payload = JSON.parse(rawPayload);
          } catch {
            payload = { msg: rawPayload };
          }
          if (!phemexResponse.ok || payload.code !== 0 || Number(payload.data?.bizError || 0) !== 0) {
            throw {
              message: phemexErrorMessage(payload, `Phemex ${kind} protection replace failed`),
              status: phemexResponse.status,
              request: { path, params: Object.fromEntries(params.entries()) },
              payload
            };
          }
          return {
            orderID: payload.data?.orderID || orderID,
            clOrdID: payload.data?.clOrdID,
            request: { path, params: Object.fromEntries(params.entries()) },
            payload
          };
        };

        const createConditionalOrder = async (kind: "takeProfit" | "stopLoss", triggerPrice: number) => {
          const path = "/g-orders";
          const expiry = Math.floor(Date.now() / 1000) + 60;
          const orderBody: Record<string, string | boolean> = {
            symbol,
            side: closeSide,
            posSide: "Merged",
            ordType: kind === "takeProfit" ? "MarketIfTouched" : "Stop",
            timeInForce: "ImmediateOrCancel",
            reduceOnly: true,
            closeOnTrigger: true,
            orderQtyRq: String(quantity),
            stopPxRp: String(triggerPrice),
            triggerType: "ByLastPrice",
            clOrdID: `crt-${kind}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
            text: "Chart_Replay_Tool"
          };
          const rawBody = JSON.stringify(orderBody);
          const signature = signPhemexRequest(path, "", expiry, rawBody, apiSecret);
          const phemexResponse = await fetch(`${host}${path}`, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "x-phemex-access-token": apiKey,
              "x-phemex-request-expiry": String(expiry),
              "x-phemex-request-signature": signature
            },
            body: rawBody
          });
          const rawPayload = await phemexResponse.text();
          let payload: any;
          try {
            payload = JSON.parse(rawPayload);
          } catch {
            payload = { msg: rawPayload };
          }
          if (!phemexResponse.ok || payload.code !== 0 || Number(payload.data?.bizError || 0) !== 0) {
            throw {
              message: phemexErrorMessage(payload, `Phemex ${kind} order failed`),
              status: phemexResponse.status,
              request: { path, body: orderBody },
              payload
            };
          }
          return {
            orderID: payload.data?.orderID,
            clOrdID: payload.data?.clOrdID,
            request: { path, body: orderBody },
            payload
          };
        };

        const result: Record<string, unknown> = {};
        const hasTakeProfit = Number.isFinite(takeProfit) && takeProfit > 0;
        const hasStopLoss = Number.isFinite(stopLoss) && stopLoss > 0;
        if (hasTakeProfit) {
          result.takeProfit = takeProfitOrderID
            ? await replaceExistingProtection("takeProfit", takeProfitOrderID, takeProfit)
            : await createConditionalOrder("takeProfit", takeProfit);
        } else if (takeProfitOrderID) {
          result.oldTakeProfit = await cancelExistingProtection(takeProfitOrderID);
        }
        if (hasStopLoss) {
          result.stopLoss = stopLossOrderID
            ? await replaceExistingProtection("stopLoss", stopLossOrderID, stopLoss)
            : await createConditionalOrder("stopLoss", stopLoss);
        } else if (stopLossOrderID) {
          result.oldStopLoss = await cancelExistingProtection(stopLossOrderID);
        }

        response.setHeader("Content-Type", "application/json");
        response.end(JSON.stringify({ ok: true, ...result }));
      } catch (error: any) {
        response.statusCode = 502;
        response.end(JSON.stringify({
          ok: false,
          message: error?.message || "Phemex position protection failed",
          status: error?.status,
          request: error?.request,
          payload: error?.payload
        }));
      }
    });

    server.middlewares.use("/api/phemex-close-position", async (request, response) => {
      try {
        if (request.method !== "POST") {
          response.statusCode = 405;
          response.end("Method not allowed");
          return;
        }

        const values = await loadEnvValues();
        const body = await parseBody(request);
        const exchange = activeExchangeFromBody(body, values);
        const apiKey = cleanEnvValue(exchange === "binance" ? values.BINANCE_API_KEY : values.PHEMEX_API_KEY);
        const apiSecret = cleanEnvValue(exchange === "binance" ? values.BINANCE_API_SECRET : values.PHEMEX_API_SECRET);
        if (!apiKey || !apiSecret) {
          response.statusCode = 401;
          response.end(JSON.stringify({ ok: false, message: `${exchange === "binance" ? "Binance" : "Phemex"} API key/secret missing` }));
          return;
        }

        const testnet = body.testnet !== false;
        const liveOrdersEnabled = exchange === "binance" ? values.BINANCE_LIVE_ORDERS_ENABLED === "true" : values.PHEMEX_LIVE_ORDERS_ENABLED === "true";
        if (!liveOrdersEnabled) {
          response.statusCode = 403;
          response.end(JSON.stringify({ ok: false, message: `${exchange === "binance" ? "Binance" : "Phemex"} live orders are disabled in Exchange settings.` }));
          return;
        }
        if (!testnet && (exchange === "binance" ? values.BINANCE_ALLOW_MAINNET_ORDERS : values.PHEMEX_ALLOW_MAINNET_ORDERS) !== "true") {
          response.statusCode = 403;
          response.end(JSON.stringify({ ok: false, message: "Mainnet orders are disabled. Enable Mainnet orders in Exchange settings." }));
          return;
        }

        const symbol = String(body.symbol || "SOLUSDT").toUpperCase();
        const side = String(body.side || "").toLowerCase() === "sell" ? "sell" : "buy";
        const quantity = Number(body.quantity);
        if (!Number.isFinite(quantity) || quantity <= 0) {
          response.statusCode = 400;
          response.end(JSON.stringify({ ok: false, message: "Close needs valid quantity" }));
          return;
        }

        if (exchange === "binance") {
          const query = signedBinanceQuery({
            symbol,
            side: side === "buy" ? "SELL" : "BUY",
            type: "MARKET",
            quantity,
            reduceOnly: true,
            newClientOrderId: `crt-close-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
          }, apiSecret);
          const binanceResponse = await fetch(`${binanceHost(testnet)}/fapi/v1/order?${query}`, {
            method: "POST",
            headers: { "X-MBX-APIKEY": apiKey }
          });
          const payload = await binanceResponse.json();
          if (!binanceResponse.ok || payload.code) {
            response.statusCode = 502;
            response.end(JSON.stringify({
              ok: false,
              message: payload.msg || "Binance close position failed",
              status: binanceResponse.status,
              payload
            }));
            return;
          }
          response.setHeader("Content-Type", "application/json");
          response.end(JSON.stringify({ ok: true, orderID: String(payload.orderId), clOrdID: payload.clientOrderId, payload }));
          return;
        }

        const path = "/g-orders";
        const expiry = Math.floor(Date.now() / 1000) + 60;
        const orderBody: Record<string, string | boolean> = {
          symbol,
          side: side === "buy" ? "Sell" : "Buy",
          posSide: "Merged",
          ordType: "Market",
          timeInForce: "ImmediateOrCancel",
          orderQtyRq: String(quantity),
          reduceOnly: true,
          clOrdID: `crt-close-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
          text: "Chart_Replay_Tool"
        };
        const rawBody = JSON.stringify(orderBody);
        const signature = signPhemexRequest(path, "", expiry, rawBody, apiSecret);
        const host = testnet ? "https://testnet-api.phemex.com" : "https://api.phemex.com";
        const phemexResponse = await fetch(`${host}${path}`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "x-phemex-access-token": apiKey,
            "x-phemex-request-expiry": String(expiry),
            "x-phemex-request-signature": signature
          },
          body: rawBody
        });
        const rawPayload = await phemexResponse.text();
        let payload: any;
        try {
          payload = JSON.parse(rawPayload);
        } catch {
          payload = { msg: rawPayload };
        }
        if (!phemexResponse.ok || payload.code !== 0 || Number(payload.data?.bizError || 0) !== 0) {
          response.statusCode = 502;
          response.end(JSON.stringify({
            ok: false,
            message: phemexErrorMessage(payload, "Phemex close position failed"),
            status: phemexResponse.status,
            payload
          }));
          return;
        }

        response.setHeader("Content-Type", "application/json");
        response.end(JSON.stringify({
          ok: true,
          orderID: payload.data?.orderID,
          clOrdID: payload.data?.clOrdID,
          payload
        }));
      } catch (error) {
        response.statusCode = 500;
        response.end(error instanceof Error ? error.message : "Unknown error");
      }
    });

    server.middlewares.use("/api/phemex-cancel-order", async (request, response) => {
      try {
        if (request.method !== "POST") {
          response.statusCode = 405;
          response.end("Method not allowed");
          return;
        }

        const values = await loadEnvValues();
        const body = await parseBody(request);
        const exchange = activeExchangeFromBody(body, values);
        const apiKey = cleanEnvValue(exchange === "binance" ? values.BINANCE_API_KEY : values.PHEMEX_API_KEY);
        const apiSecret = cleanEnvValue(exchange === "binance" ? values.BINANCE_API_SECRET : values.PHEMEX_API_SECRET);
        if (!apiKey || !apiSecret) {
          response.statusCode = 401;
          response.end(JSON.stringify({ ok: false, message: `${exchange === "binance" ? "Binance" : "Phemex"} API key/secret missing` }));
          return;
        }

        const testnet = body.testnet !== false;
        if (!testnet && (exchange === "binance" ? values.BINANCE_ALLOW_MAINNET_ORDERS : values.PHEMEX_ALLOW_MAINNET_ORDERS) !== "true") {
          response.statusCode = 403;
          response.end(JSON.stringify({ ok: false, message: "Mainnet orders are disabled. Enable Mainnet orders in Exchange settings." }));
          return;
        }

        const symbol = String(body.symbol || "SOLUSDT").toUpperCase();
        const orderID = String(body.orderID || "");
        const clOrdID = String(body.clOrdID || "");
        if (!orderID && !clOrdID) {
          response.statusCode = 400;
          response.end(JSON.stringify({ ok: false, message: "Cancel needs order id or client order id" }));
          return;
        }

        if (exchange === "binance") {
          const query = signedBinanceQuery({
            symbol,
            orderId: orderID || undefined,
            origClientOrderId: clOrdID || undefined
          }, apiSecret);
          const binanceResponse = await fetch(`${binanceHost(testnet)}/fapi/v1/order?${query}`, {
            method: "DELETE",
            headers: { "X-MBX-APIKEY": apiKey }
          });
          const payload = await binanceResponse.json();
          if (!binanceResponse.ok || payload.code) {
            response.statusCode = 502;
            response.end(JSON.stringify({
              ok: false,
              message: payload.msg || "Binance cancel order failed",
              status: binanceResponse.status,
              payload
            }));
            return;
          }

          response.setHeader("Content-Type", "application/json");
          response.end(JSON.stringify({
            ok: true,
            orderID: String(payload.orderId || orderID),
            clOrdID: payload.clientOrderId || clOrdID,
            payload
          }));
          return;
        }

        const path = "/g-orders/cancel";
        const cancelParams = new URLSearchParams({
          symbol,
          posSide: "Merged"
        });
        if (orderID) {
          cancelParams.set("orderID", orderID);
        } else if (clOrdID) {
          cancelParams.set("clOrdID", clOrdID);
        }
        const query = cancelParams.toString();
        const expiry = Math.floor(Date.now() / 1000) + 60;
        const signature = signPhemexRequest(path, query, expiry, "", apiSecret);
        const host = testnet ? "https://testnet-api.phemex.com" : "https://api.phemex.com";
        const phemexResponse = await fetch(`${host}${path}?${query}`, {
          method: "DELETE",
          headers: {
            "x-phemex-access-token": apiKey,
            "x-phemex-request-expiry": String(expiry),
            "x-phemex-request-signature": signature
          }
        });
        const rawPayload = await phemexResponse.text();
        let payload: any;
        try {
          payload = JSON.parse(rawPayload);
        } catch {
          payload = { msg: rawPayload };
        }
        if (!phemexResponse.ok || payload.code !== 0 || Number(payload.data?.bizError || 0) !== 0) {
          response.statusCode = 502;
          response.end(JSON.stringify({
            ok: false,
            message: phemexErrorMessage(payload, "Phemex cancel order failed"),
            status: phemexResponse.status,
            payload
          }));
          return;
        }

        response.setHeader("Content-Type", "application/json");
        response.end(JSON.stringify({
          ok: true,
          orderID: payload.data?.orderID || orderID,
          clOrdID: payload.data?.clOrdID || clOrdID,
          payload
        }));
      } catch (error) {
        response.statusCode = 500;
        response.end(error instanceof Error ? error.message : "Unknown error");
      }
    });

    server.middlewares.use("/api/phemex-balance", async (request, response) => {
      try {
        if (request.method !== "POST") {
          response.statusCode = 405;
          response.end("Method not allowed");
          return;
        }

        const values = await loadEnvValues();
        const body = await parseBody(request);
        const exchange = activeExchangeFromBody(body, values);
        const apiKey = cleanEnvValue(exchange === "binance" ? values.BINANCE_API_KEY : values.PHEMEX_API_KEY);
        const apiSecret = cleanEnvValue(exchange === "binance" ? values.BINANCE_API_SECRET : values.PHEMEX_API_SECRET);
        if (!apiKey || !apiSecret) {
          response.statusCode = 401;
          response.end(JSON.stringify({ ok: false, message: `${exchange === "binance" ? "Binance" : "Phemex"} API key/secret missing` }));
          return;
        }

        const testnet = body.testnet !== false;
        const symbol = String(body.symbol || (exchange === "binance" ? values.BINANCE_SYMBOL : values.PHEMEX_SYMBOL) || "SOLUSDT").toUpperCase();
        if (exchange === "binance") {
          const accountQuery = signedBinanceQuery({}, apiSecret);
          const accountResponse = await fetch(`${binanceHost(testnet)}/fapi/v3/account?${accountQuery}`, {
            headers: { "X-MBX-APIKEY": apiKey }
          });
          const accountPayload = await accountResponse.json();
          if (!accountResponse.ok || accountPayload.code) {
            response.statusCode = 502;
            response.end(JSON.stringify({ ok: false, message: accountPayload.msg || "Binance account request failed", status: accountResponse.status, payload: accountPayload }));
            return;
          }
          const positionQuery = signedBinanceQuery({ symbol }, apiSecret);
          const positionResponse = await fetch(`${binanceHost(testnet)}/fapi/v3/positionRisk?${positionQuery}`, {
            headers: { "X-MBX-APIKEY": apiKey }
          });
          const positionPayload = await positionResponse.json();
          const positionsRaw = Array.isArray(positionPayload) ? positionPayload : [];
          const positions = positionsRaw.map((position: any) => ({
            symbol: position.symbol,
            side: Number(position.positionAmt) < 0 ? "Sell" : Number(position.positionAmt) > 0 ? "Buy" : "None",
            size: String(Math.abs(Number(position.positionAmt || 0))),
            avgEntryPriceRp: position.entryPrice,
            markPriceRp: position.markPrice,
            posSide: position.positionSide || "Merged"
          }));
          const usdtAsset = Array.isArray(accountPayload.assets)
            ? accountPayload.assets.find((asset: any) => asset.asset === "USDT")
            : undefined;
          const accountBalance = Number(usdtAsset?.walletBalance ?? accountPayload.totalWalletBalance ?? 0);
          const usedBalance = Number(accountPayload.totalInitialMargin ?? 0);
          response.setHeader("Content-Type", "application/json");
          response.end(JSON.stringify({
            ok: true,
            currency: "USDT",
            accountBalance,
            totalUsedBalance: usedBalance,
            bonusBalance: 0,
            payload: {
              code: 0,
              msg: "",
              data: {
                account: {
                  accountBalanceRv: String(accountBalance),
                  totalUsedBalanceRv: String(usedBalance)
                },
                positions
              },
              binanceAccount: accountPayload,
              binancePositions: positionPayload
            }
          }));
          return;
        }
        const host = testnet ? "https://testnet-api.phemex.com" : "https://api.phemex.com";
        const path = "/g-accounts/accountPositions";
        const query = `currency=USDT&symbol=${encodeURIComponent(symbol)}`;
        const expiry = Math.floor(Date.now() / 1000) + 60;
        const signature = signPhemexRequest(path, query, expiry, "", apiSecret);
        const phemexResponse = await fetch(`${host}${path}?${query}`, {
          method: "GET",
          headers: {
            "x-phemex-access-token": apiKey,
            "x-phemex-request-expiry": String(expiry),
            "x-phemex-request-signature": signature
          }
        });
        const rawPayload = await phemexResponse.text();
        let payload: any;
        try {
          payload = JSON.parse(rawPayload);
        } catch {
          payload = { msg: rawPayload };
        }
        if (!phemexResponse.ok || payload.code !== 0) {
          response.statusCode = 502;
          response.end(JSON.stringify({
            ok: false,
            message: phemexErrorMessage(payload, "Phemex balance request failed"),
            status: phemexResponse.status,
            payload
          }));
          return;
        }

        const account = payload.data?.account || {};
        response.setHeader("Content-Type", "application/json");
        response.end(JSON.stringify({
          ok: true,
          currency: account.currency || "USDT",
          accountBalance: Number(account.accountBalanceRv),
          totalUsedBalance: Number(account.totalUsedBalanceRv),
          bonusBalance: Number(account.bonusBalanceRv),
          payload
        }));
      } catch (error) {
        response.statusCode = 500;
        response.end(error instanceof Error ? error.message : "Unknown error");
      }
    });
  }
});

export default defineConfig({
  plugins: [react(), phemexSettingsPlugin()],
  server: {
    host: "127.0.0.1",
    port: 8788,
    strictPort: true
  }
});
