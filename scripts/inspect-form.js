/**
 * Field inspector SRIKANDI — jalankan di DevTools Console (F12 → Console)
 * pada halaman Registrasi Naskah Keluar (form sudah ter-render).
 *
 * Cara pakai:
 *   1. Buka https://srikandi.arsip.go.id/pembuatan-naskah-keluar/registrasi-naskah-keluar
 *   2. F12 → tab Console
 *   3. Tempel seluruh isi file ini, Enter.
 *   4. Copy output JSON (ada di `window.__SNAPSHOT` dan tercetak di console).
 *   5. Kirimkan JSON-nya (dan daftar IFRAME bila ada) ke Claude.
 *
 * Snapshot ini meniru apa yang dilihat extension (label + type + opsi select)
 * ditambah atribut name/id/placeholder untuk pencocokan yang lebih andal.
 */
(() => {
  const norm = (s) =>
    (s || "")
      .toLowerCase()
      .normalize("NFD")
      .replace(/[̀-ͯ]/g, "")
      .replace(/\s+/g, " ")
      .trim();

  const isVisible = (el) => {
    const st = getComputedStyle(el);
    if (st.display === "none" || st.visibility === "hidden") return false;
    const r = el.getBoundingClientRect();
    return !(r.width === 0 && r.height === 0);
  };

  const labelFor = (el) => {
    if (el.id) {
      const l = document.querySelector(`label[for="${CSS.escape(el.id)}"]`);
      if (l && l.textContent.trim()) return l.textContent.trim();
    }
    const aria = el.getAttribute("aria-label");
    if (aria && aria.trim()) return aria.trim();
    const wrap = el.closest("label");
    if (wrap && wrap.textContent.trim()) return wrap.textContent.trim();
    const row = el.closest("tr");
    if (row) {
      const th = row.querySelector("th[scope='row'], th, .label, [class*='label']");
      if (th && th.textContent.trim()) return th.textContent.trim().slice(0, 120);
    }
    // Komponen custom (react-select / MUI): label sibling sebelum container,
    // atau label pertama di container MuiGrid/form-group
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
    const name = el.getAttribute("name");
    const ph = el.getAttribute("placeholder");
    return [name, ph].filter(Boolean).join(" | ");
  };

  const fields = [];
  document.querySelectorAll("input, textarea, select").forEach((el) => {
    const t = el.type;
    if (["hidden", "file", "submit", "button", "reset", "image"].includes(t)) return;
    if (!isVisible(el) || el.disabled || el.readOnly) return;
    const rawLabel = labelFor(el);
    const entry = {
      tag: el.tagName.toLowerCase(),
      type: el.tagName === "SELECT" ? "select" : el.tagName === "TEXTAREA" ? "textarea" : t || "text",
      label: norm(rawLabel),
      rawLabel,
      id: el.id || null,
      name: el.getAttribute("name") || null,
      placeholder: el.getAttribute("placeholder") || null,
      reactSelect: !!(el.id && el.id.startsWith("react-select-")) || el.getAttribute("role") === "combobox",
    };
    if (el.tagName === "SELECT") {
      entry.options = Array.from(el.options)
        .filter((o) => o.value !== "" && o.textContent.trim() !== "")
        .map((o) => o.textContent.trim())
        .slice(0, 40);
    }
    fields.push(entry);
  });

  const iframes = Array.from(document.querySelectorAll("iframe")).map((f) => ({
    src: f.src || "(tanpa src)",
    sameOrigin: (() => {
      try {
        void f.contentDocument;
        return true;
      } catch {
        return false;
      }
    })(),
  }));

  const snapshot = {
    url: location.href,
    formCount: document.querySelectorAll("form").length,
    fields,
    iframes,
  };
  window.__SNAPSHOT = snapshot;

  console.log(`%c== FIELD INSPECTOR == ${fields.length} field, ${snapshot.formCount} form`, "font-weight:bold");
  if (iframes.length) console.log("IFRAMES:", iframes);
  console.table(fields.map((f) => ({ label: f.rawLabel, type: f.type, name: f.name, id: f.id, placeholder: f.placeholder })));
  console.log("JSON (copy ini):");
  console.log(JSON.stringify(snapshot, null, 2));
  return snapshot;
})();
