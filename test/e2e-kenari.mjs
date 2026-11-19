/**
 * E2E test: simulasi alur analyze() service-worker ke endpoint Kenari.
 * Jalankan: node test/e2e-kenari.mjs
 */
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import path from "node:path";

const require = createRequire(import.meta.url);
const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");

globalThis.chrome = {
  runtime: { onMessage: { addListener() {} }, openOptionsPage() {} },
  action: { onClicked: { addListener() {} } },
  storage: { local: { get: async () => ({}) } },
  tabs: {},
};
const sw = require(path.join(root, "extension/background/service-worker.js"));

const DOCS = `KEPALA DINAS ARSIP DAERAH PROVINSI X
Jl. Jenderal Sudirman No. 1, Kota X
Kota X, 3 November 2026

Nomor    : 005/1013/2026
Sifat    : Segera
Perihal  : Permohonan Penggunaan Ruang Rapat
Referensi: 002/1001/2026

Kepada Yth.
Bapak/Ibu Kepala Bagian Umum
Pemerintah Kota X
di
Kota X

Dengan hormat,
Sehubungan dengan surat Nomor 002/1001/2026 tanggal 20 Oktober 2026, dan dalam rangka pelaksanaan rapat koordinasi daerah, bersama ini kami mengajukan permohonan penggunaan ruang rapat lantai 3 pada hari Senin, 16 November 2026, pukul 09.00 WIB.
Terlampir daftar peserta rapat sebanyak 25 orang.
Atas perhatian dan kerja sama Bapak/Ibu, kami ucapkan terima kasih.

Kepala Dinas Arsip Daerah,
(tanda tangan)
Budi Santoso
NIP. 19800101 200501 1 001

Lampiran : 1 (satu) berkas
Tembusan : -`;

// Konteks form sesuai DOM SRIKANDI asli (dropdown dinamis tanpa opsi statis)
const formContext = [
  { label: "Nomor Naskah", type: "text" },
  { label: "Nomor Referensi", type: "select", options: [] },
  { label: "Hal", type: "textarea" },
  { label: "Jenis Naskah", type: "select", options: [] },
  { label: "Sifat Naskah", type: "select", options: [] },
  { label: "Klasifikasi", type: "select", options: [] },
  { label: "Isi Ringkas", type: "textarea" },
  { label: "Utama (Internal / Eksternal Srikandi)", type: "select", options: [] },
];

// Rekonstruksi user message persis seperti buildUserMessage di SW
let msg = "KONTEKS FORM YANG TERSEDIA DI HALAMAN (isi field dengan nilai yang cocok untuk field ini):\n";
for (const f of formContext) {
  msg += `- [${f.type}] "${f.label}"`;
  if (f.type === "select") msg += ` — opsi: ${f.options.join(", ")}`;
  msg += "\n";
}
msg += `\nTEKS DOKUMEN (diperiksa dari file, bisa dipotong bila panjang):\n"""\n${DOCS}\n"""\n\nBalas dengan JSON:`;

const cfg = {
  apiKey: process.env.KENARI_API_KEY,
  baseUrl: process.env.KENARI_BASE_URL || "https://kenari.id/v1",
  model: process.env.KENARI_MODEL || "deepseek-v4-1-flash",
};
if (!cfg.apiKey) {
  console.error("Set KENARI_API_KEY env var dulu — key tidak lagi di-hardcode di repo.");
  process.exit(1);
}

const res = await fetch(`${cfg.baseUrl}/chat/completions`, {
  method: "POST",
  headers: { "content-type": "application/json", authorization: `Bearer ${cfg.apiKey}` },
  body: JSON.stringify({
    model: cfg.model,
    temperature: 0.2,
    max_tokens: 4096,
    messages: [
      { role: "system", content: sw.SYSTEM_PROMPT },
      { role: "user", content: msg },
    ],
  }),
});
const body = await res.json();
if (!res.ok) {
  console.error("HTTP", res.status, JSON.stringify(body).slice(0, 400));
  process.exit(1);
}
const raw = body.choices?.[0]?.message?.content || "";
console.log("--- respons mentah ---\n" + raw + "\n");
const fields = sw.normalizeFields(sw.extractJson(raw));
console.log("--- hasil parse ---");
console.log(JSON.stringify(fields, null, 2));
if (!fields) {
  console.error("\nGAGAL: JSON tidak ter-parse");
  process.exit(1);
}
const expect = {
  nomor_naskah: "005/1013/2026",
  nomor_referensi: "002/1001/2026",
  tanggal_naskah: "2026-11-03",
  jenis_naskah: "Surat",
  jumlah_lampiran: 1,
};
// gradasi/prioritas adalah dropdown dinamis (opsi tidak diketahui) → model boleh
// menulis nilai singkat sesuai dokumen (mis. "Segera", "Biasa") atau null.
const optional = ["gradasi", "prioritas", "pokok_surat", "ringkasan"];
let bad = 0;
for (const [k, v] of Object.entries(expect)) {
  const got = fields[k];
  const okk = typeof got === "number" ? got === v : got === v || (typeof got === "string" && got.includes(v));
  console.log(`${okk ? "✔" : "✘"} ${k}: ${JSON.stringify(got)}${okk ? "" : ` (diharap ${v})`}`);
  if (!okk) bad++;
}
for (const k of optional) {
  const got = fields[k];
  const okk = got === null || got === undefined || (typeof got === "string" && got.length > 0);
  console.log(`${okk ? "✔" : "✘"} ${k} (bebas/null): ${JSON.stringify(got)}`);
  if (!okk) bad++;
}
process.exit(bad ? 1 : 0);
