#!/usr/bin/env node
/**
 * SRIKANDI Naskah AI — proxy backend tipis (zero-dependency, Node >= 18)
 *
 * Tugas: menerima request dari extension (auth pakai *token aplikasi*),
 * lalu meneruskannya ke endpoint AI dengan API key asli yang hanya ada
 * di server ini. Isi dokumen TIDAK dilog.
 *
 * Endpoint:
 *   GET  /healthz              → health check (tanpa auth)
 *   POST /v1/chat/completions  → forward OpenAI-compatible (default: Kenari)
 *   POST /v1/messages          → forward Anthropic (opsional, kalau diisi)
 *
 * Konfigurasi via .env — lihat .env.example.
 */

"use strict";

const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");

/* ---------------------------- load .env ---------------------------- */

function loadDotEnv(file) {
  try {
    const raw = fs.readFileSync(file, "utf8");
    for (const line of raw.split(/\r?\n/)) {
      if (line.trim().startsWith("#")) continue;
      const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
      if (!m) continue;
      let v = m[2];
      if (
        (v.startsWith('"') && v.endsWith('"')) ||
        (v.startsWith("'") && v.endsWith("'"))
      ) {
        v = v.slice(1, -1);
      }
      if (!(m[1] in process.env)) process.env[m[1]] = v;
    }
  } catch {
    /* .env tidak ada — biarkan env asli yang dipakai */
  }
}

loadDotEnv(path.join(__dirname, ".env"));

/* ---------------------------- konfigurasi ---------------------------- */

const trimSlash = (s) => s.replace(/\/+$/, "");
const toInt = (v, def) => {
  const n = parseInt(v, 10);
  return Number.isFinite(n) && n > 0 ? n : def;
};

const CONFIG = {
  port: toInt(process.env.PORT, 8787),
  host: process.env.HOST || "127.0.0.1",
  // Upstream OpenAI-compatible (default: preset Kenari)
  upstreamBaseUrl: trimSlash(process.env.UPSTREAM_BASE_URL || "https://kenari.id/v1"),
  upstreamApiKey: process.env.UPSTREAM_API_KEY || "",
  // Upstream Anthropic (opsional)
  anthropicBaseUrl: trimSlash(process.env.ANTHROPIC_BASE_URL || "https://api.anthropic.com"),
  anthropicApiKey: process.env.ANTHROPIC_API_KEY || "",
  // Token aplikasi untuk pengguna extension (BUKAN key AI)
  appTokens: (process.env.APP_TOKENS || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean),
  maxBodyBytes: toInt(process.env.MAX_BODY_BYTES, 400_000),
  rateLimitPerHour: toInt(process.env.RATE_LIMIT_PER_HOUR, 60),
  upstreamTimeoutMs: toInt(process.env.UPSTREAM_TIMEOUT_MS, 120_000),
};

/* ---------------------------- util ---------------------------- */

function json(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(body),
  });
  res.end(body);
}

/** Bandingkan token tanpa timing attack. */
function tokenMatches(incoming) {
  if (!incoming) return false;
  const a = Buffer.from(incoming);
  for (const t of CONFIG.appTokens) {
    const b = Buffer.from(t);
    if (a.length === b.length && crypto.timingSafeEqual(a, b)) return true;
  }
  return false;
}

/** ID pendek untuk log — jangan log token mentah. */
function tokenIdOf(token) {
  return crypto.createHash("sha256").update(token).digest("hex").slice(0, 12);
}

function extractToken(req) {
  const auth = req.headers["authorization"] || "";
  if (auth.toLowerCase().startsWith("bearer ")) return auth.slice(7).trim();
  const xkey = req.headers["x-api-key"];
  if (typeof xkey === "string" && xkey.trim()) return xkey.trim();
  return "";
}

function log(entry) {
  console.log(JSON.stringify({ ts: new Date().toISOString(), ...entry }));
}

/* ---------------------------- rate limit ---------------------------- */

// Sederhana, in-memory: cukup untuk proxy tipis. Reset saat restart.
const hits = new Map(); // tokenId -> timestamp[]

function rateLimited(tokenId) {
  const now = Date.now();
  const windowStart = now - 3_600_000;
  const arr = (hits.get(tokenId) || []).filter((ts) => ts > windowStart);
  if (arr.length >= CONFIG.rateLimitPerHour) {
    hits.set(tokenId, arr);
    return true;
  }
  arr.push(now);
  hits.set(tokenId, arr);
  return false;
}

/* ---------------------------- body reader ---------------------------- */

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let tooLarge = false;
    req.on("data", (chunk) => {
      if (tooLarge) return; // buang sisanya; 413 diposisikan setelah body habis
      size += chunk.length;
      if (size > limit) {
        tooLarge = true;
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve({ buf: Buffer.concat(chunks), tooLarge }));
    req.on("error", reject);
  });
}

/* ---------------------------- forward ---------------------------- */

