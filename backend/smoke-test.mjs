#!/usr/bin/env node
/**
 * Smoke test proxy:
 *   node smoke-test.mjs https://proxy.example.com TOKEN_APLIKASI
 *
 * Cek: /healthz OK, request tanpa token ditolak 401,
 * request dengan token salah ditolak 401.
 * Tanpa memanggil AI (hemat kuota) — cukup pastikan auth & routing jalan.
 */

const base = process.argv[2]?.replace(/\/+$/, "");
const token = process.argv[3];

if (!base || !token) {
  console.error("Pemakaian: node smoke-test.mjs https://proxy.example.com TOKEN_APLIKASI");
  process.exit(1);
}

let fail = 0;
const check = (name, cond, extra = "") => {
  console.log(`${cond ? "✔" : "✘"} ${name}${extra ? ` — ${extra}` : ""}`);
  if (!cond) fail++;
};

// 1. healthz
const hz = await fetch(`${base}/healthz`);
const hzBody = await hz.json().catch(() => ({}));
check("GET /healthz = 200", hz.status === 200, JSON.stringify(hzBody));

// 2. tanpa token → 401
const noAuth = await fetch(`${base}/v1/chat/completions`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ model: "x", messages: [] }),
});
check("POST tanpa token = 401", noAuth.status === 401, `dapat ${noAuth.status}`);

// 3. token salah → 401
const badAuth = await fetch(`${base}/v1/chat/completions`, {
  method: "POST",
  headers: { "content-type": "application/json", authorization: `Bearer token-ngawur` },
  body: JSON.stringify({ model: "x", messages: [] }),
});
check("POST token salah = 401", badAuth.status === 401, `dapat ${badAuth.status}`);

// 4. token benar tapi body rusak → 400 (buktikan auth lolos, validasi jalan)
const badBody = await fetch(`${base}/v1/chat/completions`, {
  method: "POST",
  headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
  body: "bukan-json",
});
check("POST token benar + body rusak = 400", badBody.status === 400, `dapat ${badBody.status}`);

process.exit(fail ? 1 : 0);
