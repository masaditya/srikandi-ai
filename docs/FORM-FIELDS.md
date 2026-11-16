# Pemetaan Field — SRIKANDI Registrasi Naskah Keluar

Dokumentasi field yang diekstrak AI dan cara pencocokannya dengan form
SRIKANDI. **Tervalidasi terhadap DOM asli halaman**
(`https://srikandi.arsip.go.id/pembuatan-naskah-keluar/registrasi-naskah-keluar`)
pada 2026-11-03.

Bila SRIKANDI mengubah label form, yang perlu disesuaikan adalah pola pada
`KEY_PATTERNS` (`extension/content/formfill.js`) — bukan selector.

## Anatomi form (temuan penting)

- **Dropdown mayoritas = `react-select`**, bukan `<select>` native:
  `<input role="combobox" id="react-select-N-input">` + menu
  `div[role="listbox"]` berisi `div[role="option"]` (menu baru ada di DOM
  saat dibuka). Cara mengisi: ketik nilai (memfilter opsi) lalu
  **`mousedown`** pada opsi — react-select merespons `mousedown`, bukan
  `click`.
- **Label = `<label>` sibling** (tanpa atribut `for`) di dalam container
  `div.MuiGrid-root`. Deteksi: sibling sebelum container → label pertama
  di container MuiGrid/form-group.
- **Tidak ada field "Tanggal Naskah"** di form ini → `tanggal_naskah` hanya
  ditampilkan sebagai info di panel (di-skip saat auto-fill).
- **Dua slot file** (react-dropzone): "File naskah" (single, DOCX/PDF, maks
  5 MB) dan "Lampiran" (multiple). File yang dilempar ke panel dilampirkan
  langsung: file pertama → naskah, sisanya → lampiran (via `DataTransfer`).
- Tidak ada iframe; semua field ada di dokumen utama.

## Inventaris field form

| Field form | Tipe | Diisi extension? | Dari key AI |
| --- | --- | --- | --- |
| Mode Registrasi (Standar/E-Form) | tombol | ❌ (default Standar) | — |
| Tipe Naskah | radio `document_mode` | ❌ (default Naskah Keluar) | — |
| Dikirimkan melalui (unit kerja) | react-select | ❌ (spesifik pengguna) | — |
| Jenis Naskah | react-select | ✅ | `jenis_naskah` |
| Sifat Naskah | react-select | ✅ | `prioritas` |
| Klasifikasi | react-select | ✅ | `gradasi` |
| Nomor Naskah | `input[name=nomor]` | ✅ | `nomor_naskah` |
| Nomor Referensi | react-select (searchable) | ✅ | `nomor_referensi` |
| Diberkaskan Oleh Unit Pengolah | react-select | ❌ (spesifik organisasi) | — |
| Hal | `textarea[name=hal]` | ✅ | `pokok_surat` |
| Isi Ringkas | `textarea[name=ringkasan]` | ✅ | `ringkasan` |
| File naskah | dropzone single | ✅ (file pertama) | — |
| Lampiran | dropzone multiple | ✅ (file sisanya) | — (detil dari `lampiran`) |
| Grup Tujuan / Utama (Internal-Eksternal Srikandi) / Utama Eksternal Non Srikandi | react-select | ✅ (pola `utama` → field pertama) | `tujuan[0].instansi` |
| Grup Tembusan / Tembusan … | react-select | ❌ (biar dipilih pengguna) | — |
| Verifikator / Penandatangan | react-select | ❌ (orang, bukan dari dokumen) | — |
| Tipe Tanda Tangan / Visual TTE | radio | ❌ (default TTE/VISIBLE) | — |
| Ukuran QR Code | `<select name="ukuran_qr">` | ❌ (default 1X1) | — |

## Skema output AI

AI diinstruksikan menjawab **hanya** JSON:

```json
{
  "tanggal_naskah": "2026-11-03",
  "nomor_naskah": "005/1013/2026",
  "nomor_referensi": "002/1001/2026",
  "pokok_surat": "Permohonan Penggunaan Ruang Rapat",
  "jenis_naskah": "Surat",
  "gradasi": "Terbuka",
  "prioritas": "Segera",
  "jumlah_lampiran": 1,
  "lampiran": [{ "nama": "Daftar Peserta", "halaman": 2 }],
  "tujuan": [{ "instansi": "Kementerian X", "nama": "Budi", "jabatan": "Kabag" }],
  "ringkasan": "Surat permohonan penggunaan ruang rapat lantai 3 pada …"
}
```

- Nilai tak ditemukan → `null` (tidak ditebak).
- `nomor_referensi`: nomor surat lain yang dirujuk/dijawab
  ("sehubungan dengan surat nomor …") — dipakai di dropdown "Nomor Referensi".
