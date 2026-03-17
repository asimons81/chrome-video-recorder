// v0.1.1 — badge + double-stop fix + stale-state recovery
console.log("[SW ↻ load] service-worker module evaluated");

import { MESSAGE, SESSION_STATE, DEFAULT_SETTINGS } from "./shared/constants.js";
import { getSettings, putSession, log, putEvent, getSession } from "./shared/db.js";

const OFFSCREEN_URL = chrome.runtime.getURL("src/offscreen/offscreen.html");

const runtimeState = {
  sessionId: null,
  tabId: null,
  state: SESSION_STATE.IDLE,
  startedAt: 0,
  settings: DEFAULT_SETTINGS,
  lastSessionId: null,
  lastReadySessionId: null,
  lastError: null
};

init();

async function init() {
  console.log("[SW ↻ init] starting");
  runtimeState.settings = await getSettings().catch(() => DEFAULT_SETTINGS);
  const existing = await chrome.storage.session.get("runtimeState");
  if (existing.runtimeState) {
    Object.assign(runtimeState, existing.runtimeState);
    // If the SW restarted while recording was active, the offscreen document
    // may be gone. Detect this and recover to a clean error state.
    const wasActive =
      runtimeState.state === SESSION_STATE.RECORDING ||
      runtimeState.state === SESSION_STATE.PAUSED ||
      runtimeState.state === SESSION_STATE.PROCESSING;
    if (wasActive) {
      const offscreenAlive = await chrome.offscreen.hasDocument().catch(() => false);
      console.log(`[SW ↻ init] restored state=${runtimeState.state} offscreenAlive=${offscreenAlive}`);
      if (!offscreenAlive) {
        await log("sw-init-stale-state", { state: runtimeState.state, sessionId: runtimeState.sessionId });
        if (runtimeState.sessionId) {
          await markSessionError(runtimeState.sessionId, "Extension restarted during recording").catch(() => {});
        }
        runtimeState.lastSessionId = runtimeState.sessionId || runtimeState.lastSessionId;
        runtimeState.lastError = "Recording interrupted: extension was restarted";
        runtimeState.state = SESSION_STATE.ERROR;
        clearActiveRecordingState();
        await persistState();
      }
    }
  }
  console.log(`[SW ↻ init] complete — state=${runtimeState.state}`);
  await updateBadge(runtimeState.state);
  chrome.alarms.create("recorder-heartbeat", { periodInMinutes: 1 });
}

chrome.runtime.onInstalled.addListener(async () => {
  console.log("[SW ↻ installed]");
  await chrome.storage.session.set({ runtimeState });
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  console.log(`[SW ↻ msg] received type=${message?.type}`);
  handleMessage(message, sender)
    .then((res) => sendResponse(res || { ok: true }))
    .catch(async (error) => {
      console.error(`[SW ↻ msg] handler threw for type=${message?.type}:`, error?.message);
      await log("sw-error", { message: error?.message || String(error), stack: error?.stack || null });
      sendResponse({ ok: false, error: error?.message || "Unknown error" });
    });
  return true;
});

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name !== "recorder-heartbeat") return;
  await chrome.storage.session.set({ runtimeState });
});

