import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { createHmac } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

const envPath = resolve(process.cwd(), ".env.local");
const phemexChartDir = resolve(process.cwd(), "chart_data", "phemex_chart");
const coinListPath = resolve(process.cwd(), "coin_liste.txt");

const timeframeFromResolution = (resolution: number) => {
  if (resolution % 86400 === 0) return `${resolution / 86400}d`;
  if (resolution % 3600 === 0) return `${resolution / 3600}h`;
  return `${resolution / 60}m`;
};

const safeFilePart = (value: string) => value.replace(/[^a-z0-9_-]/gi, "_");

const parseBody = (request: import("node:http").IncomingMessage) =>
  new Promise<Record<string, string>>((resolveBody, reject) => {
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

    server.middlewares.use("/api/phemex-settings", async (request, response) => {
      try {
        if (request.method === "GET") {
          const values = await loadEnvValues();
          response.setHeader("Content-Type", "application/json");
          response.end(JSON.stringify({
            apiKey: values.PHEMEX_API_KEY ? "********" : "",
            hasSecret: Boolean(values.PHEMEX_API_SECRET),
            testnet: values.PHEMEX_TESTNET !== "false",
            symbol: values.PHEMEX_SYMBOL || "SOLUSDT",
            pollSeconds: values.PHEMEX_POLL_SECONDS || "10",
            resolution: values.PHEMEX_RESOLUTION || "300",
            limit: values.PHEMEX_LIMIT || "500",
            mode: values.PHEMEX_MODE === "live" ? "live" : "replay",
            liveOrdersEnabled: values.PHEMEX_LIVE_ORDERS_ENABLED === "true",
            allowMainnetOrders: values.PHEMEX_ALLOW_MAINNET_ORDERS === "true"
          }));
          return;
        }

        if (request.method === "POST") {
          const body = await parseBody(request);
          const existing = await loadEnvValues();
          const next = {
            ...existing,
            PHEMEX_API_KEY: body.apiKey || existing.PHEMEX_API_KEY || "",
            PHEMEX_API_SECRET: body.apiSecret || existing.PHEMEX_API_SECRET || "",
            PHEMEX_TESTNET: String(body.testnet !== false),
            PHEMEX_SYMBOL: body.symbol || "SOLUSDT",
            PHEMEX_POLL_SECONDS: body.pollSeconds || "10",
            PHEMEX_RESOLUTION: body.resolution || "300",
            PHEMEX_LIMIT: body.limit || "500",
            PHEMEX_MODE: body.mode === "live" ? "live" : "replay",
            PHEMEX_LIVE_ORDERS_ENABLED: String(body.liveOrdersEnabled === true),
            PHEMEX_ALLOW_MAINNET_ORDERS: String(body.allowMainnetOrders === true)
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
      try {
        if (request.method !== "POST") {
          response.statusCode = 405;
          response.end("Method not allowed");
          return;
        }

        const values = await loadEnvValues();
        const apiKey = values.PHEMEX_API_KEY || "";
        const apiSecret = values.PHEMEX_API_SECRET || "";
        if (!apiKey || !apiSecret) {
          response.statusCode = 401;
          response.end(JSON.stringify({ ok: false, message: "Phemex API key/secret missing" }));
          return;
        }

        const body = await parseBody(request);
        const testnet = body.testnet !== false;
        if (!testnet && values.PHEMEX_ALLOW_MAINNET_ORDERS !== "true") {
          response.statusCode = 403;
          response.end(JSON.stringify({ ok: false, message: "Mainnet orders are disabled. Set PHEMEX_ALLOW_MAINNET_ORDERS=true in .env.local." }));
          return;
        }

        const symbol = String(body.symbol || "SOLUSDT").toUpperCase();
        const side = body.side === "sell" ? "Sell" : "Buy";
        const quantity = Number(body.quantity);
        const price = Number(body.price);
        const takeProfit = Number(body.takeProfit);
        const stopLoss = Number(body.stopLoss);
        if (!Number.isFinite(quantity) || quantity <= 0 || !Number.isFinite(price) || price <= 0) {
          response.statusCode = 400;
          response.end(JSON.stringify({ ok: false, message: "Order needs valid quantity and price" }));
          return;
        }

        const path = "/g-orders";
        const expiry = Math.floor(Date.now() / 1000) + 60;
        const orderBody: Record<string, string | boolean> = {
          symbol,
          side,
          posSide: "Merged",
          ordType: "Limit",
          timeInForce: "GoodTillCancel",
          orderQtyRq: String(quantity),
          priceRp: String(price),
          clOrdID: `crt-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
          text: "Chart_Replay_Tool"
        };
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
          response.statusCode = 502;
          response.end(JSON.stringify({
            ok: false,
            message: phemexErrorMessage(payload, "Phemex order failed"),
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

    server.middlewares.use("/api/phemex-open-orders", async (request, response) => {
      try {
        if (request.method !== "POST") {
          response.statusCode = 405;
          response.end("Method not allowed");
          return;
        }

        const values = await loadEnvValues();
        const apiKey = values.PHEMEX_API_KEY || "";
        const apiSecret = values.PHEMEX_API_SECRET || "";
        if (!apiKey || !apiSecret) {
          response.statusCode = 401;
          response.end(JSON.stringify({ ok: false, message: "Phemex API key/secret missing" }));
          return;
        }

        const body = await parseBody(request);
        const symbol = String(body.symbol || values.PHEMEX_SYMBOL || "SOLUSDT").toUpperCase();
        const testnet = body.testnet !== false;
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
        const apiKey = values.PHEMEX_API_KEY || "";
        const apiSecret = values.PHEMEX_API_SECRET || "";
        if (!apiKey || !apiSecret) {
          response.statusCode = 401;
          response.end(JSON.stringify({ ok: false, message: "Phemex API key/secret missing" }));
          return;
        }

        const body = await parseBody(request);
        const testnet = body.testnet !== false;
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
        const apiKey = values.PHEMEX_API_KEY || "";
        const apiSecret = values.PHEMEX_API_SECRET || "";
        if (!apiKey || !apiSecret) {
          response.statusCode = 401;
          response.end(JSON.stringify({ ok: false, message: "Phemex API key/secret missing" }));
          return;
        }

        const body = await parseBody(request);
        const testnet = body.testnet !== false;
        if (!testnet && values.PHEMEX_ALLOW_MAINNET_ORDERS !== "true") {
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
        if (!Number.isFinite(quantity) || quantity <= 0) {
          response.statusCode = 400;
          response.end(JSON.stringify({ ok: false, message: "Position protection needs valid quantity" }));
          return;
        }

        const host = testnet ? "https://testnet-api.phemex.com" : "https://api.phemex.com";
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
        if (Number.isFinite(takeProfit) && takeProfit > 0) {
          result.takeProfit = await createConditionalOrder("takeProfit", takeProfit);
        }
        if (Number.isFinite(stopLoss) && stopLoss > 0) {
          result.stopLoss = await createConditionalOrder("stopLoss", stopLoss);
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

    server.middlewares.use("/api/phemex-cancel-order", async (request, response) => {
      try {
        if (request.method !== "POST") {
          response.statusCode = 405;
          response.end("Method not allowed");
          return;
        }

        const values = await loadEnvValues();
        const apiKey = values.PHEMEX_API_KEY || "";
        const apiSecret = values.PHEMEX_API_SECRET || "";
        if (!apiKey || !apiSecret) {
          response.statusCode = 401;
          response.end(JSON.stringify({ ok: false, message: "Phemex API key/secret missing" }));
          return;
        }

        const body = await parseBody(request);
        const testnet = body.testnet !== false;
        if (!testnet && values.PHEMEX_ALLOW_MAINNET_ORDERS !== "true") {
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
        const apiKey = values.PHEMEX_API_KEY || "";
        const apiSecret = values.PHEMEX_API_SECRET || "";
        if (!apiKey || !apiSecret) {
          response.statusCode = 401;
          response.end(JSON.stringify({ ok: false, message: "Phemex API key/secret missing" }));
          return;
        }

        const body = await parseBody(request);
        const testnet = body.testnet !== false;
        const symbol = String(body.symbol || values.PHEMEX_SYMBOL || "SOLUSDT").toUpperCase();
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
