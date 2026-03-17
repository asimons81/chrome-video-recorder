import {
  getSessionMediaBlob,
  listSessions,
  getSession,
  putSession,
  listEvents,
  listLogs
} from "../../shared/db.js";

const sessionListEl = document.getElementById("sessionList");
const sourceVideo = document.getElementById("sourceVideo");
const canvas = document.getElementById("previewCanvas");
const ctx = canvas.getContext("2d");
const scrub = document.getElementById("scrub");
const trimStart = document.getElementById("trimStart");
const trimEnd = document.getElementById("trimEnd");
const playBtn = document.getElementById("play");
const saveTrimBtn = document.getElementById("saveTrim");
const exportWebmBtn = document.getElementById("exportWebm");
const exportMp4Btn = document.getElementById("exportMp4");
const downloadRawBtn = document.getElementById("downloadRaw");
const copyDiagnosticsBtn = document.getElementById("copyDiagnostics");
const presetEl = document.getElementById("preset");
const status = document.getElementById("status");
const requestedSessionId = new URLSearchParams(window.location.search).get("sessionId");

const editorState = {
  sessionId: null,
  session: null,
  events: [],
  clicks: [],
  cursor: [],
  scrolls: [],
  viewports: [],
  clickClusters: [],
  trim: { startMs: 0, endMs: 0 },
  raf: 0,
  activeUrl: null,
  exporting: false
};

const MP4_MIME_CANDIDATES = [
  "video/mp4;codecs=avc1.640028,mp4a.40.2",
  "video/mp4;codecs=avc1.42E01E,mp4a.40.2",
  "video/mp4"
];

await init();
wireEvents();
applyExportSupport();

async function init() {
  try {
    await loadSessions();
    if (requestedSessionId && !editorState.sessionId) {
      await loadSession(requestedSessionId);
    }
    if (!editorState.sessionId && !requestedSessionId) {
      setIdleState("No recordings yet. Start a capture from the popup, then return here to export WebM.");
    }
  } catch (error) {
    setIdleState(error?.message || "Editor failed to load saved sessions.");
  }
}

async function loadSessions() {
  const sessions = await listSessions();
  sessionListEl.innerHTML = "";

  if (!sessions.length) {
    clearSessionState();
    toggleSessionActions(false);
    return;
  }

  for (const session of sessions) {
    const li = document.createElement("li");
    li.textContent = `${new Date(session.createdAt).toLocaleString()} · ${Math.round((session.durationMs || 0) / 1000)}s`;
    li.title = session.id;
    li.addEventListener("click", () => loadSession(session.id));
    if (session.id === editorState.sessionId) li.classList.add("active");
    sessionListEl.appendChild(li);
  }

  if (!editorState.sessionId && !requestedSessionId && sessions.length) {
    await loadSession(sessions[0].id);
  }
}

async function loadSession(sessionId) {
  cancelAnimationFrame(editorState.raf);
  sourceVideo.pause();

  editorState.sessionId = sessionId;
  editorState.session = await getSession(sessionId);
  if (!editorState.session) {
    clearSessionState();
    status.textContent = `Session ${sessionId.slice(0, 8)} is missing from storage. Recording may not have finalized.`;
    toggleSessionActions(false);
    return;
  }
  editorState.events = (await listEvents(sessionId)).sort((a, b) => a.tMs - b.tMs);
  editorState.clicks = editorState.events.filter((event) => event.type === "click");
  editorState.cursor = editorState.events.filter((event) => event.type === "cursor");
  editorState.scrolls = editorState.events.filter((event) => event.type === "scroll");
  editorState.viewports = editorState.events.filter((event) => event.type === "viewport");
  editorState.clickClusters = buildClickClusters(editorState.clicks);

  const blob = await getSessionMediaBlob(sessionId);
  if (!blob) {
    handleIncompleteSession(editorState.session);
    return;
  }

  if (editorState.activeUrl) URL.revokeObjectURL(editorState.activeUrl);
  editorState.activeUrl = URL.createObjectURL(blob);
  sourceVideo.src = editorState.activeUrl;
  await waitForMediaMetadata();

  editorState.trim.startMs = Math.max(0, editorState.session.trimStartMs || 0);
  const computedEnd = editorState.session.trimEndMs || Math.floor((editorState.session.durationMs || sourceVideo.duration * 1000));
  editorState.trim.endMs = Math.min(Math.floor(sourceVideo.duration * 1000), computedEnd);

  trimStart.value = String(editorState.trim.startMs);
  trimEnd.value = String(editorState.trim.endMs);
  scrub.value = "0";

  await seekTo(editorState.trim.startMs / 1000);
  drawFrame(editorState.trim.startMs);
  markActiveSession();
  toggleSessionActions(true);
  status.textContent = `Loaded session ${sessionId.slice(0, 8)}.`;
}

