// v0.1.1 — state indicator + stop-button guard
console.log("[popup] v0.1.1 loaded");

import { MESSAGE, SESSION_STATE } from "../../shared/constants.js";

const withMic = document.getElementById("withMic");
const withTabAudio = document.getElementById("withTabAudio");
const resolution = document.getElementById("resolution");
const status = document.getElementById("status");
const stateIndicator = document.getElementById("stateIndicator");
const start = document.getElementById("start");
const pause = document.getElementById("pause");
const stop = document.getElementById("stop");
const main = document.querySelector("main");

console.log(`[POPUP ↻ dom] stateIndicator=${!!stateIndicator} main=${!!main} start=${!!start}`);

init().catch((error) => {
  console.error("[POPUP ↻ init] fatal:", error?.message);
  status.textContent = error?.message || "Popup failed to initialize.";
});

document.getElementById("openEditor").addEventListener("click", async () => {
  const targetSessionId = await getPreferredEditorSessionId();
  const editorUrl = new URL(chrome.runtime.getURL("src/ui/editor/editor.html"));
  if (targetSessionId) {
    editorUrl.searchParams.set("sessionId", targetSessionId);
  }
  chrome.tabs.create({ url: editorUrl.toString() });
});

document.getElementById("openOptions").addEventListener("click", () => {
  chrome.runtime.openOptionsPage();
});

start.addEventListener("click", async () => {
  console.log("[POPUP ↻ start] click");
  status.textContent = "Starting recording...";
  try {
    const response = await chrome.runtime.sendMessage({
      type: MESSAGE.START_RECORDING,
      payload: {
        withMic: withMic.checked,
        withTabAudio: withTabAudio.checked,
        resolution: resolution.value
      }
    });
    console.log(`[POPUP ↻ start] response ok=${response?.ok} error=${response?.error}`);
    if (!response?.ok) {
      status.textContent = response?.error || "Unable to start recording.";
    } else {
      status.textContent = "Recording started.";
    }
  } catch (error) {
    console.error("[POPUP ↻ start] sendMessage threw:", error?.message);
    status.textContent = error?.message || "Unable to start recording.";
  }
  // Always refresh so the UI reflects actual SW state, even on error paths.
  // This ensures the state indicator, badge, and button states are in sync.
  await refresh();
});

pause.addEventListener("click", async () => {
  const isPaused = pause.dataset.paused === "true";
  const type = isPaused ? MESSAGE.RESUME_RECORDING : MESSAGE.PAUSE_RECORDING;
  console.log(`[POPUP ↻ pause] click isPaused=${isPaused}`);
  try {
    const response = await chrome.runtime.sendMessage({ type });
    if (!response?.ok) {
      status.textContent = response?.error || "Unable to change recording state.";
    } else {
      status.textContent = isPaused ? "Recording resumed." : "Recording paused.";
    }
  } catch (error) {
    status.textContent = error?.message || "Unable to change recording state.";
  }
  await refresh();
});

stop.addEventListener("click", async () => {
  console.log("[POPUP ↻ stop] click");
  status.textContent = "Stopping recording...";
  try {
    const response = await chrome.runtime.sendMessage({ type: MESSAGE.STOP_RECORDING });
    console.log(`[POPUP ↻ stop] response ok=${response?.ok} error=${response?.error}`);
    if (!response?.ok) {
      status.textContent = response?.error || "Unable to stop recording.";
    }
  } catch (error) {
    console.error("[POPUP ↻ stop] sendMessage threw:", error?.message);
    status.textContent = error?.message || "Unable to stop recording.";
  }
  // Always refresh — stop may have transitioned to PROCESSING or ERROR.
  await refresh();
});

chrome.runtime.onMessage.addListener((message) => {
  if (message?.type === MESSAGE.RECORDING_STATUS) {
    console.log(`[POPUP ↻ broadcast] received RECORDING_STATUS state=${message?.payload?.state}`);
    refresh();
  }
});

