/**
 * ╔══════════════════════════════════════════════════════════╗
 * ║        RemoteDesk — Web Dashboard (React 18 + Vite)     ║
 * ║   WebRTC Viewer · Session Control · Dark-Mode Premium   ║
 * ╚══════════════════════════════════════════════════════════╝
 */

import React, {
  useState, useEffect, useRef, useCallback, useMemo,
} from "react";
import { io, Socket } from "socket.io-client";
import {
  Monitor, Smartphone, Wifi, WifiOff, Copy, Check,
  MousePointer2, Keyboard, Clipboard, AlertCircle,
  ChevronRight, RotateCcw, Shield, Zap, Circle,
  Download, Apple, Terminal,
  Globe, ArrowLeft, ArrowRight, RefreshCw, ExternalLink, X,
} from "lucide-react";

// ─── Config ───────────────────────────────────────────────────────────────────
const SERVER_URL = import.meta.env.VITE_SERVER_URL ?? "http://localhost:4000";

const ICE_SERVERS = [
  { urls: "stun:stun.l.google.com:19302" },
  { urls: "stun:stun1.l.google.com:19302" },
];

type ConnectionState = "idle" | "connecting" | "connected" | "error" | "disconnected";
type ViewMode = "viewer" | "controller";
type ControlStatus = "idle" | "requesting" | "granted" | "denied";

interface PeerInfo { role: string; platform: string; ready: boolean; }
interface SessionSummary { id: string; peers: PeerInfo[]; }
interface ControlRequest { from: string; fromPlatform: string; fromRole: string; }

// ─── WebRTC hook ──────────────────────────────────────────────────────────────
function useWebRTC(socket: Socket | null, sessionId: string | null) {
  const pcRef      = useRef<RTCPeerConnection | null>(null);
  const streamRef  = useRef<MediaStream | null>(null);
  const videoRef   = useRef<HTMLVideoElement | null>(null);
  const [rtcState, setRtcState] = useState<RTCPeerConnectionState>("new");

  const createPC = useCallback(() => {
    const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });
    pcRef.current = pc;

    pc.onicecandidate = ({ candidate }) => {
      if (candidate && socket && sessionId)
        socket.emit("rtc:ice", { sessionId, candidate });
    };

    pc.ontrack = (e) => {
      const [remoteStream] = e.streams;
      streamRef.current = remoteStream;
      if (videoRef.current) videoRef.current.srcObject = remoteStream;
    };

    pc.onconnectionstatechange = () => {
      setRtcState(pc.connectionState);
    };

    pc.onnegotiationneeded = async () => {
      try {
        const offer = await pc.createOffer({ offerToReceiveVideo: true, offerToReceiveAudio: true });
        await pc.setLocalDescription(offer);
        socket?.emit("rtc:offer", { sessionId, offer });
      } catch (err) { console.error("[rtc:negotiate]", err); }
    };

    return pc;
  }, [socket, sessionId]);

  useEffect(() => {
    if (!socket || !sessionId) return;

    socket.on("rtc:offer", async ({ offer }: { offer: RTCSessionDescriptionInit }) => {
      const pc = pcRef.current ?? createPC();
      await pc.setRemoteDescription(offer);
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      socket.emit("rtc:answer", { sessionId, answer });
    });

    socket.on("rtc:answer", async ({ answer }: { answer: RTCSessionDescriptionInit }) => {
      await pcRef.current?.setRemoteDescription(answer);
    });

    socket.on("rtc:ice", async ({ candidate }: { candidate: RTCIceCandidateInit }) => {
      try { await pcRef.current?.addIceCandidate(candidate); } catch {}
    });

    return () => {
      socket.off("rtc:offer");
      socket.off("rtc:answer");
      socket.off("rtc:ice");
      pcRef.current?.close();
      pcRef.current = null;
    };
  }, [socket, sessionId, createPC]);

  return { videoRef, rtcState, pcRef, createPC };
}

// ─── Input sender (normalized coords) ────────────────────────────────────────
function useInputSender(socket: Socket | null, sessionId: string | null) {
  const containerRef = useRef<HTMLDivElement | null>(null);

  const toNorm = useCallback((clientX: number, clientY: number) => {
    const rect = containerRef.current?.getBoundingClientRect();
    if (!rect) return { x: 0, y: 0 };
    return {
      x: Math.max(0, Math.min(1, (clientX - rect.left) / rect.width)),
      y: Math.max(0, Math.min(1, (clientY - rect.top)  / rect.height)),
    };
  }, []);

  const sendPointer = useCallback((type: string, clientX: number, clientY: number, button = "left") => {
    if (!socket || !sessionId) return;
    socket.emit("input:pointer", { sessionId, type, ...toNorm(clientX, clientY), button });
  }, [socket, sessionId, toNorm]);

  const sendKey = useCallback((key: string, modifiers: string[], eventType: string) => {
    if (!socket || !sessionId) return;
    socket.emit("input:key", { sessionId, key, modifiers, eventType });
  }, [socket, sessionId]);

  const sendScroll = useCallback((dx: number, dy: number) => {
    if (!socket || !sessionId) return;
    socket.emit("input:scroll", { sessionId, dx, dy });
  }, [socket, sessionId]);

  return { containerRef, sendPointer, sendKey, sendScroll };
}

// ─── SessionID display with groups ───────────────────────────────────────────
function SessionID({ id }: { id: string }) {
  const [copied, setCopied] = useState(false);
  const groups = useMemo(() =>
    id.match(/.{1,3}/g)?.join(" – ") ?? id, [id]);

  const copy = async () => {
    await navigator.clipboard.writeText(id);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <div className="session-id-block">
      <span className="session-id-text">{groups}</span>
      <button className="icon-btn" onClick={copy} title="Copy session ID">
        {copied ? <Check size={14} /> : <Copy size={14} />}
      </button>
    </div>
  );
}

// ─── Status Badge ─────────────────────────────────────────────────────────────
function StatusBadge({ state }: { state: ConnectionState }) {
  const map: Record<ConnectionState, { label: string; cls: string }> = {
    idle:         { label: "Idle",         cls: "badge-idle"  },
    connecting:   { label: "Connecting…",  cls: "badge-warn"  },
    connected:    { label: "Live",         cls: "badge-live"  },
    error:        { label: "Error",        cls: "badge-error" },
    disconnected: { label: "Disconnected", cls: "badge-error" },
  };
  const { label, cls } = map[state];
  return (
    <span className={`badge ${cls}`}>
      <Circle size={6} fill="currentColor" />
      {label}
    </span>
  );
}

// ─── Remote Screen Viewer ─────────────────────────────────────────────────────
function ScreenViewer({
  videoRef, containerRef, sendPointer, sendScroll, active,
}: {
  videoRef: React.RefObject<HTMLVideoElement>;
  containerRef: React.RefObject<HTMLDivElement>;
  sendPointer: (t: string, x: number, y: number, b?: string) => void;
  sendScroll: (dx: number, dy: number) => void;
  active: boolean;
}) {
  const btnMap: Record<number, string> = { 0: "left", 1: "middle", 2: "right" };

  return (
    <div
      ref={containerRef}
      className={`screen-viewer ${active ? "screen-active" : "screen-placeholder"}`}
      onMouseMove={(e) => active && sendPointer("move", e.clientX, e.clientY)}
      onMouseDown={(e) => active && sendPointer("down", e.clientX, e.clientY, btnMap[e.button])}
      onMouseUp={(e)   => active && sendPointer("up",   e.clientX, e.clientY, btnMap[e.button])}
      onClick={(e)     => active && sendPointer("click", e.clientX, e.clientY, btnMap[e.button])}
      onDoubleClick={(e) => active && sendPointer("dblclick", e.clientX, e.clientY)}
      onContextMenu={(e) => { e.preventDefault(); active && sendPointer("click", e.clientX, e.clientY, "right"); }}
      onWheel={(e)     => active && sendScroll(e.deltaX, e.deltaY)}
    >
      {active ? (
        <video ref={videoRef} autoPlay playsInline muted className="screen-video" />
      ) : (
        <div className="screen-empty">
          <Monitor size={48} className="empty-icon" />
          <p>Waiting for host connection…</p>
        </div>
      )}
    </div>
  );
}

// ─── Keyboard overlay ─────────────────────────────────────────────────────────
function KeyboardOverlay({ sendKey, visible }: {
  sendKey: (k: string, m: string[], t: string) => void;
  visible: boolean;
}) {
  const [text, setText] = useState("");

  const onKeyDown = (e: React.KeyboardEvent) => {
    e.stopPropagation();
    const mods: string[] = [];
    if (e.ctrlKey)  mods.push("ctrl");
    if (e.altKey)   mods.push("alt");
    if (e.shiftKey) mods.push("shift");
    if (e.metaKey)  mods.push("meta");
    sendKey(e.key, mods, "keydown");
  };

  if (!visible) return null;
  return (
    <div className="keyboard-overlay">
      <textarea
        autoFocus
        className="keyboard-input"
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={onKeyDown}
        placeholder="Type to send keystrokes to remote…"
      />
    </div>
  );
}

