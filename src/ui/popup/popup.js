import { MESSAGE } from "../../shared/constants.js";

const withMic = document.getElementById("withMic");
const withTabAudio = document.getElementById("withTabAudio");
const resolution = document.getElementById("resolution");
const status = document.getElementById("status");
const start = document.getElementById("start");
const pause = document.getElementById("pause");
const stop = document.getElementById("stop");

init().catch((error) => {
  status.textContent = error?.message || "Popup failed to initialize.";
});

document.getElementById("openEditor").addEventListener("click", () => {
  chrome.tabs.create({ url: chrome.runtime.getURL("src/ui/editor/editor.html") });
});

document.getElementById("openOptions").addEventListener("click", () => {
  chrome.runtime.openOptionsPage();
});

start.addEventListener("click", async () => {
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
    if (!response?.ok) {
      status.textContent = response?.error || "Unable to start recording.";
      return;
    }
    status.textContent = "Recording started.";
    await refresh();
  } catch (error) {
    status.textContent = error?.message || "Unable to start recording.";
  }
});

pause.addEventListener("click", async () => {
  const isPaused = pause.dataset.paused === "true";
  const type = isPaused ? MESSAGE.RESUME_RECORDING : MESSAGE.PAUSE_RECORDING;
  try {
    const response = await chrome.runtime.sendMessage({ type });
    if (!response?.ok) {
      status.textContent = response?.error || "Unable to change recording state.";
      return;
    }
    status.textContent = isPaused ? "Recording resumed." : "Recording paused.";
    await refresh();
  } catch (error) {
    status.textContent = error?.message || "Unable to change recording state.";
  }
});

stop.addEventListener("click", async () => {
  status.textContent = "Stopping recording...";
  try {
    const response = await chrome.runtime.sendMessage({ type: MESSAGE.STOP_RECORDING });
    if (!response?.ok) {
      status.textContent = response?.error || "Unable to stop recording.";
      return;
    }
    await refresh();
  } catch (error) {
    status.textContent = error?.message || "Unable to stop recording.";
  }
});

chrome.runtime.onMessage.addListener((message) => {
  if (message?.type === MESSAGE.RECORDING_STATUS) refresh();
});

async function init() {
  await loadSettings();
  await refresh();
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
  let response;
  try {
    response = await chrome.runtime.sendMessage({ type: MESSAGE.GET_STATUS });
  } catch (error) {
    status.textContent = error?.message || "Recorder status unavailable.";
    return;
  }
  if (!response?.ok) {
    status.textContent = response?.error || "Recorder status unavailable.";
    return;
  }

  const st = response.status;
  status.textContent = describeStatus(st);

  const active = st.state === "recording" || st.state === "paused" || st.state === "processing";
  start.disabled = active;
  stop.disabled = !active;
  pause.disabled = !(st.state === "recording" || st.state === "paused");
  pause.textContent = st.state === "paused" ? "Resume" : "Pause";
  pause.dataset.paused = String(st.state === "paused");
}

function describeStatus(statusState) {
  const shortId = statusState.sessionId ? ` ${statusState.sessionId.slice(0, 8)}` : "";
  if (statusState.state === "idle") return "Ready to record the current tab.";
  if (statusState.state === "processing") return `Finalizing recording${shortId}...`;
  if (statusState.state === "recording") return `Recording in progress.${shortId}`;
  if (statusState.state === "paused") return `Recording paused.${shortId}`;
  if (statusState.state === "ready") return `Last recording saved.${shortId} Open Editor to export WebM.`;
  if (statusState.state === "error") return "Recording failed. Open Editor diagnostics or try again.";
  return `State: ${statusState.state}${shortId}`;
}