async function handleMessage(message, sender) {
  switch (message?.type) {
    case MESSAGE.GET_STATUS:
      return { ok: true, status: { ...runtimeState } };
    case MESSAGE.SETTINGS_GET:
      runtimeState.settings = await getSettings();
      return { ok: true, settings: runtimeState.settings };
    case MESSAGE.SETTINGS_UPDATE:
      runtimeState.settings = { ...runtimeState.settings, ...(message.payload || {}) };
      await chrome.storage.session.set({ runtimeState });
      return { ok: true };
    case MESSAGE.START_RECORDING:
      return startRecording(message.payload || {}, sender);
    case MESSAGE.STOP_RECORDING:
      return stopRecording();
    case MESSAGE.PAUSE_RECORDING:
      await routeToOffscreen({ type: MESSAGE.OFFSCREEN_PAUSE, sessionId: runtimeState.sessionId });
      runtimeState.state = SESSION_STATE.PAUSED;
      await persistState();
      await broadcastStatus();
      return { ok: true };
    case MESSAGE.RESUME_RECORDING:
      await routeToOffscreen({ type: MESSAGE.OFFSCREEN_RESUME, sessionId: runtimeState.sessionId });
      runtimeState.state = SESSION_STATE.RECORDING;
      await persistState();
      await broadcastStatus();
      return { ok: true };
    case MESSAGE.CONTENT_EVENT:
      if (!runtimeState.sessionId || runtimeState.state === SESSION_STATE.IDLE) return { ok: true };
      await putEvent({
        id: crypto.randomUUID(),
        sessionId: runtimeState.sessionId,
        tabId: runtimeState.tabId,
        tMs: Date.now() - runtimeState.startedAt,
        ...message.payload
      });
      return { ok: true };
    case MESSAGE.OFFSCREEN_STARTED:
      console.log("[SW ↻ offscreen-started] setting RECORDING");
      runtimeState.state = SESSION_STATE.RECORDING;
      runtimeState.lastError = null;
      await persistState();
      await broadcastStatus();
      return { ok: true };
    case MESSAGE.OFFSCREEN_STOPPED:
      console.log("[SW ↻ offscreen-stopped] setting READY");
      runtimeState.lastSessionId = message.payload?.sessionId || runtimeState.sessionId || runtimeState.lastSessionId;
      runtimeState.lastReadySessionId = runtimeState.lastSessionId;
      runtimeState.lastError = null;
      runtimeState.state = SESSION_STATE.READY;
      clearActiveRecordingState();
      await log("sw-offscreen-stopped", message.payload || {});
      await persistState();
      await broadcastStatus();
      return { ok: true };
    case MESSAGE.OFFSCREEN_ERROR:
      console.error("[SW ↻ offscreen-error]", message.payload?.message);
      runtimeState.state = SESSION_STATE.ERROR;
      runtimeState.lastSessionId = message.payload?.sessionId || runtimeState.sessionId || runtimeState.lastSessionId;
      runtimeState.lastError = message.payload?.message || "Recording failed";
      await markSessionError(runtimeState.lastSessionId, runtimeState.lastError);
      clearActiveRecordingState();
      await persistState();
      await log("offscreen-error", message.payload || {});
      await broadcastStatus();
      return { ok: true };
    default:
      return { ok: false, error: `Unhandled message type: ${message?.type}` };
  }
}