// ─── Browser Control Panel ────────────────────────────────────────────────────
function BrowserControlPanel({
  targetUrl, setTargetUrl, sendBrowserCmd,
}: {
  targetUrl: string;
  setTargetUrl: (v: string) => void;
  sendBrowserCmd: (type: string, payload?: Record<string, any>) => void;
}) {
  const [jsCode, setJsCode] = useState("");

  const navigate = () => {
    let url = targetUrl.trim();
    if (url && !url.startsWith("http")) url = "https://" + url;
    sendBrowserCmd("navigate", { url });
  };

  return (
    <div className="browser-panel">
      <div className="browser-panel-header">
        <Globe size={13} />
        Browser Control
        <span style={{ marginLeft: "auto", fontSize: 10, opacity: .6, fontWeight: 400 }}>
          Commands run in the sharer's browser tab
        </span>
      </div>

      {/* URL bar */}
      <div className="browser-url-row">
        <input
          className="browser-url-input"
          value={targetUrl}
          onChange={e => setTargetUrl(e.target.value)}
          onKeyDown={e => e.key === "Enter" && navigate()}
          placeholder="Enter URL and press Enter…"
          spellCheck={false}
        />
        <button className="nav-btn" onClick={navigate} title="Navigate to URL">
          <Globe size={12} /> Go
        </button>
        <button className="nav-btn" onClick={() => sendBrowserCmd("open", { url: targetUrl })} title="Open in new tab">
          <ExternalLink size={12} />
        </button>
      </div>

      {/* Nav buttons */}
      <div className="browser-nav-btns">
        <button className="nav-btn" onClick={() => sendBrowserCmd("back")} title="Go back">
          <ArrowLeft size={12} /> Back
        </button>
        <button className="nav-btn" onClick={() => sendBrowserCmd("forward")} title="Go forward">
          <ArrowRight size={12} /> Forward
        </button>
        <button className="nav-btn" onClick={() => sendBrowserCmd("reload")} title="Reload page">
          <RefreshCw size={12} /> Reload
        </button>
        <button className="nav-btn" onClick={() => sendBrowserCmd("scroll_top")} title="Scroll to top">
          ⇑ Top
        </button>
        <button className="nav-btn" onClick={() => sendBrowserCmd("scroll_bottom")} title="Scroll to bottom">
          ⇓ Bottom
        </button>
        <button className="nav-btn nav-btn-danger" onClick={() => sendBrowserCmd("close")} title="Close their window">
          <X size={12} /> Close Window
        </button>
      </div>

      {/* JS console */}
      <div className="browser-js-row">
        <textarea
          className="browser-js-input"
          value={jsCode}
          onChange={e => setJsCode(e.target.value)}
          placeholder="document.title = 'Hello'; // JS executed in sharer's tab"
          spellCheck={false}
        />
        <button
          className="nav-btn nav-btn-js"
          onClick={() => { sendBrowserCmd("execute_js", { code: jsCode }); setJsCode(""); }}
          title="Run JS in sharer's browser"
        >
          ▶ Run JS
        </button>
      </div>
    </div>
  );
}

// ─── Mobile Device Control Panel ──────────────────────────────────────────────
function MobileControlPanel({
  sendRemoteAction, sendRemoteText,
}: {
  sendRemoteAction: (action: string, payload?: Record<string, any>) => void;
  sendRemoteText: (text: string) => void;
}) {
  const [remoteText, setRemoteText] = useState("");

  return (
    <div className="mobile-ctrl-panel">
      <div className="mobile-ctrl-header">
        <Smartphone size={13} />
        Android Device Control
        <span style={{ marginLeft: "auto", fontSize: 10, opacity: .6, fontWeight: 400 }}>
          Commands execute on mobile device
        </span>
      </div>

      {/* Navigation */}
      <div className="mobile-ctrl-section">
        <div className="mobile-ctrl-section-label">Navigation</div>
        <div className="mobile-ctrl-btns">
          <button className="mobile-ctrl-btn" onClick={() => sendRemoteAction("back")} title="Back button">
            <ArrowLeft size={13} /> Back
          </button>
          <button className="mobile-ctrl-btn mobile-ctrl-btn-primary" onClick={() => sendRemoteAction("home")} title="Home button">
            <Circle size={13} /> Home
          </button>
          <button className="mobile-ctrl-btn" onClick={() => sendRemoteAction("recents")} title="Recent apps">
            <Copy size={13} /> Recents
          </button>
        </div>
      </div>

      {/* System Actions */}
      <div className="mobile-ctrl-section">
        <div className="mobile-ctrl-section-label">System</div>
        <div className="mobile-ctrl-btns">
          <button className="mobile-ctrl-btn" onClick={() => sendRemoteAction("notifications")} title="Pull down notification shade">
            🔔 Notifications
          </button>
          <button className="mobile-ctrl-btn" onClick={() => sendRemoteAction("lock_screen")} title="Lock the device screen">
            🔒 Lock Screen
          </button>
          <button className="mobile-ctrl-btn mobile-ctrl-btn-danger" onClick={() => sendRemoteAction("power_dialog")} title="Open power menu">
            ⚡ Power Menu
          </button>
        </div>
      </div>

      {/* Advanced */}
      <div className="mobile-ctrl-section">
        <div className="mobile-ctrl-section-label">Advanced</div>
        <div className="mobile-ctrl-btns">
          <button className="mobile-ctrl-btn" onClick={() => sendRemoteAction("screenshot")} title="Take a screenshot">
            📸 Screenshot
          </button>
          <button className="mobile-ctrl-btn" onClick={() => sendRemoteAction("split_screen")} title="Toggle split screen">
            ⇄ Split Screen
          </button>
          <button className="mobile-ctrl-btn" onClick={() => sendRemoteAction("pinch", { centerX: 0.5, centerY: 0.5, factor: 1.5 })} title="Zoom in">
            🔎 Zoom In
          </button>
          <button className="mobile-ctrl-btn" onClick={() => sendRemoteAction("pinch", { centerX: 0.5, centerY: 0.5, factor: 0.5 })} title="Zoom out">
            🔍 Zoom Out
          </button>
        </div>
      </div>

      {/* Text Input */}
      <div className="mobile-ctrl-section">
        <div className="mobile-ctrl-section-label">Text Input</div>
        <div className="mobile-ctrl-text-row">
          <input
            className="mobile-ctrl-text-input"
            value={remoteText}
            onChange={e => setRemoteText(e.target.value)}
            onKeyDown={e => { if (e.key === "Enter" && remoteText) { sendRemoteText(remoteText); setRemoteText(""); } }}
            placeholder="Type text to send to device…"
            spellCheck={false}
          />
          <button
            className="mobile-ctrl-btn mobile-ctrl-text-send"
            onClick={() => { if (remoteText) { sendRemoteText(remoteText); setRemoteText(""); } }}
          >
            ↵ Send
          </button>
        </div>
      </div>
    </div>
  );
}