function markActiveSession() {
  const items = sessionListEl.querySelectorAll("li");
  items.forEach((li) => {
    li.classList.toggle("active", li.title === editorState.sessionId);
  });
}

function wireEvents() {
  scrub.addEventListener("input", () => {
    if (!sourceVideo.duration || !editorState.session) return;
    const t = Number(scrub.value) / 1000;
    const time = editorState.trim.startMs / 1000 + ((editorState.trim.endMs - editorState.trim.startMs) / 1000) * t;
    renderAt(time).catch(() => {});
  });

  playBtn.addEventListener("click", () => {
    if (!editorState.session || !sourceVideo.duration) {
      status.textContent = "Load a recording before previewing.";
      return;
    }

    if (sourceVideo.paused) {
      const startSec = editorState.trim.startMs / 1000;
      const endSec = editorState.trim.endMs / 1000;
      if (sourceVideo.currentTime < startSec || sourceVideo.currentTime > endSec) {
        sourceVideo.currentTime = startSec;
      }
      sourceVideo.play();
      tick();
      return;
    }

    sourceVideo.pause();
    cancelAnimationFrame(editorState.raf);
  });

  saveTrimBtn.addEventListener("click", async () => {
    if (!editorState.session) {
      status.textContent = "Load a recording before saving trim.";
      return;
    }
    const trimValues = validateTrimInputs();
    if (!trimValues.ok) {
      status.textContent = trimValues.error;
      return;
    }
    const { startMs, endMs } = trimValues;

    editorState.trim = { startMs, endMs };
    editorState.session.trimStartMs = startMs;
    editorState.session.trimEndMs = endMs;
    editorState.session.updatedAt = Date.now();

    await putSession(editorState.session);
    await loadSessions();
    status.textContent = "Trim saved (non-destructive).";
  });

  exportWebmBtn.addEventListener("click", () => {
    exportRendered("webm").catch((error) => {
      status.textContent = error.message;
    });
  });

  exportMp4Btn.addEventListener("click", () => {
    exportRendered("mp4").catch((error) => {
      status.textContent = error.message;
    });
  });

  downloadRawBtn.addEventListener("click", async () => {
    if (!editorState.sessionId) {
      status.textContent = "Load a recording before downloading the raw WebM.";
      return;
    }
    const blob = await getSessionMediaBlob(editorState.sessionId);
    if (!blob) {
      status.textContent = "Raw WebM is not available for this session.";
      return;
    }
    downloadBlob(blob, `recording-${editorState.sessionId}.webm`);
    status.textContent = "Raw WebM download started.";
  });

  copyDiagnosticsBtn.addEventListener("click", async () => {
    if (!editorState.sessionId) {
      status.textContent = "Load a recording before copying diagnostics.";
      return;
    }
    const logs = await listLogs(200);
    const payload = {
      generatedAt: new Date().toISOString(),
      sessionId: editorState.sessionId,
      session: editorState.session,
      trim: editorState.trim,
      events: {
        total: editorState.events.length,
        clicks: editorState.clicks.length,
        cursor: editorState.cursor.length,
        scrolls: editorState.scrolls.length,
        viewports: editorState.viewports.length
      },
      logs
    };

    try {
      await navigator.clipboard.writeText(JSON.stringify(payload, null, 2));
      status.textContent = "Diagnostics copied to clipboard.";
    } catch (error) {
      status.textContent = error?.message || "Clipboard copy failed. Select and copy diagnostics manually from DevTools if needed.";
    }
  });
}

function tick() {
  if (sourceVideo.paused) return;
  if (sourceVideo.currentTime * 1000 >= editorState.trim.endMs) {
    sourceVideo.pause();
    cancelAnimationFrame(editorState.raf);
    return;
  }

  drawFrame(sourceVideo.currentTime * 1000);
  updateScrub(sourceVideo.currentTime * 1000);
  editorState.raf = requestAnimationFrame(tick);
}

async function renderAt(timeSec) {
  if (!Number.isFinite(timeSec)) return;
  await seekTo(timeSec);
  drawFrame(timeSec * 1000);
  updateScrub(timeSec * 1000);
}

