/**
 * SRIKANDI Naskah AI — background service worker
 *
 * Satu-satunya tempat yang menyentuh API AI. Content script mengirim teks
 * hasil ekstraksi dokumen, worker memanggil provider (Anthropic atau
 * OpenAI-compatible), lalu mengembalikan field terstruktur.
 */

const DEFAULTS = {
  provider: "openai",
  anthropic: {
    apiKey: "",
    baseUrl: "https://api.anthropic.com",
    model: "claude-opus-5-5",
  },
  openai: {
    // Preset Kenari (endpoint OpenAI-compatible) — bisa diganti di Options.
    apiKey: "kn-9f709535c9db26a167f922c852000bb3f70a6f37843b5389",
    baseUrl: "https://kenari.id/v1",
    model: "deepseek-v4-1-flash",
  },
  pageMatch: "registrasi-naskah-keluar",
};

/** Gabung config tersimpan dengan default: nilai tersimpan kosong → pakai default. */
function mergeCfg(saved, def) {
  const out = {};
  for (const k of Object.keys(def)) {
    out[k] = saved && typeof saved[k] === "string" && saved[k] !== "" ? saved[k] : def[k];
  }
  return out;
}

const FIELD_KEYS = [
  "tanggal_naskah",
  "nomor_naskah",
  "nomor_referensi",
  "pokok_surat",
  "jenis_naskah",
  "gradasi",
  "prioritas",
  "jumlah_lampiran",
  "lampiran",
  "tujuan",
  "ringkasan",
];

// Alias per key kanonik: model kadang menamai key menurut label form
// (mis. "tingkat_kerahasiaan" untuk "Tingkat Kerahasiaan"). Alias
// dipetakan ke key kanonik agar nilai tidak hilang.
const KEY_ALIASES = {
  tanggal_naskah: ["tanggal_naskah", "tanggal", "tanggal_surat", "tanggal_dokumen"],
  nomor_naskah: ["nomor_naskah", "nomor", "nomor_surat", "nomor_dokumen"],
  nomor_referensi: ["nomor_referensi", "referensi", "nomor_reff", "reff", "nomor_jawaban"],
  pokok_surat: ["pokok_surat", "perihal", "pokok", "judul", "subjek", "subject", "hal"],
  jenis_naskah: ["jenis_naskah", "jenis", "jenis_surat", "jenis_dokumen"],
  gradasi: ["gradasi", "tingkat_kerahasiaan", "kerahasiaan", "tingkat_rahasia", "rahasia", "klasifikasi"],
  prioritas: ["prioritas", "tingkat_prioritas", "urgensi", "prioritet", "sifat", "sifat_naskah", "sifat_surat"],
  jumlah_lampiran: ["jumlah_lampiran", "jumlah_lampiran_naskah", "jumlah_lamp"],
  lampiran: ["lampiran", "attachment", "lampiran_list"],
  tujuan: ["tujuan", "instansi_tujuan", "penerima", "tujuan_surat"],
  ringkasan: ["ringkasan", "abstrak", "ikhtisar", "summary"],
};

