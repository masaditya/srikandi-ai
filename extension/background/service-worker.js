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
    // Default: lewat proxy backend di VPS (lihat backend/README.md).
    // Ganti host di bawah dengan domain proxy Anda, lalu "apiKey" diisi
    // TOKEN APLIKASI dari admin proxy — bukan API key AI. Key AI yang
    // sebenarnya hanya ada di server proxy, tidak pernah dibawa browser.
    apiKey: "",
    baseUrl: "https://PROXY-ANDA.example.com/v1",
    model: "deepseek-v4-1-flash",
  },
  pageMatch: "registrasi-naskah-keluar",
};

/** Gabung config tersimpan dengan default: nilai tersimpan kosong → pakai default. */
function mergeCfg(saved, def) {
  const out = {};
  for (const k of Object.keys(def)) {
    out[k] =
      saved && typeof saved[k] === "string" && saved[k] !== ""
        ? saved[k]
        : def[k];
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
  "ringkasan",
  "klasifikasi_kandidat", // internal: kandidat kode cabang untuk tahap 2 klasifikasi
];

// Alias per key kanonik: model kadang menamai key menurut label form
// (mis. "tingkat_kerahasiaan" untuk "Tingkat Kerahasiaan"). Alias
// dipetakan ke key kanonik agar nilai tidak hilang.
const KEY_ALIASES = {
  tanggal_naskah: [
    "tanggal_naskah",
    "tanggal",
    "tanggal_surat",
    "tanggal_dokumen",
  ],
  nomor_naskah: ["nomor_naskah", "nomor", "nomor_surat", "nomor_dokumen"],
  nomor_referensi: [
    "nomor_referensi",
    "referensi",
    "nomor_reff",
    "reff",
    "nomor_jawaban",
  ],
  pokok_surat: [
    "pokok_surat",
    "perihal",
    "pokok",
    "judul",
    "subjek",
    "subject",
    "hal",
  ],
  jenis_naskah: ["jenis_naskah", "jenis", "jenis_surat", "jenis_dokumen"],
  gradasi: [
    "gradasi",
    "tingkat_kerahasiaan",
    "kerahasiaan",
    "tingkat_rahasia",
    "rahasia",
    "klasifikasi",
  ],
  prioritas: [
    "prioritas",
    "tingkat_prioritas",
    "urgensi",
    "prioritet",
    "sifat",
    "sifat_naskah",
    "sifat_surat",
  ],
  // Kunci yang dilarang dikembalikan AI sebagai placeholder template —
  // nilai harus diganti hasil ekstraksi nyata (aturan 13-15 SYSTEM_PROMPT).
  FORBIDDEN_PLACEHOLDER_PATTERN: /^\$\{.+\}$/,
  ringkasan: ["ringkasan", "abstrak", "ikhtisar", "summary"],
};

const SYSTEM_PROMPT = [
  "Kamu adalah asisten kearsipan dinas (SRIKANDI, ANRI) yang ahli membaca naskah dinas keluar Indonesia.",
  "Tugasmu: ekstrak metadata naskah dari teks dokumen yang diberikan, untuk mengisi form Registrasi Naskah Keluar.",
  "",
  "Kamu HANYA boleh memakai key berikut (jangan membuat key lain):",
  "tanggal_naskah, nomor_naskah, nomor_referensi, pokok_surat, jenis_naskah, gradasi, prioritas, ringkasan, klasifikasi_kandidat.",
  "",
  "Aturan:",
  "1. Jawab HANYA dengan satu objek JSON valid — tanpa markdown, tanpa penjabaran di luar JSON.",
  "2. Nilai yang tidak ditemukan di dokumen: null (jangan menebak).",
  "3. tanggal_naskah: format ISO YYYY-MM-DD, tanggal naskah/surat (bukan tanggal terima/arsip). Untuk informasi saja (form registrasi tidak punya field tanggal).",
  "4. nomor_naskah: nomor resmi naskah persis seperti tertulis (termasuk tanda baca).",
  '5. nomor_referensi: nomor naskah/surat lain yang dirujuk atau dijawab dalam dokumen (mis. "sehubungan dengan surat nomor ...", "menindaklanjuti surat nomor ..."); persis seperti tertulis, null bila tidak ada.',
  '6. pokok_surat: ringkas maks 100 kata, gaya judul surat dinas (mis. "Permohonan ...", "Undangan ...", "Laporan ...") — akan mengisi field "Hal".',
  '7. jenis_naskah & prioritas (field "Sifat Naskah"): bila opsi tersedia tercantum di KONTEKS FORM, PERSIS salah satu opsi tersebut; bila dropdown dinamis (opsi tidak tercantum), tulis nilai singkat paling tepat sesuai isi dokumen (mis. "Surat", "Undangan", "Biasa", "Segera"); null bila dokumen tidak menyebutnya.',
  '8. gradasi (field "Klasifikasi"): KODE KLASIFIKASI ARSIP + nama, HANYA dari "DAFTAR KLASIFIKASI ARSIP" di pesan user (mis. "000.5.2.6 Bimbingan Konsultasi Kearsipan") — BUKAN sifat naskah. JANGAN pernah mengisi gradasi dengan "Biasa"/"Segera"/"Rahasia" — itu adalah prioritas. Bila daftar tidak tersedia atau tidak ada yang cocok: null.',
  '9. ringkasan: 2-4 kalimat (maks 500 karakter) merangkum isi/permintaan naskah — akan mengisi field "Isi Ringkas".',
  "10. Abaikan header/footer berulang, watermark, dan tanda tangan digital.",
  "11. DILARANG mengembalikan nilai yang masih berupa placeholder template seperti ${tanggal_naskah}, ${nomor_naskah}, ${ttd}, ${ttd_pengirim}, ${nomor_referensi}. Placeholder apa pun harus diganti dengan nilai NYATA hasil ekstraksi dokumen:",
  "    - tanggal_naskah: tanggal surat yang tertulis di dokumen (format ISO YYYY-MM-DD).",
  "    - nomor_naskah: nomor surat resmi persis seperti tertulis (mis. 000.5.2/681/412.216/2026).",
  '    - pokok_surat (field "Hal"): perihal/nama acara dari dokumen (mis. "Udangan Bimbingan Teknis Digitalisasi Arsip Tahun 2026").',
  '    - gradasi (field "Klasifikasi"): kode klasifikasi arsip + nama dari "DAFTAR KLASIFIKASI ARSIP" (bila tersedia dan ada yang cocok); null bila tidak ada. JANGAN mengisi dengan sifat naskah ("Biasa"/"Segera"/"Rahasia").',
  '    - ringkasan (field "Isi Ringkas"): ringkas 2-4 kalimat isi naskah sendiri dengan bahasa Anda — jangan salin kalimat (jangan pernah memuat ${...}).',
  '    - ttd / ttd_pengirim: nama pejabat penanda tangan + jabatan yang tertulis (mis. "EDI SUSANTO — Sekretaris Daerah Kabupaten Bojonegoro"); null bila tidak ada.',
  "12. Bila sebuah field hanya tersedia sebagai placeholder di dokumen dan nilainya tidak dapat disimpulkan dari isi, kembalikan null — JANGAN pernah mengembalikan string yang masih mengandung ${...}.",
  '13. Sumber kebenaran nilai adalah ISI DOKUMEN yang dikirim di pesan user, bukan template. Contoh dokumen berupa surat undangan resmi (mis. "Udangan Bimbingan Teknis") → pokok_surat = judul acara, karena itu field yang diminta form.',
  '14. klasifikasi_kandidat: HANYA bila pesan user memuat "DAFTAR KLASIFIKASI ARSIP" — pilih MAKSIMAL 5 kode cabang dari daftar itu yang paling relevan dengan isi naskah (array string kode saja, mis. ["000.1", "412.2"]). Bila daftar tidak tersedia: null. Ini hanya kandidat; pemilihan final dilakukan tahap berikutnya.',
].join("\n");

const KLAS_SYSTEM_PROMPT = [
  "Kamu asisten kearsipan (SRIKANDI, ANRI).",
  "Tugasmu: pilih SATU kode klasifikasi arsip paling tepat dari DAFTAR KLASIFIKASI yang diberikan, berdasar perihal, jenis, dan ringkasan naskah.",
  'Balas HANYA satu objek JSON valid: {"klasifikasi": "<kode> <nama>"} (persis kode+nama dari daftar). Bila tidak ada yang cocok, balas {"klasifikasi": null}. Tanpa penjelasan lain.',
].join("\n");

function buildUserMessage(text, formContext, klasBlock) {
  let msg = "";
  if (formContext && formContext.length) {
    msg +=
      "KONTEKS FORM YANG TERSEDIA DI HALAMAN (isi field dengan nilai yang cocok untuk field ini):\n";
    for (const f of formContext) {
      msg += `- [${f.type}] "${f.label}"`;
      if (f.type === "select" && f.options && f.options.length) {
        msg += ` — opsi: ${f.options.join(", ")}`;
      }
      msg += "\n";
    }
    msg += "\n";
  }
  if (klasBlock) {
    msg += `DAFTAR KLASIFIKASI ARSIP (pilih kandidat kode cabang dari sini untuk key klasifikasi_kandidat):\n${klasBlock}\n\n`;
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
  const placeholderRe = /^\$\{.*\}$/;
  for (const canon of FIELD_KEYS) {
    const aliases = KEY_ALIASES[canon] || [canon];
    for (const a of aliases) {
      if (a in obj) {
        let v = obj[a];
        // Anti-placeholder: literal "${...}" dari template → null, jangan diteruskan.
        if (typeof v === "string") {
          const trimmed = v.trim();
          v = placeholderRe.test(trimmed) ? null : v;
        }
        out[canon] = v;
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
    throw new Error(
      "Anthropic: model menolak memproses dokumen (stop_reason: refusal).",
    );
  }
  return { text, model: body.model || cfg.model };
}

async function callOpenAI(cfg, userText) {
  const url = `${cfg.baseUrl.replace(/\/+$/, "")}/chat/completions`;
  const res = await fetch(url, {
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
  let text = body.choices?.[0]?.message?.content || "";
  // Upstream kadang mengembalikan content kosong — coba lagi (maks 3x)
  for (let attempt = 0; attempt < 2 && !text.trim(); attempt++) {
    const retry = await fetch(url, {
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
          { role: "system", content: SYSTEM_PROMPT },
          { role: "user", content: userText },
        ],
      }),
    });
    const rbody = await retry.json().catch(() => ({}));
    if (!retry.ok) break;
    text = rbody.choices?.[0]?.message?.content || "";
  }
  return { text, model: body.model || cfg.model };
}

async function getSettings() {
  const stored = await chrome.storage.local.get(DEFAULTS);
  let provider = stored.provider || DEFAULTS.provider;
  const anthropic = mergeCfg(stored.anthropic, DEFAULTS.anthropic);
  const openai = mergeCfg(stored.openai, DEFAULTS.openai);
  // Self-heal: provider tersimpan "anthropic" tanpa token, tapi token
  // aplikasi untuk OpenAI-compatible sudah diisi → pakai path itulah
  // (pengguna yang sengaja pakai Anthropic pasti sudah mengisi token-nya).
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
      `Token aplikasi belum diisi. Buka "SRIKANDI Naskah AI → Options" (klik kanan ikon extension), isi Base URL proxy dan Token aplikasi.${settings.provider === "anthropic" ? " " : ""}`,
    );
  }
  const userText = buildUserMessage(
    msg.text || "",
    msg.formContext || [],
    await getKlasTopBlock(),
  );
  const { text, model } =
    settings.provider === "anthropic"
      ? await callAnthropic(cfg, userText)
      : await callOpenAI(cfg, userText);

  const fields = normalizeFields(extractJson(text));
  if (!fields) {
    throw new Error(
      "Respons AI bukan JSON yang valid. Coba lagi, atau gunakan provider lain.",
    );
  }

  // Tahap 2: persempit klasifikasi ke kode persis dari daftar (bila daftar
  // termuat dan AI belum menemukan gradasi sendiri).
  try {
    const klas = await refineKlasifikasi(cfg, settings.provider, msg, fields);
    if (klas) fields.gradasi = klas;
  } catch (e) {
    console.warn(
      "[SRIKANDI Naskah AI] refine klasifikasi gagal:",
      e?.message || e,
    );
  }

  return { ok: true, fields, raw: text, model, provider: settings.provider };
}

/* ---------------------- klasifikasi arsip (CSV) ---------------------- */

let KLAS_LIST = null;
let KLAS_LEAVES = null;

async function loadKlasifikasi() {
  if (KLAS_LIST) return KLAS_LIST;
  try {
    const res = await fetch(chrome.runtime.getURL("data/klasifikasi.json"));
    if (res.ok) KLAS_LIST = await res.json();
  } catch (e) {
    console.warn("[SRIKANDI Naskah AI] daftar klasifikasi tidak termuat:", e);
  }
  return KLAS_LIST;
}

/** Blok cabang level atas (≤1 titik) untuk tahap 1 — ringkas. */
async function getKlasTopBlock() {
  const list = await loadKlasifikasi();
  if (!list || !list.length) return null;
  return list
    .filter((e) => (e.k.match(/\./g) || []).length <= 1)
    .map((e) => `${e.k} ${e.n}`)
    .join("\n");
}

/** Entri tanpa anak (kode persis yang bisa dipilih di form). */
function klasLeaves(list) {
  if (KLAS_LEAVES) return KLAS_LEAVES;
  KLAS_LEAVES = list.filter(
    (e) => !list.some((o) => o.k !== e.k && o.k.startsWith(e.k + ".")),
  );
  return KLAS_LEAVES;
}

function pickKandidat(fields) {
  const k = fields?.klasifikasi_kandidat;
  if (Array.isArray(k))
    return k.filter((x) => typeof x === "string").slice(0, 5);
  if (typeof k === "string" && k.trim()) return [k.trim()];
  return [];
}

/**
 * Tahap 2: kirim daftar kode persis di bawah cabang kandidat, minta AI
 * memilih satu. Return string "<kode> <nama>" atau null.
 */
async function refineKlasifikasi(cfg, provider, msg, fields) {
  const list = await loadKlasifikasi();
  if (!list || !list.length) return null;
  // Lanjut bila gradasi kosong ATAU bukan kode persis (leaf) dari daftar:
  // bisa berupa teks sifat ("Biasa") atau kode cabang ("000.5 Kearsipan").
  const gradasiStr =
    typeof fields.gradasi === "string" ? fields.gradasi.trim() : "";
  if (gradasiStr) {
    const code = gradasiStr.split(/\s+/)[0];
    const leaf = klasLeaves(list).find((e) => e.k === code);
    if (leaf) return null; // sudah kode persis yang valid
  }
  const kandidat = pickKandidat(fields).filter((kd) =>
    list.some((e) => e.k === kd),
  );
  if (!kandidat.length) return null;
  const leaves = klasLeaves(list).filter((e) =>
    kandidat.some((kd) => e.k === kd || e.k.startsWith(kd + ".")),
  );
  if (!leaves.length) return null;
  const daftar = leaves
    .slice(0, 200)
    .map((e) => `${e.k} ${e.n}`)
    .join("\n");
  const konteks = [
    `Perihal naskah: ${fields.pokok_surat || "-"}`,
    `Jenis naskah: ${fields.jenis_naskah || "-"}`,
    `Ringkasan: ${fields.ringkasan || "-"}`,
    `Cuplikan dokumen: ${(msg.text || "").slice(0, 2000)}`,
    "",
    `DAFTAR KLASIFIKASI:\n${daftar}`,
    "\nBalas dengan JSON:",
  ].join("\n");
  const callRaw = provider === "anthropic" ? callAnthropicRaw : callOpenAIRaw;
  let text = "";
  for (let attempt = 0; attempt < 3 && !text.trim(); attempt++) {
    ({ text } = await callRaw(cfg, KLAS_SYSTEM_PROMPT, konteks));
  }
  const parsed = extractJson(text);
  const val = parsed?.klasifikasi;
  if (typeof val === "string" && val.trim()) {
    const code = val.trim().split(/\s+/)[0];
    const exact = leaves.find((e) => e.k === code);
    return exact ? `${exact.k} ${exact.n}` : null;
  }
  return null;
}

// Varian call dengan system prompt berbeda (dipakai tahap 2 klasifikasi)
async function callAnthropicRaw(cfg, system, userText) {
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
      max_tokens: 1024,
      system,
      messages: [{ role: "user", content: userText }],
    }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok)
    throw new Error(
      `Anthropic: ${body?.error?.message || `HTTP ${res.status}`}`,
    );
  const t = (body.content || [])
    .filter((b) => b.type === "text")
    .map((b) => b.text)
    .join("\n");
  return { text: t };
}

