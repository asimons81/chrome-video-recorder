console.log("[OFFSCREEN ↻ load] offscreen module evaluated");

import { MESSAGE, SESSION_STATE } from "../shared/constants.js";
import { putChunk, putSession, getSession, listChunks, log } from "../shared/db.js";

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
  mimeType: "video/webm;codecs=vp9,opus",
  pendingChunkWrites: new Set(),
  chunkWriteError: null
};

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.target && message.target !== "offscreen") return;
  console.log(`[OFFSCREEN ↻ msg] type=${message?.type}`);
  handleMessage(message)
    .then((result) => sendResponse(result || { ok: true }))
    .catch(async (error) => {
      console.error(`[OFFSCREEN ↻ msg] handler threw for type=${message?.type}:`, error?.message);
      await reportError(error);
      sendResponse({ ok: false, error: error?.message || "offscreen-error" });
    });
  return true;
});

async function handleMessage(message) {
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
  console.log(`[OFFSCREEN ↻ startRecorder] sessionId=${sessionId} tabId=${tabId}`);

  if (recorderState.mediaRecorder && recorderState.mediaRecorder.state !== "inactive") {
    throw new Error("Recorder already active");
  }

  recorderState.sessionId = sessionId;
  recorderState.tabId = tabId;
  recorderState.startedAt = startedAt;
  recorderState.seq = 0;
  recorderState.pendingChunkWrites.clear();
  recorderState.chunkWriteError = null;

  try {
    console.log(`[OFFSCREEN ↻ startRecorder] calling getUserMedia streamId=${streamId?.slice(0, 16)}…`);
    recorderState.captureStream = await getTabStream(streamId, settings);
    console.log(`[OFFSCREEN ↻ startRecorder] captureStream ok — videoTracks=${recorderState.captureStream.getVideoTracks().length} audioTracks=${recorderState.captureStream.getAudioTracks().length}`);

    recorderState.micStream = settings.withMic ? await navigator.mediaDevices.getUserMedia({ audio: true }) : null;
    recorderState.mixedStream = await makeMixedStream(recorderState.captureStream, recorderState.micStream, settings);
    console.log(`[OFFSCREEN ↻ startRecorder] mixedStream ok — tracks=${recorderState.mixedStream.getTracks().length}`);
  } catch (error) {
    console.error("[OFFSCREEN ↻ startRecorder] stream setup failed:", error?.message);
    cleanupStreams();
    throw error;
  }

  recorderState.mimeType = pickMimeType();
  console.log(`[OFFSCREEN ↻ startRecorder] mimeType=${recorderState.mimeType}`);

  if (!recorderState.mixedStream?.getVideoTracks()?.length) {
    cleanupStreams();
    throw new Error("Capture stream started without a video track.");
  }

  const recorder = new MediaRecorder(recorderState.mixedStream, {
    mimeType: recorderState.mimeType,
    videoBitsPerSecond: pickVideoBitrate(settings),
    audioBitsPerSecond: 128000
  });

  recorderState.mediaRecorder = recorder;

  recorder.ondataavailable = async (event) => {
    if (!event.data || event.data.size === 0) return;
    const chunkSeq = recorderState.seq++;
    if (chunkSeq === 0) console.log(`[OFFSCREEN ↻ chunk] first chunk bytes=${event.data.size}`);
    const write = putChunk({
      id: crypto.randomUUID(),
      sessionId,
      seq: chunkSeq,
      createdAt: Date.now(),
      mimeType: recorderState.mimeType,
      blob: event.data
    })
      .then(() =>
        log("recorder-chunk", {
          sessionId,
          seq: chunkSeq,
          bytes: event.data.size
        })
      )
      .catch(async (error) => {
        recorderState.chunkWriteError = error;
        console.error(`[OFFSCREEN ↻ chunk] write failed seq=${chunkSeq}:`, error?.message);
        await reportError(error);
      })
      .finally(() => {
        recorderState.pendingChunkWrites.delete(write);
      });
    recorderState.pendingChunkWrites.add(write);
    await write;
  };

  recorder.onerror = async (event) => {
    console.error("[OFFSCREEN ↻ recorder.onerror]", event.error?.message);
    await reportError(event.error || new Error("MediaRecorder error"));
  };

  recorder.onstop = async () => {
    console.log("[OFFSCREEN ↻ recorder.onstop] fired");
    const stoppedSessionId = recorderState.sessionId;
    try {
      await flushChunkWrites();
      console.log("[OFFSCREEN ↻ recorder.onstop] chunks flushed — finalizing");
      const finalized = await finalizeSession();
      console.log(`[OFFSCREEN ↻ recorder.onstop] finalized chunkCount=${finalized.chunkCount} bytes=${finalized.bytes}`);
      await chrome.runtime.sendMessage({
        type: MESSAGE.OFFSCREEN_STOPPED,
        payload: finalized
      });
    } catch (error) {
      console.error("[OFFSCREEN ↻ recorder.onstop] finalize failed:", error?.message);
      await reportError(error, stoppedSessionId);
    } finally {
      cleanupStreams();
    }
  };

  console.log("[OFFSCREEN ↻ startRecorder] calling recorder.start(1000)");
  recorder.start(1000);
  console.log(`[OFFSCREEN ↻ startRecorder] recorder.state=${recorder.state}`);

  await chrome.runtime.sendMessage({
    type: MESSAGE.OFFSCREEN_STARTED,
    payload: { sessionId }
  });
  console.log("[OFFSCREEN ↻ startRecorder] OFFSCREEN_STARTED sent to SW");

  attachTrackLogging(sessionId, recorderState.captureStream, "capture");
  attachTrackLogging(sessionId, recorderState.micStream, "mic");
  attachTrackLogging(sessionId, recorderState.mixedStream, "mixed");

  await log("recorder-started", {
    sessionId,
    tabId,
    mimeType: recorderState.mimeType,
    withMic: Boolean(settings.withMic),
    withTabAudio: Boolean(settings.withTabAudio)
  });
  return { ok: true };
}

