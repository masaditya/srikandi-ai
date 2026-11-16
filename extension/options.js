/* SRIKANDI Naskah AI — options.js */
(() => {
  "use strict";

  const DEFAULTS = {
    provider: "openai",
    anthropic: { apiKey: "", baseUrl: "https://api.anthropic.com", model: "claude-opus-5-5" },
    openai: {
      // Preset Kenari (endpoint OpenAI-compatible)
      apiKey: "kn-9f709535c9db26a167f922c852000bb3f70a6f37843b5389",
      baseUrl: "https://kenari.id/v1",
      model: "deepseek-v4-1-flash",
    },
    pageMatch: "registrasi-naskah-keluar",
  };

  const $ = (id) => document.getElementById(id);

  function mergeCfg(saved, def) {
    const out = {};
    for (const k of Object.keys(def)) {
      out[k] = saved && typeof saved[k] === "string" && saved[k] !== "" ? saved[k] : def[k];
    }
    return out;
  }

  function showMsg(text, ok) {
    const m = $("save-msg");
    m.textContent = text;
    m.className = ok ? "ok" : "err";
  }

  function currentProvider() {
    return $("provider").value;
  }

  function syncProviderVisibility() {
    $("body-anthropic").classList.toggle("active", currentProvider() === "anthropic");
    $("body-openai").classList.toggle("active", currentProvider() === "openai");
  }

  async function load() {
    const stored = await chrome.storage.local.get({});
    const p = {
      provider: stored.provider || DEFAULTS.provider,
      anthropic: mergeCfg(stored.anthropic, DEFAULTS.anthropic),
      openai: mergeCfg(stored.openai, DEFAULTS.openai),
      pageMatch: typeof stored.pageMatch === "string" && stored.pageMatch !== "" ? stored.pageMatch : DEFAULTS.pageMatch,
    };
    $("provider").value = p.provider;
    $("anthropic-key").value = p.anthropic.apiKey;
    $("anthropic-model").value = p.anthropic.model;
    $("anthropic-baseurl").value = p.anthropic.baseUrl;
    $("openai-key").value = p.openai.apiKey;
    $("openai-baseurl").value = p.openai.baseUrl;
    $("openai-model").value = p.openai.model;
    $("page-match").value = p.pageMatch;
    syncProviderVisibility();
  }

  function collect() {
    return {
      provider: currentProvider(),
      anthropic: {
        apiKey: $("anthropic-key").value.trim(),
        baseUrl: $("anthropic-baseurl").value.trim() || DEFAULTS.anthropic.baseUrl,
        model: $("anthropic-model").value.trim() || DEFAULTS.anthropic.model,
      },
      openai: {
        apiKey: $("openai-key").value.trim(),
        baseUrl: $("openai-baseurl").value.trim() || DEFAULTS.openai.baseUrl,
        model: $("openai-model").value.trim() || DEFAULTS.openai.model,
      },
      pageMatch: $("page-match").value.trim() || DEFAULTS.pageMatch,
    };
  }

  $("provider").addEventListener("change", syncProviderVisibility);

  $("btn-save").addEventListener("click", async () => {
    await chrome.storage.local.set(collect());
    showMsg("Tersimpan ✔", true);
  });

  $("btn-test").addEventListener("click", async () => {
    // Simpan dulu agar pengujian memakai nilai terbaru
    await chrome.storage.local.set(collect());
    showMsg("Menguji…", true);
    try {
      const resp = await chrome.runtime.sendMessage({ type: "srikandi:test" });
      if (resp?.ok) showMsg(`Terhubung ✔ (${resp.model})`, true);
      else showMsg(resp?.error || "Gagal terhubung", false);
    } catch (err) {
      showMsg(err.message || String(err), false);
    }
  });

  load().catch((e) => console.error(e));
})();