- Dropdown react-select bersifat **dinamis** (opsi dibuat saat menu dibuka,
  tidak ikut `formContext`) → AI menulis nilai singkat paling tepat sesuai
  dokumen (mis. "Surat", "Segera", "Biasa"). Pengisian memilih opsi dengan
  kecocokan: persis (abaikan aksen/huruf besar-kecil) → opsi mengandung nilai.
  **Tidak ada kecocokan → field dibiarkan kosong** (dilaporkan di toast),
  tidak menebak sembarangan.
- `<select>` native (mis. Ukuran QR Code) mengirim daftar opsi ke AI; nilai
  harus persis salah satu opsi.

## Pola pencocokan label (KEY_PATTERNS)

Label dinormalisasi sebelum diuji (lowercase, tanpa aksen).

| Key AI | Pola label |
| --- | --- |
| `nomor_naskah` | `^nomor`, `nomor (naskah\|surat\|dokumen)`, `nomor` |
| `nomor_referensi` | `referensi` |
| `pokok_surat` | `pokok`, `perihal`, `perkara`, `hal` |
| `jenis_naskah` | `jenis` |
| `gradasi` | `gradasi`, `kerahasiaan`, `tingkat rahasia`, `rahasia`, `klasifikasi` |
| `prioritas` | `prioritas`, `prioritet`, `urgensi`, `sifat` |
| `jumlah_lampiran` | `(jumlah\|banyaknya) (lampiran\|file\|attachment)` |
| `lampiran` | field berlabel "nama lampiran" (bila ada) |
| `tujuan` | `instansi`, `tujuan utama`, `utama` |
| `ringkasan` | `ringkasan`, `ringkas`, `abstrak`, `ikhtisar` |
| `tanggal_naskah` | di-skip (`SKIP_KEYS`) — tidak ada field di form ini |

Urutan pengisian (satu field hanya diisi sekali, field pertama di DOM yang
cocok menang):
`tanggal_naskah(skip) → nomor_naskah → nomor_referensi → pokok_surat →
jenis_naskah → gradasi → prioritas → jumlah_lampiran → ringkasan →
lampiran → tujuan`.

## Deteksi label

`labelFor()` mencoba berurutan:

1. `<label for="id">`
2. `aria-label`
3. `<label>` pembungkus
4. `<th scope="row">` / `<th>` di baris tabel
5. **Komponen custom (react-select / MUI)**: `<label>` sibling sebelum
   container, atau label pertama di container `.MuiGrid-root`/`.form-group`
6. atribut `name` / `data-field` / `placeholder` (fallback)

Field **tanpa label** dilewati — biarkan kosong daripada salah isi.

## Penulisan nilai (React-safe)

- **react-select** (`input[role=combobox][id^=react-select-]`):
  1. `focus()` + set nilai via native value setter + event `input`
     (react-select memfilter opsi berdasarkan isi input).
  2. Tunggu `[role=listbox]` visible (polling ≤ 1,5 dtk).
  3. Pilih opsi: persis → opsi mengandung nilai → **`mousedown`** (lalu
     `mouseup`/`click`) pada `div[role=option]`.
  4. Fallback bila menu tidak muncul: `mousedown` pada element
     `[class*="-control"]`, ulangi 2–3.
  5. Gagal: kosongkan input + `Escape` → dilaporkan `failed`.
- `input`/`textarea`: native value setter
  (`Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,"value").set`)
  + event `input` + `change` — agar state React ikut ter-update.
- `select` native: cari opsi (persis → value → mengandung) → set `value` +
  `change`.
- `checkbox`/`radio`: `click()` (hanya bila AI menyuruh "ya"/true).
- `date`: dipaksa format ISO `YYYY-MM-DD`. `number`: angka pertama dari nilai.
- **File**: `DataTransfer` → `input.files = dt.files` + event `change`
  (react-dropzone merespons `change` pada input-nya).

## Jika field SRIKANDI tidak cocok

1. Buka DevTools → Console, cari `[SRIKANDI Naskah AI] field tidak terisi`.
2. Cocokkan label aktual form dengan `KEY_PATTERNS`.
3. Tambahkan pola baru (regex diuji terhadap label dinormalisasi).
4. Reload extension di `chrome://extensions`, muat ulang halaman.

## Keterbatasan diketahui

- Dropdown dinamis: kecocokan opsi bergantung teks dokumen. Nilai AI yang
  terlalu panjang/salah ejaan bisa tidak menemukan opsi → field kosong.
  Perbaiki nilainya di panel lalu klik "Isi Form Otomatis" lagi.
- `tujuan` hanya mengisi field "Utama (Internal / Eksternal Srikandi)"
  (pola `utama`, field pertama di DOM). Tujuan eksternal non-Srikandi &
  tembusan tetap dipilih pengguna.
- Batas form: file naskah DOCX/PDF maks 5 MB; lampiran maks 5 MB/file &
  20 MB total (dipantau server).
