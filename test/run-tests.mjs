/**
 * Unit test SRIKANDI Naskah AI (jalankan: node test/run-tests.mjs)
 *
 * - formfill.js : deteksi label (sibling/MuiGrid), pengisian native,
 *                 react-select (ketik → mousedown opsi), slot file.
 * - service-worker.js : extractJson + normalizeFields (+ nomor_referensi).
 *
 * DOM shim: pohon elemen mini yang meniru struktur form SRIKANDI
 * (label sibling di dalam MuiGrid, input react-select, select native,
 * input file dropzone) + simulasi react-select (filter opsi + mousedown).
 */
import assert from "node:assert";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");

/* ------------------------------ mini DOM ------------------------------ */

function matchPart(el, part) {
  part = part.trim();
  if (!part) return false;
  if (part.startsWith(".")) return (el.className || "").split(/\s+/).includes(part.slice(1));
  let m = part.match(/^([a-zA-Z*]+):not\(\[([a-zA-Z-]+)\]\)$/);
  if (m) {
    const tag = m[1].toUpperCase();
    if (el.tagName !== tag) return false;
    return !(m[2].toLowerCase() in el._attrs);
  }
  m = part.match(/^([a-zA-Z*]+)?\[([a-zA-Z-]+)(\*)?=(['"])([^'"]*)\4\]$/);
  if (m) {
    if (m[1] && el.tagName !== m[1].toUpperCase()) return false;
    if (!(m[2] in el._attrs)) return false;
    const v = String(el._attrs[m[2]]);
    return m[3] === "*" ? v.includes(m[5]) : v === m[5];
  }
  m = part.match(/^([a-zA-Z*]+)?\[([a-zA-Z-]+)\]$/);
  if (m) {
    if (m[1] && el.tagName !== m[1].toUpperCase()) return false;
    return m[2] in el._attrs;
  }
  m = part.match(/^([a-zA-Z*]+)$/);
  if (m) return el.tagName === m[1].toUpperCase();
  return false;
}

class FakeEl {
  constructor(tag, attrs = {}) {
    this.tagName = tag.toUpperCase();
    this._attrs = {};
    if (attrs.class) this.className = attrs.class;
    if (attrs.id) this.id = attrs.id;
    if (attrs.type) this.type = attrs.type;
    else if (tag === "input") this.type = "text";
    if (attrs.multiple !== undefined) this.multiple = !!attrs.multiple;
    this.disabled = !!attrs.disabled;
    this.readOnly = !!attrs.readOnly;
    this.checked = false;
    this.textContent = attrs.textContent || "";
    this._v = "";
    this.files = null;
    this.events = [];
    this._handlers = {};
    this.children = [];
    this._parent = null;
    this._prev = null;
    if (tag === "select") {
      this.options = (attrs.options || []).map((t) => ({ value: t, textContent: t }));
    }
  }
  get value() {
    return this._v;
  }
  set value(v) {
    this._v = String(v);
  }
  // `type` disinkronkan ke atribut (DOM asli: el.type === atribut type)
  get type() {
    return "type" in this._attrs ? this._attrs.type : this.tagName === "INPUT" ? "text" : undefined;
  }
  set type(v) {
    this._attrs.type = v;
  }
  get className() {
    return this._attrs.class || "";
  }
  set className(c) {
    this._attrs.class = c;
  }
  getAttribute(n) {
    return n in this._attrs ? this._attrs[n] : null;
  }
  setAttribute(n, v) {
    this._attrs[n] = String(v);
  }
  get parentElement() {
    return this._parent;
  }
  get previousElementSibling() {
    return this._prev;
  }
  append(...kids) {
    for (const k of kids) {
      k._parent = this;
      k._prev = this.children.length ? this.children[this.children.length - 1] : null;
      this.children.push(k);
    }
    return this;
  }
  remove() {
    if (this._parent) this._parent.children = this._parent.children.filter((c) => c !== this);
    this._parent = null;
  }
  descendants(includeSelf = true) {
    const out = includeSelf ? [this] : [];
    for (const c of this.children) out.push(...c.descendants(true));
    return out;
  }
  querySelectorAll(sel) {
    return this.descendants(true).filter((el) => sel.split(",").some((p) => matchPart(el, p.trim())));
  }
  querySelector(sel) {
    return this.querySelectorAll(sel)[0] || null;
  }
  closest(sel) {
    let n = this;
    while (n) {
      if (sel.split(",").some((p) => matchPart(n, p.trim()))) return n;
      n = n.parentElement;
    }
    return null;
  }
  dispatchEvent(e) {
    if (!e || !e.type) return true;
    this.events.push(e.type);
    const h = this._handlers[e.type];
    if (h) h(e);
    return true;
  }
  addEventListener(type, fn) {
    this._handlers[type] = fn;
  }
  focus() {}
  click() {
    this.checked = !this.checked;
    this.dispatchEvent({ type: "click" });
  }
  getBoundingClientRect() {
    return { width: 120, height: 24 };
  }
}

const body = new FakeEl("body");
globalThis.document = {
  body,
  querySelectorAll(sel) {
    return body.descendants(true).filter((el) => sel.split(",").some((p) => matchPart(el, p.trim())));
  },
  querySelector(sel) {
    return this.querySelectorAll(sel)[0] || null;
  },
};
globalThis.window = globalThis;
window.getComputedStyle = () => ({ display: "block", visibility: "visible" });
globalThis.CSS = { escape: (s) => s };
globalThis.HTMLInputElement = class {
  get value() {
    return this._v || "";
  }
  set value(v) {
    this._v = String(v);
  }
};
globalThis.HTMLTextAreaElement = globalThis.HTMLInputElement;
globalThis.Event = class {
  constructor(type, opts = {}) {
    this.type = type;
    this.bubbles = !!opts.bubbles;
  }
};
globalThis.MouseEvent = class {
  constructor(type, opts = {}) {
    this.type = type;
    Object.assign(this, opts);
  }
};
globalThis.KeyboardEvent = class {
  constructor(type, opts = {}) {
    this.type = type;
    Object.assign(this, opts);
  }
};
globalThis.DataTransfer = class {
  constructor() {
    this._items = [];
  }
  get items() {
    return { add: (f) => this._items.push(f) };
  }
  get files() {
    return this._items;
  }
};

/* ------------------- simulasi react-select (filter+mousedown) ------------------- */

const RS_OPTIONS = {
  "react-select-3-input": ["Surat", "Memo", "Nota Dinas", "Lainnya"],
  "react-select-4-input": ["Biasa", "Segera", "Darurat"],
  "react-select-5-input": ["Terbuka", "Internal", "Rahasia"],
  "react-select-6-input": ["001/1001/2026", "002/1001/2026"],
  "react-select-9-input": ["Pemerintah Kota X", "Dinas Arsip Provinsi Y"],
};
const rsSelected = {};
const openBoxes = [];
const closeBox = () => {
  while (openBoxes.length) openBoxes.pop().remove();
};

function mkReactSelect(id, gridLabel) {
  const input = new FakeEl("input", { type: "text", id });
  input.setAttribute("role", "combobox");
  input.addEventListener("input", () => {
    const q = input.value.toLowerCase();
    closeBox();
    const opts = (RS_OPTIONS[id] || []).filter((t) => t.toLowerCase().includes(q));
    if (opts.length) {
      const lb = new FakeEl("div");
      lb.setAttribute("role", "listbox");
      for (const t of opts) {
        const o = new FakeEl("div");
        o.setAttribute("role", "option");
        o.textContent = t;
        o.addEventListener("mousedown", () => {
          rsSelected[input.id] = t;
          input.value = "";
          closeBox();
        });
        lb.append(o);
      }
      body.append(lb);
      openBoxes.push(lb);
    }
  });
  input.addEventListener("keydown", (e) => {
    if (e && e.key === "Escape") closeBox();
  });
  const control = new FakeEl("div", { class: "css-test-control" });
  control.append(input);
  const rsRoot = new FakeEl("div", { class: "css-test-container" });
  rsRoot.append(control);
  const grid = new FakeEl("div", { class: "MuiGrid-root" });
  const label = new FakeEl("label");
  label.textContent = gridLabel;
  grid.append(label, rsRoot);
  body.append(grid);
  return input;
}

/* ---------------- fixture: meniru form SRIKANDI asli ---------------- */

function mkGrid(labelText, ...inner) {
  const grid = new FakeEl("div", { class: "MuiGrid-root" });
  const label = new FakeEl("label");
  label.textContent = labelText;
  grid.append(label, ...inner);
  body.append(grid);
  return grid;
}

const nomor = new FakeEl("input", { type: "text" });
mkGrid("Nomor Naskah *", new FakeEl("div").append(nomor));
const hal = new FakeEl("textarea");
hal.setAttribute("name", "hal");
mkGrid("Hal *", hal);
const ringkas = new FakeEl("textarea");
ringkas.setAttribute("name", "ringkasan");
mkGrid("Isi Ringkas", ringkas);
mkReactSelect("react-select-3-input", "Jenis Naskah *");
mkReactSelect("react-select-4-input", "Sifat Naskah *");
mkReactSelect("react-select-5-input", "Klasifikasi *");
mkReactSelect("react-select-6-input", "Nomor Referensi");
mkReactSelect("react-select-9-input", "Utama (Internal / Eksternal Srikandi) *");
const qrSel = new FakeEl("select", { options: ["1X1", "2X2", "3X3"] });
qrSel.setAttribute("name", "ukuran_qr");
mkGrid("Ukuran QR Code", new FakeEl("div").append(qrSel));
const fileNaskah = new FakeEl("input", { type: "file" });
const fileLamp = new FakeEl("input", { type: "file", multiple: true });
body.append(fileNaskah, fileLamp);
const radioMode = new FakeEl("input", { type: "radio" });
radioMode.setAttribute("name", "document_mode");
const radioWrap = new FakeEl("label");
radioWrap.textContent = "Naskah Keluar";
radioWrap.append(radioMode);
body.append(radioWrap);

require(path.join(root, "extension/content/formfill.js"));
const { collectFields, applyFields, collectFileInputs, setFiles } = window.SNAI.formfill;

/* --------------------------------- test --------------------------------- */

let passed = 0;
async function ok(name, fn) {
  await fn();
  passed++;
  console.log(`  ✔ ${name}`);
}

console.log("formfill.js:");

await ok("collectFields membaca label sibling/MuiGrid (tanpa for)", () => {
  const f = collectFields();
  const labels = f.map((x) => x.label.toLowerCase());
  for (const want of [
    "nomor naskah *",
    "hal *",
    "isi ringkas",
    "jenis naskah *",
    "sifat naskah *",
    "klasifikasi *",
    "nomor referensi",
    "utama (internal / eksternal srikandi) *",
    "ukuran qr code",
  ]) {
    assert.ok(labels.some((l) => l.includes(want)), `label tidak ditemukan: "${want}" → ${labels.join(" | ")}`);
  }
  assert.ok(f.some((x) => x.reactSelect), "react-select terdeteksi");
  assert.strictEqual(f.filter((x) => x.reactSelect).length, 5);
  assert.ok(f.every((x) => x.label.length > 0));
});

const ai = {
  tanggal_naskah: "2026-11-03", // tidak ada field tanggal di form → skipped (info)
  nomor_naskah: "005/1013/2026",
  nomor_referensi: "002/1001/2026",
  pokok_surat: "Permohonan Penggunaan Ruangan",
  jenis_naskah: "surat", // huruf kecil → opsi "Surat"
  gradasi: "TERBUKA", // huruf besar → opsi "Terbuka"
  prioritas: "segera", // → opsi "Segera"
  ringkasan: "Surat permohonan penggunaan ruang rapat lantai 3.",
  lampiran: [{ nama: "Daftar Peserta", halaman: null }],
  tujuan: [{ instansi: "Pemerintah Kota X", nama: "", jabatan: "" }],
};

const res = await applyFields(ai);

await ok("applyFields mengisi 8 field (native + 5 react-select + tujuan)", () => {
  assert.strictEqual(res.filled.length, 8, JSON.stringify(res, null, 2));
  assert.strictEqual(res.failed.length, 0, JSON.stringify(res.failed));
  assert.strictEqual(res.notFound.length, 0, JSON.stringify(res.notFound));
});
await ok("nilai native + event React dipicu", () => {
  assert.strictEqual(nomor.value, "005/1013/2026");
  assert.strictEqual(hal.value, "Permohonan Penggunaan Ruangan");
  assert.strictEqual(ringkas.value, "Surat permohonan penggunaan ruang rapat lantai 3.");
  assert.ok(nomor.events.includes("input") && nomor.events.includes("change"), nomor.events.join(","));
});
await ok("react-select: nilai dinormalisasi lalu mousedown opsi yang benar", () => {
  assert.strictEqual(rsSelected["react-select-3-input"], "Surat");
  assert.strictEqual(rsSelected["react-select-5-input"], "Terbuka");
  assert.strictEqual(rsSelected["react-select-4-input"], "Segera");
  assert.strictEqual(rsSelected["react-select-6-input"], "002/1001/2026");
  assert.strictEqual(rsSelected["react-select-9-input"], "Pemerintah Kota X");
});
await ok("tanggal_naskah di-skip (tidak ada di form)", () => {
  assert.deepStrictEqual(res.skippedKeys, ["tanggal_naskah"]);
  assert.ok(!res.filled.some((f) => f.key === "tanggal_naskah"));
});

const resNoMatch = await applyFields({ gradasi: "Sangat Rahasia" });
await ok("react-select tanpa kecocokan → tidak nebak (masuk failed)", () => {
  assert.ok(resNoMatch.failed.some((f) => f.key === "gradasi"), JSON.stringify(resNoMatch));
  // nilai "Terbuka" dari run sebelumnya tetap — tidak ada opsi baru yang dipilih
  assert.strictEqual(rsSelected["react-select-5-input"], "Terbuka");
});

const resNull = await applyFields({ nomor_naskah: null, pokok_surat: "  ", gradasi: "Terbuka" });
await ok("nilai null/kosong dilewati", () => {
  assert.strictEqual(resNull.filled.length, 1);
  assert.strictEqual(resNull.filled[0].key, "gradasi");
});

await ok("slot file: naskah (single) & lampiran (multiple) ditemukan", () => {
  const inputs = collectFileInputs();
  assert.strictEqual(inputs.naskah, fileNaskah);
  assert.strictEqual(inputs.lampiran, fileLamp);
});
await ok("setFiles memasang File[] + memicu change", () => {
  const f1 = { name: "a.docx" };
  const f2 = { name: "b.pdf" };
  assert.strictEqual(setFiles(fileNaskah, [f1]), true);
  assert.deepStrictEqual(fileNaskah.files, [f1]);
  assert.ok(fileNaskah.events.includes("change"));
  assert.strictEqual(setFiles(fileLamp, [f1, f2]), true);
  assert.deepStrictEqual(fileLamp.files, [f1, f2]);
  assert.strictEqual(setFiles(null, [f1]), false);
});

/* ----------------------------- service-worker.js ----------------------------- */

globalThis.chrome = {
  runtime: { onMessage: { addListener() {} }, openOptionsPage() {} },
  action: { onClicked: { addListener() {} } },
  storage: { local: { get: async () => ({}) } },
  tabs: {},
};
const sw = require(path.join(root, "extension/background/service-worker.js"));

console.log("service-worker.js:");

await ok("extractJson: JSON polos / code fence / teks ekstra / gagal", () => {
  assert.deepStrictEqual(sw.extractJson('{"a": 1}'), { a: 1 });
  assert.deepStrictEqual(sw.extractJson('```json\n{"b": "x"}\n```'), { b: "x" });
  assert.deepStrictEqual(sw.extractJson('Hasil:\n{"c": [1,2]}\nSelesai.'), { c: [1, 2] });
  assert.strictEqual(sw.extractJson("halo dunia"), null);
  assert.strictEqual(sw.extractJson(null), null);
});
await ok("normalizeFields: key asing dibuang, null dipertahankan", () => {
  const o = sw.normalizeFields({ nomor_naskah: "1", foo: "bar", prioritas: null });
  assert.deepStrictEqual(o, { nomor_naskah: "1", prioritas: null });
  assert.strictEqual(sw.normalizeFields("x"), null);
});
await ok("normalizeFields: alias label form → key kanonik", () => {
  const o = sw.normalizeFields({
    tingkat_kerahasiaan: "Terbuka",
    perihal: "Undangan Rapat",
    nomor: "1/2026",
    summary: "x",
    referensi: "002/1001/2026",
    sifat: "Segera",
  });
  assert.strictEqual(o.gradasi, "Terbuka");
  assert.strictEqual(o.pokok_surat, "Undangan Rapat");
  assert.strictEqual(o.nomor_naskah, "1/2026");
  assert.strictEqual(o.ringkasan, "x");
  assert.strictEqual(o.nomor_referensi, "002/1001/2026");
  assert.strictEqual(o.prioritas, "Segera");
  assert.ok(!("tingkat_kerahasiaan" in o));
});
await ok("SYSTEM_PROMPT menyebut nomor_referensi & label asli form", () => {
  assert.ok(sw.SYSTEM_PROMPT.includes("nomor_referensi"));
  assert.ok(sw.SYSTEM_PROMPT.includes("Klasifikasi"));
  assert.ok(sw.SYSTEM_PROMPT.includes("Sifat Naskah"));
  assert.ok(sw.SYSTEM_PROMPT.includes("Isi Ringkas"));
});

console.log(`\n${passed} test lulus 🎉`);
