/**
 * SRIKANDI Naskah AI — formfill.js
 * Mesin auto-fill yang bekerja di content script (isolated world).
 *
 * Bentuk form SRIKANDI (terverifikasi 2026-11-03):
 * - Dropdown mayoritas = react-select (input role="combobox" id="react-select-N-input"),
 *   BUKAN <select> native. Cara mengisi: ketik nilai (memfilter opsi) lalu
 *   "mousedown" pada opsi [role="option"] (react-select merespons mousedown).
 * - Label = elemen <label> sibling (tanpa for) di dalam container MuiGrid.
 * - Field teks native: input[name=nomor], textarea[name=hal], textarea[name=ringkasan].
 * - Ada 2 slot file (react-dropzone): file naskah (single) & lampiran (multiple).
 *
 * window.SNAI.formfill = { collectFields, applyFields, setFieldValue,
 *                           setFiles, collectFileInputs }
 */
(() => {
  "use strict";

  const norm = (s) =>
    (s || "")
      .toLowerCase()
      .normalize("NFD")
      .replace(/[̀-ͯ]/g, "")
      .replace(/\s+/g, " ")
      .trim();

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  /** Key yang TIDAK dicoba diisi di form ini (hanya ditampilkan sebagai info). */
  const SKIP_KEYS = ["tanggal_naskah"]; // form registrasi tidak punya field tanggal

  /** Apakah elemen terlihat & bisa diisi? */
  function isFillable(el) {
    if (!el || el.disabled || el.readOnly) return false;
    const t = el.type;
    if (t === "hidden" || t === "file" || t === "submit" || t === "button" || t === "reset" || t === "image") return false;
    const style = window.getComputedStyle(el);
    if (style.display === "none" || style.visibility === "hidden") return false;
    const rect = el.getBoundingClientRect();
    return !(rect.width === 0 && rect.height === 0);
  }

  /** Deteksi input react-select (combobox custom). */
  function isReactSelect(el) {
    if (!el || !el.id) return false;
    if (el.id.startsWith("react-select-")) return true;
    return el.getAttribute && el.getAttribute("role") === "combobox";
  }

  /** Ambil label manusia untuk sebuah elemen form. */
  function labelFor(el) {
    if (el.id) {
      const byId = document.querySelector(`label[for="${CSS.escape(el.id)}"]`);
      if (byId && byId.textContent.trim()) return byId.textContent.trim();
    }
    const aria = el.getAttribute("aria-label");
    if (aria && aria.trim()) return aria.trim();
    const wrapLabel = el.closest("label");
    if (wrapLabel && wrapLabel.textContent.trim()) return wrapLabel.textContent.trim();

    // th scope="row" / cell di depan pada tabel form
    const row = el.closest("tr");
    if (row) {
      const th = row.querySelector("th[scope='row'], th, .label, [class*='label']");
      if (th && th.textContent.trim()) return th.textContent.trim().slice(0, 120);
    }

    // Komponen custom (react-select / MUI): label umumnya <label> sibling
    // sebelum container field, atau label pertama di container MuiGrid/form-group.
    let node = el;
    for (let depth = 0; depth < 8 && node; depth++) {
      node = node.parentElement;
      if (!node) break;
      const prev = node.previousElementSibling;
      if (prev && prev.tagName === "LABEL" && prev.textContent.trim()) {
        return prev.textContent.trim().slice(0, 120);
      }
      const container = node.closest(".MuiGrid-root, .form-group, fieldset");
      if (container) {
        const lab = container.querySelector("label");
        if (lab && lab.textContent.trim()) return lab.textContent.trim().slice(0, 120);
      }
    }

    const name = el.getAttribute("name") || el.getAttribute("data-field");
    const placeholder = el.getAttribute("placeholder");
    return [name, placeholder].filter(Boolean).join(" | ").slice(0, 120);
  }

  /** Kumpulkan semua field form yang terlihat di halaman. */
  function collectFields() {
    const fields = [];
    const sel = [
      "input[type='text']",
      "input[type='search']",
      "input[type='url']",
      "input[type='tel']",
      "input[type='number']",
      "input[type='email']",
      "input[type='date']",
      "input[type='month']",
      "input[type='week']",
      "input[type='time']",
      "input:not([type])",
      "textarea",
      "select",
    ].join(",");

    for (const el of document.querySelectorAll(sel)) {
      if (!isFillable(el)) continue;
      const label = labelFor(el);
      if (!label) continue; // tanpa label → tidak bisa dicocokkan dengan aman
      const rs = isReactSelect(el);
      const entry = {
        el,
        label,
        reactSelect: rs,
        type: el.tagName === "SELECT" ? "select" : el.tagName === "TEXTAREA" ? "textarea" : rs ? "select" : el.type || "text",
      };
      if (entry.type === "select" && !rs) {
        entry.options = Array.from(el.options)
          .filter((o) => o.value !== "" && o.textContent.trim() !== "")
          .map((o) => o.textContent.trim())
          .slice(0, 40);
      } else if (rs) {
        entry.options = []; // opsi react-select dinamis (dibuat saat menu dibuka)
      }
      fields.push(entry);
    }

    // checkbox / radio (dipisah karena logika isi-nya berbeda)
    for (const el of document.querySelectorAll("input[type='checkbox'], input[type='radio']")) {
      if (!isFillable(el)) continue;
      const label = labelFor(el);
      if (!label) continue;
      fields.push({ el, label, type: el.type, checked: el.checked, reactSelect: false });
    }

    return fields;
  }

  /** Set nilai input/textarea kompatibel dengan React (native setter + event). */
  function setNativeValue(el, value) {
    const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    const desc = Object.getOwnPropertyDescriptor(proto, "value");
    if (desc && typeof desc.set === "function") {
      desc.set.call(el, value);
    } else {
      el.value = value;
    }
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
  }

  /* ----------------------- react-select filling ----------------------- */

  /** Tunggu sampai ada listbox [role=listbox] yang visible (menu react-select). */
  async function waitForListbox(timeout = 1500) {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      const boxes = Array.from(document.querySelectorAll('[role="listbox"]'));
      const visible = boxes.filter((b) => {
        const st = window.getComputedStyle(b);
        return st.display !== "none" && st.visibility !== "hidden";
      });
      if (visible.length) return visible[visible.length - 1]; // menu yang terbaru
      await sleep(80);
    }
    return null;
  }

  /** Pilih opsi di listbox: persis (abaikan aksen) → opsi mengandung nilai → null (tidak nebak). */
  function pickOption(listbox, target) {
    const opts = Array.from(listbox.querySelectorAll('[role="option"]'));
    let opt = opts.find((o) => norm(o.textContent) === target);
    if (!opt) opt = opts.find((o) => norm(o.textContent).includes(target));
    return opt || null;
  }

  /** Klik opsi react-select (responsif terhadap mousedown). */
  function clickOption(opt) {
    for (const type of ["mousedown", "mouseup", "click"]) {
      opt.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, view: window }));
    }
    return true;
  }

  /**
   * Isi dropdown react-select dengan mengetik nilai (filter) lalu memilih opsi.
   * @returns {Promise<boolean>} true bila opsi terpilih.
   */
  async function fillReactSelect(input, value) {
    const target = norm(value);
    if (!target) return false;

    // 1) Ketik nilai → memfilter opsi pada select yang bisa dicari
    setNativeValue(input, "");
    input.focus();
    setNativeValue(input, value);

    let listbox = await waitForListbox(1200);
    if (listbox) {
      const opt = pickOption(listbox, target);
      if (opt) return clickOption(opt);
      setNativeValue(input, "");
    }

    // 2) Rescue: sebagian versi react-select hanya membuka menu via keydown.
    //    Nilai tetap diketik (filter state masih aktif) + ArrowDown.
    setNativeValue(input, value);
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", code: "ArrowDown", keyCode: 40, which: 40, bubbles: true }));
    listbox = await waitForListbox(1500);
    if (listbox) {
      const opt = pickOption(listbox, target);
      if (opt) return clickOption(opt);
    }

    // 3) Rescue terakhir: kosongkan nilai, buka menu dengan mousedown di control
    setNativeValue(input, "");
    const control =
      input.closest('[class*="-control"]') ||
      input.parentElement;
    if (control) {
      control.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true, view: window }));
      listbox = await waitForListbox(1500);
      if (listbox) {
        const opt = pickOption(listbox, target);
        if (opt) return clickOption(opt);
      }
    }

    // 4) Gagal: bersihkan input & tutup menu; log opsi yang terlihat untuk diagnostik
    setNativeValue(input, "");
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", code: "Escape", bubbles: true }));
    try {
      const boxes = Array.from(document.querySelectorAll('[role="listbox"]'));
      const opts = boxes.flatMap((b) => Array.from(b.querySelectorAll('[role="option"]')).map((o) => o.textContent.trim())).slice(0, 30);
      console.info(`[SRIKANDI Naskah AI] dropdown "${input.id}" tidak cocok untuk "${value}" — opsi terlihat: ${opts.length ? JSON.stringify(opts) : "(menu tertutup)"}`);
    } catch {}
    return false;
  }

  /* -------------------------- set nilai field -------------------------- */

  /** Set nilai sebuah field; mengembalikan true bila sukses. (async: react-select) */
  async function setFieldValue(field, value) {
    const el = field.el;
    const v = String(value ?? "");
    if (!v) return false;

    if (field.reactSelect) {
      return fillReactSelect(el, v);
    }

    if (field.type === "select") {
      const options = Array.from(el.options);
      const target = norm(v);
      let opt = options.find((o) => norm(o.textContent) === target);
      if (!opt) opt = options.find((o) => norm(o.value) === target);
      if (!opt) opt = options.find((o) => norm(o.textContent).includes(target));
      if (!opt) return false;
      el.value = opt.value;
      el.dispatchEvent(new Event("input", { bubbles: true }));
      el.dispatchEvent(new Event("change", { bubbles: true }));
      return true;
    }

    if (field.type === "checkbox" || field.type === "radio") {
      const want = v === "1" || /^(ya|true|x|checked|ya,? )$/i.test(v);
      if (want && !el.checked) {
        el.click();
        return true;
      }
      return false;
    }

    if (field.type === "date") {
      const iso = v.match(/\d{4}-\d{2}-\d{2}/);
      if (iso) {
        setNativeValue(el, iso[0]);
        return true;
      }
      return false;
    }

    if (field.type === "number") {
      const num = v.match(/\d+(?:[.,]\d+)?/);
      if (!num) return false;
      setNativeValue(el, num[0].replace(",", "."));
      return true;
    }

    // text / textarea / lainnya
    setNativeValue(el, v);
    return true;
  }

  /* --------------------------- pencocokan label -------------------------- */

  const KEY_PATTERNS = {
    nomor_naskah: [/^nomor\b/, /\bnomor (naskah|surat|dokumen)\b/, /\bnomor\b/],
    tanggal_naskah: [/^tanggal\b/, /\btanggal (naskah|surat|dokumen)\b/, /\btanggal\b/],
    pokok_surat: [/\b(pokok|perihal|perkara|hal)\b/], // form SRIKANDI memakai label "Hal"
    jenis_naskah: [/\bjenis\b/],
    gradasi: [/\b(gradasi|kerahasiaan|tingkat rahasia|rahasia|klasifikasi)\b/], // label "Klasifikasi"
    prioritas: [/\b(prioritas|prioritet|urgensi|sifat)\b/], // label "Sifat Naskah"
    jumlah_lampiran: [/\b(jumlah|banyaknya) (lampiran|file|attachment)\b/],
    lampiran: [/\blampiran\b/],
    instansi_tujuan: [/\b(instansi|tujuan|penerima|utama)\b/],
    nama_penerima: [/\bnama (penerima|pejabat)\b/, /\bnama\b/],
    nomor_referensi: [/\breferensi\b/],
    ringkasan: [/\b(ringkasan|ringkas|abstrak|ikhtisar)\b/], // label "Isi Ringkas"
  };

  /**
   * Isi form dari hasil AI.
   * @param {object} fieldsResult - objek field dari AI
   * @returns {Promise<{filled:Array, notFound:Array, failed:Array, skippedKeys:Array}>}
   */
  async function applyFields(fieldsResult) {
    const fields = collectFields();
    const used = new Set();
    const result = { filled: [], notFound: [], failed: [], skippedKeys: [] };
    try {
      console.info(
        `[SRIKANDI Naskah AI] applyFields: ${fields.length} field terdeteksi —`,
        fields.map((f) => `"${f.label}" (${f.type}${f.reactSelect ? ",react-select" : ""})`).join(" | ")
      );
    } catch {}

    const keysWithValues = Object.entries(fieldsResult || {}).filter(([, v]) => {
      if (v === null || v === undefined) return false;
      if (typeof v === "string" && !v.trim()) return false;
      if (Array.isArray(v) && v.length === 0) return false;
      return true;
    });

    // urutan prioritas pengisian (field scalars dulu, lalu lampiran/tujuan)
    const order = [
      "tanggal_naskah", // dilaporkan skipped (tidak ada field tanggal di form)
      "nomor_naskah",
      "nomor_referensi",
      "pokok_surat",
      "jenis_naskah",
      "gradasi",
      "prioritas",
      "jumlah_lampiran",
      "ringkasan",
    ];
    const orderedKeys = order.filter((k) => keysWithValues.some(([k2]) => k2 === k));

    for (const key of orderedKeys) {
      if (SKIP_KEYS.includes(key)) {
        result.skippedKeys.push(key);
        continue;
      }
      const value = fieldsResult[key];
      const patterns = KEY_PATTERNS[key] || [new RegExp(key.replace(/_/g, "\\b"))];
      let target = null;
      for (const field of fields) {
        if (used.has(field.el)) continue;
        if (field.type === "checkbox" || field.type === "radio") continue;
        const label = norm(field.label);
        if (patterns.some((re) => re.test(label))) {
          target = field;
          break;
        }
      }
      if (!target) {
        result.notFound.push({ key, value: typeof value === "object" ? JSON.stringify(value) : value });
        continue;
      }
      const ok = await setFieldValue(target, value);
      if (ok) {
        used.add(target.el);
        result.filled.push({ key, fieldLabel: target.label, value: String(value).slice(0, 200) });
      } else {
        result.failed.push({ key, fieldLabel: target.label, value: String(value) });
      }
    }

    // Lampiran: cari input berteks "nama lampiran" (bila ada di form lain)
    const lampiran = fieldsResult.lampiran;
    if (Array.isArray(lampiran) && lampiran.length && typeof lampiran[0] === "object") {
      const first = lampiran[0] || {};
      const value = first.nama || first.name || "";
      if (value) {
        const target = fields.find(
          (f) => !used.has(f.el) && f.type !== "checkbox" && f.type !== "radio" && norm(f.label).includes("nama lampiran")
        );
        if (target) {
          if (await setFieldValue(target, value)) {
            used.add(target.el);
            result.filled.push({ key: "lampiran", fieldLabel: target.label, value });
          } else {
            result.failed.push({ key: "lampiran", fieldLabel: target.label, value });
          }
        }
        // Lampiran di form SRIKANDI = slot file (ditangani setFiles oleh content.js)
      }
    }

    // Tujuan: isi field "tujuan utama" (react-select di form SRIKANDI)
    const tujuan = fieldsResult.tujuan;
    if (Array.isArray(tujuan) && tujuan.length && typeof tujuan[0] === "object") {
      const t = tujuan[0] || {};
      const instansiValue = t.instansi || t.nama || "";
      if (instansiValue) {
        const patterns = [/\b(instansi|tujuan utama|utama)\b/];
        const target = fields.find(
          (f) => !used.has(f.el) && f.type !== "checkbox" && f.type !== "radio" && patterns.some((re) => re.test(norm(f.label)))
        );
        if (target) {
          if (await setFieldValue(target, instansiValue)) {
            used.add(target.el);
            result.filled.push({ key: "tujuan", fieldLabel: target.label, value: instansiValue });
          } else {
            result.failed.push({ key: "tujuan", fieldLabel: target.label, value: instansiValue });
          }
        } else {
          result.notFound.push({ key: "tujuan", value: instansiValue });
        }
      }
    }

    return result;
  }

  /* ---------------------------- slot file ---------------------------- */

  /** Ambil input file: naskah (single) & lampiran (multiple) dari react-dropzone. */
  function collectFileInputs() {
    const all = Array.from(document.querySelectorAll("input[type='file']"));
    const singles = all.filter((i) => !i.multiple && !i.disabled);
    const multiples = all.filter((i) => i.multiple && !i.disabled);
    return { naskah: singles[0] || null, lampiran: multiples[0] || null };
  }

  /** Pasang File[] ke input file via DataTransfer (trigger event change). */
  function setFiles(input, files) {
    if (!input || !Array.isArray(files) || !files.length) return false;
    try {
      const dt = new DataTransfer();
      for (const f of files) dt.items.add(f);
      input.files = dt.files;
      input.dispatchEvent(new Event("change", { bubbles: true }));
      return true;
    } catch (e) {
      console.warn("[SRIKANDI Naskah AI] setFiles gagal:", e);
      return false;
    }
  }

  window.SNAI = window.SNAI || {};
  window.SNAI.formfill = {
    collectFields,
    applyFields,
    setFieldValue,
    collectFileInputs,
    setFiles,
    isReactSelect,
  };
})();