async function callOpenAIRaw(cfg, system, userText) {
  const url = `${cfg.baseUrl.replace(/\/+$/, "")}/chat/completions`;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${cfg.apiKey}`,
    },
    body: JSON.stringify({
      model: cfg.model,
      temperature: 0.2,
      max_tokens: 1024,
      messages: [
        { role: "system", content: system },
        { role: "user", content: userText },
      ],
    }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok)
    throw new Error(
      `OpenAI-compatible: ${body?.error?.message || `HTTP ${res.status}`}`,
    );
  return { text: body.choices?.[0]?.message?.content || "" };
}

async function handleTest() {
  const settings = await getSettings();
  const cfg = settings[settings.provider];
  if (!cfg || !cfg.apiKey) throw new Error("Token aplikasi belum diisi (Options).");
  const headers =
    settings.provider === "anthropic"
      ? {
          "content-type": "application/json",
          "x-api-key": cfg.apiKey,
          "anthropic-version": "2026-10-21",
        }
      : {
          "content-type": "application/json",
          authorization: `Bearer ${cfg.apiKey}`,
        };
  const url =
    settings.provider === "anthropic"
      ? `${cfg.baseUrl.replace(/\/+$/, "")}/v1/messages`
      : `${cfg.baseUrl.replace(/\/+$/, "")}/chat/completions`;
  const body =
    settings.provider === "anthropic"
      ? {
          model: cfg.model,
          max_tokens: 32,
          messages: [{ role: "user", content: "Balas dengan kata: SIAP" }],
        }
      : {
          model: cfg.model,
          max_tokens: 32,
          messages: [{ role: "user", content: "Balas dengan kata: SIAP" }],
        };
  const res = await fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok)
    throw new Error(
      `${settings.provider === "anthropic" ? "Anthropic" : "Endpoint"}: ${data?.error?.message || "HTTP " + res.status}`,
    );
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
