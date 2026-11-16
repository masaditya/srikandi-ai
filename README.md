# 📄 SRIKANDI Naskah AI — Chrome Extension

Chrome extension (Manifest V3) yang membantu **Registrasi Naskah Keluar** di
[SRIKANDI](https://srikandi.arsip.go.id) (Sistem Informasi Pengelolaan Kearsipan
Dinamis Terintegrasi — ANRI).

Alurnya sederhana:

1. Buka halaman
   `https://srikandi.arsip.go.id/pembuatan-naskah-keluar/registrasi-naskah-keluar`
2. Panel **Naskah AI** muncul otomatis (pojok kanan atas, dekat tombol
   extension). Tombol 📄 bisa dipakai untuk membuka/menutup panel.
3. **Drag & drop** file naskah (PDF / DOCX / TXT) — boleh beberapa file.
   File pertama = naskah, sisanya = lampiran.
4. Teks diekstrak (pdf.js untuk PDF, mammoth untuk DOCX) lalu dikirim ke AI
   (Claude / endpoint OpenAI-compatible) untuk diekstrak metadatanya.
5. Hasil analisis ditampilkan di panel — **silakan perbaiki dulu** bila perlu.
6. Form SRIKANDI **langsung terisi otomatis** setelah analisis (kompatibel
   React: nilai diset lewat native setter + event `input`/`change`, dropdown
   react-select dibuka & opsinya diklik). Tombol **Isi Form Otomatis** dipakai
   untuk mengulang pengisian setelah Anda mengedit nilai di panel.

## Fitur

- **Drag & drop multi-file** + file picker (`.pdf`, `.docx`, `.txt`, `.md`).
- **Ekstraksi teks di browser** — dokumen tidak diunggah ke server mana pun
  selain endpoint AI yang Anda pilih.
- **Provider AI configurable**: default **Kenari**
  (`https://kenari.id/v1`, model `deepseek-v4-1-flash`), bisa diganti
  Anthropic (Claude) atau endpoint OpenAI-compatible lain (Ollama, Groq, …).
- **Pencocokan field berbasis label**, bukan selector kaku — tahan terhadap
  perubahan DOM SRIKANDI. Untuk field `<select>`, AI memilih opsi yang
  persis tersedia di form (opsi form dikirim sebagai konteks prompt).
- **Reviewer sebelum diisi**: semua hasil bisa diedit/dikosongkan di panel.
- **Laporan pengisian**: toast + log konsol berapa field terisi / tidak cocok.
- Panel terisolasi dalam **Shadow DOM** — tidak terpengaruh CSS SRIKANDI.

## Struktur project

```
srikandi-naskah-ai/
├── extension/                  ← folder yang di-load ke Chrome
│   ├── manifest.json           MV3
│   ├── background/service-worker.js   ← pemanggil API AI + orkestrasi
│   ├── content/content.js      ← panel UI, drag-drop, pipeline
│   ├── content/formfill.js     ← mesin auto-fill (label-matching)
│   ├── content/content.css     ← style panel (di-shadow-DOM)
│   ├── options.html / options.js      ← pengaturan (API key, model, dsb.)
│   ├── lib/                    ← pdf.js 3.11.174 + mammoth 1.13.0 (vendored)
│   └── icons/                  ← ikon (hasilkan ulang: scripts/generate_icons.py)
├── test/run-tests.mjs          ← unit test (node test/run-tests.mjs)
├── scripts/generate_icons.py   ← generator ikon PNG (tanpa dependensi)
└── docs/FORM-FIELDS.md         ← dokumentasi field yang diekstrak
```

## Instalasi (Developer mode)

Lihat [`extension/INSTALL.md`](extension/INSTALL.md) untuk langkah lengkap
(load unpacked, distribusi .zip, reload). Intinya:

1. `chrome://extensions` → **Developer mode**
2. **Load unpacked** → folder `extension/`
3. Ikon extension muncul di toolbar — klik untuk toggle panel di SRIKANDI
4. Edit kode → klik ikon ↻ untuk reload, tidak perlu build

> `chrome.storage.local` menyimpan key hanya di browser Anda. Untuk
> endpoint OpenAI-compatible selain OpenAI/Groq (mis. Ollama `localhost`),
> endpoint harus mengirim header CORS; tambahkan host-nya ke
> `host_permissions` di `manifest.json` bila perlu.

## Alur data

```
File (PDF/DOCX/TXT)
   │  drag & drop
   ▼
content.js ── ekstrak teks (pdf.js / mammoth, cap 20k karakter/file)
   │  chrome.runtime.sendMessage({type:"srikandi:analyze"})
   ▼
service-worker.js ── baca chrome.storage.local (provider, key, model)
   │  POST /v1/messages  (Anthropic, anthropic-version 2026-10-21)
   │  atau  POST /chat/completions (OpenAI-compatible)
   ▼
JSON metadata ──→ panel (bisa diedit) ──→ auto-fill form (tombol untuk ulangi)
   │
   ▼
formfill.js: label-matching → native setter + event input/change
```

## Field yang diekstrak AI

| Key               | Deskripsi                                                                                   |
| ----------------- | ------------------------------------------------------------------------------------------- |
| `tanggal_naskah`  | tanggal surat (ISO `YYYY-MM-DD`) — info saja, form tidak punya field tanggal                |
| `nomor_naskah`    | nomor resmi naskah                                                                          |
| `nomor_referensi` | nomor surat yang dirujuk/dijawab (dropdown "Nomor Referensi")                               |
| `pokok_surat`     | perihal / judul (≤ 100 kata) — field "Hal"                                                  |
| `jenis_naskah`    | nilai dropdown "Jenis Naskah"                                                               |
| `gradasi`         | nilai dropdown "Klasifikasi"                                                                |
| `prioritas`       | nilai dropdown "Sifat Naskah" (biasa/segera/darurat)                                        |
| `jumlah_lampiran` | jumlah lampiran (info)                                                                      |
| `lampiran`        | daftar `{nama, halaman}` (bila disebut)                                                     |
| `tujuan`          | daftar `{instansi, nama, jabatan}` — mengisi dropdown "Utama (Internal/Eksternal Srikandi)" |
| `ringkasan`       | 2–4 kalimat isi naskah — field "Isi Ringkas"                                                |

Field yang tak ditemukan → `null` (tidak ditebak). Dropdown form mayoritas
**react-select** (dihandle khusus: ketik untuk memfilter → `mousedown` pada
opsi). File yang dilempar ke panel langsung dilampirkan: file pertama → slot
"File naskah", sisanya → slot "Lampiran". Detail pemetaan & pola pencocokan
label ada di [`docs/FORM-FIELDS.md`](docs/FORM-FIELDS.md).

## Pengembangan

```bash
node test/run-tests.mjs         # unit test (formfill + parsing JSON AI)
node test/e2e-kenari.mjs        # E2E: prompt asli → endpoint Kenari → parse
python3 scripts/generate_icons.py  # regenerate ikon bila perlu
```

## Catatan & keterbatasan

- **PDF hasil scan** (tanpa layer teks) belum didukung — perlu OCR dulu.
- Format `.doc` (Word lama) tidak didukung — konversi ke `.docx`.
- Teks dipotong di 20.000 karakter per file / 30.000 total agar hemat token.
- Auto-fill mengisi field **yang berlabel & terlihat**; field tanpa label
  dilewati demi keamanan (tidak mengisi field yang salah).
- Selalu periksa field di SRIKANDI sebelum menekan tombol simpan/lanjut
  bawaan SRIKANDI.
