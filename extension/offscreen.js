"use strict";

const state = {
  audio: null,
  abortController: null,
  currentUrl: null,
  requestId: null,
  tabId: null,
};

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  void sender;
  if (message?.type !== "NUVOREAD_OFFSCREEN_COMMAND") {
    return false;
  }

  handleCommand(message);
  sendResponse({ ok: true });
  return false;
});

function handleCommand(message) {
  if (message.command === "NUVOREAD_PLAY") {
    void playSpeech(message);
    return;
  }

  if (message.requestId !== state.requestId) {
    return;
  }

  if (message.command === "NUVOREAD_PAUSE") {
    state.audio?.pause();
    return;
  }

  if (message.command === "NUVOREAD_RESUME") {
    state.audio?.play().catch((error) => {
      emit("error", {
        error: error?.message || "Audio playback failed",
        phase: "playback",
      });
    });
    return;
  }

  if (message.command === "NUVOREAD_STOP") {
    stopCurrentPlayback();
  }
}

async function playSpeech(message) {
  stopCurrentPlayback();
  state.requestId = message.requestId;
  state.tabId = message.tabId;
  state.abortController = new AbortController();

  const audio = new Audio();
  audio.preload = "auto";
  state.audio = audio;

  audio.onloadedmetadata = () => {
    emit("loadedmetadata", {
      currentTime: audio.currentTime,
      duration: audio.duration,
    });
  };
  audio.ontimeupdate = () => {
    emit("timeupdate", {
      currentTime: audio.currentTime,
      duration: audio.duration,
    });
  };
  audio.onended = () => {
    emit("ended", {
      currentTime: audio.currentTime,
      duration: audio.duration,
    });
    stopCurrentPlayback();
  };
  audio.onerror = () => {
    emit("error", {
      error: "Audio playback failed",
      phase: "playback",
    });
    stopCurrentPlayback();
  };

  try {
    const response = await fetch(message.endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      signal: state.abortController.signal,
      body: JSON.stringify(message.payload),
    });

    if (!isCurrentRequest(message)) {
      return;
    }

    if (!response.ok) {
      emit("error", {
        error: `TTS failed: ${response.status}`,
        phase: "request",
        status: response.status,
      });
      stopCurrentPlayback();
      return;
    }

    const blob = await response.blob();
    if (!isCurrentRequest(message)) {
      return;
    }

    if (!blob.size) {
      emit("error", {
        error: "TTS returned empty audio",
        phase: "request",
      });
      stopCurrentPlayback();
      return;
    }

    state.currentUrl = URL.createObjectURL(blob);
    audio.src = state.currentUrl;
    audio.load();
    await audio.play();
  } catch (error) {
    if (!isCurrentRequest(message)) {
      return;
    }
    if (error?.name === "AbortError") {
      return;
    }
    emit("error", {
      error: error?.message || "Audio playback failed",
      phase: error?.phase || "playback",
    });
    stopCurrentPlayback();
  }
}

function isCurrentRequest(message) {
  return state.requestId === message.requestId;
}

function emit(event, data = {}) {
  chrome.runtime.sendMessage({
    type: "NUVOREAD_OFFSCREEN_EVENT",
    tabId: state.tabId,
    requestId: state.requestId,
    event,
    ...data,
  });
}

function stopCurrentPlayback() {
  state.abortController?.abort();
  state.abortController = null;

  if (state.audio) {
    state.audio.pause();
    state.audio.removeAttribute("src");
    state.audio.load();
    state.audio = null;
  }

  if (state.currentUrl) {
    URL.revokeObjectURL(state.currentUrl);
    state.currentUrl = null;
  }

  state.requestId = null;
  state.tabId = null;
}
