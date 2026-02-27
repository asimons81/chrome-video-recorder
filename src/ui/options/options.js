import { setSettings, getSettings } from "../../shared/db.js";

const form = document.getElementById("form");
const status = document.getElementById("status");
const withMic = document.getElementById("withMic");
const withTabAudio = document.getElementById("withTabAudio");
const resolution = document.getElementById("resolution");
const qualityPreset = document.getElementById("qualityPreset");
const easingPreset = document.getElementById("easingPreset");

init();

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  const settings = {
    withMic: withMic.checked,
    withTabAudio: withTabAudio.checked,
    resolution: resolution.value,
    qualityPreset: qualityPreset.value,
    easingPreset: easingPreset.value,
    fps: 30
  };

  await setSettings(settings);
  await chrome.runtime.sendMessage({ type: "SETTINGS_UPDATE", payload: settings }).catch(() => {});
  status.textContent = "Saved.";
});

async function init() {
  const settings = await getSettings();
  withMic.checked = settings.withMic;
  withTabAudio.checked = settings.withTabAudio;
  resolution.value = settings.resolution;
  qualityPreset.value = settings.qualityPreset;
  easingPreset.value = settings.easingPreset;
}
