/**
 * SRIKANDI Naskah AI — content.js
 *
 * Menampilkan panel drag-n-drop di halaman SRIKANDI, mengekstrak teks dari
 * file (PDF/DOCX/TXT), mengirimkannya ke background worker untuk dianalisis
 * AI, lalu mengisi form via SNAI.formfill.
 */
(() => {
  "use strict";

  if (window.__srikandiNaskahAI) return;
  window.__srikandiNaskahAI = true;

  const MAX_FILE_CHARS = 20000;
  const MAX_TOTAL_CHARS = 30000;

  // Field yang COBA diisi di form SRIKANDI (label sesuai form asli, tervalidasi 2026-11-03).
  // tanggal_naskah & jumlah_lampiran TIDAK punya field di form ini → hanya ditampilkan sebagai info.
  const FIELD_DEFS = [
    { key: "nomor_naskah", label: "Nomor Naskah" },
    { key: "nomor_referensi", label: "Nomor Referensi" },
    { key: "pokok_surat", label: "Hal (Perihal)", area: true },
    { key: "jenis_naskah", label: "Jenis Naskah" },
    { key: "prioritas", label: "Sifat Naskah" },
    { key: "gradasi", label: "Klasifikasi" },
    { key: "ringkasan", label: "Isi Ringkas", area: true },
  ];

  const DEFAULT_PAGE_MATCH = "registrasi-naskah-keluar";

  const S = {
    files: [], // { name, text, kind, file:File } — file[0] → naskah, sisanya → lampiran
    state: "idle", // idle | extracting | analyzing | ready | error
    fields: null, // hasil AI
    settings: {},
    panelOpen: false,
  };

  let host = null;
  let shadow = null;
  const R = {}; // referensi elemen UI

  /* ------------------------------ util ------------------------------ */

  function el(tag, attrs = {}, ...children) {
    const node = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) {
      if (k === "class") node.className = v;
      else if (k.startsWith("on") && typeof v === "function") node.addEventListener(k.slice(2), v);
      else if (v !== null && v !== undefined) node.setAttribute(k, v);
    }
    for (const c of children) {
      if (c === null || c === undefined) continue;
      node.append(c instanceof Node ? c : document.createTextNode(String(c)));
    }
    return node;
  }

  function setStatus(text, kind = "info") {
    if (!R.status) return;
    R.status.replaceChildren(text);
    R.status.className = `snai-status snai-status-${kind}`;
  }

  function setState(state) {
    S.state = state;
    const busy = state === "extracting" || state === "analyzing";
    if (R.btnApply) R.btnApply.disabled = busy || state !== "ready";
    if (R.btnRetry) R.btnRetry.disabled = busy;
  }

  /* ---------------------------- settings ---------------------------- */

  async function loadSettings() {
    const stored = await chrome.storage.local.get({});
    S.settings = stored;
    S.settings.pageMatch = stored.pageMatch || DEFAULT_PAGE_MATCH;
  }

  function isTargetPage() {
    const m = S.settings.pageMatch || DEFAULT_PAGE_MATCH;
    if (!m) return true;
    return location.pathname.includes(m) || location.href.includes(m);
  }

  /* --------------------------- ekstraksi ---------------------------- */

  function truncate(text) {
    if (text.length <= MAX_FILE_CHARS) return text;
    return text.slice(0, MAX_FILE_CHARS) + "\n[…teks dipotong karena panjang…]";
  }

  async function extractPdf(file) {
    const buf = await file.arrayBuffer();
    const pdf = await window.pdfjsLib.getDocument({ data: buf, isEvalSupported: false }).promise;
    try {
      let out = "";
      for (let p = 1; p <= pdf.numPages; p++) {
        const page = await pdf.getPage(p);
        const tc = await page.getTextContent();
        out += tc.items.map((i) => i.str).join(" ") + "\n";
        if (out.length > MAX_FILE_CHARS) {
          out += " […dipotong…]";
          break;
        }
      }
      return out.trim();
    } finally {
      try {
        await pdf.destroy();
      } catch {}
    }
  }

  async function extractDocx(file) {
    const buf = await file.arrayBuffer();
    const res = await window.mammoth.convertToHtml({ arrayBuffer: buf });
    const div = document.createElement("div");
    div.innerHTML = res.value || "";
    return (div.textContent || "").replace(/\s+\n/g, "\n").trim();
  }

  async function extractFile(file) {
    const name = file.name.toLowerCase();
    if (name.endsWith(".pdf")) return { text: await extractPdf(file), kind: "pdf" };
    if (name.endsWith(".docx")) return { text: await extractDocx(file), kind: "docx" };
    if (/\.(txt|md|csv)$/.test(name)) return { text: await file.text(), kind: "text" };
    throw new Error(`Format "${file.name}" belum didukung. Gunakan PDF, DOCX, atau TXT.`);
  }

  /* ------------------------------- UI ------------------------------- */

  function buildUI() {
    host = el("div", { id: "snai-host", class: "snai-hidden" });
    shadow = host.attachShadow({ mode: "open" });

    const style = el("style");
    shadow.append(style);

    R.fab = el(
      "button",
      { class: "snai-fab", title: "Naskah AI — analisis & isi form otomatis", onclick: () => setPanelOpen(true) },
      "📄"
    );

    R.panel = el("div", { class: "snai-panel" });

    // header
    const gear = el("button", { class: "snai-btn-ghost", title: "Pengaturan (API key, dsb.)", onclick: openOptions }, "⚙️");
    const close = el("button", { class: "snai-btn-ghost", title: "Tutup panel", onclick: () => setPanelOpen(false) }, "×");
    R.panel.append(
      el(
        "div",
        { class: "snai-header" },
        el("div", { class: "snai-title" }, "📄 Naskah AI", el("span", { class: "snai-badge" }, "SRIKANDI")),
        el("div", { class: "snai-header-actions" }, gear, close)
      )
    );

    const body = el("div", { class: "snai-body" });

    // dropzone
    R.drop = el(
      "div",
      { class: "snai-dropzone" },
      el("div", { class: "snai-drop-ico" }, "⬆️"),
      el("div", { class: "snai-drop-text" }, "Tarik & lepas naskah di sini", el("div", { class: "snai-drop-sub" }, "PDF, DOCX, TXT — file pertama = naskah, sisanya = lampiran")),
      el("span", { class: "snai-drop-link", role: "button", tabindex: "0" }, "atau pilih file")
    );
    R.fileInput = el("input", { type: "file", accept: ".pdf,.docx,.txt,.md", multiple: "multiple", class: "snai-fileinput" });
    body.append(R.drop, R.fileInput);

    R.files = el("div", { class: "snai-files" });
    R.status = el("div", { class: "snai-status snai-status-idle" }, "");
    R.result = el("div", { class: "snai-result snai-hidden" });
    R.error = el("div", { class: "snai-error snai-hidden" });
    body.append(R.files, R.status, R.result, R.error);
    R.panel.append(body);

    // footer
    R.btnRetry = el("button", { class: "snai-btn snai-btn-secondary" }, "Analisis Ulang");
    R.btnApply = el("button", { class: "snai-btn snai-btn-primary", disabled: "disabled" }, "Isi Form Otomatis");
    R.panel.append(el("div", { class: "snai-footer" }, R.btnRetry, R.btnApply));

    R.drop.addEventListener("click", (e) => {
      if (e.target === R.drop || e.target.closest(".snai-drop-link")) R.fileInput.click();
    });
    ["dragenter", "dragover"].forEach((ev) =>
      R.drop.addEventListener(ev, (e) => {
        e.preventDefault();
        R.drop.classList.add("snai-drop-active");
      })
    );
    ["dragleave", "dragend"].forEach((ev) => R.drop.addEventListener(ev, () => R.drop.classList.remove("snai-drop-active")));
    R.drop.addEventListener("drop", (e) => {
      e.preventDefault();
      R.drop.classList.remove("snai-drop-active");
      const files = Array.from(e.dataTransfer?.files || []);
      if (files.length) addFiles(files);
    });
    R.fileInput.addEventListener("change", () => {
      addFiles(Array.from(R.fileInput.files || []));
      R.fileInput.value = "";
    });
    R.btnRetry.addEventListener("click", analyze);
    R.btnApply.addEventListener("click", applyToForm);

    shadow.append(R.fab, R.panel);
    document.documentElement.appendChild(host);
    loadCss(style);
  }

  async function loadCss(styleEl) {
    try {
      const res = await fetch(chrome.runtime.getURL("content/content.css"));
      styleEl.textContent = await res.text();
    } catch {
      styleEl.textContent =
        ':host{--snai-bg:#fff;--snai-text:#0f172a;--snai-border:#e2e8f0;--snai-primary:#4f46e5}:host(.snai-hidden){display:none}.snai-hidden{display:none}.snai-fab{position:fixed;top:14px;right:14px;width:52px;height:52px;border:none;border-radius:50%;background:#4f46e5;color:#fff;font-size:22px;cursor:pointer;z-index:2147483000}.snai-panel{position:fixed;top:78px;right:14px;width:380px;max-width:calc(100vw - 28px);max-height:calc(100vh - 100px);background:var(--snai-bg);border:1px solid var(--snai-border);border-radius:14px;box-shadow:0 8px 30px rgba(15,23,42,.18);font:13px/1.5 system-ui;z-index:2147483000;padding:14px;color:var(--snai-text)}';
    }
  }

  function setPanelOpen(open) {
    S.panelOpen = open;
    if (!host) return;
    R.panel.classList.toggle("snai-hidden", !open);
    R.fab.classList.toggle("snai-hidden", open);
  }

  function renderFiles() {
    R.files.replaceChildren();
    for (const [i, f] of S.files.entries()) {
      const chip = el(
        "div",
        { class: "snai-file-chip" },
        el("span", { class: "snai-file-name" }, f.name),
        el("button", {
          class: "snai-file-x",
          title: "Hapus file",
          onclick: () => {
            S.files.splice(i, 1);
            if (!S.files.length) {
              S.fields = null;
              R.result.classList.add("snai-hidden");
              setState("idle");
              setStatus("");
            }
            renderFiles();
            if (S.files.length) analyze();
          },
        }, "×")
      );
      R.files.append(chip);
    }
  }

  function renderResult() {
    R.result.replaceChildren();
    R.result.append(el("div", { class: "snai-result-title" }, "Hasil analisis — perbaiki bila perlu, kosongkan bila ingin dilewati"));
    const grid = el("div", { class: "snai-fields" });
    for (const def of FIELD_DEFS) {
      const input = el(def.area ? "textarea" : "input", {
        class: `snai-field-input${def.area ? " snai-area" : ""}`,
        value: S.fields?.[def.key] != null ? String(S.fields[def.key]) : "",
        rows: def.area ? "3" : undefined,
      });
      if (def.hint) input.placeholder = def.hint;
      input.dataset.snaiKey = def.key;
      grid.append(el("label", { class: "snai-field" }, el("span", { class: "snai-field-label" }, def.label), input));
    }
    R.result.append(grid);

    // Info: field yang tidak punya tempat di form registrasi (hanya ditampilkan)
    const infoRows = [
      ["Tanggal Naskah", S.fields?.tanggal_naskah],
      ["Jumlah Lampiran", S.fields?.jumlah_lampiran],
    ].filter(([, v]) => v !== null && v !== undefined && v !== "");
    if (infoRows.length) {
      const info = el("div", { class: "snai-result-info" });
      for (const [label, v] of infoRows) {
        info.append(el("div", { class: "snai-info-row" }, el("span", { class: "snai-info-label" }, label + " "), el("span", { class: "snai-info-value" }, String(v))));
      }
      R.result.append(info);
    }

    const extras = [];
    if (Array.isArray(S.fields?.lampiran) && S.fields.lampiran.length) extras.push(["Lampiran (detil)", S.fields.lampiran]);
    if (Array.isArray(S.fields?.tujuan) && S.fields.tujuan.length) extras.push(["Tujuan Surat (detil)", S.fields.tujuan]);
    for (const [title, data] of extras) {
      const pre = el("pre", { class: "snai-extras" }, JSON.stringify(data, null, 2));
      R.result.append(el("details", { class: "snai-extras-wrap" }, el("summary", {}, title), pre));
    }

    if (R.btnApply) R.btnApply.disabled = false;
  }

  function showError(msg) {
    R.error.replaceChildren(msg);
    R.error.classList.remove("snai-hidden");
  }

  function toast(msg) {
    const t = el("div", { class: "snai-toast" }, msg);
    shadow.append(t);
    requestAnimationFrame(() => t.classList.add("snai-toast-in"));
    setTimeout(() => {
      t.classList.remove("snai-toast-in");
      setTimeout(() => t.remove(), 400);
    }, 9000);
  }

  /* ----------------------------- alur ------------------------------ */

  async function addFiles(files) {
    if (S.state === "extracting" || S.state === "analyzing") return;
    setState("extracting");
    for (const [i, file] of files.entries()) {
      setStatus(`Mengekstrak teks: ${file.name} (${i + 1}/${files.length})…`, "busy");
      try {
        const { text, kind } = await extractFile(file);
        if (!text || text.trim().length < 3) throw new Error(`Tidak ada teks yang terbaca dari "${file.name}" (PDF hasil scan perlu OCR).`);
        S.files.push({ name: file.name, text: truncate(text), kind, file });
        renderFiles();
      } catch (err) {
        setState("error");
        setStatus("Gagal mengekstrak.", "error");
        showError(err.message || String(err));
        return;
      }
    }
    await analyze();
  }

  async function analyze() {
    if (!S.files.length) return;
    setState("analyzing");
    R.result.classList.add("snai-hidden");
    R.error.classList.add("snai-hidden");
    setStatus("Menganalisis dengan AI…", "busy");
    const total = S.files.map((f) => `=== FILE: ${f.name} ===\n${f.text}`).join("\n\n").slice(0, MAX_TOTAL_CHARS);

    // Konteks form: field yang tersedia + opsi select-nya
    let formContext = [];
    try {
      const seen = new Set();
      formContext = window.SNAI.formfill
        .collectFields()
        .filter((f) => f.type !== "checkbox" && f.type !== "radio")
        .filter((f) => !seen.has(f.label) || seen.add(f.label))
        .slice(0, 60)
        .map((f) => ({ label: f.label, type: f.type, options: f.options }));
    } catch {}

    console.info(`[SRIKANDI Naskah AI] analyze: ${S.files.length} file, ${formContext.length} field form sebagai konteks`);
    const resp = await chrome.runtime.sendMessage({ type: "srikandi:analyze", text: total, formContext });
    console.info("[SRIKANDI Naskah AI] hasil AI:", resp?.ok ? resp.fields : resp);
    if (!resp || !resp.ok) {
      setState("error");
      setStatus("Analisis gagal.", "error");
      showError(resp?.error || "Terjadi kesalahan yang tidak diketahui.");
      return;
    }
    S.fields = resp.fields;
    setState("ready");
    const nonEmpty = Object.values(S.fields).filter((v) => v !== null && v !== "" && (!Array.isArray(v) || v.length)).length;
    setStatus(`Selesai (${resp.model}). ${nonEmpty} field terdeteksi — mengisi form otomatis…`, "busy");
    renderResult();
    R.result.classList.remove("snai-hidden");
    // Pengisian otomatis setelah analisis (tombol tetap ada untuk pengulangan
    // setelah mengedit nilai di panel).
    setTimeout(() => applyToForm(), 400);
  }

  let applying = false;
  async function applyToForm() {
    if (applying) return;
    applying = true;
    if (R.btnApply) R.btnApply.disabled = true;
    setStatus("Mengisi form otomatis…", "busy");
    // Gabung hasil AI + editan user di panel
    const merged = { ...(S.fields || {}) };
    R.result.querySelectorAll("[data-snai-key]").forEach((input) => {
      const key = input.dataset.snaiKey;
      const v = (input.value || "").trim();
      merged[key] = v === "" ? null : v;
    });

    try {
      const res = await window.SNAI.formfill.applyFields(merged);
      console.info("[SRIKANDI Naskah AI] hasil pengisian:", res);

      // Lampirkan file: file pertama → slot "File naskah", sisanya → "Lampiran"
      const fileNotes = [];
      try {
        const inputs = window.SNAI.formfill.collectFileInputs();
        const naskahFile = S.files[0]?.file;
        let naskahAttached = false;
        if (naskahFile && inputs.naskah && window.SNAI.formfill.setFiles(inputs.naskah, [naskahFile])) {
          naskahAttached = true;
          fileNotes.push(`file naskah: ${naskahFile.name}`);
        } else if (S.files[0]) {
          fileNotes.push("file naskah tidak bisa dilampirkan");
        }
        const lampFiles = S.files.slice(1).map((f) => f.file).filter(Boolean);
        if (lampFiles.length) {
          if (inputs.lampiran && window.SNAI.formfill.setFiles(inputs.lampiran, lampFiles)) {
            fileNotes.push(`lampiran: ${lampFiles.map((f) => f.name).join(", ")}`);
          } else {
            fileNotes.push("lampiran tidak bisa dilampirkan");
          }
        }
      } catch (e) {
        console.warn("[SRIKANDI Naskah AI] lampirkan file gagal:", e);
      }

      if (res.filled.length || fileNotes.length) {
        const parts = [];
        if (res.filled.length) parts.push(`${res.filled.length} field terisi`);
        if (fileNotes.length) parts.push(fileNotes.join(" • "));
        const unmet = res.notFound.length + res.failed.length;
        toast(
          `✔ ${parts.join(" | ")}${unmet ? ` — ${unmet} field tidak cocok di halaman` : ""}. Periksa lalu simpan form.`
        );
        setStatus(`Form diisi: ${res.filled.map((f) => f.key).join(", ") || "file"}`, "ok");
      } else {
        toast("Tidak ada field yang terisi — tidak ada kecocokan label. Perbaiki nilai lalu ulangi.");
        setStatus("Tidak ada field yang cocok di halaman ini.", "error");
      }
      const detail = [...res.notFound, ...res.failed];
      if (detail.length) {
        console.info("[SRIKANDI Naskah AI] field tidak terisi:", detail);
        toast2(`Tidak cocok di halaman: ${detail.map((d) => d.key).join(", ")}`);
      }
    } catch (err) {
      console.error("[SRIKANDI Naskah AI] apply gagal:", err);
      toast("Gagal mengisi form: " + (err?.message || String(err)));
      setStatus("Gagal mengisi form.", "error");
    } finally {
      applying = false;
      setState(S.state);
    }
  }

  function toast2(msg) {
    setTimeout(() => toast(msg), 3500);
  }

  /* ------------------------------ init ------------------------------ */

  function openOptions() {
    chrome.runtime.openOptionsPage();
  }

  async function init() {
    await loadSettings();
    pdfjsWorkerSetup();
    buildUI();
    setPanelOpen(true);
    host.classList.toggle("snai-hidden", !isTargetPage());

    // Ikuti navigasi SPA: cek path setiap 1 detik
    setInterval(() => {
      if (host && !isTargetPage()) host.classList.add("snai-hidden");
      else if (host) host.classList.remove("snai-hidden");
    }, 1000);

    // Toggle dari ikon extension
    chrome.runtime.onMessage.addListener((msg) => {
      if (msg?.type === "srikandi:toggle") setPanelOpen(!S.panelOpen);
    });

    // Setting berubah (mis. pageMatch) → muat ulang
    chrome.storage.onChanged.addListener((_changes, _area) => loadSettings());
  }

  function pdfjsWorkerSetup() {
    try {
      window.pdfjsLib.GlobalWorkerOptions.workerSrc = chrome.runtime.getURL("lib/pdf.worker.min.js");
    } catch {}
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", () => init().catch(console.error));
  } else {
    init().catch((e) => console.error("[SRIKANDI Naskah AI] init gagal:", e));
  }
})();