// ─── Main App ─────────────────────────────────────────────────────────────────
export default function App() {
  const [connState,    setConnState]    = useState<ConnectionState>("idle");
  const [socket,       setSocket]       = useState<Socket | null>(null);
  const [sessionId,    setSessionId]    = useState<string | null>(null);
  const [inputSessId,  setInputSessId]  = useState("");
  const [peers,        setPeers]        = useState<PeerInfo[]>([]);
  const [viewMode,     setViewMode]     = useState<ViewMode>("viewer");
  const [showKeyboard, setShowKeyboard] = useState(false);
  const [error,        setError]        = useState<string | null>(null);
  const [clipText,     setClipText]     = useState("");
  const socketRef = useRef<Socket | null>(null);

  // ── Remote Control state ─────────────────────────────────────────────────
  const [controlStatus,  setControlStatus]  = useState<ControlStatus>("idle");
  const [controlRequest, setControlRequest] = useState<ControlRequest | null>(null);
  const [isController,   setIsController]   = useState(false);   // am I the active controller?
  const [controlActive,  setControlActive]  = useState(false);   // is anyone controlling?

  // ── Screen sharing state ──────────────────────────────────────────────────
  const [isSharing,    setIsSharing]    = useState(false);
  const [sharerPlatform, setSharerPlatform] = useState<string | null>(null);
  const sharingStreamRef = useRef<MediaStream | null>(null);
  const localVideoRef    = useRef<HTMLVideoElement | null>(null);

  const { videoRef, rtcState, pcRef, createPC } = useWebRTC(socket, sessionId);
  const { containerRef, sendPointer, sendKey, sendScroll } = useInputSender(socket, sessionId);

  // ── Connect & create session ────────────────────────────────────────────
  const createSession = useCallback(async () => {
    setError(null);
    setConnState("connecting");
    try {
      const sock = io(SERVER_URL, {
        auth: { role: "web", platform: "browser" },
        transports: ["websocket"],
        reconnectionAttempts: 5,
        reconnectionDelay: 2000,
      });
      socketRef.current = sock;

      sock.on("connect", () => {
        sock.emit("session:create", {}, (res: any) => {
          if (res.error) { setError(res.error); setConnState("error"); return; }
          setSessionId(res.sessionId);
          setPeers(res.summary.peers);
          setConnState("connected");
          setSocket(sock);

          // Advertise screen dimensions
          sock.emit("peer:dimensions", {
            sessionId: res.sessionId,
            width: screen.width,
            height: screen.height,
            dpr: devicePixelRatio,
          });
        });
      });

      sock.on("peer:joined",  ({ summary }: { summary: SessionSummary }) => setPeers(summary.peers));
      sock.on("peer:left",    ({ summary }: { summary: SessionSummary }) => setPeers(summary.peers));
      sock.on("session:expired", () => { setConnState("disconnected"); setSessionId(null); });
      sock.on("disconnect",  () => setConnState("disconnected"));
      sock.on("connect_error", (e) => { setError(e.message); setConnState("error"); });

      sock.on("clipboard:sync", ({ text }: { text: string }) => setClipText(text));

      // ── Screen state tracking ──────────────────────────────────────────
      sock.on("screen:state", ({ sharing, sharerPlatform: sp }: any) => {
        setSharerPlatform(sharing ? sp : null);
      });

      // ── Control events ──────────────────────────────────────────────────
      sock.on("control:request", (req: ControlRequest) => {
        setControlRequest(req);
      });
      sock.on("control:state", ({ active, controller }: { active: boolean; controller: string | null }) => {
        setControlActive(active);
        if (active && controller === sock.id) {
          setIsController(true);
          setControlStatus("granted");
          setViewMode("controller");
        } else {
          setIsController(false);
          if (!active) setControlStatus("idle");
        }
      });
      sock.on("control:denied", ({ reason }: { reason: string }) => {
        setControlStatus("denied");
        setError(`Control denied: ${reason}`);
        setTimeout(() => setControlStatus("idle"), 3000);
      });

    } catch (err: any) {
      setError(err.message);
      setConnState("error");
    }
  }, []);

  // ── Join existing session ───────────────────────────────────────────────
  const joinSession = useCallback(async () => {
    const id = inputSessId.replace(/\s/g, "");
    if (id.length !== 9) { setError("Session ID must be 9 digits"); return; }
    setError(null);
    setConnState("connecting");
    try {
      const sock = io(SERVER_URL, {
        auth: { role: "web", platform: "browser" },
        transports: ["websocket"],
        reconnectionAttempts: 5,
      });
      socketRef.current = sock;

      sock.on("connect", () => {
        sock.emit("session:join", { sessionId: id }, (res: any) => {
          if (res.error) { setError(res.error); setConnState("error"); return; }
          setSessionId(id);
          setPeers(res.summary.peers);
          setConnState("connected");
          setSocket(sock);
          // Initiate WebRTC as viewer (receive-only)
          createPC();
        });
      });

      sock.on("peer:joined",     ({ summary }: any) => setPeers(summary.peers));
      sock.on("peer:left",       ({ summary }: any) => setPeers(summary.peers));
      sock.on("session:expired", () => { setConnState("disconnected"); setSessionId(null); });
      sock.on("disconnect",      () => setConnState("disconnected"));
      sock.on("connect_error",   (e: any) => { setError(e.message); setConnState("error"); });
      sock.on("clipboard:sync",  ({ text }: any) => setClipText(text));

      // ── Screen state tracking ──────────────────────────────────────────
      sock.on("screen:state", ({ sharing, sharerPlatform: sp }: any) => {
        setSharerPlatform(sharing ? sp : null);
      });

      // ── Control events ──────────────────────────────────────────────────
      sock.on("control:request", (req: ControlRequest) => {
        setControlRequest(req);
      });
      sock.on("control:state", ({ active, controller }: { active: boolean; controller: string | null }) => {
        setControlActive(active);
        if (active && controller === sock.id) {
          setIsController(true);
          setControlStatus("granted");
          setViewMode("controller");
        } else {
          setIsController(false);
          if (!active) setControlStatus("idle");
        }
      });
      sock.on("control:denied", ({ reason }: { reason: string }) => {
        setControlStatus("denied");
        setError(`Control denied: ${reason}`);
        setTimeout(() => setControlStatus("idle"), 3000);
      });
    } catch (err: any) {
      setError(err.message);
      setConnState("error");
    }
  }, [inputSessId, createPC]);

  // ── Disconnect ──────────────────────────────────────────────────────────
  const disconnect = useCallback(() => {
    sharingStreamRef.current?.getTracks().forEach((t: MediaStreamTrack) => t.stop());
    sharingStreamRef.current = null;
    if (localVideoRef.current) localVideoRef.current.srcObject = null;
    setIsSharing(false);
    socketRef.current?.disconnect();
    pcRef.current?.close();
    pcRef.current = null;
    setSocket(null);
    setSessionId(null);
    setPeers([]);
    setConnState("idle");
    setError(null);
    setControlStatus("idle");
    setControlActive(false);
    setIsController(false);
    setControlRequest(null);
  }, [pcRef]);

  // ── Clipboard push ──────────────────────────────────────────────────────
  const pushClipboard = useCallback(() => {
    if (!socket || !sessionId || !clipText) return;
    socket.emit("clipboard:sync", { sessionId, text: clipText });
  }, [socket, sessionId, clipText]);

  // ── Control actions ─────────────────────────────────────────────────────
  const requestControl = useCallback(() => {
    if (!socket || !sessionId) return;
    setControlStatus("requesting");
    socket.emit("control:request", { sessionId });
  }, [socket, sessionId]);

  const grantControl = useCallback(() => {
    if (!socket || !sessionId || !controlRequest) return;
    socket.emit("control:grant", { sessionId, to: controlRequest.from });
    setControlRequest(null);
  }, [socket, sessionId, controlRequest]);

  const denyControl = useCallback(() => {
    if (!socket || !sessionId || !controlRequest) return;
    socket.emit("control:deny", { sessionId, to: controlRequest.from });
    setControlRequest(null);
  }, [socket, sessionId, controlRequest]);

  const revokeControl = useCallback(() => {
    if (!socket || !sessionId) return;
    socket.emit("control:revoke", { sessionId });
    setControlActive(false);
    setIsController(false);
    setControlStatus("idle");
  }, [socket, sessionId]);

  // ── Screen Share ─────────────────────────────────────────────────────────
  const startSharing = useCallback(async () => {
    if (!socket || !sessionId) return;
    try {
      const stream = await (navigator.mediaDevices as any).getDisplayMedia({
        video: { frameRate: 30, cursor: "always" },
        audio: false,
      });
      sharingStreamRef.current = stream;

      // Show local preview
      if (localVideoRef.current) {
        localVideoRef.current.srcObject = stream;
      }

      // Add tracks to existing or new RTCPeerConnection and offer
      const pc = pcRef.current ?? createPC();
      stream.getTracks().forEach((track: MediaStreamTrack) => {
        pc.addTrack(track, stream);
      });

      setIsSharing(true);
      socket.emit("screen:start", { sessionId });
      socket.emit("peer:dimensions", {
        sessionId,
        width: window.innerWidth,
        height: window.innerHeight,
        dpr: devicePixelRatio,
      });

      // Stop sharing when user clicks the browser's "Stop sharing" button
      stream.getVideoTracks()[0].addEventListener("ended", () => stopSharing());
    } catch (err: any) {
      if (err.name !== "NotAllowedError") setError("Screen share failed: " + err.message);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [socket, sessionId, pcRef, createPC]);

  const stopSharing = useCallback(() => {
    sharingStreamRef.current?.getTracks().forEach((t: MediaStreamTrack) => t.stop());
    sharingStreamRef.current = null;
    if (localVideoRef.current) localVideoRef.current.srcObject = null;
    setIsSharing(false);
    if (socket && sessionId) socket.emit("screen:stop", { sessionId });
  }, [socket, sessionId]);

  // ── DOM Input Injection (runs on the SHARER side when being controlled) ──
  useEffect(() => {
    if (!socket || !controlActive || isController) return;

    const injectPointer = ({ type, x, y, button }: any) => {
      const cx = x * window.innerWidth;
      const cy = y * window.innerHeight;
      const el = (document.elementFromPoint(cx, cy) ?? document.body) as HTMLElement;
      const btnNum = button === "right" ? 2 : button === "middle" ? 1 : 0;
      const evtMap: Record<string, string> = {
        move: "mousemove", down: "mousedown", up: "mouseup",
        click: "click",    dblclick: "dblclick",
      };
      el.dispatchEvent(new MouseEvent(evtMap[type] ?? "mousemove", {
        bubbles: true, cancelable: true,
        clientX: cx, clientY: cy,
        button: btnNum, buttons: type === "down" ? btnNum + 1 : 0,
      }));
      // For input / contenteditable click — also focus
      if (type === "click" || type === "down") {
        try { el.focus?.(); } catch {}
      }
    };

    const injectKey = ({ key, modifiers, eventType }: any) => {
      const el = (document.activeElement ?? document.body) as HTMLElement;
      el.dispatchEvent(new KeyboardEvent(eventType ?? "keydown", {
        bubbles: true, cancelable: true, key,
        ctrlKey:  modifiers?.includes("ctrl"),
        altKey:   modifiers?.includes("alt"),
        shiftKey: modifiers?.includes("shift"),
        metaKey:  modifiers?.includes("meta"),
      }));
      // For printable chars, also fire input event on active element
      if (key.length === 1 && el instanceof HTMLInputElement) {
        const nativeInputValueSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")?.set;
        nativeInputValueSetter?.call(el, el.value + key);
        el.dispatchEvent(new Event("input", { bubbles: true }));
      }
    };

    const injectScroll = ({ dx, dy }: any) => {
      window.scrollBy({ left: dx, top: dy, behavior: "instant" } as any);
    };

    socket.on("input:pointer", injectPointer);
    socket.on("input:key",     injectKey);
    socket.on("input:scroll",  injectScroll);
    return () => {
      socket.off("input:pointer", injectPointer);
      socket.off("input:key",     injectKey);
      socket.off("input:scroll",  injectScroll);
    };
  }, [socket, controlActive, isController]);

  // ── Disconnect cleans up sharing too ────────────────────────────────────

  // ── Browser Commands (controller sends, sharer executes) ─────────────────
  const [targetUrl, setTargetUrl] = useState("https://");

  const sendBrowserCmd = useCallback((type: string, payload: Record<string, any> = {}) => {
    if (!socket || !sessionId || !isController) return;
    socket.emit("browser:cmd", { sessionId, type, payload });
  }, [socket, sessionId, isController]);

  // ── Mobile Remote Control helpers ──────────────────────────────────────
  const sendRemoteAction = useCallback((action: string, payload: Record<string, any> = {}) => {
    if (!socket || !sessionId || !isController) return;
    const map: Record<string, string> = {
      back: "remote:back", home: "remote:home", recents: "remote:recents",
      notifications: "remote:notifications", lock_screen: "remote:lock_screen",
      power_dialog: "remote:power_dialog", screenshot: "remote:screenshot",
      split_screen: "remote:split_screen", pinch: "remote:pinch",
    };
    const evt = map[action];
    if (evt) socket.emit(evt, { sessionId, ...payload });
  }, [socket, sessionId, isController]);

  const sendRemoteText = useCallback((text: string) => {
    if (!socket || !sessionId || !isController || !text) return;
    socket.emit("remote:text", { sessionId, text });
  }, [socket, sessionId, isController]);

  const isMobileSharer = sharerPlatform === "android" || sharerPlatform === "ios";

  // Sharer: execute incoming browser commands
  useEffect(() => {
    if (!socket || !controlActive || isController) return;

    const handleBrowserCmd = ({ type, payload }: { type: string; payload: any }) => {
      switch (type) {
        case "navigate":
          if (payload?.url) window.location.href = payload.url;
          break;
        case "reload":
          window.location.reload();
          break;
        case "back":
          window.history.back();
          break;
        case "forward":
          window.history.forward();
          break;
        case "close":
          window.close();
          break;
        case "open":
          if (payload?.url) window.open(payload.url, "_blank");
          break;
        case "scroll_top":
          window.scrollTo({ top: 0, behavior: "smooth" });
          break;
        case "scroll_bottom":
          window.scrollTo({ top: document.body.scrollHeight, behavior: "smooth" });
          break;
        case "execute_js":
          // eslint-disable-next-line no-eval
          if (payload?.code) { try { eval(payload.code); } catch {} }
          break;
      }
    };

    socket.on("browser:cmd", handleBrowserCmd);
    return () => { socket.off("browser:cmd", handleBrowserCmd); };
  }, [socket, controlActive, isController]);

  const isConnected = connState === "connected";
  const hasVideo    = rtcState === "connected";
  const hostOnline  = peers.some(p => p.role === "host" && p.ready);
  const hasPeers    = peers.length > 1;

  return (
    <>
      {/* ── Global styles ─────────────────────────────────────────────── */}
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=DM+Mono:wght@400;500&family=Syne:wght@400;600;700;800&display=swap');

        *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }

        :root {
          --bg:        #0b0c10;
          --bg2:       #111318;
          --bg3:       #181b22;
          --border:    #1e2330;
          --accent:    #3b82f6;
          --accent-d:  #1d4ed8;
          --accent-g:  rgba(59,130,246,0.12);
          --text:      #e2e8f0;
          --text-dim:  #64748b;
          --text-mute: #334155;
          --red:       #ef4444;
          --green:     #22c55e;
          --yellow:    #f59e0b;
          --r:         10px;
          --r-sm:      6px;
          --font-ui:   'Syne', sans-serif;
          --font-mono: 'DM Mono', monospace;
        }

        html, body, #root { height: 100%; background: var(--bg); color: var(--text); }
        body { font-family: var(--font-ui); font-size: 14px; line-height: 1.5; -webkit-font-smoothing: antialiased; }

        /* ── Layout ────────────────────────────────────────────────────── */
        .app { display: flex; flex-direction: column; height: 100vh; overflow: hidden; }

        .topbar {
          display: flex; align-items: center; gap: 16px;
          padding: 12px 24px;
          border-bottom: 1px solid var(--border);
          background: var(--bg2);
          flex-shrink: 0;
        }
        .logo { display: flex; align-items: center; gap: 8px; font-size: 18px; font-weight: 800; letter-spacing: -0.5px; }
        .logo-icon { color: var(--accent); }
        .logo-dot  { color: var(--text-dim); font-weight: 400; }

        .main { display: flex; flex: 1; overflow: hidden; }

        /* ── Sidebar ───────────────────────────────────────────────────── */
        .sidebar {
          width: 280px; flex-shrink: 0;
          border-right: 1px solid var(--border);
          background: var(--bg2);
          display: flex; flex-direction: column;
          overflow-y: auto; padding: 20px 16px;
          gap: 20px;
        }

        .section-label {
          font-size: 10px; font-weight: 700; letter-spacing: 1.5px;
          text-transform: uppercase; color: var(--text-mute);
          margin-bottom: 8px;
        }

        /* ── Cards ─────────────────────────────────────────────────────── */
        .card {
          background: var(--bg3);
          border: 1px solid var(--border);
          border-radius: var(--r);
          padding: 14px;
        }
        .card + .card { margin-top: 0; }

        /* ── Buttons ───────────────────────────────────────────────────── */
        .btn {
          display: inline-flex; align-items: center; justify-content: center; gap: 6px;
          padding: 9px 16px; border-radius: var(--r-sm);
          font-family: var(--font-ui); font-size: 13px; font-weight: 600;
          border: none; cursor: pointer; transition: all .15s;
          width: 100%;
        }
        .btn-primary { background: var(--accent); color: #fff; }
        .btn-primary:hover { background: var(--accent-d); }
        .btn-ghost {
          background: transparent; color: var(--text-dim);
          border: 1px solid var(--border);
        }
        .btn-ghost:hover { border-color: var(--accent); color: var(--text); }
        .btn-danger { background: rgba(239,68,68,.12); color: var(--red); border: 1px solid rgba(239,68,68,.2); }
        .btn-danger:hover { background: rgba(239,68,68,.2); }
        .btn:disabled { opacity: .4; cursor: not-allowed; }
        .icon-btn {
          display: inline-flex; align-items: center; justify-content: center;
          width: 28px; height: 28px; border-radius: var(--r-sm);
          background: transparent; border: none; color: var(--text-dim);
          cursor: pointer; transition: color .15s;
        }
        .icon-btn:hover { color: var(--text); }

        /* ── Inputs ────────────────────────────────────────────────────── */
        .input {
          width: 100%; background: var(--bg);
          border: 1px solid var(--border); border-radius: var(--r-sm);
          color: var(--text); font-family: var(--font-mono); font-size: 14px;
          padding: 9px 12px; outline: none; transition: border-color .15s;
        }
        .input:focus { border-color: var(--accent); }
        .input::placeholder { color: var(--text-mute); }

        /* ── Session ID ────────────────────────────────────────────────── */
        .session-id-block {
          display: flex; align-items: center; gap: 8px;
          background: var(--bg); border: 1px solid var(--accent);
          border-radius: var(--r-sm); padding: 10px 14px;
        }
        .session-id-text {
          flex: 1; font-family: var(--font-mono); font-size: 18px;
          font-weight: 500; letter-spacing: 2px; color: var(--accent);
        }

        /* ── Badge ─────────────────────────────────────────────────────── */
        .badge {
          display: inline-flex; align-items: center; gap: 5px;
          padding: 3px 10px; border-radius: 100px;
          font-size: 11px; font-weight: 700; letter-spacing: .5px;
        }
        .badge-idle  { background: rgba(100,116,139,.12); color: var(--text-dim); }
        .badge-warn  { background: rgba(245,158,11,.12);  color: var(--yellow); }
        .badge-live  { background: rgba(34,197,94,.12);   color: var(--green);  }
        .badge-error { background: rgba(239,68,68,.12);   color: var(--red);    }

        /* ── Peers list ────────────────────────────────────────────────── */
        .peers-list { display: flex; flex-direction: column; gap: 6px; }
        .peer-row {
          display: flex; align-items: center; gap: 8px;
          padding: 7px 10px; border-radius: var(--r-sm);
          background: var(--bg); border: 1px solid var(--border);
          font-size: 12px;
        }
        .peer-icon { color: var(--accent); }
        .peer-role { font-weight: 600; }
        .peer-platform { color: var(--text-dim); }
        .peer-ready { margin-left: auto; color: var(--green); font-size: 10px; }

        /* ── Tab switcher ──────────────────────────────────────────────── */
        .tabs { display: flex; gap: 4px; padding: 4px; background: var(--bg); border-radius: var(--r-sm); border: 1px solid var(--border); }
        .tab {
          flex: 1; padding: 6px 10px; border-radius: 4px;
          font-family: var(--font-ui); font-size: 12px; font-weight: 600;
          cursor: pointer; border: none; transition: all .15s;
          background: transparent; color: var(--text-dim);
        }
        .tab.active { background: var(--accent); color: #fff; }

        /* ── Content area ──────────────────────────────────────────────── */
        .content { flex: 1; overflow: hidden; display: flex; flex-direction: column; padding: 24px; gap: 16px; }

        /* ── Screen viewer ─────────────────────────────────────────────── */
        .screen-viewer {
          flex: 1; border-radius: var(--r);
          border: 1px solid var(--border);
          overflow: hidden; position: relative; cursor: crosshair;
          min-height: 0;
        }
        .screen-active { border-color: var(--accent); box-shadow: 0 0 0 1px var(--accent-g), 0 0 40px rgba(59,130,246,.08); }
        .screen-video  { width: 100%; height: 100%; object-fit: contain; display: block; background: #000; }
        .screen-empty  {
          width: 100%; height: 100%; display: flex; flex-direction: column;
          align-items: center; justify-content: center; gap: 12px;
          background: var(--bg3); color: var(--text-mute);
        }
        .empty-icon { opacity: .3; }

        /* ── Keyboard overlay ──────────────────────────────────────────── */
        .keyboard-overlay {
          padding: 12px 0 0;
        }
        .keyboard-input {
          width: 100%; height: 80px; resize: none;
          background: var(--bg); border: 1px solid var(--border);
          border-radius: var(--r-sm); color: var(--text);
          font-family: var(--font-mono); font-size: 13px;
          padding: 10px 12px; outline: none; transition: border-color .15s;
        }
        .keyboard-input:focus { border-color: var(--accent); }

        /* ── Clipboard ─────────────────────────────────────────────────── */
        .clip-area { display: flex; gap: 8px; }
        .clip-area .input { font-size: 12px; }

        /* ── Error bar ─────────────────────────────────────────────────── */
        .error-bar {
          display: flex; align-items: center; gap: 8px;
          background: rgba(239,68,68,.1); border: 1px solid rgba(239,68,68,.25);
          border-radius: var(--r-sm); padding: 10px 14px;
          color: var(--red); font-size: 13px;
        }

        /* ── Stats row ─────────────────────────────────────────────────── */
        .stats-row { display: flex; gap: 8px; align-items: center; font-size: 11px; color: var(--text-dim); }
        .stat-pill {
          display: flex; align-items: center; gap: 4px;
          background: var(--bg3); border: 1px solid var(--border);
          border-radius: 100px; padding: 3px 10px;
        }

        /* ── Divider ───────────────────────────────────────────────────── */
        .divider { height: 1px; background: var(--border); margin: 4px 0; }

        /* ── Download section ───────────────────────────────────────────── */
        .download-card {
          background: linear-gradient(135deg, rgba(59,130,246,0.08) 0%, rgba(139,92,246,0.06) 100%);
          border: 1px solid rgba(59,130,246,0.2);
          border-radius: var(--r);
          padding: 14px;
        }
        .download-card-mobile {
          background: linear-gradient(135deg, rgba(34,197,94,0.07) 0%, rgba(59,130,246,0.06) 100%);
          border: 1px solid rgba(34,197,94,0.2);
          border-radius: var(--r);
          padding: 14px;
        }
        .download-title {
          display: flex; align-items: center; gap: 7px;
          font-size: 12px; font-weight: 700;
          color: var(--text); margin-bottom: 10px;
        }
        .download-title svg { color: var(--accent); }
        .download-title-mobile svg { color: var(--green); }
        .download-version {
          display: inline-block;
          font-size: 9px; font-weight: 700; letter-spacing: 1px;
          background: rgba(59,130,246,0.15); color: var(--accent);
          border-radius: 100px; padding: 2px 8px;
          margin-left: auto;
        }
        .download-version-mobile {
          display: inline-block;
          font-size: 9px; font-weight: 700; letter-spacing: 1px;
          background: rgba(34,197,94,0.15); color: var(--green);
          border-radius: 100px; padding: 2px 8px;
          margin-left: auto;
        }
        .download-btns { display: flex; flex-direction: column; gap: 6px; }
        .dl-btn {
          display: flex; align-items: center; gap: 8px;
          padding: 8px 12px; border-radius: var(--r-sm);
          background: var(--bg); border: 1px solid var(--border);
          color: var(--text-dim); font-family: var(--font-ui);
          font-size: 12px; font-weight: 600;
          cursor: pointer; transition: all .15s; text-decoration: none;
          width: 100%;
        }
        .dl-btn:hover { border-color: var(--accent); color: var(--text); background: var(--accent-g); }
        .dl-btn-ios {
          display: flex; align-items: center; gap: 8px;
          padding: 8px 12px; border-radius: var(--r-sm);
          background: var(--bg); border: 1px solid rgba(139,92,246,0.25);
          color: var(--text-dim); font-family: var(--font-ui);
          font-size: 12px; font-weight: 600;
          cursor: pointer; transition: all .15s; text-decoration: none;
          width: 100%;
        }
        .dl-btn-ios:hover { border-color: #a78bfa; color: var(--text); background: rgba(139,92,246,0.1); }
        .dl-btn-android {
          display: flex; align-items: center; gap: 8px;
          padding: 8px 12px; border-radius: var(--r-sm);
          background: var(--bg); border: 1px solid rgba(34,197,94,0.25);
          color: var(--text-dim); font-family: var(--font-ui);
          font-size: 12px; font-weight: 600;
          cursor: pointer; transition: all .15s; text-decoration: none;
          width: 100%;
        }
        .dl-btn-android:hover { border-color: var(--green); color: var(--text); background: rgba(34,197,94,0.1); }
        .dl-btn svg { flex-shrink: 0; }
        .dl-btn-ios svg, .dl-btn-android svg { flex-shrink: 0; }
        .dl-btn-label { flex: 1; text-align: left; }
        .dl-btn-ext { font-size: 10px; color: var(--text-mute); margin-left: auto; font-family: var(--font-mono); }
        .dl-divider { height: 1px; background: rgba(59,130,246,0.1); margin: 6px 0; }
        .dl-divider-mobile { height: 1px; background: rgba(34,197,94,0.1); margin: 6px 0; }
        .store-badge-note {
          font-size: 10px; color: var(--text-mute); margin-top: 8px;
          display: flex; align-items: center; gap: 4px; line-height: 1.4;
        }

        /* ── Remote Control UI ─────────────────────────────────────────── */
        .ctrl-active-pill {
          display: flex; align-items: center; gap: 7px;
          padding: 7px 12px; border-radius: var(--r-sm);
          background: rgba(34,197,94,.1); border: 1px solid rgba(34,197,94,.25);
          font-size: 12px; font-weight: 700; color: var(--green);
        }
        .ctrl-warn-pill {
          background: rgba(245,158,11,.1); border-color: rgba(245,158,11,.25); color: var(--yellow);
        }
        .live-dot {
          width: 7px; height: 7px; border-radius: 50%;
          background: var(--green); flex-shrink: 0;
          animation: blink 1.2s ease-in-out infinite;
        }
        .live-dot-warn { background: var(--yellow); }
        @keyframes blink { 0%,100%{opacity:1} 50%{opacity:.3} }

        /* ── Control banner ────────────────────────────────────────────── */
        .ctrl-banner {
          display: flex; align-items: center; gap: 8px;
          padding: 9px 14px; border-radius: var(--r-sm);
          font-size: 12px; font-weight: 600; flex-shrink: 0;
        }
        .ctrl-banner-green {
          background: rgba(34,197,94,.1); border: 1px solid rgba(34,197,94,.25); color: var(--green);
        }
        .ctrl-banner-yellow {
          background: rgba(245,158,11,.1); border: 1px solid rgba(245,158,11,.25); color: var(--yellow);
        }

        /* ── Permission Modal ──────────────────────────────────────────── */
        .perm-overlay {
          position: fixed; inset: 0; z-index: 1000;
          background: rgba(0,0,0,.7); backdrop-filter: blur(6px);
          display: flex; align-items: center; justify-content: center;
        }
        .perm-modal {
          background: var(--bg2); border: 1px solid var(--border);
          border-radius: 16px; padding: 32px 28px;
          max-width: 380px; width: 90%; text-align: center;
          box-shadow: 0 24px 80px rgba(0,0,0,.6);
          animation: modal-in .2s ease;
        }
        @keyframes modal-in { from{transform:scale(.92);opacity:0} to{transform:scale(1);opacity:1} }
        .perm-icon {
          width: 56px; height: 56px; border-radius: 50%;
          background: rgba(59,130,246,.15); border: 1px solid rgba(59,130,246,.3);
          display: flex; align-items: center; justify-content: center;
          margin: 0 auto 16px; color: var(--accent);
        }
        .perm-title { font-size: 18px; font-weight: 800; margin-bottom: 10px; }
        .perm-body {
          font-size: 13px; color: var(--text-dim); line-height: 1.6; margin-bottom: 24px;
        }
        .perm-body strong { color: var(--text); }
        .perm-actions { display: flex; gap: 10px; }
        .perm-actions .btn { flex: 1; }

        /* ── Responsive ────────────────────────────────────────────────── */
        @media (max-width: 768px) {
          .sidebar { width: 100%; height: auto; flex-direction: row; flex-wrap: wrap; border-right: none; border-bottom: 1px solid var(--border); }
          .main { flex-direction: column; }
          .content { padding: 12px; }
        }

        /* ── Animations ────────────────────────────────────────────────── */
        @keyframes pulse-ring {
          0%   { box-shadow: 0 0 0 0 rgba(34,197,94,.4); }
          70%  { box-shadow: 0 0 0 8px rgba(34,197,94,0); }
          100% { box-shadow: 0 0 0 0 rgba(34,197,94,0); }
        }
        /* ── Local preview card ───────────────────────────────────────────── */
        .local-preview-card {
          flex-shrink: 0;
          background: var(--bg3); border: 1px solid rgba(59,130,246,.25);
          border-radius: var(--r); overflow: hidden;
          box-shadow: 0 0 0 1px rgba(59,130,246,.08), 0 4px 24px rgba(0,0,0,.3);
        }
        .local-preview-label {
          display: flex; align-items: center; gap: 7px;
          padding: 8px 12px; border-bottom: 1px solid var(--border);
          font-size: 11px; font-weight: 700; color: var(--accent);
        }
        .local-preview-video {
          width: 100%; max-height: 140px;
          object-fit: contain; display: block; background: #000;
        }

        /* ── Browser Control Panel ───────────────────────────────────────── */
        .browser-panel {
          flex-shrink: 0;
          background: var(--bg3); border: 1px solid rgba(59,130,246,.3);
          border-radius: var(--r); overflow: hidden;
          box-shadow: 0 0 30px rgba(59,130,246,.07);
        }
        .browser-panel-header {
          display: flex; align-items: center; gap: 8px;
          padding: 10px 14px; border-bottom: 1px solid var(--border);
          font-size: 12px; font-weight: 700; color: var(--accent);
          background: rgba(59,130,246,.06);
        }
        .browser-url-row {
          display: flex; gap: 6px; padding: 10px 12px;
          border-bottom: 1px solid var(--border);
        }
        .browser-url-input {
          flex: 1; background: var(--bg); border: 1px solid var(--border);
          border-radius: var(--r-sm); color: var(--text);
          font-family: var(--font-mono); font-size: 12px;
          padding: 7px 10px; outline: none; transition: border-color .15s;
        }
        .browser-url-input:focus { border-color: var(--accent); }
        .browser-nav-btns {
          display: flex; flex-wrap: wrap; gap: 6px; padding: 10px 12px;
          border-bottom: 1px solid var(--border);
        }
        .nav-btn {
          display: inline-flex; align-items: center; gap: 5px;
          padding: 6px 12px; border-radius: var(--r-sm);
          font-family: var(--font-ui); font-size: 12px; font-weight: 600;
          border: 1px solid var(--border); background: var(--bg);
          color: var(--text-dim); cursor: pointer; transition: all .15s;
        }
        .nav-btn:hover { border-color: var(--accent); color: var(--text); background: var(--accent-g); }
        .nav-btn-danger { border-color: rgba(239,68,68,.3); color: var(--red); }
        .nav-btn-danger:hover { background: rgba(239,68,68,.1); border-color: var(--red); }
        .browser-js-row {
          display: flex; gap: 6px; padding: 10px 12px; align-items: flex-end;
        }
        .browser-js-input {
          flex: 1; background: var(--bg); border: 1px solid var(--border);
          border-radius: var(--r-sm); color: var(--text);
          font-family: var(--font-mono); font-size: 11px;
          padding: 7px 10px; outline: none; resize: none; height: 56px;
          transition: border-color .15s;
        }
        .browser-js-input:focus { border-color: #f59e0b; }
        .nav-btn-js { border-color: rgba(245,158,11,.3); color: var(--yellow); }
        .nav-btn-js:hover { background: rgba(245,158,11,.1); border-color: var(--yellow); }

        .live-pulse { animation: pulse-ring 2s infinite; border-radius: 50%; }

        /* ── Mobile Control Panel ──────────────────────────────────────────── */
        .mobile-ctrl-panel {
          flex-shrink: 0;
          background: var(--bg3); border: 1px solid rgba(34,197,94,.3);
          border-radius: var(--r); overflow: hidden;
          box-shadow: 0 0 30px rgba(34,197,94,.07);
        }
        .mobile-ctrl-header {
          display: flex; align-items: center; gap: 8px;
          padding: 10px 14px; border-bottom: 1px solid var(--border);
          font-size: 12px; font-weight: 700; color: var(--green);
          background: rgba(34,197,94,.06);
        }
        .mobile-ctrl-section {
          padding: 10px 12px; border-bottom: 1px solid var(--border);
        }
        .mobile-ctrl-section:last-child { border-bottom: none; }
        .mobile-ctrl-section-label {
          font-size: 10px; font-weight: 700; letter-spacing: 1px;
          text-transform: uppercase; color: var(--text-mute);
          margin-bottom: 8px;
        }
        .mobile-ctrl-btns {
          display: flex; flex-wrap: wrap; gap: 6px;
        }
        .mobile-ctrl-btn {
          display: inline-flex; align-items: center; gap: 5px;
          padding: 7px 14px; border-radius: var(--r-sm);
          font-family: var(--font-ui); font-size: 12px; font-weight: 600;
          border: 1px solid var(--border); background: var(--bg);
          color: var(--text-dim); cursor: pointer; transition: all .15s;
        }
        .mobile-ctrl-btn:hover {
          border-color: var(--green); color: var(--text);
          background: rgba(34,197,94,.08);
        }
        .mobile-ctrl-btn:active { transform: scale(0.96); }
        .mobile-ctrl-btn-primary {
          border-color: rgba(34,197,94,.4); color: var(--green);
          background: rgba(34,197,94,.08);
        }
        .mobile-ctrl-btn-primary:hover {
          background: rgba(34,197,94,.15); border-color: var(--green);
        }
        .mobile-ctrl-btn-danger {
          border-color: rgba(239,68,68,.3); color: var(--red);
        }
        .mobile-ctrl-btn-danger:hover {
          background: rgba(239,68,68,.1); border-color: var(--red);
        }
        .mobile-ctrl-text-row {
          display: flex; gap: 6px; align-items: center;
        }
        .mobile-ctrl-text-input {
          flex: 1; background: var(--bg); border: 1px solid var(--border);
          border-radius: var(--r-sm); color: var(--text);
          font-family: var(--font-mono); font-size: 12px;
          padding: 8px 10px; outline: none; transition: border-color .15s;
        }
        .mobile-ctrl-text-input:focus { border-color: var(--green); }
        .mobile-ctrl-text-send {
          border-color: rgba(34,197,94,.4) !important;
          color: var(--green) !important; white-space: nowrap;
        }
        .mobile-ctrl-text-send:hover {
          background: rgba(34,197,94,.12) !important;
          border-color: var(--green) !important;
        }
      `}</style>

      <div className="app">
        {/* ── Topbar ─────────────────────────────────────────────────────── */}
        <header className="topbar">
          <div className="logo">
            <Zap size={20} className="logo-icon" />
            RemoteDesk<span className="logo-dot"> / </span>
            <span style={{ color: "var(--text-dim)", fontWeight: 400, fontSize: 14 }}>Web Console</span>
          </div>
          <div style={{ marginLeft: "auto", display: "flex", alignItems: "center", gap: 10 }}>
            <StatusBadge state={connState} />
            {isConnected && (
              <span className="stat-pill" style={{ fontSize: 11 }}>
                <Wifi size={10} /> WebRTC: {rtcState}
              </span>
            )}
            <Shield size={14} style={{ color: "var(--text-mute)" }} />
          </div>
        </header>

        <div className="main">
          {/* ── Sidebar ──────────────────────────────────────────────────── */}
          <aside className="sidebar">
            {/* Connection */}
            <div>
              <p className="section-label">Session</p>
              {!isConnected ? (
                <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                  <button className="btn btn-primary" onClick={createSession}
                    disabled={connState === "connecting"}>
                    <Monitor size={14} /> Create Session
                  </button>
                  <div className="divider" />
                  <input
                    className="input"
                    placeholder="Enter 9-digit ID"
                    value={inputSessId}
                    onChange={(e) => setInputSessId(e.target.value)}
                    maxLength={9}
                    onKeyDown={(e) => e.key === "Enter" && joinSession()}
                  />
                  <button className="btn btn-ghost" onClick={joinSession}
                    disabled={connState === "connecting" || inputSessId.length < 9}>
                    <ChevronRight size={14} /> Join Session
                  </button>
                </div>
              ) : (
                <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
                  <SessionID id={sessionId!} />
                  <p style={{ fontSize: 11, color: "var(--text-dim)", textAlign: "center" }}>
                    Share this ID with the host device
                  </p>
                  <button className="btn btn-danger" onClick={disconnect}>
                    <WifiOff size={14} /> Disconnect
                  </button>
                </div>
              )}
            </div>

            {/* Peers */}
            {isConnected && (
              <div>
                <p className="section-label">Peers ({peers.length})</p>
                <div className="peers-list">
                  {peers.length === 0 && (
                    <p style={{ fontSize: 12, color: "var(--text-mute)" }}>No peers connected</p>
                  )}
                  {peers.map((p, i) => (
                    <div className="peer-row" key={i}>
                      {p.platform === "desktop" ? <Monitor size={14} className="peer-icon" /> : <Smartphone size={14} className="peer-icon" />}
                      <span className="peer-role">{p.role}</span>
                      <span className="peer-platform">{p.platform}</span>
                      {p.ready && <span className="peer-ready">● LIVE</span>}
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* View Mode */}
            {isConnected && (
              <div>
                <p className="section-label">Mode</p>
                <div className="tabs">
                  <button className={`tab ${viewMode === "viewer" ? "active" : ""}`} onClick={() => setViewMode("viewer")}>
                    <Monitor size={12} /> Viewer
                  </button>
                  <button className={`tab ${viewMode === "controller" ? "active" : ""}`} onClick={() => setViewMode("controller")}>
                    <MousePointer2 size={12} /> Controller
                  </button>
                </div>
              </div>
            )}

            {/* ── Share Screen ──────────────────────────────────────── */}
            {isConnected && (
              <div>
                <p className="section-label">Share Screen</p>
                {!isSharing ? (
                  <button className="btn btn-primary" onClick={startSharing}
                    style={{ background: "linear-gradient(135deg,#3b82f6,#8b5cf6)" }}>
                    <Monitor size={14} /> Start Sharing
                  </button>
                ) : (
                  <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                    <div className="ctrl-active-pill">
                      <span className="live-dot" /> Sharing Live
                    </div>
                    <button className="btn btn-danger" onClick={stopSharing}>
                      <WifiOff size={14} /> Stop Sharing
                    </button>
                  </div>
                )}
                <p style={{ fontSize: 11, color: "var(--text-mute)", marginTop: 8, lineHeight: 1.5 }}>
                  {isSharing
                    ? "Your screen is visible to connected peers."
                    : "Share your tab or screen so others can view and control it."}
                </p>
              </div>
            )}

            {/* ── Remote Control Request ───────────────────────────────── */}
            {isConnected && hasPeers && (
              <div>
                <p className="section-label">Remote Control</p>
                {!controlActive && !isController && (
                  <button
                    className={`btn ${
                      controlStatus === "requesting" ? "btn-ghost" :
                      controlStatus === "granted"    ? "btn-primary" :
                      "btn-ghost"
                    }`}
                    onClick={requestControl}
                    disabled={controlStatus === "requesting"}
                    style={{ gap: 7 }}
                  >
                    <MousePointer2 size={14} />
                    {controlStatus === "requesting" ? "Waiting for permission…" :
                     controlStatus === "denied"     ? "Request Denied" :
                     "Request Control"}
                  </button>
                )}
                {controlActive && isController && (
                  <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                    <div className="ctrl-active-pill">
                      <span className="live-dot" />
                      Control Active
                    </div>
                    <button className="btn btn-danger" onClick={revokeControl}>
                      <WifiOff size={14} /> Release Control
                    </button>
                  </div>
                )}
                {controlActive && !isController && (
                  <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                    <div className="ctrl-active-pill ctrl-warn-pill">
                      <span className="live-dot live-dot-warn" />
                      Being Controlled
                    </div>
                    <button className="btn btn-danger" onClick={revokeControl}>
                      <Shield size={14} /> Revoke Access
                    </button>
                  </div>
                )}
              </div>
            )}

            {/* Keyboard */}
            {isConnected && viewMode === "controller" && (
              <div>
                <p className="section-label">Keyboard</p>
                <button className={`btn ${showKeyboard ? "btn-primary" : "btn-ghost"}`}
                  onClick={() => setShowKeyboard(v => !v)}>
                  <Keyboard size={14} /> {showKeyboard ? "Hide Keyboard" : "Show Keyboard"}
                </button>
                <KeyboardOverlay sendKey={sendKey} visible={showKeyboard} />
              </div>
            )}

            {/* Clipboard */}
            {isConnected && (
              <div>
                <p className="section-label">Clipboard</p>
                <div className="clip-area">
                  <input
                    className="input"
                    placeholder="Paste to sync…"
                    value={clipText}
                    onChange={(e) => setClipText(e.target.value)}
                  />
                  <button className="icon-btn" onClick={pushClipboard} title="Send clipboard">
                    <Clipboard size={14} />
                  </button>
                </div>
              </div>
            )}

            {/* ── Download Desktop App ─────────────────────────────────── */}
            <div>
              <p className="section-label">Desktop App</p>
              <div className="download-card">
                <div className="download-title">
                  <Download size={13} />
                  Download Host App
                  <span className="download-version">v1.0</span>
                </div>
                <p style={{ fontSize: 11, color: "var(--text-dim)", marginBottom: 10, lineHeight: 1.5 }}>
                  Install on the PC you want to control remotely. Requires Node.js 18+.
                </p>
                <div className="download-btns">
                  <a className="dl-btn" href="/downloads/RemoteDesk-Windows.exe" download="RemoteDesk-Windows.exe" title="Download for Windows">
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
                      <path d="M0 3.449L9.75 2.1v9.451H0m10.949-9.602L24 0v11.4H10.949M0 12.6h9.75v9.451L0 20.699M10.949 12.6H24V24l-12.9-1.801" />
                    </svg>
                    <div style={{ flex: 1, textAlign: "left" }}>
                      <div style={{ fontWeight: 700 }}>Windows</div>
                      <div style={{ fontSize: 10, color: "var(--text-mute)", marginTop: 1 }}>Direct Installer</div>
                    </div>
                    <span className="dl-btn-ext">.exe</span>
                  </a>
                  <a className="dl-btn" href="/downloads/RemoteDesk-macOS.dmg" download="RemoteDesk-macOS.dmg" title="Download for macOS">
                    <Apple size={14} />
                    <div style={{ flex: 1, textAlign: "left" }}>
                      <div style={{ fontWeight: 700 }}>macOS</div>
                      <div style={{ fontSize: 10, color: "var(--text-mute)", marginTop: 1 }}>Universal</div>
                    </div>
                    <span className="dl-btn-ext">.dmg</span>
                  </a>
                  <a className="dl-btn" href="/downloads/RemoteDesk-Linux.AppImage" download="RemoteDesk-Linux.AppImage" title="Download for Linux">
                    <Terminal size={14} />
                    <div style={{ flex: 1, textAlign: "left" }}>
                      <div style={{ fontWeight: 700 }}>Linux</div>
                      <div style={{ fontSize: 10, color: "var(--text-mute)", marginTop: 1 }}>Portable</div>
                    </div>
                    <span className="dl-btn-ext">.AppImage</span>
                  </a>
                </div>
              </div>
            </div>

            {/* ── Download Mobile App ──────────────────────────────────── */}
            <div>
              <p className="section-label">Mobile App</p>
              <div className="download-card-mobile">
                <div className="download-title download-title-mobile">
                  <Smartphone size={13} style={{ color: "var(--green)" }} />
                  RemoteDesk Mobile
                  <span className="download-version-mobile">v1.0</span>
                </div>
                <p style={{ fontSize: 11, color: "var(--text-dim)", marginBottom: 10, lineHeight: 1.5 }}>
                  View & control remote PCs from your phone or tablet.
                </p>
                <div className="download-btns">
                  {/* iOS — App Store */}
                  <a
                    className="dl-btn-ios"
                    href="https://apps.apple.com/app/remotedesk"
                    target="_blank"
                    rel="noopener noreferrer"
                    title="Download on the App Store"
                  >
                    <svg width="14" height="14" viewBox="0 0 814 1000" fill="currentColor" style={{ flexShrink: 0 }}>
                      <path d="M788.1 340.9c-5.8 4.5-108.2 62.2-108.2 190.5 0 148.4 130.3 200.9 134.2 202.2-.6 3.2-20.7 71.9-68.7 141.9-42.8 61.6-87.5 123.1-155.5 123.1s-85.5-39.5-164-39.5c-76 0-103.7 40.8-165.9 40.8s-105-43.4-150.3-109.2C80.6 680.8 1 576.9 1 470.8c0-204.6 132.4-312.6 261.7-312.6 69.6 0 127.7 45.5 170.8 45.5 41.5 0 107.3-47.6 183.9-47.6 29.3 0 108.2 3.2 162.8 57.7zm-156.3-175.3c30.2-35.5 51.6-84.7 51.6-133.9 0-6.9-.6-13.9-1.9-19.5-48.9 1.9-108.2 32.6-143.7 73.1-27.6 30.8-53.3 80-53.3 130.5 0 7.5 1.3 14.9 1.9 17.2 3.2.6 8.4 1.3 13.6 1.3 43.4 0 97.9-29.2 131.8-68.7z"/>
                    </svg>
                    <div style={{ flex: 1, textAlign: "left" }}>
                      <div style={{ fontWeight: 700, color: "#a78bfa" }}>iOS</div>
                      <div style={{ fontSize: 10, color: "var(--text-mute)", marginTop: 1 }}>App Store</div>
                    </div>
                    <span style={{ fontSize: 10, color: "#a78bfa", fontFamily: "var(--font-mono)" }}>↗</span>
                  </a>

                  <div className="dl-divider-mobile" />

                  {/* Android — Direct APK + Play Store */}
                  <a
                    className="dl-btn-android"
                    href="/downloads/RemoteDesk-Android.apk"
                    download="RemoteDesk-Android.apk"
                    title="Download APK for Android"
                  >
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" style={{ flexShrink: 0 }}>
                      <path d="M17.6 9.48l1.84-3.18c.16-.31.04-.69-.26-.85a.637.637 0 0 0-.83.22l-1.88 3.24a11.463 11.463 0 0 0-8.94 0L5.65 5.67a.643.643 0 0 0-.87-.2c-.28.18-.37.54-.22.83L6.4 9.48A10.78 10.78 0 0 0 1 18h22a10.78 10.78 0 0 0-5.4-8.52zM7 15.25a1.25 1.25 0 1 1 0-2.5 1.25 1.25 0 0 1 0 2.5zm10 0a1.25 1.25 0 1 1 0-2.5 1.25 1.25 0 0 1 0 2.5z"/>
                    </svg>
                    <div style={{ flex: 1, textAlign: "left" }}>
                      <div style={{ fontWeight: 700, color: "var(--green)" }}>Android</div>
                      <div style={{ fontSize: 10, color: "var(--text-mute)", marginTop: 1 }}>Direct APK</div>
                    </div>
                    <span style={{ fontSize: 10, color: "var(--text-mute)", fontFamily: "var(--font-mono)" }}>.apk</span>
                  </a>
                  <a
                    className="dl-btn-android"
                    href="https://play.google.com/store/apps/details?id=com.remotedesk"
                    target="_blank"
                    rel="noopener noreferrer"
                    title="Get it on Google Play"
                  >
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" style={{ flexShrink: 0 }}>
                      <path d="M3.18 23.76c.35.2.74.24 1.12.14l12.02-12.02-2.93-2.92L3.18 23.76zM20.7 10.06l-2.87-1.62-3.29 3.29 3.29 3.29 2.89-1.63c.82-.46.82-1.87-.02-2.33zM1.05 1.52C1.02 1.67 1 1.84 1 2.02v19.96c0 .18.02.35.05.5l12.32-12.32L1.05 1.52zM4.3.1L16.32 6.76 13.39 9.7 1.42.14C1.79.04 2.2.08 2.55.28L4.3.1z"/>
                    </svg>
                    <div style={{ flex: 1, textAlign: "left" }}>
                      <div style={{ fontWeight: 700, color: "var(--green)" }}>Android</div>
                      <div style={{ fontSize: 10, color: "var(--text-mute)", marginTop: 1 }}>Google Play</div>
                    </div>
                    <span style={{ fontSize: 10, color: "var(--green)", fontFamily: "var(--font-mono)" }}>↗</span>
                  </a>
                </div>
                <p className="store-badge-note">
                  <Shield size={9} style={{ flexShrink: 0, marginTop: 1 }} />
                  Enable "Unknown sources" to sideload the APK.
                </p>
              </div>
            </div>

          </aside>

          {/* ── Content ─────────────────────────────────────────────────── */}
          <main className="content">
            {/* ── Permission Modal (incoming control request) ───────────── */}
            {controlRequest && (
              <div className="perm-overlay">
                <div className="perm-modal">
                  <div className="perm-icon"><MousePointer2 size={28} /></div>
                  <h3 className="perm-title">Control Request</h3>
                  <p className="perm-body">
                    A <strong>{controlRequest.fromRole}</strong> ({controlRequest.fromPlatform}) is
                    requesting to control your screen. Do you want to allow this?
                  </p>
                  <div className="perm-actions">
                    <button className="btn btn-primary" onClick={grantControl}>
                      <Check size={14} /> Allow
                    </button>
                    <button className="btn btn-danger" onClick={denyControl}>
                      <WifiOff size={14} /> Deny
                    </button>
                  </div>
                </div>
              </div>
            )}

            {/* ── Active Control Banner ─────────────────────────────────── */}
            {controlActive && (
              <div className={`ctrl-banner ${isController ? "ctrl-banner-green" : "ctrl-banner-yellow"}`}>
                {isController ? (
                  <><MousePointer2 size={13} /> You have remote control — move carefully<span style={{marginLeft:"auto",fontSize:11,opacity:.7}}>ESC to release</span></>
                ) : (
                  <><Shield size={13} /> Your screen is being controlled remotely<span style={{marginLeft:"auto",fontSize:11,opacity:.7}}>Click "Revoke Access" to stop</span></>
                )}
              </div>
            )}

            {error && (
              <div className="error-bar">
                <AlertCircle size={15} />
                <span>{error}</span>
                <button className="icon-btn" onClick={() => setError(null)} style={{ marginLeft: "auto" }}>
                  <RotateCcw size={13} />
                </button>
              </div>
            )}

            {isConnected && (
              <div className="stats-row">
                <span className="stat-pill"><Zap size={10} /> {hostOnline ? "Host Online" : "Awaiting Host"}</span>
                <span className="stat-pill"><Wifi size={10} /> {peers.length} peer{peers.length !== 1 ? "s" : ""}</span>
                {sessionId && <span className="stat-pill" style={{ fontFamily: "var(--font-mono)" }}>#{sessionId}</span>}
              </div>
            )}

            <ScreenViewer
              videoRef={videoRef}
              containerRef={containerRef}
              sendPointer={viewMode === "controller" ? sendPointer : () => {}}
              sendScroll={viewMode === "controller" ? sendScroll : () => {}}
              active={hasVideo}
            />

            {/* ── Control Panels (shown to active controller) ──────────── */}
            {controlActive && isController && (
              isMobileSharer ? (
                <MobileControlPanel
                  sendRemoteAction={sendRemoteAction}
                  sendRemoteText={sendRemoteText}
                />
              ) : (
                <BrowserControlPanel
                  targetUrl={targetUrl}
                  setTargetUrl={setTargetUrl}
                  sendBrowserCmd={sendBrowserCmd}
                />
              )
            )}

            {/* ── Local screen-share preview ────────────────────────────── */}
            {isSharing && (
              <div className="local-preview-card">
                <div className="local-preview-label">
                  <span className="live-dot" style={{ width: 6, height: 6 }} />
                  Your Screen (preview)
                  <button className="icon-btn" onClick={stopSharing}
                    style={{ marginLeft: "auto", color: "var(--red)" }} title="Stop sharing">
                    <WifiOff size={12} />
                  </button>
                </div>
                <video
                  ref={localVideoRef}
                  autoPlay muted playsInline
                  className="local-preview-video"
                />
              </div>
            )}
          </main>
        </div>
      </div>
    </>
  );
}