async function stopRecorder(payload) {
  const { sessionId, endedAt } = payload || {};
  console.log(`[OFFSCREEN ↻ stopRecorder] sessionId=${sessionId} recorderState=${recorderState.mediaRecorder?.state}`);

  if (!recorderState.mediaRecorder || recorderState.mediaRecorder.state === "inactive") {
    console.warn("[OFFSCREEN ↻ stopRecorder] recorder not active");
    return { ok: false, error: "Recorder not active" };
  }

  if (sessionId && recorderState.sessionId !== sessionId) {
    console.warn(`[OFFSCREEN ↻ stopRecorder] session mismatch: expected=${recorderState.sessionId} got=${sessionId}`);
    return { ok: false, error: "Session mismatch" };
  }

  await updateSession({
    id: recorderState.sessionId,
    state: SESSION_STATE.PROCESSING,
    updatedAt: Date.now(),
    endedAt
  });

  await log("recorder-stop-requested", {
    sessionId: recorderState.sessionId,
    recorderState: recorderState.mediaRecorder.state,
    endedAt
  });

  if (recorderState.mediaRecorder.state !== "inactive") {
    recorderState.mediaRecorder.requestData();
  }
  recorderState.mediaRecorder.stop();
  console.log("[OFFSCREEN ↻ stopRecorder] recorder.stop() called — onstop will fire async");
  return { ok: true };
}

async function finalizeSession() {
  await flushChunkWrites();
  if (recorderState.chunkWriteError) {
    throw recorderState.chunkWriteError;
  }
  const durationMs = Date.now() - recorderState.startedAt;
  const chunks = await listChunks(recorderState.sessionId);
  const bytes = chunks.reduce((total, chunk) => total + (chunk.blob?.size || 0), 0);
  console.log(`[OFFSCREEN ↻ finalizeSession] chunks=${chunks.length} bytes=${bytes} durationMs=${durationMs}`);
  if (!chunks.length || bytes === 0) {
    throw new Error("Recording stopped without any saved media chunks.");
  }
  await updateSession({
    id: recorderState.sessionId,
    state: SESSION_STATE.READY,
    durationMs,
    chunkCount: chunks.length,
    bytes,
    mimeType: recorderState.mimeType,
    updatedAt: Date.now()
  });
  await log("recorder-finalized", {
    sessionId: recorderState.sessionId,
    durationMs,
    chunkCount: chunks.length,
    bytes
  });
  return {
    sessionId: recorderState.sessionId,
    durationMs,
    chunkCount: chunks.length,
    bytes
  };
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

  console.log(`[OFFSCREEN ↻ getTabStream] withTabAudio=${settings.withTabAudio} withMic=${settings.withMic}`);
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
  console.log("[OFFSCREEN ↻ cleanupStreams]");
  [recorderState.captureStream, recorderState.micStream, recorderState.mixedStream].forEach((stream) => {
    stream?.getTracks()?.forEach((track) => track.stop());
  });
  recorderState.audioContext?.close?.();

  recorderState.sessionId = null;
  recorderState.tabId = null;
  recorderState.startedAt = 0;
  recorderState.seq = 0;
  recorderState.captureStream = null;
  recorderState.micStream = null;
  recorderState.mixedStream = null;
  recorderState.audioContext = null;
  recorderState.mediaRecorder = null;
  recorderState.pendingChunkWrites.clear();
  recorderState.chunkWriteError = null;
}

async function reportError(error, sessionId = recorderState.sessionId) {
  console.error(`[OFFSCREEN ↻ reportError] sessionId=${sessionId} message=${error?.message}`);
  await log("offscreen-error", {
    sessionId,
    message: error?.message || String(error),
    stack: error?.stack || null
  });
  await chrome.runtime.sendMessage({
    type: MESSAGE.OFFSCREEN_ERROR,
    payload: { sessionId, message: error?.message || String(error) }
  });
}

async function flushChunkWrites() {
  if (!recorderState.pendingChunkWrites.size) return;
  console.log(`[OFFSCREEN ↻ flushChunkWrites] waiting for ${recorderState.pendingChunkWrites.size} writes`);
  await Promise.allSettled([...recorderState.pendingChunkWrites]);
}

function attachTrackLogging(sessionId, stream, label) {
  stream?.getTracks?.().forEach((track) => {
    track.addEventListener("ended", () => {
      console.log(`[OFFSCREEN ↻ track-ended] label=${label} kind=${track.kind}`);
      log("track-ended", {
        sessionId,
        label,
        kind: track.kind,
        readyState: track.readyState
      }).catch(() => {});
    });
    track.addEventListener("mute", () => {
      console.log(`[OFFSCREEN ↻ track-muted] label=${label} kind=${track.kind}`);
      log("track-muted", {
        sessionId,
        label,
        kind: track.kind
      }).catch(() => {});
    });
  });
}
