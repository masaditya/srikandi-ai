# SRIKANDI Naskah AI — cara cepat pakai / distribusi

## 1. Install di Chrome (tanpa build)

1. Buka `chrome://extensions`
2. Aktifkan tombol **Developer mode** (kanan atas)
3. Klik **Load unpacked** → pilih folder `D:\Dev\Internal\srikandi-ai\extension`
4. Selesai — ikon extension muncul di toolbar, siap dipakai.

## 2. Membuat `.zip` untuk di-share / upload Web Store (opsional)

Jalankan dari root project:

**PowerShell (Windows):**

```powershell
Compress-Archive -Path extension\* -DestinationPath srikandi-naskah-ai.zip -Force
```

**Bash:**

```bash
zip -r srikandi-naskah-ai.zip extension -x "*/.*" "*/node_modules/*"
```

File `srikandi-naskah-ai.zip` bisa langsung di-upload ke Web Store / dibagikan
— orang lain tinggal "Load unpacked" dari folder hasil ekstrak.

## 3. Update / reload setelah edit kode

Klik ikon **reload** ↻ pada kartu extension di `chrome://extensions`,
atau tekan tombol reload ikon extension di toolbar. Tidak perlu build apa pun.

## 4. Catatan

- Tidak ada bundler, compiler, atau node_modules yang wajib — semua dependensi
  runtime (pdf.js, mammoth) sudah di-vendor di `extension/lib/`.
- `scripts/generate_icons.py` hanya untuk menghasilkan ulang ikon PNG.
- `test/run-tests.mjs` hanya untuk development (unit test).