async function init() {
  console.log("[POPUP ↻ init] start");
  await loadSettings();
  await refresh();
  console.log("[POPUP ↻ init] complete");
}

async function loadSettings() {
  try {
    const response = await chrome.runtime.sendMessage({ type: MESSAGE.SETTINGS_GET });
    if (!response?.ok || !response.settings) return;

    withMic.checked = Boolean(response.settings.withMic);
    withTabAudio.checked = Boolean(response.settings.withTabAudio);
    resolution.value = response.settings.resolution || "1080p";
  } catch {
    status.textContent = "Using local defaults. Open Options to review capture settings.";
  }
}

async function refresh() {
  console.log("[POPUP ↻ refresh] called");
  let response;
  try {
    response = await chrome.runtime.sendMessage({ type: MESSAGE.GET_STATUS });
  } catch (error) {
    console.error("[POPUP ↻ refresh] GET_STATUS failed:", error?.message);
    status.textContent = error?.message || "Recorder status unavailable.";
    return;
  }
  if (!response?.ok) {
    status.textContent = response?.error || "Recorder status unavailable.";
    return;
  }

  const st = response.status;
  console.log(`[POPUP ↻ refresh] state=${st.state} lastError=${st.lastError}`);
  status.textContent = describeStatus(st);

  // Apply state attribute so CSS can show state-specific visual indicators.
  main.dataset.state = st.state;
  stateIndicator.textContent = describeStateIndicator(st);

  const canControl = st.state === SESSION_STATE.RECORDING || st.state === SESSION_STATE.PAUSED;
  const busy = canControl || st.state === SESSION_STATE.PROCESSING;

  start.disabled = busy;
  // Stop is only enabled during active recording or pause — not during
  // finalization. Clicking Stop during PROCESSING causes a double-stop race
  // that corrupts the session state.
  stop.disabled = !canControl;
  pause.disabled = !canControl;
  pause.textContent = st.state === SESSION_STATE.PAUSED ? "Resume" : "Pause";
  pause.dataset.paused = String(st.state === SESSION_STATE.PAUSED);
}

function describeStateIndicator(st) {
  if (st.state === SESSION_STATE.RECORDING) return "Recording in progress";
  if (st.state === SESSION_STATE.PAUSED) return "Paused";
  if (st.state === SESSION_STATE.PROCESSING) return "Finalizing\u2026";
  if (st.state === SESSION_STATE.READY) return "Recording ready";
  if (st.state === SESSION_STATE.ERROR) return st.lastError ? `Failed: ${st.lastError}` : "Recording failed";
  return "";
}

function describeStatus(statusState) {
  const sessionRef = statusState.sessionId || statusState.lastReadySessionId || statusState.lastSessionId;
  const shortId = sessionRef ? ` ${sessionRef.slice(0, 8)}` : "";
  if (statusState.state === "idle") return "Ready to record the current tab.";
  if (statusState.state === "processing") return `Finalizing recording${shortId}...`;
  if (statusState.state === "recording") return `Recording in progress.${shortId}`;
  if (statusState.state === "paused") return `Recording paused.${shortId}`;
  if (statusState.state === "ready") return `Last recording saved.${shortId} Open Editor to export WebM.`;
  if (statusState.state === "error") {
    return statusState.lastError
      ? `Recording failed.${shortId} ${statusState.lastError}`
      : "Recording failed. Open Editor diagnostics or try again.";
  }
  return `State: ${statusState.state}${shortId}`;
}

async function getPreferredEditorSessionId() {
  try {
    const response = await chrome.runtime.sendMessage({ type: MESSAGE.GET_STATUS });
    if (!response?.ok || !response.status) return null;
    const status = response.status;
    return status.sessionId || status.lastReadySessionId || status.lastSessionId || null;
  } catch {
    return null;
  }
}
