"use strict";

const OFFSCREEN_DOCUMENT = "offscreen.html";
const OFFSCREEN_URL = chrome.runtime.getURL(OFFSCREEN_DOCUMENT);
const CONTENT_COMMANDS = new Set([
  "NUVOREAD_PLAY",
  "NUVOREAD_PAUSE",
  "NUVOREAD_RESUME",
  "NUVOREAD_STOP",
]);

let creatingOffscreenDocument = null;

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type === "NUVOREAD_OFFSCREEN_EVENT") {
    forwardAudioEvent(message);
    sendResponse({ ok: true });
    return false;
  }

  if (!CONTENT_COMMANDS.has(message?.type)) {
    return false;
  }

  handleContentCommand(message, sender)
    .then(() => sendResponse({ ok: true }))
    .catch((error) => {
      sendResponse({
        ok: false,
        error: error?.message || "Audio playback command failed",
        phase: "playback",
      });
    });
  return true;
});

async function handleContentCommand(message, sender) {
  await ensureOffscreenDocument();
  await chrome.runtime.sendMessage({
    type: "NUVOREAD_OFFSCREEN_COMMAND",
    command: message.type,
    tabId: sender.tab?.id,
    requestId: message.requestId,
    endpoint: message.endpoint,
    payload: message.payload,
  });
}

async function ensureOffscreenDocument() {
  if (await hasOffscreenDocument()) {
    return;
  }

  if (!creatingOffscreenDocument) {
    creatingOffscreenDocument = chrome.offscreen
      .createDocument({
        url: OFFSCREEN_DOCUMENT,
        reasons: ["AUDIO_PLAYBACK"],
        justification:
          "Play generated text-to-speech audio outside page CSP restrictions.",
      })
      .finally(() => {
        creatingOffscreenDocument = null;
      });
  }

  await creatingOffscreenDocument;
}

async function hasOffscreenDocument() {
  if (!chrome.runtime.getContexts) {
    return false;
  }

  const contexts = await chrome.runtime.getContexts({
    contextTypes: ["OFFSCREEN_DOCUMENT"],
    documentUrls: [OFFSCREEN_URL],
  });
  return contexts.length > 0;
}

function forwardAudioEvent(message) {
  if (typeof message.tabId !== "number") {
    return;
  }

  chrome.tabs.sendMessage(message.tabId, {
    type: "NUVOREAD_AUDIO_EVENT",
    requestId: message.requestId,
    event: message.event,
    currentTime: message.currentTime,
    duration: message.duration,
    error: message.error,
    phase: message.phase,
    status: message.status,
  }, () => {
    void chrome.runtime.lastError;
  });
}