async function startRecording(overrideSettings) {
  console.log(`[SW ↻ startRecording] state=${runtimeState.state}`);

  if (runtimeState.state === SESSION_STATE.RECORDING || runtimeState.state === SESSION_STATE.PAUSED) {
    console.log("[SW ↻ startRecording] already active — aborting");
    return { ok: false, error: "Recording already active" };
  }

  // IMPORTANT: `currentWindow: true` is not well-defined in a service worker context.
  // When the extension popup is open, Chrome may treat the popup as the current window,
  // returning zero tabs. Use `lastFocusedWindow: true` to reliably get the browser tab
  // the user was viewing before they opened the popup.
  let [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  console.log(`[SW ↻ startRecording] tabs.query(lastFocusedWindow) → tabId=${tab?.id} url=${tab?.url}`);

  // Fallback: if lastFocusedWindow returned nothing or a non-recordable tab, try
  // getting the last focused normal window directly.
  if (!tab?.id || !canRecordUrl(tab.url)) {
    console.log("[SW ↻ startRecording] lastFocusedWindow fallback — trying windows.getLastFocused");
    try {
      const win = await chrome.windows.getLastFocused({ populate: true, windowTypes: ["normal"] });
      const candidate = win?.tabs?.find((t) => t.active);
      console.log(`[SW ↻ startRecording] windows fallback → tabId=${candidate?.id} url=${candidate?.url}`);
      if (candidate?.id) tab = candidate;
    } catch (winErr) {
      console.warn("[SW ↻ startRecording] windows.getLastFocused failed:", winErr?.message);
    }
  }

  if (!tab?.id) {
    console.warn("[SW ↻ startRecording] no active tab found");
    return { ok: false, error: "No active tab found. Open a normal website tab and try again." };
  }
  if (!canRecordUrl(tab.url)) {
    console.warn(`[SW ↻ startRecording] non-recordable url=${tab.url}`);
    return { ok: false, error: "Open a normal http(s) tab before starting. Chrome and extension pages cannot be captured." };
  }

  const settings = { ...runtimeState.settings, ...overrideSettings };
  const sessionId = crypto.randomUUID();
  console.log(`[SW ↻ startRecording] sessionId=${sessionId} tabId=${tab.id}`);

  runtimeState.sessionId = sessionId;
  runtimeState.lastSessionId = sessionId;
  runtimeState.lastError = null;
  runtimeState.tabId = tab.id;
  runtimeState.startedAt = Date.now();
  runtimeState.state = SESSION_STATE.PROCESSING;

  await persistState();
  const baseSession = {
    id: sessionId,
    tabId: tab.id,
    state: SESSION_STATE.RECORDING,
    createdAt: runtimeState.startedAt,
    updatedAt: Date.now(),
    settings,
    trimStartMs: 0,
    trimEndMs: null,
    durationMs: 0
  };
  await putSession(baseSession);
  await log("sw-start-recording", { sessionId, tabId: tab.id, settings });

  try {
    console.log(`[SW ↻ startRecording] requesting stream id for tab ${tab.id}`);
    const streamId = await getTabStreamId(tab.id);
    console.log(`[SW ↻ startRecording] streamId=${streamId?.slice(0, 16)}…`);

    await ensureContentScript(tab.id);
    console.log("[SW ↻ startRecording] ensureOffscreen");
    await ensureOffscreen();
    console.log("[SW ↻ startRecording] routeToOffscreen OFFSCREEN_START");
    await routeToOffscreen({
      type: MESSAGE.OFFSCREEN_START,
      payload: {
        sessionId,
        tabId: tab.id,
        streamId,
        settings,
        startedAt: runtimeState.startedAt
      }
    });
    console.log("[SW ↻ startRecording] offscreen acknowledged start — broadcasting");

    await chrome.tabs.sendMessage(tab.id, { type: MESSAGE.INJECT_CONTROLLER, payload: { state: "recording" } }).catch(() => {});
    await broadcastStatus();
    return { ok: true, sessionId };
  } catch (error) {
    console.error("[SW ↻ startRecording] caught error:", error?.message);
    await markSessionError(sessionId, error?.message || "Unable to start recording");
    clearActiveRecordingState();
    runtimeState.lastSessionId = sessionId;
    runtimeState.lastError = error?.message || "Unable to start recording";
    runtimeState.state = SESSION_STATE.ERROR;
    await persistState();
    await broadcastStatus();
    throw error;
  }
}

async function stopRecording() {
  console.log(`[SW ↻ stopRecording] state=${runtimeState.state} sessionId=${runtimeState.sessionId}`);

  if (!runtimeState.sessionId || runtimeState.state === SESSION_STATE.IDLE) {
    return { ok: false, error: "No active recording" };
  }
  if (runtimeState.state === SESSION_STATE.PROCESSING) {
    return { ok: false, error: "Stop already in progress, please wait" };
  }
  const sessionId = runtimeState.sessionId;
  runtimeState.state = SESSION_STATE.PROCESSING;
  runtimeState.lastError = null;
  await persistState();
  await broadcastStatus();
  await log("sw-stop-recording", { sessionId, tabId: runtimeState.tabId });

  try {
    console.log("[SW ↻ stopRecording] routing OFFSCREEN_STOP");
    await routeToOffscreen({
      type: MESSAGE.OFFSCREEN_STOP,
      payload: {
        sessionId,
        endedAt: Date.now()
      }
    });
    console.log("[SW ↻ stopRecording] offscreen acknowledged stop");

    if (runtimeState.tabId) {
      await chrome.tabs.sendMessage(runtimeState.tabId, { type: MESSAGE.INJECT_CONTROLLER, payload: { state: "idle" } }).catch(() => {});
    }
    return { ok: true };
  } catch (error) {
    console.error("[SW ↻ stopRecording] caught error:", error?.message);
    runtimeState.state = SESSION_STATE.ERROR;
    runtimeState.lastSessionId = sessionId;
    runtimeState.lastError = error?.message || "Unable to stop recording";
    await markSessionError(sessionId, runtimeState.lastError);
    clearActiveRecordingState();
    await persistState();
    await log("sw-stop-recording-error", { sessionId, message: runtimeState.lastError });
    await broadcastStatus();
    throw error;
  }
}

async function persistState() {
  await chrome.storage.session.set({ runtimeState });
}

async function broadcastStatus() {
  console.log(`[SW ↻ broadcast] state=${runtimeState.state}`);
  await updateBadge(runtimeState.state);
  await chrome.runtime.sendMessage({ type: MESSAGE.RECORDING_STATUS, payload: runtimeState }).catch(() => {});
}

async function updateBadge(state) {
  const BADGE = {
    [SESSION_STATE.IDLE]:       { text: "",      color: "#6b7280" },
    [SESSION_STATE.RECORDING]:  { text: "REC",   color: "#ef4444" },
    [SESSION_STATE.PAUSED]:     { text: "||",    color: "#f97316" },
    [SESSION_STATE.PROCESSING]: { text: "...",   color: "#3b82f6" },
    [SESSION_STATE.READY]:      { text: "DONE",  color: "#22c55e" },
    [SESSION_STATE.ERROR]:      { text: "ERR",   color: "#ef4444" }
  };
  const badge = BADGE[state] || BADGE[SESSION_STATE.IDLE];
  console.log(`[SW ↻ badge] text="${badge.text}" color=${badge.color}`);
  await Promise.all([
    chrome.action.setBadgeText({ text: badge.text }),
    chrome.action.setBadgeBackgroundColor({ color: badge.color })
  ]).catch((err) => {
    console.warn("[SW ↻ badge] setBadge failed:", err?.message);
  });
}

async function getTabStreamId(tabId) {
  return new Promise((resolve, reject) => {
    chrome.tabCapture.getMediaStreamId({ targetTabId: tabId }, (streamId) => {
      if (chrome.runtime.lastError) {
        console.error("[SW ↻ getTabStreamId] error:", chrome.runtime.lastError.message);
        reject(new Error(chrome.runtime.lastError.message));
        return;
      }
      console.log(`[SW ↻ getTabStreamId] ok, streamId prefix=${streamId?.slice(0, 16)}`);
      resolve(streamId);
    });
  });
}

async function ensureOffscreen() {
  const existing = await chrome.offscreen.hasDocument();
  console.log(`[SW ↻ ensureOffscreen] hasDocument=${existing}`);
  if (existing) return;
  await chrome.offscreen.createDocument({
    url: OFFSCREEN_URL,
    reasons: ["USER_MEDIA", "BLOBS"],
    justification: "Record and process tab media for the active session"
  });
  console.log("[SW ↻ ensureOffscreen] created new offscreen document");
}

async function ensureContentScript(tabId) {
  try {
    await chrome.tabs.sendMessage(tabId, { type: "PING" });
    console.log(`[SW ↻ contentScript] already present in tab ${tabId}`);
    return;
  } catch {
    // Content script not yet injected — try to inject it.
    // Failure is non-fatal: recording proceeds without the floating controller
    // and interaction event capture.
    try {
      await chrome.scripting.executeScript({
        target: { tabId, allFrames: true },
        files: ["src/content/content-script.js"]
      });
      await chrome.scripting.insertCSS({
        target: { tabId },
        files: ["src/content/controller.css"]
      });
      console.log(`[SW ↻ contentScript] injected into tab ${tabId}`);
    } catch (err) {
      console.warn(`[SW ↻ contentScript] injection failed (non-fatal): ${err?.message}`);
      await log("content-script-inject-failed", { tabId, message: err?.message || String(err) });
    }
  }
}

async function routeToOffscreen(message) {
  return chrome.runtime.sendMessage({ source: "sw", target: "offscreen", ...message });
}

function canRecordUrl(url = "") {
  return /^https?:\/\//.test(url);
}

async function markSessionError(sessionId, errorMessage) {
  if (!sessionId) return;
  const session = await getSession(sessionId).catch(() => null);
  if (!session) return;
  await putSession({
    ...session,
    state: SESSION_STATE.ERROR,
    error: errorMessage,
    updatedAt: Date.now()
  });
}

function clearActiveRecordingState() {
  runtimeState.sessionId = null;
  runtimeState.tabId = null;
  runtimeState.startedAt = 0;
}
