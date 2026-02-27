import { MESSAGE, SESSION_STATE } from "../shared/constants.js";
import { putChunk, putSession, getSession, log } from "../shared/db.js";

const recorderState = {
  sessionId: null,
  tabId: null,
  startedAt: 0,
  seq: 0,
  mediaRecorder: null,
  captureStream: null,
  micStream: null,
  mixedStream: null,
  audioContext: null,
  mimeType: "video/webm;codecs=vp9,opus"
};

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  handleMessage(message)
    .then((result) => sendResponse(result || { ok: true }))
    .catch(async (error) => {
      await reportError(error);
      sendResponse({ ok: false, error: error?.message || "offscreen-error" });
    });
  return true;
});

async function handleMessage(message) {
  if (message?.target && message.target !== "offscreen") return { ok: true };

  switch (message?.type) {
    case MESSAGE.OFFSCREEN_START:
      return startRecorder(message.payload);
    case MESSAGE.OFFSCREEN_PAUSE:
      if (recorderState.mediaRecorder?.state === "recording") recorderState.mediaRecorder.pause();
      return { ok: true };
    case MESSAGE.OFFSCREEN_RESUME:
      if (recorderState.mediaRecorder?.state === "paused") recorderState.mediaRecorder.resume();
      return { ok: true };
    case MESSAGE.OFFSCREEN_STOP:
      return stopRecorder(message.payload);
    default:
      return { ok: true };
  }
}

async function startRecorder(payload) {
  const { sessionId, tabId, streamId, settings, startedAt } = payload;
  if (recorderState.mediaRecorder && recorderState.mediaRecorder.state !== "inactive") {
    throw new Error("Recorder already active");
  }

  recorderState.sessionId = sessionId;
  recorderState.tabId = tabId;
  recorderState.startedAt = startedAt;
  recorderState.seq = 0;
  recorderState.captureStream = await getTabStream(streamId, settings);
  recorderState.micStream = settings.withMic ? await navigator.mediaDevices.getUserMedia({ audio: true }) : null;
  recorderState.mixedStream = await makeMixedStream(recorderState.captureStream, recorderState.micStream, settings);

  recorderState.mimeType = pickMimeType();
  const recorder = new MediaRecorder(recorderState.mixedStream, {
    mimeType: recorderState.mimeType,
    videoBitsPerSecond: pickVideoBitrate(settings),
    audioBitsPerSecond: 128000
  });

  recorderState.mediaRecorder = recorder;
  recorder.ondataavailable = async (event) => {
    if (!event.data || event.data.size === 0) return;
    await putChunk({
      id: crypto.randomUUID(),
      sessionId,
      seq: recorderState.seq++,
      createdAt: Date.now(),
      mimeType: recorderState.mimeType,
      blob: event.data
    });
  };

  recorder.onerror = async (event) => {
    await reportError(event.error || new Error("MediaRecorder error"));
  };

  recorder.onstop = async () => {
    await finalizeSession();
    await chrome.runtime.sendMessage({
      type: MESSAGE.OFFSCREEN_STOPPED,
      payload: { sessionId: recorderState.sessionId }
    });
    cleanupStreams();
  };

  recorder.start(1000);

  await chrome.runtime.sendMessage({
    type: MESSAGE.OFFSCREEN_STARTED,
    payload: { sessionId }
  });

  await log("recorder-started", { sessionId, tabId, mimeType: recorderState.mimeType });
  return { ok: true };
}

async function stopRecorder(payload) {
  const { sessionId, endedAt } = payload || {};
  if (!recorderState.mediaRecorder || recorderState.mediaRecorder.state === "inactive") {
    return { ok: false, error: "Recorder not active" };
  }

  if (sessionId && recorderState.sessionId !== sessionId) {
    return { ok: false, error: "Session mismatch" };
  }

  await updateSession({
    id: recorderState.sessionId,
    state: SESSION_STATE.PROCESSING,
    updatedAt: Date.now(),
    endedAt
  });

  recorderState.mediaRecorder.stop();
  return { ok: true };
}

async function finalizeSession() {
  const durationMs = Date.now() - recorderState.startedAt;
  await updateSession({
    id: recorderState.sessionId,
    state: SESSION_STATE.READY,
    durationMs,
    updatedAt: Date.now()
  });
}

async function updateSession(patch) {
  const current = await getSession(patch.id);
  if (!current) return;
  await putSession({ ...current, ...patch });
}

async function getTabStream(streamId, settings) {
  const resolution = settings.resolution === "720p"
    ? { maxWidth: 1280, maxHeight: 720 }
    : { maxWidth: 1920, maxHeight: 1080 };

  const constraints = {
    audio: settings.withTabAudio
      ? {
          mandatory: {
            chromeMediaSource: "tab",
            chromeMediaSourceId: streamId
          }
        }
      : false,
    video: {
      mandatory: {
        chromeMediaSource: "tab",
        chromeMediaSourceId: streamId,
        maxFrameRate: settings.fps || 30,
        ...resolution
      }
    }
  };

  return navigator.mediaDevices.getUserMedia(constraints);
}

async function makeMixedStream(tabStream, micStream, settings) {
  const videoTrack = tabStream.getVideoTracks()[0];
  const output = new MediaStream([videoTrack]);

  if (!settings.withTabAudio && !settings.withMic) return output;

  const ctx = new AudioContext();
  recorderState.audioContext = ctx;
  const dest = ctx.createMediaStreamDestination();

  if (settings.withTabAudio && tabStream.getAudioTracks().length) {
    const tabAudioSource = ctx.createMediaStreamSource(new MediaStream([tabStream.getAudioTracks()[0]]));
    const tabGain = ctx.createGain();
    tabGain.gain.value = 1.0;
    tabAudioSource.connect(tabGain).connect(dest);
  }

  if (settings.withMic && micStream?.getAudioTracks().length) {
    const micAudioSource = ctx.createMediaStreamSource(new MediaStream([micStream.getAudioTracks()[0]]));
    const micGain = ctx.createGain();
    micGain.gain.value = 1.0;
    micAudioSource.connect(micGain).connect(dest);
  }

  dest.stream.getAudioTracks().forEach((track) => output.addTrack(track));
  return output;
}

function pickMimeType() {
  if (MediaRecorder.isTypeSupported("video/webm;codecs=vp9,opus")) return "video/webm;codecs=vp9,opus";
  if (MediaRecorder.isTypeSupported("video/webm;codecs=vp8,opus")) return "video/webm;codecs=vp8,opus";
  return "video/webm";
}

function pickVideoBitrate(settings) {
  if (settings.resolution === "720p") return 5_000_000;
  return settings.qualityPreset === "high" ? 11_000_000 : 8_000_000;
}

function cleanupStreams() {
  [recorderState.captureStream, recorderState.micStream, recorderState.mixedStream].forEach((stream) => {
    stream?.getTracks()?.forEach((track) => track.stop());
  });
  recorderState.audioContext?.close?.();

  recorderState.captureStream = null;
  recorderState.micStream = null;
  recorderState.mixedStream = null;
  recorderState.audioContext = null;
  recorderState.mediaRecorder = null;
}

async function reportError(error) {
  await log("offscreen-error", { message: error?.message || String(error), stack: error?.stack || null });
  await chrome.runtime.sendMessage({
    type: MESSAGE.OFFSCREEN_ERROR,
    payload: { message: error?.message || String(error) }
  });
}
