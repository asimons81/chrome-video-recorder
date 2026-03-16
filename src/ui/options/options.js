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
  status.textContent = "";
  const settings = {
    withMic: withMic.checked,
    withTabAudio: withTabAudio.checked,
    resolution: resolution.value,
    qualityPreset: qualityPreset.value,
    easingPreset: easingPreset.value,
    fps: 30
  };

  if (!isValidSettings(settings)) {
    status.textContent = "Choose a supported resolution, quality, and easing preset.";
    return;
  }

  try {
    await setSettings(settings);
    await chrome.runtime.sendMessage({ type: "SETTINGS_UPDATE", payload: settings }).catch(() => {});
    status.textContent = "Defaults saved.";
  } catch (error) {
    status.textContent = error?.message || "Unable to save defaults.";
  }
});

async function init() {
  try {
    const settings = await getSettings();
    withMic.checked = settings.withMic;
    withTabAudio.checked = settings.withTabAudio;
    resolution.value = settings.resolution;
    qualityPreset.value = settings.qualityPreset;
    easingPreset.value = settings.easingPreset;
  } catch (error) {
    status.textContent = error?.message || "Unable to load saved defaults.";
  }
}

function isValidSettings(settings) {
  const resolutions = new Set(["1080p", "720p"]);
  const qualityPresets = new Set(["balanced", "high"]);
  const easingPresets = new Set(["subtle", "medium", "spicy"]);

  return resolutions.has(settings.resolution)
    && qualityPresets.has(settings.qualityPreset)
    && easingPresets.has(settings.easingPreset);
}
