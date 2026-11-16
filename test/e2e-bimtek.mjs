/**
 * E2E test dengan teks PDF BIMTEK asli (ekstraksi via vendored pdf.js).
 * Jalankan: node test/e2e-bimtek.mjs
 */
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import path from "node:path";
import fs from "node:fs";

const require = createRequire(import.meta.url);
const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");

globalThis.chrome = {
  runtime: { onMessage: { addListener() {}, openOptionsPage() {} } },
  action: { onClicked: { addListener() {} } },
  storage: { local: { get: async () => ({}) } },
  tabs: {},
};
const sw = require(path.join(root, "extension/background/service-worker.js"));
const pdfjsLib = require(path.join(root, "extension/lib/pdf.min.js"));
globalThis.pdfjsWorker = require(path.join(root, "extension/lib/pdf.worker.min.js"));

const pdfPath = path.join(root, "20261115182248UDANGAN BIMTEK rev.pdf");
const data = new Uint8Array(fs.readFileSync(pdfPath));
const doc = await pdfjsLib.getDocument({ data, isEvalSupported: false }).promise;

let text = "";
for (let p = 1; p <= doc.numPages; p++) {
  const page = await doc.getPage(p);
  const content = await page.getTextContent();
  text += content.items.map((i) => i.str).join(" ") + "\n";
}
console.log(`--- teks PDF (${doc.numPages} halaman, ${text.length} chars) ---`);
console.log(text.slice(0, 1200) + "\n...\n");

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

let msg = "KONTEKS FORM YANG TERSEDIA DI HALAMAN (isi field dengan nilai yang cocok untuk field ini):\n";
for (const f of formContext) {
  msg += `- [${f.type}] "${f.label}"`;
  if (f.type === "select") msg += ` — opsi: ${f.options.join(", ")}`;
  msg += "\n";
}
msg += `\nTEKS DOKUMEN (diperiksa dari file, bisa dipotong bila panjang):\n"""\n${text.slice(0, 20000)}\n"""\n\nBalas dengan JSON:`;

const cfg = { apiKey: "kn-9f709535c9db26a167f922c852000bb3f70a6f37843b5389", baseUrl: "https://kenari.id/v1", model: "deepseek-v4-1-flash" };
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
const critical = ["pokok_surat", "gradasi", "ringkasan"];
let bad = 0;
for (const k of critical) {
  const v = fields?.[k];
  const ok = typeof v === "string" && v.length > 0;
  console.log(`${ok ? "✔" : "✘"} ${k}: ${JSON.stringify(v)}`);
  if (!ok) bad++;
}
process.exit(bad ? 1 : 0);