const SYSTEM_PROMPT = [
  "Kamu adalah asisten kearsipan dinas (SRIKANDI, ANRI) yang ahli membaca naskah dinas keluar Indonesia.",
  "Tugasmu: ekstrak metadata naskah dari teks dokumen yang diberikan, untuk mengisi form Registrasi Naskah Keluar.",
  "",
  "Kamu HANYA boleh memakai key berikut (jangan membuat key lain):",
  "tanggal_naskah, nomor_naskah, nomor_referensi, pokok_surat, jenis_naskah, gradasi, prioritas, jumlah_lampiran, lampiran, tujuan, ringkasan.",
  "",
  "Aturan:",
  "1. Jawab HANYA dengan satu objek JSON valid — tanpa markdown, tanpa penjabaran di luar JSON.",
  "2. Nilai yang tidak ditemukan di dokumen: null (jangan menebak).",
  "3. tanggal_naskah: format ISO YYYY-MM-DD, tanggal naskah/surat (bukan tanggal terima/arsip). Untuk informasi saja (form registrasi tidak punya field tanggal).",
  "4. nomor_naskah: nomor resmi naskah persis seperti tertulis (termasuk tanda baca).",
  "5. nomor_referensi: nomor naskah/surat lain yang dirujuk atau dijawab dalam dokumen (mis. \"sehubungan dengan surat nomor ...\", \"menindaklanjuti surat nomor ...\"); persis seperti tertulis, null bila tidak ada.",
  "6. pokok_surat: ringkas maks 100 kata, gaya judul surat dinas (mis. \"Permohonan ...\", \"Undangan ...\", \"Laporan ...\") — akan mengisi field \"Hal\".",
  "7. jenis_naskah, gradasi (field \"Klasifikasi\"), prioritas (field \"Sifat Naskah\"): bila opsi tersedia tercantum di KONTEKS FORM, PERSIS salah satu opsi tersebut; bila dropdown dinamis (opsi tidak tercantum), tulis nilai singkat paling tepat sesuai isi dokumen (mis. \"Surat\", \"Segera\", \"Biasa\", \"Rahasia\"); null bila dokumen tidak menyebutnya.",
  "8. jumlah_lampiran: jumlah lampiran (angka) bila tertulis, selain itu null.",
  "9. lampiran: array objek {\"nama\":\"...\",\"halaman\":<angka|null>} hanya bila dokumen menyebutkan isi lampiran.",
  "10. tujuan: array objek {\"instansi\":\"...\",\"nama\":\"...\",\"jabatan\":\"...\"} untuk instansi/orang tujuan surat; field yang tidak ada: string kosong.",
  "11. ringkasan: 2-4 kalimat (maks 500 karakter) merangkum isi/permintaan naskah — akan mengisi field \"Isi Ringkas\".",
  "12. Abaikan header/footer berulang, watermark, dan tanda tangan digital.",
].join("\n");

function buildUserMessage(text, formContext) {
  let msg = "";
  if (formContext && formContext.length) {
    msg += "KONTEKS FORM YANG TERSEDIA DI HALAMAN (isi field dengan nilai yang cocok untuk field ini):\n";
    for (const f of formContext) {
      msg += `- [${f.type}] "${f.label}"`;
      if (f.type === "select" && f.options && f.options.length) {
        msg += ` — opsi: ${f.options.join(", ")}`;
      }
      msg += "\n";
    }
    msg += "\n";
  }
  msg += `TEKS DOKUMEN (diperiksa dari file, bisa dipotong bila panjang):\n"""\n${text}\n"""\n\nBalas dengan JSON:`;
  return msg;
}

/** Ambil teks JSON pertama dari respons model (toleran terhadap code fence / teks ekstra). */
function extractJson(raw) {
  if (typeof raw !== "string") return null;
  let s = raw.trim();
  // Buang code fence bila ada
  const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) s = fence[1].trim();
  const start = s.indexOf("{");
  const end = s.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) return null;
  try {
    return JSON.parse(s.slice(start, end + 1));
  } catch {
    return null;
  }
}

function normalizeFields(obj) {
  if (!obj || typeof obj !== "object") return null;
  const out = {};
  for (const canon of FIELD_KEYS) {
    const aliases = KEY_ALIASES[canon] || [canon];
    for (const a of aliases) {
      if (a in obj) {
        out[canon] = obj[a];
        break;
      }
    }
  }
  return out;
}

async function callAnthropic(cfg, userText) {
  const url = `${cfg.baseUrl.replace(/\/+$/, "")}/v1/messages`;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": cfg.apiKey,
      "anthropic-version": "2026-10-21",
    },
    body: JSON.stringify({
      model: cfg.model,
      max_tokens: 8192,
      system: SYSTEM_PROMPT,
      messages: [{ role: "user", content: userText }],
    }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg = body?.error?.message || `HTTP ${res.status}`;
    throw new Error(`Anthropic: ${msg}`);
  }
  const text = (body.content || [])
    .filter((b) => b.type === "text")
    .map((b) => b.text)
    .join("\n");
  if (body.stop_reason === "refusal") {
    throw new Error("Anthropic: model menolak memproses dokumen (stop_reason: refusal).");
  }
  return { text, model: body.model || cfg.model };
}

async function callOpenAI(cfg, userText) {
  const url = `${cfg.baseUrl.replace(/\/+$/, "")}/chat/completions`;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "authorization": `Bearer ${cfg.apiKey}`,
    },
    body: JSON.stringify({
      model: cfg.model,
      temperature: 0.2,
      max_tokens: 4096,
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: userText },
      ],
    }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg = body?.error?.message || `HTTP ${res.status}`;
    throw new Error(`OpenAI-compatible: ${msg}`);
  }
  const text = body.choices?.[0]?.message?.content || "";
  return { text, model: body.model || cfg.model };
}