function updateScrub(tMs) {
  const duration = Math.max(1, editorState.trim.endMs - editorState.trim.startMs);
  const t = (tMs - editorState.trim.startMs) / duration;
  scrub.value = String(clamp(t, 0, 1) * 1000);
}

function drawFrame(tMs) {
  if (!sourceVideo.videoWidth || !sourceVideo.videoHeight) return;

  const camera = resolveCameraTransform(tMs, presetEl.value);
  const srcW = sourceVideo.videoWidth / camera.scale;
  const srcH = sourceVideo.videoHeight / camera.scale;
  const srcX = clamp(camera.cx - srcW / 2, 0, Math.max(0, sourceVideo.videoWidth - srcW));
  const srcY = clamp(camera.cy - srcH / 2, 0, Math.max(0, sourceVideo.videoHeight - srcH));

  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(sourceVideo, srcX, srcY, srcW, srcH, 0, 0, canvas.width, canvas.height);

  drawCursor(tMs, camera, srcX, srcY, srcW, srcH);
  drawClickRipples(tMs, srcX, srcY, srcW, srcH);
}

function resolveCameraTransform(tMs, preset) {
  const base = { scale: 1, cx: sourceVideo.videoWidth / 2, cy: sourceVideo.videoHeight / 2 };
  if (!editorState.clickClusters.length) return base;

  const segment = editorState.clickClusters.find((cluster) => tMs >= cluster.startMs && tMs <= cluster.endMs);
  if (!segment) return base;

  const timing = getPresetTiming(preset);
  const local = tMs - segment.startMs;

  const inP = clamp(local / timing.inMs, 0, 1);
  const outP = clamp((local - timing.holdMs - timing.inMs) / timing.outMs, 0, 1);

  let inEase = timing.inEase(inP);
  const outEase = timing.outEase(outP);

  if (preset === "spicy") inEase = easeOutBack(inP);

  const zoomedScale = 1 + (segment.targetScale - 1) * inEase;
  const scale = zoomedScale + (1 - zoomedScale) * outEase;

  const vp = resolveViewportAt(tMs);
  const focus = projectEventPointToVideo(
    {
      x: segment.focusX,
      y: segment.focusY,
      viewport: { w: vp.w, h: vp.h }
    },
    tMs
  );

  const scroll = resolveScrollAt(tMs);
  const ratioX = sourceVideo.videoWidth / Math.max(1, vp.w);
  const ratioY = sourceVideo.videoHeight / Math.max(1, vp.h);
  const dx = (scroll.x - segment.baseScrollX) * ratioX;
  const dy = (scroll.y - segment.baseScrollY) * ratioY;

  return {
    scale,
    cx: clamp(focus.vx + dx, 0, sourceVideo.videoWidth),
    cy: clamp(focus.vy + dy, 0, sourceVideo.videoHeight)
  };
}

function drawCursor(tMs, camera, srcX, srcY, srcW, srcH) {
  const cursor = findNearest(editorState.cursor, tMs);
  if (!cursor || Math.abs(cursor.tMs - tMs) > 180) return;

  const { vx, vy } = projectEventPointToVideo(cursor, tMs);
  const px = ((vx - srcX) * canvas.width) / srcW;
  const py = ((vy - srcY) * canvas.height) / srcH;

  ctx.save();
  ctx.beginPath();
  ctx.arc(px, py, 14 * Math.max(1, camera.scale * 0.42), 0, Math.PI * 2);
  ctx.fillStyle = "rgba(34, 211, 238, 0.34)";
  ctx.fill();
  ctx.beginPath();
  ctx.arc(px, py, 4, 0, Math.PI * 2);
  ctx.fillStyle = "rgba(255,255,255,0.95)";
  ctx.fill();
  ctx.restore();
}

function drawClickRipples(tMs, srcX, srcY, srcW, srcH) {
  const active = editorState.clicks.filter((click) => tMs >= click.tMs && tMs <= click.tMs + 650);
  for (const click of active) {
    const p = clamp((tMs - click.tMs) / 650, 0, 1);
    const { vx, vy } = projectEventPointToVideo(click, tMs);
    const px = ((vx - srcX) * canvas.width) / srcW;
    const py = ((vy - srcY) * canvas.height) / srcH;

    const radius = 10 + 40 * easeOutCubic(p);
    const alpha = 1 - p;

    ctx.save();
    ctx.beginPath();
    ctx.arc(px, py, radius, 0, Math.PI * 2);
    ctx.strokeStyle = `rgba(255,255,255,${alpha * 0.82})`;
    ctx.lineWidth = 3;
    ctx.stroke();
    ctx.restore();
  }
}

