(() => {
  "use strict";

  const DEFAULT_SERVER_BASE_URL = "http://127.0.0.1:9876";
  const SERVER_STORAGE_KEY = "mlxTtsServerBaseUrl";
  const WORD_HIGHLIGHT_STORAGE_KEY = "mlxTtsWordHighlightEnabled";

  const input = document.getElementById("server-url");
  const wordHighlight = document.getElementById("word-highlight");
  const save = document.getElementById("save");
  const reset = document.getElementById("reset");
  const status = document.getElementById("status");

  chrome.storage.local.get(
    {
      [SERVER_STORAGE_KEY]: DEFAULT_SERVER_BASE_URL,
      [WORD_HIGHLIGHT_STORAGE_KEY]: false,
    },
    (items) => {
      input.value = normalizeServerBaseUrl(items[SERVER_STORAGE_KEY]);
      wordHighlight.checked = Boolean(items[WORD_HIGHLIGHT_STORAGE_KEY]);
    }
  );

  save.addEventListener("click", saveSettings);
  reset.addEventListener("click", () => {
    input.value = DEFAULT_SERVER_BASE_URL;
    wordHighlight.checked = false;
    saveSettings();
  });
  input.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      saveSettings();
    }
  });

  function saveSettings() {
    const value = normalizeServerBaseUrl(input.value);
    input.value = value;
    chrome.storage.local.set(
      {
        [SERVER_STORAGE_KEY]: value,
        [WORD_HIGHLIGHT_STORAGE_KEY]: wordHighlight.checked,
      },
      () => {
        status.textContent = "Saved";
        window.setTimeout(() => {
          status.textContent = "";
        }, 1800);
      }
    );
  }

  function normalizeServerBaseUrl(value) {
    const raw = String(value || DEFAULT_SERVER_BASE_URL).trim();
    const withoutEndpoint = raw.replace(/\/v1\/audio\/speech\/?$/i, "");
    return withoutEndpoint.replace(/\/+$/, "") || DEFAULT_SERVER_BASE_URL;
  }
})();