async function getSettings() {
  const stored = await chrome.storage.local.get(DEFAULTS);
  let provider = stored.provider || DEFAULTS.provider;
  const anthropic = mergeCfg(stored.anthropic, DEFAULTS.anthropic);
  const openai = mergeCfg(stored.openai, DEFAULTS.openai);
  // Self-heal: provider tersimpan "anthropic" tanpa key, tapi preset Kenari
  // punya key → pakai Kenari (pengguna yang sengaja pakai Anthropic pasti
  // sudah mengisi key-nya).
  if (provider === "anthropic" && !anthropic.apiKey && openai.apiKey) {
    provider = "openai";
  }
  return {
    provider,
    anthropic,
    openai,
    pageMatch:
      typeof stored.pageMatch === "string" && stored.pageMatch !== ""
        ? stored.pageMatch
        : DEFAULTS.pageMatch,
  };
}

async function handleAnalyze(msg) {
  const settings = await getSettings();
  const cfg = settings[settings.provider];
  if (!cfg || !cfg.apiKey) {
    throw new Error(
      `API key belum diisi. Buka "SRIKANDI Naskah AI → Options" (klik kanan ikon extension) dan isi API key ${settings.provider === "anthropic" ? "Anthropic" : "OpenAI-compatible"}.`
    );
  }
  const userText = buildUserMessage(msg.text || "", msg.formContext || []);
  const { text, model } =
    settings.provider === "anthropic"
      ? await callAnthropic(cfg, userText)
      : await callOpenAI(cfg, userText);

  const fields = normalizeFields(extractJson(text));
  if (!fields) {
    throw new Error("Respons AI bukan JSON yang valid. Coba lagi, atau gunakan provider lain.");
  }
  return { ok: true, fields, raw: text, model, provider: settings.provider };
}

async function handleTest() {
  const settings = await getSettings();
  const cfg = settings[settings.provider];
  if (!cfg || !cfg.apiKey) throw new Error("API key belum diisi.");
  const headers =
    settings.provider === "anthropic"
      ? { "content-type": "application/json", "x-api-key": cfg.apiKey, "anthropic-version": "2026-10-21" }
      : { "content-type": "application/json", authorization: `Bearer ${cfg.apiKey}` };
  const url =
    settings.provider === "anthropic"
      ? `${cfg.baseUrl.replace(/\/+$/, "")}/v1/messages`
      : `${cfg.baseUrl.replace(/\/+$/, "")}/chat/completions`;
  const body =
    settings.provider === "anthropic"
      ? { model: cfg.model, max_tokens: 32, messages: [{ role: "user", content: "Balas dengan kata: SIAP" }] }
      : { model: cfg.model, max_tokens: 32, messages: [{ role: "user", content: "Balas dengan kata: SIAP" }] };
  const res = await fetch(url, { method: "POST", headers, body: JSON.stringify(body) });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`${settings.provider === "anthropic" ? "Anthropic" : "Endpoint"}: ${data?.error?.message || "HTTP " + res.status}`);
  return { ok: true, model: data.model || cfg.model };
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  (async () => {
    try {
      if (msg?.type === "srikandi:analyze") {
        sendResponse(await handleAnalyze(msg));
      } else if (msg?.type === "srikandi:test") {
        sendResponse(await handleTest());
      } else {
        sendResponse({ ok: false, error: "Message tidak dikenal" });
      }
    } catch (err) {
      console.error(`[SRIKANDI Naskah AI] ${msg?.type} gagal:`, err);
      sendResponse({ ok: false, error: err?.message || String(err) });
    }
  })();
  return true; // respons async
});

// Klik ikon extension: toggle panel di tab SRIKANDI, atau buka options.
chrome.action.onClicked.addListener(async (tab) => {
  if (tab.url && tab.url.includes("srikandi.arsip.go.id")) {
    chrome.tabs.sendMessage(tab.id, { type: "srikandi:toggle" }).catch(() => {
      // content script belum siap — injeksi ulang pesan setelah dokumen siap
      chrome.tabs.reload(tab.id);
    });
  } else {
    chrome.runtime.openOptionsPage();
  }
});

// Export untuk unit test (diabaikan browser/service worker).
if (typeof module !== "undefined" && module.exports) {
  module.exports = { extractJson, normalizeFields, SYSTEM_PROMPT };
}
