/**
 * Uji alur klasifikasi dua tahap (tanpa ekstraksi PDF) dengan daftar asli.
 * Jalankan: node test/uji-klasifikasi.mjs
 */
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import path from "node:path";
import fs from "node:fs";

const require = createRequire(import.meta.url);
const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");

globalThis.chrome = {
  runtime: {
    onMessage: { addListener() {} },
    openOptionsPage() {},
    getURL: (p) => path.join(root, "extension", p),
  },
  action: { onClicked: { addListener() {} } },
  storage: { local: { get: async () => ({}) } },
  tabs: {},
};
const sw = require(path.join(root, "extension/background/service-worker.js"));
const fsMod = await import("node:fs");
const list = JSON.parse(
  fsMod.readFileSync(
    path.join(root, "extension/data/klasifikasi.json"),
    "utf8",
  ),
);

// Replikasi logika SW: blok top-level → tahap 1 → refine (akses fungsi internal
// tidak bisa; jadi replikasi minimal di sini hanya untuk tahap 1).
const tops = list
  .filter((e) => (e.k.match(/\./g) || []).length <= 1)
  .map((e) => `${e.k} ${e.n}`)
  .join("\n");

const DOC = `PEMERINTAH KABUPATEN BOJONEGORO  SEKRETARIAT DAERAH
Bojonegoro, ${"${tanggal_naskah}"}
Nomor : ${"${nomor_naskah}"}
Sifat : Biasa
Hal : Udangan Bimbingan Teknis Digitalisasi Arsip Tahun 2026
Dalam rangka meningkatkan kualitas pengelolaan dan digitalisasi arsip serta
optimalisasi pemanfaatan aplikasi kearsipan, Dinas Perpustakaan dan Kearsipan
Kabupaten Bojonegoro akan melaksanakan Bimbingan Teknis Aplikasi SRIKANDI.
Kepala Perangkat Daerah diminta menugaskan 1 orang administrator aplikasi
SRIKANDI untuk mengikuti kegiatan pada 23 s.d 24 November 2026.`;

const formContext = [
  { label: "Nomor Naskah", type: "text" },
  { label: "Hal", type: "textarea" },
  { label: "Jenis Naskah", type: "select", options: [] },
  { label: "Sifat Naskah", type: "select", options: [] },
  { label: "Klasifikasi", type: "select", options: [] },
  { label: "Isi Ringkas", type: "textarea" },
];

let msg =
  "KONTEKS FORM YANG TERSEDIA DI HALAMAN (isi field dengan nilai yang cocok untuk field ini):\n";
for (const f of formContext) {
  msg += `- [${f.type}] "${f.label}"`;
  if (f.type === "select") msg += ` — opsi: ${f.options.join(", ")}`;
  msg += "\n";
}
msg += `\nDAFTAR KLASIFIKASI ARSIP (pilih kandidat kode cabang dari sini untuk key klasifikasi_kandidat):\n${tops}\n\n`;
msg += `TEKS DOKUMEN (diperiksa dari file, bisa dipotong bila panjang):\n"""\n${DOC}\n"""\n\nBalas dengan JSON:`;

const cfg = {
  apiKey: process.env.KENARI_API_KEY,
  baseUrl: process.env.KENARI_BASE_URL || "https://kenari.id/v1",
  model: process.env.KENARI_MODEL || "deepseek-v4-1-flash",
};
if (!cfg.apiKey) {
  console.error("Set KENARI_API_KEY env var dulu — key tidak lagi di-hardcode di repo.");
  process.exit(1);
}

const call = async (system, user) => {
  const res = await fetch(`${cfg.baseUrl}/chat/completions`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${cfg.apiKey}`,
    },
    body: JSON.stringify({
      model: cfg.model,
      temperature: 0.2,
      max_tokens: 4096,
      messages: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
    }),
  });
  const body = await res.json();
  if (!res.ok)
    throw new Error(
      `HTTP ${res.status}: ${JSON.stringify(body).slice(0, 200)}`,
    );
  return body.choices?.[0]?.message?.content || "";
};

// ---- Tahap 1 ----
const raw1 = await call(sw.SYSTEM_PROMPT, msg);
console.log("--- raw tahap 1 ---\n" + raw1.slice(0, 800));
const fields = sw.normalizeFields(sw.extractJson(raw1));
console.log("--- tahap 1 ---");
console.log(JSON.stringify(fields, null, 1));
if (!fields) process.exit(1);

// ---- Tahap 2 (replikasi refineKlasifikasi) ----
// refine berjalan bila gradasi kosong ATAU kodenya bukan leaf dari daftar
const leavesAll = list.filter(
  (e) => !list.some((o) => o.k !== e.k && o.k.startsWith(e.k + ".")),
);
const gradasiStr =
  typeof fields.gradasi === "string" ? fields.gradasi.trim() : "";
const gradasiIsLeaf =
  !!gradasiStr && leavesAll.some((e) => e.k === gradasiStr.split(/\s+/)[0]);
const kandidat = Array.isArray(fields.klasifikasi_kandidat)
  ? fields.klasifikasi_kandidat.filter((kd) => list.some((e) => e.k === kd))
  : [];
let hasil = null;
if (!gradasiIsLeaf && kandidat.length) {
  const leaves = leavesAll;
  const under = leaves
    .filter((e) =>
      kandidat.some((kd) => e.k === kd || e.k.startsWith(kd + ".")),
    )
    .slice(0, 200)
    .map((e) => `${e.k} ${e.n}`)
    .join("\n");
  if (under) {
    const kmsg = [
      `Perihal naskah: ${fields.pokok_surat || "-"}`,
      `Jenis naskah: ${fields.jenis_naskah || "-"}`,
      `Ringkasan: ${fields.ringkasan || "-"}`,
      `Cuplikan dokumen: ${DOC.slice(0, 2000)}`,
      "",
      `DAFTAR KLASIFIKASI:\n${under}`,
      "\nBalas dengan JSON:",
    ].join("\n");
    const raw2 = await call(
      'Kamu asisten kearsipan (SRIKANDI, ANRI). Pilih SATU kode klasifikasi arsip paling tepat dari DAFTAR KLASIFIKASI yang diberikan, berdasar perihal, jenis, dan ringkasan naskah. Balas HANYA satu objek JSON valid: {"klasifikasi": "<kode> <nama>"} (persis kode+nama dari daftar). Bila tidak ada yang cocok, balas {"klasifikasi": null}. Tanpa penjelasan lain.',
      kmsg,
    );
    console.log("--- tahap 2 ---");
    console.log(raw2);
    const parsed = sw.extractJson(raw2);
    const val = parsed?.klasifikasi;
    if (typeof val === "string" && val.trim()) {
      const code = val.trim().split(/\s+/)[0];
      const exact = leaves.find((e) => e.k === code);
      hasil = exact ? `${exact.k} ${exact.n}` : null;
    }
  }
}
console.log("klasifikasi final:", hasil);
console.log("kandidat tahap 1:", JSON.stringify(kandidat));
const ok = hasil !== null && typeof hasil === "string" && /\d/.test(hasil);
console.log(
  ok ? "✔ klasifikasi terpilih dari CSV" : "✘ klasifikasi tidak terpilih",
);
process.exit(ok ? 0 : 1);