async function forward(req, res, pathname, rawBody, tokenId) {
  const isAnthropic = pathname === "/v1/messages";
  const upstreamKey = isAnthropic ? CONFIG.anthropicApiKey : CONFIG.upstreamApiKey;
  if (!upstreamKey) {
    json(res, 501, {
      error: {
        message: `Upstream ${isAnthropic ? "Anthropic" : "OpenAI-compatible"} belum dikonfigurasi di proxy (cek .env).`,
      },
    });
    return;
  }

  const baseUrl = isAnthropic ? CONFIG.anthropicBaseUrl : CONFIG.upstreamBaseUrl;
  const upstreamUrl = baseUrl + pathname;

  const headers = { "content-type": "application/json" };
  if (isAnthropic) {
    headers["x-api-key"] = upstreamKey;
    headers["anthropic-version"] =
      req.headers["anthropic-version"] || "2026-10-21";
  } else {
    headers.authorization = `Bearer ${upstreamKey}`;
  }

  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), CONFIG.upstreamTimeoutMs);
  const start = Date.now();
  try {
    const up = await fetch(upstreamUrl, {
      method: "POST",
      headers,
      body: rawBody.toString("utf8"),
      signal: ac.signal,
    });
    const text = await up.text();
    log({
      event: "forward",
      tokenId,
      path: pathname,
      status: up.status,
      ms: Date.now() - start,
      bytes: rawBody.length,
    });
    res.writeHead(up.status, {
      "content-type": up.headers.get("content-type") || "application/json",
    });
    res.end(text);
  } catch (err) {
    const aborted = err?.name === "AbortError";
    log({
      event: "upstream_error",
      tokenId,
      path: pathname,
      ms: Date.now() - start,
      error: aborted ? "timeout" : String(err?.message || err),
    });
    json(res, aborted ? 504 : 502, {
      error: {
        message: aborted
          ? "Upstream timeout — coba lagi."
          : "Gagal menghubungi endpoint AI.",
      },
    });
  } finally {
    clearTimeout(timer);
  }
}

/* ---------------------------- server ---------------------------- */

const server = http.createServer(async (req, res) => {
  let pathname = "/";
  try {
    pathname = new URL(req.url, "http://localhost").pathname;
  } catch {
    /* biarkan fallback */
  }

  try {
    // Health check — tanpa auth (untuk monitoring/UptimeRobot)
    if (req.method === "GET" && pathname === "/healthz") {
      return json(res, 200, {
        ok: true,
        uptime: Math.round(process.uptime()),
        providers: {
          "openai-compatible": CONFIG.upstreamApiKey ? "configured" : "unset",
          anthropic: CONFIG.anthropicApiKey ? "configured" : "unset",
        },
      });
    }

    const ROUTES = ["/v1/chat/completions", "/v1/messages"];
    if (req.method !== "POST" || !ROUTES.includes(pathname)) {
      return json(res, 404, { error: { message: "Not found" } });
    }

    const token = extractToken(req);
    if (!tokenMatches(token)) {
      log({ event: "auth_fail", path: pathname });
      return json(res, 401, {
        error: { message: "Token aplikasi tidak valid. Hubungi admin proxy." },
      });
    }

    const tokenId = tokenIdOf(token);
    if (rateLimited(tokenId)) {
      log({ event: "rate_limited", tokenId, path: pathname });
      return json(res, 429, {
        error: {
          message: `Kuota ${CONFIG.rateLimitPerHour} request/jam terlampaui. Coba lagi nanti.`,
        },
      });
    }

    const { buf: rawBody, tooLarge } = await readBody(req, CONFIG.maxBodyBytes);
    if (tooLarge) {
      log({
        event: "payload_too_large",
        tokenId,
        path: pathname,
        limit: CONFIG.maxBodyBytes,
      });
      return json(res, 413, {
        error: {
          message: `Payload melebihi ${CONFIG.maxBodyBytes} byte.`,
        },
      });
    }
    // Validasi JSON sekali di sini; diteruskan apa adanya ke upstream.
    try {
      const parsed = JSON.parse(rawBody.toString("utf8"));
      if (!parsed || typeof parsed !== "object") throw new Error("bukan objek");
    } catch {
      return json(res, 400, {
        error: { message: "Body bukan JSON yang valid." },
      });
    }

    await forward(req, res, pathname, rawBody, tokenId);
  } catch (err) {
    const status = err?.status || 500;
    if (status >= 500) log({ event: "error", path: pathname, error: String(err?.message || err) });
    if (!res.headersSent) {
      json(res, status, {
        error: { message: err?.message || "Kesalahan internal proxy." },
      });
    } else {
      res.end();
    }
  }
});

server.listen(CONFIG.port, CONFIG.host, () => {
  const masked = CONFIG.upstreamApiKey
    ? `${CONFIG.upstreamApiKey.slice(0, 5)}…`
    : "(unset)";
  console.log(
    `[srikandi-proxy] listening on http://${CONFIG.host}:${CONFIG.port}`,
  );
  console.log(
    `[srikandi-proxy] upstream=${CONFIG.upstreamBaseUrl} key=${masked}`,
  );
  console.log(
    `[srikandi-proxy] tokens=${CONFIG.appTokens.length} rateLimit=${CONFIG.rateLimitPerHour}/jam maxBody=${CONFIG.maxBodyBytes}B`,
  );
  if (!CONFIG.appTokens.length || !CONFIG.upstreamApiKey) {
    console.warn(
      "[srikandi-proxy] PERINGATAN: APP_TOKENS atau UPSTREAM_API_KEY belum diisi — cek .env",
    );
  }
});

for (const sig of ["SIGINT", "SIGTERM"]) {
  process.on(sig, () => {
    log({ event: "shutdown", signal: sig });
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 5000).unref();
  });
}
