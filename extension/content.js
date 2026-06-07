(() => {
  "use strict";

  const ROOT_ID = "mlx-tts-reader";
  const SENTENCE_HIGHLIGHT = "mlx-tts-sentence";
  const WORD_HIGHLIGHT = "mlx-tts-word";
  const DEFAULT_SERVER_BASE_URL = "http://127.0.0.1:9876";
  const MODEL = "mlx-community/Kokoro-82M-bf16";
  const VOICE = "af_heart";
  const SPEEDS = [1, 1.25, 1.5, 1.75, 2];
  const DEFAULT_SPEED = 1.25;
  const SENTENCE_SCROLL_TOP_OFFSET = 80;
  const SPEED_STORAGE_KEY = "mlxTtsSpeed";
  const SERVER_STORAGE_KEY = "mlxTtsServerBaseUrl";
  const WORD_HIGHLIGHT_STORAGE_KEY = "mlxTtsWordHighlightEnabled";
  const SKIP_TAGS = new Set([
    "SCRIPT",
    "STYLE",
    "NOSCRIPT",
    "IFRAME",
    "OBJECT",
    "CANVAS",
    "SVG",
    "TEXTAREA",
    "INPUT",
    "SELECT",
    "OPTION",
  ]);
  const WORD_PATTERN = /[\p{L}\p{M}\p{N}]+(?:['’\-][\p{L}\p{M}\p{N}]+)*/gu;

  const state = {
    speed: DEFAULT_SPEED,
    serverBaseUrl: DEFAULT_SERVER_BASE_URL,
    sentences: [],
    index: 0,
    audio: null,
    currentUrl: null,
    controller: null,
    prefetch: null,
    stopped: true,
    paused: false,
    playing: false,
    lastRange: null,
    activeWordIndex: -1,
    highlightFrame: null,
    speedPopoverOpen: false,
    wordHighlightEnabled: false,
  };

  const elements = injectPlayer();
  document.addEventListener("selectionchange", rememberSelection);
  document.addEventListener("mousedown", handleDocumentMouseDown);
  document.addEventListener("dblclick", handleDocumentDoubleClick);
  window.addEventListener("pagehide", () => clearAllHighlights());
  loadSettings();
  chrome?.storage?.onChanged?.addListener(handleStorageChange);
  setStatus("Idle");
  updateButtons();

  function injectPlayer() {
    const existing = document.getElementById(ROOT_ID);
    if (existing) {
      existing.remove();
    }

    const root = document.createElement("div");
    root.id = ROOT_ID;
    root.setAttribute("role", "group");
    root.setAttribute("aria-label", "Local MLX text to speech reader");
    root.innerHTML = `
      <div class="mlx-tts-pill">
        <span class="mlx-tts-status" data-role="status" title="Idle">Idle</span>
        <button type="button" class="mlx-tts-primary" data-action="play" title="Play" aria-label="Play">
          <span class="mlx-tts-play-icon" aria-hidden="true"></span>
          <span class="mlx-tts-pause-icon" aria-hidden="true"></span>
        </button>
        <button type="button" class="mlx-tts-speed-chip" data-action="speed-menu" title="Speech speed">1.25x</button>
      </div>
      <div class="mlx-tts-speed-popover" data-role="speed-popover" hidden>
        <div class="mlx-tts-speed-grid">
          ${SPEEDS.map((speed) => `<button type="button" class="mlx-tts-speed" data-speed="${speed}">${formatSpeed(speed)}x</button>`).join("")}
        </div>
        <div class="mlx-tts-custom-speed">
          <span>Custom</span>
          <input type="number" data-role="custom-speed" min="0.5" max="3" step="0.05" inputmode="decimal" />
          <button type="button" data-action="set-speed">Set</button>
        </div>
      </div>
    `;

    document.documentElement.appendChild(root);
    root.addEventListener("mousedown", (event) => {
      if (!event.target.closest("input")) {
        event.preventDefault();
      }
    });
    root.addEventListener("click", handlePlayerClick);
    root.querySelector('[data-role="custom-speed"]').addEventListener("keydown", handleCustomSpeedKey);

    return {
      root,
      play: root.querySelector('[data-action="play"]'),
      status: root.querySelector('[data-role="status"]'),
      speedChip: root.querySelector('[data-action="speed-menu"]'),
      speedPopover: root.querySelector('[data-role="speed-popover"]'),
      customSpeed: root.querySelector('[data-role="custom-speed"]'),
      speedButtons: Array.from(root.querySelectorAll("[data-speed]")),
    };
  }

  function loadSettings() {
    if (!chrome?.storage?.local) {
      setSpeed(DEFAULT_SPEED);
      state.serverBaseUrl = DEFAULT_SERVER_BASE_URL;
      return;
    }

    chrome.storage.local.get(
      {
        [SPEED_STORAGE_KEY]: DEFAULT_SPEED,
        [SERVER_STORAGE_KEY]: DEFAULT_SERVER_BASE_URL,
        [WORD_HIGHLIGHT_STORAGE_KEY]: false,
      },
      (items) => {
        const saved = Number(items[SPEED_STORAGE_KEY]);
        setSpeed(Number.isFinite(saved) ? saved : DEFAULT_SPEED, false);
        state.serverBaseUrl = normalizeServerBaseUrl(items[SERVER_STORAGE_KEY]);
        state.wordHighlightEnabled = Boolean(items[WORD_HIGHLIGHT_STORAGE_KEY]);
      }
    );
  }

  function handleStorageChange(changes, areaName) {
    if (areaName !== "local") {
      return;
    }
    if (changes[SERVER_STORAGE_KEY]) {
      state.serverBaseUrl = normalizeServerBaseUrl(changes[SERVER_STORAGE_KEY].newValue);
    }
    if (changes[SPEED_STORAGE_KEY]) {
      const nextSpeed = Number(changes[SPEED_STORAGE_KEY].newValue);
      if (nextSpeed !== state.speed) {
        setSpeed(nextSpeed, false);
      }
    }
    if (changes[WORD_HIGHLIGHT_STORAGE_KEY]) {
      state.wordHighlightEnabled = Boolean(changes[WORD_HIGHLIGHT_STORAGE_KEY].newValue);
      if (!state.wordHighlightEnabled) {
        clearWordHighlight();
      }
    }
  }

  function handlePlayerClick(event) {
    const button = event.target.closest("button");
    if (!button || !elements.root.contains(button)) {
      return;
    }

    const action = button.dataset.action;
    if (action === "play") {
      if (state.stopped) {
        void playFromSelection();
      } else {
        togglePause();
      }
      return;
    }
    if (action === "speed-menu") {
      setSpeedPopover(!state.speedPopoverOpen);
      return;
    }
    if (action === "set-speed") {
      applyCustomSpeed();
      setSpeedPopover(false);
      return;
    }
    if (button.dataset.speed) {
      setSpeed(Number(button.dataset.speed));
      setSpeedPopover(false);
    }
  }

  function setSpeed(speed, persist = true) {
    state.speed = clampSpeed(speed);
    elements.speedButtons.forEach((button) => {
      button.dataset.active = String(Number(button.dataset.speed) === state.speed);
    });
    elements.speedChip.textContent = `${formatSpeed(state.speed)}x`;
    elements.speedChip.title = `Speech speed ${formatSpeed(state.speed)}x`;
    elements.customSpeed.value = formatSpeed(state.speed);
    if (persist) {
      chrome?.storage?.local?.set({ [SPEED_STORAGE_KEY]: state.speed });
    }
    if (state.prefetch && state.prefetch.speed !== state.speed) {
      state.prefetch.controller.abort();
      state.prefetch.promise.catch(() => {});
      state.prefetch = null;
    }
  }

  function handleCustomSpeedKey(event) {
    if (event.key === "Enter") {
      applyCustomSpeed();
      setSpeedPopover(false);
      elements.speedChip.focus();
    }
    if (event.key === "Escape") {
      setSpeedPopover(false);
      elements.speedChip.focus();
    }
  }

  function applyCustomSpeed() {
    if (!elements.customSpeed.value) {
      elements.customSpeed.value = formatSpeed(state.speed);
      return;
    }
    setSpeed(Number(elements.customSpeed.value));
  }

  function handleDocumentMouseDown(event) {
    if (!state.speedPopoverOpen || elements.root.contains(event.target)) {
      return;
    }
    setSpeedPopover(false);
  }

  function handleDocumentDoubleClick(event) {
    if (state.stopped || !state.playing || elements.root.contains(event.target)) {
      return;
    }

    setTimeout(() => {
      if (state.stopped || !state.playing || !hasReadablePageSelection()) {
        return;
      }

      rememberSelection();
      void playFromSelection();
    }, 0);
  }

  function hasReadablePageSelection() {
    const selection = window.getSelection();
    if (!selection || selection.rangeCount === 0 || selection.isCollapsed) {
      return false;
    }

    const range = selection.getRangeAt(0);
    const container = range.commonAncestorContainer;
    const element =
      container.nodeType === Node.ELEMENT_NODE ? container : container.parentElement;
    if (element && elements.root.contains(element)) {
      return false;
    }

    const start = getStartPosition(range);
    return Boolean(start && isReadableTextNode(start.node));
  }

  function setSpeedPopover(open) {
    state.speedPopoverOpen = open;
    elements.speedPopover.hidden = !open;
    elements.speedChip.dataset.active = String(open);
    elements.speedChip.setAttribute("aria-expanded", String(open));
    if (open) {
      elements.customSpeed.value = formatSpeed(state.speed);
    }
  }

  function clampSpeed(speed) {
    const numeric = Number.isFinite(speed) ? speed : DEFAULT_SPEED;
    return Math.min(3, Math.max(0.5, Math.round(numeric * 100) / 100));
  }

  function formatSpeed(speed) {
    return Number(speed).toFixed(2).replace(/\.?0+$/, "");
  }

  function normalizeServerBaseUrl(value) {
    const raw = String(value || DEFAULT_SERVER_BASE_URL).trim();
    const withoutEndpoint = raw.replace(/\/v1\/audio\/speech\/?$/i, "");
    return withoutEndpoint.replace(/\/+$/, "") || DEFAULT_SERVER_BASE_URL;
  }

  function getSpeechEndpoint() {
    return `${normalizeServerBaseUrl(state.serverBaseUrl)}/v1/audio/speech`;
  }

  async function playFromSelection() {
    const sentences = buildSentenceQueueFromSelection();
    if (!sentences.length) {
      setStatus("Select a word first");
      return;
    }

    stopPlayback("Loading");
    state.sentences = sentences;
    state.index = 0;
    state.stopped = false;
    state.paused = false;
    state.playing = true;
    setCurrentSentence("Loading", state.sentences[0]);
    updateButtons();

    await playQueue();
  }

  async function playQueue() {
    while (!state.stopped && state.index < state.sentences.length) {
      try {
        setCurrentSentence("Loading", state.sentences[state.index]);
        const blob = await getCurrentAudioBlob();
        if (state.stopped) {
          break;
        }

        prefetchNext();
        await playBlob(blob, state.sentences[state.index]);
        revokeCurrentUrl();
        state.index += 1;
      } catch (error) {
        if (state.stopped || error.name === "AbortError") {
          break;
        }
        console.error("MLX TTS playback failed", error);
        setStatus("Server unavailable");
        state.playing = false;
        updateButtons();
        return;
      }
    }

    if (!state.stopped) {
      stopPlayback("Idle");
    }
  }

  async function getCurrentAudioBlob() {
    if (
      state.prefetch &&
      state.prefetch.index === state.index &&
      state.prefetch.speed === state.speed
    ) {
      const prefetch = state.prefetch;
      state.prefetch = null;
      return prefetch.promise;
    }
    return fetchSpeechBlob(state.sentences[state.index].text, state.speed);
  }

  function prefetchNext() {
    const nextIndex = state.index + 1;
    if (nextIndex >= state.sentences.length || state.prefetch?.index === nextIndex) {
      return;
    }

    const request = createSpeechRequest(state.sentences[nextIndex].text, state.speed);
    request.promise.catch(() => {});
    state.prefetch = {
      index: nextIndex,
      speed: state.speed,
      ...request,
    };
  }

  function createSpeechRequest(text, speed) {
    const controller = new AbortController();
    state.controller = controller;

    const promise = fetch(getSpeechEndpoint(), {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      signal: controller.signal,
      body: JSON.stringify({
        model: MODEL,
        input: text,
        voice: VOICE,
        response_format: "mp3",
        speed,
        stream: true,
        streaming_interval: 0.5,
      }),
    }).then(async (response) => {
      if (!response.ok) {
        throw new Error(`TTS failed: ${response.status}`);
      }

      const blob = await response.blob();
      if (!blob.size) {
        throw new Error("TTS returned empty audio");
      }
      return blob;
    });

    return { controller, promise };
  }

  function fetchSpeechBlob(text, speed) {
    return createSpeechRequest(text, speed).promise;
  }

  function playBlob(blob, sentence) {
    return new Promise((resolve, reject) => {
      revokeCurrentUrl();
      clearPlaybackTimer();

      const url = URL.createObjectURL(blob);
      const audio = new Audio(url);

      state.currentUrl = url;
      state.audio = audio;
      state.paused = false;
      state.activeWordIndex = -1;

      audio.addEventListener("loadedmetadata", () => {
        highlightSentence(sentence);
        updateWordHighlight(sentence, audio);
        startHighlightLoop(sentence, audio);
      }, { once: true });
      audio.addEventListener("timeupdate", () => updateWordHighlight(sentence, audio));
      audio.addEventListener("ended", () => {
        clearPlaybackTimer();
        resolve();
      }, { once: true });
      audio.addEventListener("error", () => reject(new Error("Audio playback failed")), {
        once: true,
      });

      setCurrentSentence("Playing", sentence);
      updateButtons();
      audio.play().catch(reject);
    });
  }

  function togglePause() {
    if (!state.audio || state.stopped) {
      return;
    }

    if (state.audio.paused) {
      state.audio.play();
      state.paused = false;
      state.playing = true;
      const sentence = state.sentences[state.index];
      if (sentence) {
        startHighlightLoop(sentence, state.audio);
      }
      setCurrentSentence("Playing", sentence);
    } else {
      state.audio.pause();
      state.paused = true;
      state.playing = true;
      clearPlaybackTimer();
      setCurrentSentence("Paused", state.sentences[state.index]);
    }
    updateButtons();
  }

  function stopPlayback(status) {
    state.stopped = true;
    state.playing = false;
    state.paused = false;
    state.sentences = [];
    state.index = 0;
    state.activeWordIndex = -1;

    if (state.controller) {
      state.controller.abort();
      state.controller = null;
    }
    if (state.prefetch) {
      state.prefetch.controller.abort();
      state.prefetch.promise.catch(() => {});
      state.prefetch = null;
    }
    if (state.audio) {
      state.audio.pause();
      state.audio.removeAttribute("src");
      state.audio.load();
      state.audio = null;
    }
    revokeCurrentUrl();
    clearPlaybackTimer();
    clearAllHighlights();
    setSpeedPopover(false);

    setStatus(status);
    updateButtons();
  }

  function revokeCurrentUrl() {
    if (state.currentUrl) {
      URL.revokeObjectURL(state.currentUrl);
      state.currentUrl = null;
    }
  }

  function updateButtons() {
    const isActive = !state.stopped && state.playing;
    const isPaused = isActive && state.paused;
    elements.play.dataset.mode = isActive && !isPaused ? "pause" : "play";
    elements.play.title = isPaused ? "Resume" : isActive ? "Pause" : "Play";
    elements.play.setAttribute("aria-label", elements.play.title);
  }

  function setStatus(text) {
    elements.status.textContent = text;
    elements.status.title = text;
  }

  function setCurrentSentence(status, sentence) {
    void sentence;
    void status;
    const progress =
      state.sentences.length > 0
        ? `${formatCount(state.index + 1)}/${formatCount(state.sentences.length)}`
        : "0/0";
    setStatus(progress);
  }

  function formatCount(value) {
    if (value < 1000) {
      return String(value);
    }
    const compact = value / 1000;
    const formatted = compact < 10 ? compact.toFixed(1) : Math.round(compact).toString();
    return `${formatted.replace(/\.0$/, "")}k`;
  }

  function buildSentenceQueueFromSelection() {
    const start = getCurrentPageStartPosition();
    if (!start || !isReadableTextNode(start.node)) {
      return [];
    }

    const textNodes = getReadableTextNodes();
    const startIndex = textNodes.indexOf(start.node);
    if (startIndex === -1) {
      return [];
    }

    const linear = buildLinearText(textNodes.slice(startIndex), start);
    return buildSentenceObjects(linear.text, linear.refs);
  }

  function buildLinearText(textNodes, start) {
    const chars = [];
    const refs = [];

    textNodes.forEach((node) => {
      const raw = node.nodeValue || "";
      const from = node === start.node ? start.offset : 0;
      if (from >= raw.length || !raw.slice(from).trim()) {
        return;
      }

      if (chars.length && chars[chars.length - 1] !== " ") {
        chars.push(" ");
        refs.push(null);
      }

      for (let offset = from; offset < raw.length; offset += 1) {
        chars.push(raw[offset]);
        refs.push({ node, offset });
      }
    });

    return { text: chars.join(""), refs };
  }

  function buildSentenceObjects(text, refs) {
    return getSentenceSegments(text)
      .map((segment) => createSentenceObject(text, refs, segment.start, segment.end))
      .filter((sentence) => sentence && sentence.words.length);
  }

  function getSentenceSegments(text) {
    if (!text.trim()) {
      return [];
    }

    if ("Segmenter" in Intl) {
      const segmenter = new Intl.Segmenter(undefined, { granularity: "sentence" });
      return Array.from(segmenter.segment(text), (part) => ({
        start: part.index,
        end: part.index + part.segment.length,
      }));
    }

    const segments = [];
    const regex = /[^.!?]+[.!?]+(?:\s+|$)|[^.!?]+$/g;
    let match;
    while ((match = regex.exec(text)) !== null) {
      segments.push({ start: match.index, end: match.index + match[0].length });
    }
    return segments;
  }

  function createSentenceObject(text, refs, start, end) {
    const trimmed = trimBounds(text, start, end);
    if (!trimmed) {
      return null;
    }

    const sentenceRange = createRangeFromRefs(refs, trimmed.start, trimmed.end);
    if (!sentenceRange) {
      return null;
    }

    const words = [];
    const segmentText = text.slice(trimmed.start, trimmed.end);
    let match;
    WORD_PATTERN.lastIndex = 0;
    while ((match = WORD_PATTERN.exec(segmentText)) !== null) {
      const wordStart = trimmed.start + match.index;
      const wordEnd = wordStart + match[0].length;
      const range = createRangeFromRefs(refs, wordStart, wordEnd);
      if (range) {
        words.push({ text: match[0], range });
      }
    }

    return {
      text: text.slice(trimmed.start, trimmed.end).replace(/\s+/g, " ").trim(),
      range: sentenceRange,
      words,
    };
  }

  function trimBounds(text, start, end) {
    let trimmedStart = start;
    let trimmedEnd = end;

    while (trimmedStart < trimmedEnd && /\s/.test(text[trimmedStart])) {
      trimmedStart += 1;
    }
    while (trimmedEnd > trimmedStart && /\s/.test(text[trimmedEnd - 1])) {
      trimmedEnd -= 1;
    }

    return trimmedStart < trimmedEnd ? { start: trimmedStart, end: trimmedEnd } : null;
  }

  function createRangeFromRefs(refs, start, end) {
    let first = null;
    let last = null;

    for (let index = start; index < end; index += 1) {
      if (!first && refs[index]) {
        first = refs[index];
      }
      if (refs[index]) {
        last = refs[index];
      }
    }

    if (!first || !last) {
      return null;
    }

    try {
      const range = document.createRange();
      range.setStart(first.node, first.offset);
      range.setEnd(last.node, last.offset + 1);
      return range;
    } catch (error) {
      return null;
    }
  }

  function rememberSelection() {
    const selection = window.getSelection();
    if (!selection || selection.rangeCount === 0 || selection.isCollapsed) {
      return;
    }

    const range = selection.getRangeAt(0);
    const container = range.commonAncestorContainer;
    const element =
      container.nodeType === Node.ELEMENT_NODE ? container : container.parentElement;
    if (element && elements.root.contains(element)) {
      return;
    }

    state.lastRange = range.cloneRange();
  }

  function getCurrentPageStartPosition() {
    const selection = window.getSelection();
    if (selection && selection.rangeCount > 0 && !selection.isCollapsed) {
      const range = selection.getRangeAt(0);
      state.lastRange = range.cloneRange();
      return getStartPosition(range);
    }

    return state.lastRange ? getStartPosition(state.lastRange) : null;
  }

  function getStartPosition(range) {
    if (range.startContainer.nodeType === Node.TEXT_NODE) {
      return { node: range.startContainer, offset: range.startOffset };
    }

    const node = findTextNodeFromElementOffset(range.startContainer, range.startOffset);
    return node ? { node, offset: 0 } : null;
  }

  function findTextNodeFromElementOffset(container, offset) {
    const child = container.childNodes?.[offset] || container;
    const walker = document.createTreeWalker(child, NodeFilter.SHOW_TEXT, {
      acceptNode: (node) =>
        isReadableTextNode(node) ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT,
    });

    return child.nodeType === Node.TEXT_NODE && isReadableTextNode(child)
      ? child
      : walker.nextNode();
  }

  function getReadableTextNodes() {
    if (!document.body) {
      return [];
    }

    const nodes = [];
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, {
      acceptNode: (node) =>
        isReadableTextNode(node) ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT,
    });

    let node = walker.nextNode();
    while (node) {
      nodes.push(node);
      node = walker.nextNode();
    }

    return nodes;
  }

  function isReadableTextNode(node) {
    if (!node.nodeValue || !node.nodeValue.trim()) {
      return false;
    }

    let element = node.parentElement;
    while (element) {
      if (element.id === ROOT_ID || SKIP_TAGS.has(element.tagName)) {
        return false;
      }
      if (element.hidden || element.getAttribute("aria-hidden") === "true") {
        return false;
      }

      const style = window.getComputedStyle(element);
      if (
        style.display === "none" ||
        style.visibility === "hidden" ||
        Number(style.opacity) === 0
      ) {
        return false;
      }

      element = element.parentElement;
    }

    return true;
  }

  function startHighlightLoop(sentence, audio) {
    clearPlaybackTimer();

    const tick = () => {
      if (state.stopped || state.paused || audio.paused || audio.ended) {
        state.highlightFrame = null;
        return;
      }
      updateWordHighlight(sentence, audio);
      state.highlightFrame = requestAnimationFrame(tick);
    };

    state.highlightFrame = requestAnimationFrame(tick);
  }

  function clearPlaybackTimer() {
    if (state.highlightFrame) {
      cancelAnimationFrame(state.highlightFrame);
      state.highlightFrame = null;
    }
  }

  function highlightSentence(sentence) {
    scrollRangeIntoView(sentence.range, { alignToTop: true });

    if (!supportsCustomHighlights()) {
      return;
    }

    CSS.highlights.set(SENTENCE_HIGHLIGHT, new Highlight(sentence.range));
    clearWordHighlight();
  }

  function updateWordHighlight(sentence, audio) {
    if (
      !state.wordHighlightEnabled ||
      !supportsCustomHighlights() ||
      !sentence.words.length ||
      !Number.isFinite(audio.duration)
    ) {
      return;
    }

    const rawIndex = Math.floor((audio.currentTime / audio.duration) * sentence.words.length);
    const wordIndex = Math.min(sentence.words.length - 1, Math.max(0, rawIndex));
    if (wordIndex === state.activeWordIndex) {
      return;
    }

    state.activeWordIndex = wordIndex;
    const word = sentence.words[wordIndex];
    CSS.highlights.set(WORD_HIGHLIGHT, new Highlight(word.range));
    scrollRangeIntoView(word.range);
  }

  function clearAllHighlights() {
    if (!supportsCustomHighlights()) {
      return;
    }

    CSS.highlights.delete(SENTENCE_HIGHLIGHT);
    clearWordHighlight();
  }

  function clearWordHighlight() {
    state.activeWordIndex = -1;
    if (!supportsCustomHighlights()) {
      return;
    }

    CSS.highlights.delete(WORD_HIGHLIGHT);
  }

  function supportsCustomHighlights() {
    return Boolean(globalThis.CSS?.highlights && globalThis.Highlight);
  }

  function scrollRangeIntoView(range, options = {}) {
    const rect = getRangeScrollRect(range);
    if (!rect) {
      return;
    }

    if (options.alignToTop) {
      scrollRangeToTopIfNeeded(range, rect);
      return;
    }

    const margin = 80;
    const outsideViewport =
      rect.top < margin ||
      rect.bottom > window.innerHeight - margin ||
      rect.left < 0 ||
      rect.right > window.innerWidth;

    if (!outsideViewport) {
      return;
    }

    const container = range.startContainer.parentElement;
    container?.scrollIntoView({ block: "center", inline: "nearest", behavior: "smooth" });
  }

  function getRangeScrollRect(range) {
    const firstRect = Array.from(range.getClientRects()).find(
      (rect) => rect.width > 0 && rect.height > 0
    );
    const rect = firstRect || range.getBoundingClientRect();
    return rect.width > 0 || rect.height > 0 ? rect : null;
  }

  function scrollRangeToTopIfNeeded(range, rect) {
    const inViewport =
      rect.top >= 0 &&
      rect.bottom <= window.innerHeight &&
      rect.left >= 0 &&
      rect.right <= window.innerWidth;

    if (inViewport) {
      return;
    }

    window.scrollBy({
      top: rect.top - SENTENCE_SCROLL_TOP_OFFSET,
      behavior: "smooth",
    });
  }
})();