function buildClickClusters(clicks) {
  if (!clicks.length) return [];
  const clusters = [];

  for (const click of clicks) {
    const last = clusters[clusters.length - 1];
    if (!last || click.tMs - last.lastClickMs > 700) {
      clusters.push({ clicks: [click], startClickMs: click.tMs, lastClickMs: click.tMs });
      continue;
    }

    last.clicks.push(click);
    last.lastClickMs = click.tMs;
  }

  return clusters.map((cluster) => {
    const vp = resolveViewportForEvent(cluster.clicks[0]);
    let xSum = 0;
    let ySum = 0;
    for (const click of cluster.clicks) {
      const box = click.target?.bbox;
      const cx = box ? box.x + box.w / 2 : click.x;
      const cy = box ? box.y + box.h / 2 : click.y;
      xSum += 0.7 * click.x + 0.3 * cx;
      ySum += 0.7 * click.y + 0.3 * cy;
    }

    const focusX = xSum / cluster.clicks.length;
    const focusY = ySum / cluster.clicks.length;
    const targetScale = inferScale(cluster.clicks, vp);
    const presetTiming = getPresetTiming("medium");

    const startMs = cluster.startClickMs - 200;
    const endMs = cluster.lastClickMs + presetTiming.inMs + presetTiming.holdMs + presetTiming.outMs;

    return {
      startMs,
      endMs,
      targetScale,
      focusX,
      focusY,
      baseScrollX: cluster.clicks[0].target?.scroll?.x || 0,
      baseScrollY: cluster.clicks[0].target?.scroll?.y || 0
    };
  });
}

function inferScale(clicks, viewport) {
  const first = clicks[0];
  const bbox = first.target?.bbox;
  if (!bbox || !viewport?.w || !viewport?.h) return 1.65;
  const areaRatio = (bbox.w * bbox.h) / (viewport.w * viewport.h);
  if (areaRatio < 0.01) return 2.05;
  if (areaRatio < 0.03) return 1.8;
  return 1.45;
}

function getPresetTiming(preset) {
  if (preset === "subtle") {
    return {
      inMs: 280,
      holdMs: 320,
      outMs: 360,
      inEase: easeOutCubic,
      outEase: easeInOutQuad
    };
  }
  if (preset === "spicy") {
    return {
      inMs: 420,
      holdMs: 700,
      outMs: 480,
      inEase: easeOutBack,
      outEase: easeInCubic
    };
  }
  return {
    inMs: 340,
    holdMs: 500,
    outMs: 420,
    inEase: easeInOutCubic,
    outEase: easeInOutCubic
  };
}

function resolveViewportAt(tMs) {
  if (!editorState.viewports.length) {
    return {
      w: sourceVideo.videoWidth || 1920,
      h: sourceVideo.videoHeight || 1080,
      dpr: 1,
      pageScale: 1
    };
  }

  let viewport = editorState.viewports[0].viewport;
  for (const event of editorState.viewports) {
    if (event.tMs > tMs) break;
    viewport = event.viewport || viewport;
  }
  return viewport;
}

function resolveViewportForEvent(event) {
  return event.viewport || resolveViewportAt(event.tMs || 0);
}

function resolveScrollAt(tMs) {
  if (!editorState.scrolls.length) return { x: 0, y: 0 };
  let latest = editorState.scrolls[0].scroll || { x: 0, y: 0 };
  for (const event of editorState.scrolls) {
    if (event.tMs > tMs) break;
    latest = event.scroll || latest;
  }
  return latest;
}

function projectEventPointToVideo(event, tMs) {
  const vp = resolveViewportForEvent(event);
  const x = clamp(event.x ?? 0, 0, Math.max(1, vp.w));
  const y = clamp(event.y ?? 0, 0, Math.max(1, vp.h));

  return {
    vx: (x / Math.max(1, vp.w)) * sourceVideo.videoWidth,
    vy: (y / Math.max(1, vp.h)) * sourceVideo.videoHeight,
    tMs
  };
}

