(() => {
  const controllerId = "cinematic-recorder-controller";
  let state = "idle";
  let timerInterval = null;
  let startedAt = 0;
  let pausedAt = 0;
  let totalPausedMs = 0;
  let cursorSampleTs = 0;
  let lastCursor = { x: 0, y: 0, t: 0 };
  let lastScroll = { x: window.scrollX, y: window.scrollY };

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.type === "PING") {
      sendResponse({ ok: true });
      return;
    }

    if (message?.type === "INJECT_CONTROLLER") {
      const next = message.payload?.state || "idle";
      if (next === "recording") startController();
      if (next === "idle") destroyController();
      sendResponse({ ok: true });
    }
  });

  window.addEventListener("mousemove", onMouseMove, { passive: true });
  window.addEventListener("click", onClick, { capture: true, passive: true });
  window.addEventListener("scroll", onScroll, { passive: true });
  window.addEventListener("resize", onViewport, { passive: true });

  function onMouseMove(event) {
    const now = performance.now();
    if (now - cursorSampleTs < 33) return;
    cursorSampleTs = now;
    const t = Date.now();
    const dt = Math.max(1, t - lastCursor.t);
    const vx = ((event.clientX - lastCursor.x) / dt) * 1000;
    const vy = ((event.clientY - lastCursor.y) / dt) * 1000;

    sendEvent({
      type: "cursor",
      frameId: 0,
      x: event.clientX,
      y: event.clientY,
      vx,
      vy,
      viewport: {
        w: window.innerWidth,
        h: window.innerHeight,
        dpr: window.devicePixelRatio || 1,
        pageScale: window.visualViewport?.scale || 1
      }
    });

    lastCursor = { x: event.clientX, y: event.clientY, t };
  }

  function onClick(event) {
    const rect = event.target?.getBoundingClientRect?.() || {
      x: event.clientX,
      y: event.clientY,
      width: 1,
      height: 1
    };

    sendEvent({
      type: "click",
      frameId: 0,
      x: event.clientX,
      y: event.clientY,
      button: event.button,
      viewport: {
        w: window.innerWidth,
        h: window.innerHeight,
        dpr: window.devicePixelRatio || 1,
        pageScale: window.visualViewport?.scale || 1
      },
      target: {
        tag: event.target?.tagName || "UNKNOWN",
        id: event.target?.id || "",
        classes: [...(event.target?.classList || [])].slice(0, 4),
        bbox: {
          x: rect.x,
          y: rect.y,
          w: rect.width,
          h: rect.height
        },
        scroll: { x: window.scrollX, y: window.scrollY }
      }
    });
  }

  function onScroll() {
    const nextScroll = { x: window.scrollX, y: window.scrollY };
    sendEvent({
      type: "scroll",
      frameId: 0,
      scroll: nextScroll,
      delta: { x: nextScroll.x - lastScroll.x, y: nextScroll.y - lastScroll.y },
      viewport: {
        w: window.innerWidth,
        h: window.innerHeight,
        dpr: window.devicePixelRatio || 1,
        pageScale: window.visualViewport?.scale || 1
      }
    });
    lastScroll = nextScroll;
  }

  function onViewport() {
    sendEvent({
      type: "viewport",
      frameId: 0,
      viewport: {
        w: window.innerWidth,
        h: window.innerHeight,
        dpr: window.devicePixelRatio || 1,
        pageScale: window.visualViewport?.scale || 1
      }
    });
  }

  function sendEvent(payload) {
    chrome.runtime.sendMessage({ type: "CONTENT_EVENT", payload }).catch(() => {});
  }

  function startController() {
    if (document.getElementById(controllerId)) return;
    state = "recording";
    startedAt = Date.now();

    const root = document.createElement("div");
    root.id = controllerId;
    root.innerHTML = `
      <span class="time">00:00</span>
      <button class="pause">Pause</button>
      <button class="stop">Stop</button>
    `;

    const pause = root.querySelector(".pause");
    const stop = root.querySelector(".stop");
    const time = root.querySelector(".time");

    pause.addEventListener("click", async () => {
      if (state === "recording") {
        await chrome.runtime.sendMessage({ type: "PAUSE_RECORDING" });
        pause.textContent = "Resume";
        pause.className = "resume";
        state = "paused";
        pausedAt = Date.now();
        return;
      }
      await chrome.runtime.sendMessage({ type: "RESUME_RECORDING" });
      pause.textContent = "Pause";
      pause.className = "pause";
      state = "recording";
      if (pausedAt) {
        totalPausedMs += Date.now() - pausedAt;
        pausedAt = 0;
      }
    });

    stop.addEventListener("click", async () => {
      await chrome.runtime.sendMessage({ type: "STOP_RECORDING" });
      destroyController();
    });

    timerInterval = window.setInterval(() => {
      const effectiveNow = state === "paused" ? pausedAt : Date.now();
      const elapsed = Math.floor(Math.max(0, effectiveNow - startedAt - totalPausedMs) / 1000);
      const mm = String(Math.floor(elapsed / 60)).padStart(2, "0");
      const ss = String(elapsed % 60).padStart(2, "0");
      time.textContent = `${mm}:${ss}`;
    }, 500);

    document.documentElement.appendChild(root);
  }

  function destroyController() {
    state = "idle";
    pausedAt = 0;
    totalPausedMs = 0;
    const root = document.getElementById(controllerId);
    if (root) root.remove();
    if (timerInterval) {
      window.clearInterval(timerInterval);
      timerInterval = null;
    }
  }
})();
