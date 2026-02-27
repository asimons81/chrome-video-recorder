import { MESSAGE } from "../../shared/constants.js";

const withMic = document.getElementById("withMic");
const withTabAudio = document.getElementById("withTabAudio");
const resolution = document.getElementById("resolution");
const status = document.getElementById("status");
const start = document.getElementById("start");
const pause = document.getElementById("pause");
const stop = document.getElementById("stop");

document.getElementById("openEditor").addEventListener("click", () => {
  chrome.tabs.create({ url: chrome.runtime.getURL("src/ui/editor/editor.html") });
});

document.getElementById("openOptions").addEventListener("click", () => {
  chrome.runtime.openOptionsPage();
});

start.addEventListener("click", async () => {
  const response = await chrome.runtime.sendMessage({
    type: MESSAGE.START_RECORDING,
    payload: {
      withMic: withMic.checked,
      withTabAudio: withTabAudio.checked,
      resolution: resolution.value
    }
  });
  if (!response.ok) {
    status.textContent = response.error || "Unable to start";
    return;
  }
  status.textContent = "Recording started";
  await refresh();
});

pause.addEventListener("click", async () => {
  const isPaused = pause.dataset.paused === "true";
  const type = isPaused ? MESSAGE.RESUME_RECORDING : MESSAGE.PAUSE_RECORDING;
  const response = await chrome.runtime.sendMessage({ type });
  if (!response.ok) {
    status.textContent = response.error || "Unable to toggle pause";
    return;
  }
  await refresh();
});

stop.addEventListener("click", async () => {
  const response = await chrome.runtime.sendMessage({ type: MESSAGE.STOP_RECORDING });
  if (!response.ok) {
    status.textContent = response.error || "Unable to stop";
    return;
  }
  status.textContent = "Stopping...";
  await refresh();
});

chrome.runtime.onMessage.addListener((message) => {
  if (message?.type === MESSAGE.RECORDING_STATUS) refresh();
});

refresh();

async function refresh() {
  const response = await chrome.runtime.sendMessage({ type: MESSAGE.GET_STATUS });
  if (!response.ok) {
    status.textContent = response.error || "Status unavailable";
    return;
  }

  const st = response.status;
  status.textContent = `State: ${st.state}${st.sessionId ? ` (${st.sessionId.slice(0, 8)})` : ""}`;

  const active = st.state === "recording" || st.state === "paused" || st.state === "processing";
  start.disabled = active;
  stop.disabled = !active;
  pause.disabled = !(st.state === "recording" || st.state === "paused");
  pause.textContent = st.state === "paused" ? "Resume" : "Pause";
  pause.dataset.paused = String(st.state === "paused");
}