async function exportRendered(format) {
  if (!editorState.sessionId || !sourceVideo.duration || editorState.exporting) return;
  const trimValues = validateTrimInputs();
  if (!trimValues.ok) {
    throw new Error(trimValues.error);
  }
  editorState.trim = { startMs: trimValues.startMs, endMs: trimValues.endMs };

  const mimeType = pickExportMimeType(format);
  if (!mimeType) {
    throw new Error("MP4 recording is not supported in this Chrome build. Use WebM export.");
  }

  editorState.exporting = true;
  exportWebmBtn.disabled = true;
  exportMp4Btn.disabled = true;

  try {
    const startSec = editorState.trim.startMs / 1000;
    const endSec = editorState.trim.endMs / 1000;

    status.textContent = `Preparing ${format.toUpperCase()} export...`;
    sourceVideo.pause();
    sourceVideo.currentTime = startSec;
    sourceVideo.volume = 0;

    const fps = 30;
    const canvasStream = canvas.captureStream(fps);
    const mergedTracks = [canvasStream.getVideoTracks()[0]].filter(Boolean);
    if (!mergedTracks.length) {
      throw new Error("Canvas capture is unavailable in this Chrome build.");
    }

    const sourceCapture = sourceVideo.captureStream?.();
    const audioTrack = sourceCapture?.getAudioTracks?.()?.[0];
    if (audioTrack) mergedTracks.push(audioTrack);

    const outputStream = new MediaStream(mergedTracks);
    const recorder = new MediaRecorder(outputStream, { mimeType });
    const chunks = [];

    recorder.ondataavailable = (event) => {
      if (event.data?.size) chunks.push(event.data);
    };

    const stopped = new Promise((resolve) => {
      recorder.onstop = resolve;
    });

    recorder.start(1000);
    await sourceVideo.play();

    await new Promise((resolve) => {
      const render = () => {
        const nowMs = sourceVideo.currentTime * 1000;
        if (nowMs >= editorState.trim.endMs || sourceVideo.currentTime >= endSec) {
          sourceVideo.pause();
          recorder.stop();
          resolve();
          return;
        }

        drawFrame(nowMs);
        const pct = clamp((nowMs - editorState.trim.startMs) / Math.max(1, editorState.trim.endMs - editorState.trim.startMs), 0, 1);
        status.textContent = `Exporting ${format.toUpperCase()} ${Math.round(pct * 100)}%`;
        requestAnimationFrame(render);
      };
      requestAnimationFrame(render);
    });

    await stopped;
    const blob = new Blob(chunks, { type: chunks[0]?.type || mimeType });
    if (!blob.size) {
      throw new Error("Export completed without media data. Try a shorter recording.");
    }
    const ext = format === "mp4" ? "mp4" : "webm";
    downloadBlob(blob, `cinematic-${editorState.sessionId}.${ext}`);

    status.textContent = `Exported ${format.toUpperCase()} (${Math.round(blob.size / 1024 / 1024)} MB)`;
  } finally {
    sourceVideo.pause();
    sourceVideo.volume = 1;
    editorState.exporting = false;
    exportWebmBtn.disabled = false;
    exportMp4Btn.disabled = !pickExportMimeType("mp4");
  }
}

function applyExportSupport() {
  exportMp4Btn.disabled = !pickExportMimeType("mp4");
  if (exportMp4Btn.disabled) {
    exportMp4Btn.title = "MP4 MediaRecorder is not available on this Chrome build.";
  }
}

function pickExportMimeType(format) {
  if (format === "webm") {
    if (MediaRecorder.isTypeSupported("video/webm;codecs=vp9,opus")) return "video/webm;codecs=vp9,opus";
    if (MediaRecorder.isTypeSupported("video/webm;codecs=vp8,opus")) return "video/webm;codecs=vp8,opus";
    if (MediaRecorder.isTypeSupported("video/webm")) return "video/webm";
    return null;
  }

  for (const candidate of MP4_MIME_CANDIDATES) {
    if (MediaRecorder.isTypeSupported(candidate)) return candidate;
  }
  return null;
}

function findNearest(events, tMs) {
  if (!events.length) return null;
  let left = 0;
  let right = events.length - 1;
  while (left < right) {
    const mid = Math.floor((left + right) / 2);
    if (events[mid].tMs < tMs) left = mid + 1;
    else right = mid;
  }

  const current = events[left] || null;
  const previous = events[Math.max(0, left - 1)] || null;
  if (!previous) return current;
  if (!current) return previous;

  return Math.abs(previous.tMs - tMs) < Math.abs(current.tMs - tMs) ? previous : current;
}

function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1500);
}

