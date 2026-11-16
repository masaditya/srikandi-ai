/**
 * Konversi referensi klasifikasi → extension/data/klasifikasi.json
 * Mendukung dua format sumber:
 *  1. JSON API SRIKANDI (seperti klasifikasi.json):
 *     { success, result: { data: [{ kode, nama, kode_nama, status, ... }] } }
 *     → nilai diambil dari kolom "kode" (+ nama), hanya status AKTIF.
 *  2. CSV injection (fallback lama).
 * Jalankan: node scripts/build-klasifikasi.mjs [sumber.json|sumber.csv]
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const csvPath =
  process.argv[2] ||
  path.join(
    root,
    "20260723094144format-Injeksi-klasifikasi-srikandi-BOJONEGORO-2026.csv",
  );
const outDir = path.join(root, "extension", "data");
const outPath = path.join(outDir, "klasifikasi.json");

const out = [];
const seen = new Set();

if (csvPath.endsWith(".json")) {
  // ---- format JSON API ----
  const body = JSON.parse(fs.readFileSync(csvPath, "utf8"));
  const rows = body?.result?.data || [];
  for (const d of rows) {
    const kode = String(d.kode || "").trim();
    const nama = String(d.nama || "")
      .replace(/\s+/g, " ")
      .trim();
    if ((d.status && d.status !== "AKTIF") || !kode || !nama) continue;
    if (seen.has(kode)) continue;
    seen.add(kode);
    out.push({ k: kode, n: nama });
  }
} else {
  // ---- format CSV ----
  const raw = fs.readFileSync(csvPath, "utf8");
  const lines = raw.split(/\r?\n/).filter((l) => l.trim());

  // Deteksi pemisah (; atau ,)
  const sep =
    (lines[0].match(/;/g) || []).length >= (lines[0].match(/,/g) || []).length
      ? ";"
      : ",";

  function parseLine(line) {
    const cols = [];
    let cur = "";
    let inQ = false;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (ch === '"') {
        if (inQ && line[i + 1] === '"') {
          cur += '"';
          i++;
        } else inQ = !inQ;
      } else if (ch === sep && !inQ) {
        cols.push(cur.trim());
        cur = "";
      } else cur += ch;
    }
    cols.push(cur.trim());
    return cols;
  }

  // Lewati header
  const dataLines = lines.slice(1);
  for (const line of dataLines) {
    const cols = parseLine(line);
    // kolom: kode_klasifikasi_induk;kode_klasifikasi;...;nama_klasifikasi;...
    const kode = (cols[1] || "").trim();
    const nama = (cols[3] || "").replace(/\s+/g, " ").trim();
    if (!kode || !nama) continue;
    if (seen.has(kode)) continue;
    seen.add(kode);
    out.push({ k: kode, n: nama });
  }
}

fs.mkdirSync(outDir, { recursive: true });
fs.writeFileSync(outPath, JSON.stringify(out), "utf8");
console.log(`OK: ${out.length} klasifikasi → ${path.relative(root, outPath)}`);
