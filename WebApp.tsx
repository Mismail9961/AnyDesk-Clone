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
} from "lucide-react";

// ─── Config ───────────────────────────────────────────────────────────────────
const SERVER_URL = import.meta.env.VITE_SERVER_URL ?? "http://localhost:4000";

const ICE_SERVERS = [
  { urls: "stun:stun.l.google.com:19302" },
  { urls: "stun:stun1.l.google.com:19302" },
];

type ConnectionState = "idle" | "connecting" | "connected" | "error" | "disconnected";
type ViewMode = "viewer" | "controller";

interface PeerInfo { role: string; platform: string; ready: boolean; }
interface SessionSummary { id: string; peers: PeerInfo[]; }

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
    } catch (err: any) {
      setError(err.message);
      setConnState("error");
    }
  }, [inputSessId, createPC]);

  // ── Disconnect ──────────────────────────────────────────────────────────
  const disconnect = useCallback(() => {
    socketRef.current?.disconnect();
    pcRef.current?.close();
    pcRef.current = null;
    setSocket(null);
    setSessionId(null);
    setPeers([]);
    setConnState("idle");
    setError(null);
  }, [pcRef]);

  // ── Clipboard push ──────────────────────────────────────────────────────
  const pushClipboard = useCallback(() => {
    if (!socket || !sessionId || !clipText) return;
    socket.emit("clipboard:sync", { sessionId, text: clipText });
  }, [socket, sessionId, clipText]);

  const isConnected = connState === "connected";
  const hasVideo    = rtcState === "connected";
  const hostOnline  = peers.some(p => p.role === "host" && p.ready);

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
        .live-pulse { animation: pulse-ring 2s infinite; border-radius: 50%; }
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
          </aside>

          {/* ── Content ─────────────────────────────────────────────────── */}
          <main className="content">
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
          </main>
        </div>
      </div>
    </>
  );
}
