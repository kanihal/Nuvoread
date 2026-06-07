(() => {
  "use strict";

  const DEFAULT_SERVER_BASE_URL = "http://127.0.0.1:9876";
  const SERVER_STORAGE_KEY = "mlxTtsServerBaseUrl";

  const input = document.getElementById("server-url");
  const save = document.getElementById("save");
  const reset = document.getElementById("reset");
  const status = document.getElementById("status");

  chrome.storage.local.get(
    { [SERVER_STORAGE_KEY]: DEFAULT_SERVER_BASE_URL },
    (items) => {
      input.value = normalizeServerBaseUrl(items[SERVER_STORAGE_KEY]);
    }
  );

  save.addEventListener("click", saveServerUrl);
  reset.addEventListener("click", () => {
    input.value = DEFAULT_SERVER_BASE_URL;
    saveServerUrl();
  });
  input.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      saveServerUrl();
    }
  });

  function saveServerUrl() {
    const value = normalizeServerBaseUrl(input.value);
    input.value = value;
    chrome.storage.local.set({ [SERVER_STORAGE_KEY]: value }, () => {
      status.textContent = "Saved";
      window.setTimeout(() => {
        status.textContent = "";
      }, 1800);
    });
  }

  function normalizeServerBaseUrl(value) {
    const raw = String(value || DEFAULT_SERVER_BASE_URL).trim();
    const withoutEndpoint = raw.replace(/\/v1\/audio\/speech\/?$/i, "");
    return withoutEndpoint.replace(/\/+$/, "") || DEFAULT_SERVER_BASE_URL;
  }
})();