async function seekTo(timeSec) {
  if (Math.abs(sourceVideo.currentTime - timeSec) < 0.01) return;
  sourceVideo.currentTime = timeSec;
  await waitFor(sourceVideo, "seeked");
}

async function waitForMediaMetadata() {
  if (sourceVideo.readyState >= 1 && Number.isFinite(sourceVideo.duration)) return;
  await waitFor(sourceVideo, "loadedmetadata");
}

function waitFor(target, eventName) {
  return new Promise((resolve) => {
    const done = () => {
      target.removeEventListener(eventName, done);
      resolve();
    };
    target.addEventListener(eventName, done, { once: true });
  });
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function validateTrimInputs() {
  if (!editorState.session || !sourceVideo.duration) {
    return { ok: false, error: "Load a recording before trimming or exporting." };
  }

  const durationMs = Math.floor(sourceVideo.duration * 1000);
  const startMs = Number(trimStart.value);
  const endMs = Number(trimEnd.value);

  if (!Number.isFinite(startMs) || !Number.isFinite(endMs)) {
    return { ok: false, error: "Trim values must be valid numbers." };
  }
  if (startMs < 0 || endMs < 0) {
    return { ok: false, error: "Trim values cannot be negative." };
  }
  if (startMs >= endMs) {
    return { ok: false, error: "Trim end must be greater than trim start." };
  }
  if (endMs - startMs < 250) {
    return { ok: false, error: "Trimmed clip must be at least 250 ms long." };
  }

  return {
    ok: true,
    startMs: clamp(Math.floor(startMs), 0, durationMs),
    endMs: clamp(Math.floor(endMs), 0, durationMs)
  };
}

function clearSessionState() {
  cancelAnimationFrame(editorState.raf);
  if (editorState.activeUrl) {
    URL.revokeObjectURL(editorState.activeUrl);
    editorState.activeUrl = null;
  }
  editorState.sessionId = null;
  editorState.session = null;
  editorState.events = [];
  editorState.clicks = [];
  editorState.cursor = [];
  editorState.scrolls = [];
  editorState.viewports = [];
  editorState.clickClusters = [];
  editorState.trim = { startMs: 0, endMs: 0 };
  sourceVideo.removeAttribute("src");
  sourceVideo.load();
  trimStart.value = "0";
  trimEnd.value = "0";
  scrub.value = "0";
}

function setIdleState(message) {
  clearSessionState();
  toggleSessionActions(false);
  status.textContent = message;
}

function toggleSessionActions(enabled) {
  playBtn.disabled = !enabled;
  saveTrimBtn.disabled = !enabled;
  exportWebmBtn.disabled = !enabled;
  downloadRawBtn.disabled = !enabled;
  scrub.disabled = !enabled;
  trimStart.disabled = !enabled;
  trimEnd.disabled = !enabled;
  presetEl.disabled = !enabled;
  exportMp4Btn.disabled = !enabled || !pickExportMimeType("mp4");
  copyDiagnosticsBtn.disabled = !editorState.sessionId;
}

function handleIncompleteSession(session) {
  if (editorState.activeUrl) {
    URL.revokeObjectURL(editorState.activeUrl);
    editorState.activeUrl = null;
  }
  sourceVideo.removeAttribute("src");
  sourceVideo.load();
  trimStart.value = "0";
  trimEnd.value = "0";
  scrub.value = "0";
  markActiveSession();
  toggleSessionActions(false);
  status.textContent = describeIncompleteSession(session);
}

function describeIncompleteSession(session) {
  const shortId = session?.id ? session.id.slice(0, 8) : "unknown";
  if (!session) {
    return "This session is missing from storage.";
  }
  if (session.state === "error") {
    return `Session ${shortId} failed: ${session.error || "Recording failed before media was saved."}`;
  }
  if (session.state === "processing" || session.state === "recording" || session.state === "paused") {
    return `Session ${shortId} is incomplete. Stop/finalization has not produced a playable media file yet.`;
  }
  return `Session ${shortId} has no playable media chunks. Copy diagnostics from this page for failure details.`;
}

function easeOutCubic(t) {
  return 1 - Math.pow(1 - t, 3);
}

function easeInOutQuad(t) {
  return t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
}

function easeInCubic(t) {
  return t * t * t;
}

function easeInOutCubic(t) {
  return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
}

function easeOutBack(t) {
  const c1 = 1.70158;
  const c3 = c1 + 1;
  return 1 + c3 * Math.pow(t - 1, 3) + c1 * Math.pow(t - 1, 2);
}
