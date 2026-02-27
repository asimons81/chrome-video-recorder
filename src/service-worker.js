import { MESSAGE, SESSION_STATE, DEFAULT_SETTINGS } from "./shared/constants.js";
import { getSettings, putSession, log, putEvent } from "./shared/db.js";

const OFFSCREEN_URL = chrome.runtime.getURL("src/offscreen/offscreen.html");

const runtimeState = {
  sessionId: null,
  tabId: null,
  state: SESSION_STATE.IDLE,
  startedAt: 0,
  settings: DEFAULT_SETTINGS
};

init();

async function init() {
  runtimeState.settings = await getSettings().catch(() => DEFAULT_SETTINGS);
  const existing = await chrome.storage.session.get("runtimeState");
  if (existing.runtimeState) {
    Object.assign(runtimeState, existing.runtimeState);
  }
  chrome.alarms.create("recorder-heartbeat", { periodInMinutes: 1 });
}

chrome.runtime.onInstalled.addListener(async () => {
  await chrome.storage.session.set({ runtimeState });
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  handleMessage(message, sender)
    .then((res) => sendResponse(res || { ok: true }))
    .catch(async (error) => {
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
      runtimeState.state = SESSION_STATE.RECORDING;
      await persistState();
      await broadcastStatus();
      return { ok: true };
    case MESSAGE.OFFSCREEN_STOPPED:
      runtimeState.state = SESSION_STATE.READY;
      await persistState();
      await broadcastStatus();
      return { ok: true };
    case MESSAGE.OFFSCREEN_ERROR:
      runtimeState.state = SESSION_STATE.ERROR;
      await persistState();
      await log("offscreen-error", message.payload || {});
      await broadcastStatus();
      return { ok: true };
    default:
      return { ok: false, error: `Unhandled message type: ${message?.type}` };
  }
}

async function startRecording(overrideSettings) {
  if (runtimeState.state === SESSION_STATE.RECORDING || runtimeState.state === SESSION_STATE.PAUSED) {
    return { ok: false, error: "Recording already active" };
  }

  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) {
    return { ok: false, error: "No active tab found" };
  }

  const settings = { ...runtimeState.settings, ...overrideSettings };
  const streamId = await getTabStreamId(tab.id);
  const sessionId = crypto.randomUUID();

  runtimeState.sessionId = sessionId;
  runtimeState.tabId = tab.id;
  runtimeState.startedAt = Date.now();
  runtimeState.state = SESSION_STATE.PROCESSING;

  await persistState();
  await ensureContentScript(tab.id);
  await ensureOffscreen();
  await putSession({
    id: sessionId,
    tabId: tab.id,
    state: SESSION_STATE.RECORDING,
    createdAt: runtimeState.startedAt,
    updatedAt: Date.now(),
    settings,
    trimStartMs: 0,
    trimEndMs: null,
    durationMs: 0
  });

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

  await chrome.tabs.sendMessage(tab.id, { type: MESSAGE.INJECT_CONTROLLER, payload: { state: "recording" } }).catch(() => {});
  await broadcastStatus();
  return { ok: true, sessionId };
}

async function stopRecording() {
  if (!runtimeState.sessionId || runtimeState.state === SESSION_STATE.IDLE) {
    return { ok: false, error: "No active recording" };
  }
  runtimeState.state = SESSION_STATE.PROCESSING;
  await persistState();
  await broadcastStatus();

  await routeToOffscreen({
    type: MESSAGE.OFFSCREEN_STOP,
    payload: {
      sessionId: runtimeState.sessionId,
      endedAt: Date.now()
    }
  });

  if (runtimeState.tabId) {
    await chrome.tabs.sendMessage(runtimeState.tabId, { type: MESSAGE.INJECT_CONTROLLER, payload: { state: "idle" } }).catch(() => {});
  }
  return { ok: true };
}

async function persistState() {
  await chrome.storage.session.set({ runtimeState });
}

async function broadcastStatus() {
  await chrome.runtime.sendMessage({ type: MESSAGE.RECORDING_STATUS, payload: runtimeState }).catch(() => {});
}

async function getTabStreamId(tabId) {
  return new Promise((resolve, reject) => {
    chrome.tabCapture.getMediaStreamId({ targetTabId: tabId }, (streamId) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
        return;
      }
      resolve(streamId);
    });
  });
}

async function ensureOffscreen() {
  const existing = await chrome.offscreen.hasDocument();
  if (existing) return;
  await chrome.offscreen.createDocument({
    url: OFFSCREEN_URL,
    reasons: ["USER_MEDIA", "BLOBS"],
    justification: "Record and process tab media for the active session"
  });
}

async function ensureContentScript(tabId) {
  try {
    await chrome.tabs.sendMessage(tabId, { type: "PING" });
    return;
  } catch {
    await chrome.scripting.executeScript({
      target: { tabId, allFrames: true },
      files: ["src/content/content-script.js"]
    });
    await chrome.scripting.insertCSS({
      target: { tabId },
      files: ["src/content/controller.css"]
    });
  }
}

async function routeToOffscreen(message) {
  return chrome.runtime.sendMessage({ source: "sw", target: "offscreen", ...message });
}
