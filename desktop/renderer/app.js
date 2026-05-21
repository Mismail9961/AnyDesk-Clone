/**
 * RemoteDesk Renderer — WebRTC host using Electron's native Chromium WebRTC.
 * No native modules. Screen is captured via getUserMedia + desktopCapturer.
 */

let pc = null;
let sessionId = null;
let iceServers = [];

const $ = id => document.getElementById(id);

function setStatus(state, text) {
  const dot = $("dot");
  dot.className = "dot " + state;
  $("status-text").textContent = text;
}

function showError(msg) {
  const el = $("error-box");
  el.style.display = msg ? "block" : "none";
  el.textContent = msg ?? "";
}

function showSession(id) {
  const groups = id.match(/.{1,3}/g)?.join(" – ") ?? id;
  $("session-section").innerHTML = `
    <div class="session-box">
      <div class="session-label">Your Session ID</div>
      <div class="session-id">${groups}</div>
      <div class="session-hint">Share this ID with the viewer device</div>
    </div>`;
}

function showPeers(peers) {
  const row = $("info-row");
  if (!peers || peers.length === 0) { row.innerHTML = ""; return; }
  row.innerHTML = peers.map(p =>
    `<span class="pill">${p.role} / ${p.platform}${p.ready ? " ●" : ""}</span>`
  ).join("");
}

// ── WebRTC ────────────────────────────────────────────────────────────────────
async function startCapture() {
  try {
    // Get screen source via desktopCapturer (exposed in preload)
    const sources = await window.rd.getSources();
    if (!sources || sources.length === 0) throw new Error("No screen sources found");

    const stream = await navigator.mediaDevices.getUserMedia({
      audio: false,
      video: {
        mandatory: {
          chromeMediaSource: "desktop",
          chromeMediaSourceId: sources[0].id,
          minWidth: 1280, maxWidth: 3840,
          minHeight: 720, maxHeight: 2160,
        }
      }
    });

    pc = new RTCPeerConnection({ iceServers });

    pc.onicecandidate = ({ candidate }) => {
      if (candidate) window.rd.send("rtc:ice", candidate);
    };

    pc.onconnectionstatechange = () => {
      const s = pc.connectionState;
      if (s === "connected") setStatus("connected", "Streaming — viewer connected");
      else if (s === "failed" || s === "disconnected") setStatus("connecting", "Viewer disconnected");
    };

    stream.getTracks().forEach(track => pc.addTrack(track, stream));

    // Create and send offer
    const offer = await pc.createOffer({ offerToReceiveVideo: false, offerToReceiveAudio: false });
    await pc.setLocalDescription(offer);
    window.rd.send("rtc:offer", offer);

    window.rd.send("rtc:ready");
    setStatus("connected", "Session active — waiting for viewer…");
  } catch (err) {
    console.error("[capture]", err);
    showError("Screen capture failed: " + err.message);
    setStatus("error", "Capture error");
  }
}

// ── IPC event listeners ───────────────────────────────────────────────────────
window.rd.on("start-capture", ({ sessionId: sid, iceServers: ice }) => {
  sessionId = sid;
  iceServers = ice;
  showSession(sid);
  setStatus("connecting", "Starting screen capture…");
  showError(null);
  startCapture();
});

window.rd.on("status:update", (data) => {
  if (data.connState === "connected") setStatus("connected", "Connected");
  else if (data.connState === "disconnected") { setStatus("connecting", "Disconnected — reconnecting…"); }
  else if (data.connState === "error") { setStatus("error", "Error"); showError(data.error ?? "Connection failed"); }
  if (data.sessionId) showSession(data.sessionId);
  if (data.peers) showPeers(data.peers);
  if (data.error) showError(data.error);
});

// WebRTC signals from server (relayed via main process)
window.rd.on("rtc:offer", async ({ offer }) => {
  if (!pc) return;
  await pc.setRemoteDescription(offer);
  const answer = await pc.createAnswer();
  await pc.setLocalDescription(answer);
  window.rd.send("rtc:answer", answer);
});

window.rd.on("rtc:answer", async ({ answer }) => {
  try { await pc?.setRemoteDescription(answer); } catch (e) { console.error(e); }
});

window.rd.on("rtc:ice", async ({ candidate }) => {
  try { await pc?.addIceCandidate(candidate); } catch {}
});
