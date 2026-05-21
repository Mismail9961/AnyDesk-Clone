/**
 * ╔══════════════════════════════════════════════════════════╗
 * ║      RemoteDesk — Mobile Client (Expo / React Native)   ║
 * ║  Trackpad Mode · Viewer Mode · Android & iOS Support    ║
 * ╚══════════════════════════════════════════════════════════╝
 *
 * Platforms
 *   Android — uses Accessibility Service via NativeModule (skeleton below)
 *   iOS     — uses ReplayKit (broadcast) + ScreenControl API protocol
 *
 * Install: see Setup.sh
 */

import React, {
  useState, useEffect, useRef, useCallback, useMemo,
} from "react";
import {
  View, Text, TextInput, TouchableOpacity, StyleSheet,
  Dimensions, Platform, Alert, PanResponder,
  StatusBar, SafeAreaView, ScrollView, Switch,
  NativeModules, NativeEventEmitter, Vibration,
} from "react-native";
import { io } from "socket.io-client";
import { RTCPeerConnection, RTCSessionDescription, RTCIceCandidate, mediaDevices, RTCView } from "react-native-webrtc";

// ─── Config ───────────────────────────────────────────────────────────────────
const SERVER_URL     = "http://192.168.18.6:5000"; // ← change in production
const ICE_SERVERS    = [
  { urls: "stun:stun.l.google.com:19302" },
  { urls: "stun:stun1.l.google.com:19302" },
];
const { width: SW, height: SH } = Dimensions.get("screen");

// ─── Native module stubs ──────────────────────────────────────────────────────

/**
 * Android Accessibility Service Module (stub)
 * Real implementation lives in:
 *   android/app/src/main/java/com/remotedesk/AccessibilityModule.java
 *
 * The Java class extends AccessibilityService and calls
 *   dispatchGesture(gestureDescription, callback, handler)
 * to inject taps/swipes at the OS level.
 */
const AccessibilityModule = NativeModules.RemoteDeskAccessibility ?? {
  isEnabled:     async () => false,
  openSettings:  async () => {},
  dispatchTap:   async (_x, _y) => {},
  dispatchSwipe: async (_x1, _y1, _x2, _y2, _dur) => {},
};

/**
 * iOS ScreenControl Module (stub)
 * Real implementation in:
 *   ios/RemoteDesk/ScreenControlModule.swift
 *
 * Uses XCTest private APIs (UIAutomation successor) in enterprise builds,
 * or the public ScreenControl protocol for MDM-managed devices.
 * ReplayKit broadcast is initiated via RPBroadcastActivityViewController.
 */
const ScreenControlModule = NativeModules.RemoteDeskScreenControl ?? {
  startBroadcast:    async () => {},
  stopBroadcast:     async () => {},
  sendTap:           async (_x, _y) => {},
  sendSwipe:         async (_x1, _y1, _x2, _y2) => {},
};

// ─── Design tokens ────────────────────────────────────────────────────────────
const T = {
  bg:      "#0b0c10",
  bg2:     "#111318",
  bg3:     "#181b22",
  border:  "#1e2330",
  accent:  "#3b82f6",
  accentD: "#1d4ed8",
  text:    "#e2e8f0",
  textDim: "#64748b",
  textMut: "#334155",
  red:     "#ef4444",
  green:   "#22c55e",
  yellow:  "#f59e0b",
};

// ─── Helpers ──────────────────────────────────────────────────────────────────
/** Normalize a screen coordinate to 0.0–1.0 */
const normX = (x) => Math.max(0, Math.min(1, x / SW));
const normY = (y) => Math.max(0, Math.min(1, y / SH));

// ─── WebRTC ───────────────────────────────────────────────────────────────────
function useWebRTC(socket, sessionId) {
  const pcRef        = useRef(null);
  const [remoteStream, setRemoteStream] = useState(null);
  const [rtcState,  setRtcState]  = useState("new");

  const createPC = useCallback(async (initiator = false) => {
    const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });
    pcRef.current = pc;

    pc.onicecandidate = ({ candidate }) => {
      if (candidate && socket && sessionId)
        socket.emit("rtc:ice", { sessionId, candidate });
    };

    pc.ontrack = (e) => {
      setRemoteStream(e.streams[0]);
    };

    pc.onconnectionstatechange = () => {
      setRtcState(pc.connectionState);
    };

    if (initiator) {
      // Add transceiver to receive video
      pc.addTransceiver("video", { direction: "recvonly" });
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      socket?.emit("rtc:offer", { sessionId, offer });
    }

    return pc;
  }, [socket, sessionId]);

  useEffect(() => {
    if (!socket || !sessionId) return;

    const onOffer = async ({ offer }) => {
      const pc = pcRef.current ?? await createPC(false);
      await pc.setRemoteDescription(new RTCSessionDescription(offer));
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      socket.emit("rtc:answer", { sessionId, answer });
    };

    const onAnswer = async ({ answer }) => {
      await pcRef.current?.setRemoteDescription(new RTCSessionDescription(answer));
    };

    const onIce = async ({ candidate }) => {
      try { await pcRef.current?.addIceCandidate(new RTCIceCandidate(candidate)); } catch {}
    };

    socket.on("rtc:offer",  onOffer);
    socket.on("rtc:answer", onAnswer);
    socket.on("rtc:ice",    onIce);

    return () => {
      socket.off("rtc:offer",  onOffer);
      socket.off("rtc:answer", onAnswer);
      socket.off("rtc:ice",    onIce);
      pcRef.current?.close();
      pcRef.current = null;
    };
  }, [socket, sessionId, createPC]);

  const startScreenCapture = useCallback(async () => {
    try {
      const stream = await mediaDevices.getDisplayMedia({ video: true });
      if (pcRef.current) {
        stream.getTracks().forEach(t => pcRef.current.addTrack(t, stream));
      }
      socket?.emit("rtc:ready", { sessionId });
      return stream;
    } catch (err) {
      console.error("[getDisplayMedia]", err.message);
      Alert.alert("Permission Denied", "Screen capture permission is required.");
      return null;
    }
  }, [socket, sessionId]);

  return { remoteStream, rtcState, pcRef, createPC, startScreenCapture };
}

// ─── Trackpad Panel ───────────────────────────────────────────────────────────
function TrackpadPanel({ socket, sessionId, enabled }) {
  const lastPos      = useRef({ x: 0, y: 0 });
  const tapTimer     = useRef(null);
  const tapCount     = useRef(0);
  const SENSITIVITY  = 1.8;

  const emit = useCallback((event, payload) => {
    if (!socket || !sessionId || !enabled) return;
    socket.emit(event, { sessionId, ...payload });
  }, [socket, sessionId, enabled]);

  const panResponder = useMemo(() => PanResponder.create({
    onStartShouldSetPanResponder:         () => true,
    onStartShouldSetPanResponderCapture:  () => true,
    onMoveShouldSetPanResponder:          () => true,
    onMoveShouldSetPanResponderCapture:   () => true,

    onPanResponderGrant: (e) => {
      const { pageX, pageY } = e.nativeEvent;
      lastPos.current = { x: pageX, y: pageY };
    },

    onPanResponderMove: (e, gs) => {
      const { pageX, pageY } = e.nativeEvent;
      const dx = (pageX - lastPos.current.x) * SENSITIVITY;
      const dy = (pageY - lastPos.current.y) * SENSITIVITY;
      lastPos.current = { x: pageX, y: pageY };
      // Send relative delta normalized to screen fraction
      emit("input:pointer", {
        type: "move",
        x: Math.max(0, Math.min(1, 0.5 + dx / SW)),
        y: Math.max(0, Math.min(1, 0.5 + dy / SH)),
      });
    },

    onPanResponderRelease: (e, gs) => {
      const { vx, vy } = gs;
      // Two-finger scroll gesture (fling)
      if (gs.numberActiveTouches === 0 && e.nativeEvent.touches?.length === 0) {
        tapCount.current++;
        clearTimeout(tapTimer.current);
        tapTimer.current = setTimeout(() => {
          if (tapCount.current === 2) {
            // double-tap → right click
            emit("input:pointer", { type: "click", x: 0.5, y: 0.5, button: "right" });
          } else {
            emit("input:pointer", { type: "click", x: 0.5, y: 0.5, button: "left" });
          }
          tapCount.current = 0;
        }, 250);
      }
      Vibration.vibrate(10);
    },
  }), [emit]);

  const scrollResponder = useMemo(() => PanResponder.create({
    onStartShouldSetPanResponder: () => true,
    onMoveShouldSetPanResponder:  () => true,
    onPanResponderMove: (_, gs) => {
      emit("input:scroll", { dx: gs.dx * 0.5, dy: gs.dy * 0.5 });
    },
  }), [emit]);

  return (
    <View style={styles.trackpadOuter}>
      {/* Main trackpad surface */}
      <View style={styles.trackpad} {...panResponder.panHandlers}>
        <Text style={styles.trackpadHint}>Tap · Drag · Scroll</Text>
        <Text style={styles.trackpadSubHint}>Double-tap = right click</Text>
      </View>
      {/* Scroll strip */}
      <View style={styles.scrollStrip} {...scrollResponder.panHandlers}>
        <Text style={styles.scrollLabel}>↕</Text>
      </View>
    </View>
  );
}

// ─── Keyboard bar ─────────────────────────────────────────────────────────────
function KeyboardBar({ socket, sessionId }) {
  const [text, setText] = useState("");

  const sendKey = (key, modifiers = []) => {
    socket?.emit("input:key", { sessionId, key, modifiers, eventType: "keydown" });
    Vibration.vibrate(5);
  };

  const onSubmit = () => {
    for (const ch of text) sendKey(ch);
    sendKey("Return");
    setText("");
  };

  const specialKeys = [
    { label: "⌫",  key: "Backspace" },
    { label: "Tab", key: "Tab" },
    { label: "Esc", key: "Escape" },
    { label: "↵",  key: "Return" },
    { label: "⌘C", key: "c", mod: ["meta"] },
    { label: "⌘V", key: "v", mod: ["meta"] },
    { label: "⌘Z", key: "z", mod: ["meta"] },
  ];

  return (
    <View style={styles.keyboardBar}>
      <View style={styles.keyRow}>
        {specialKeys.map((k) => (
          <TouchableOpacity key={k.label} style={styles.keyBtn}
            onPress={() => sendKey(k.key, k.mod ?? [])}>
            <Text style={styles.keyLabel}>{k.label}</Text>
          </TouchableOpacity>
        ))}
      </View>
      <View style={styles.typeRow}>
        <TextInput
          style={styles.typeInput}
          value={text}
          onChangeText={setText}
          placeholder="Type and send…"
          placeholderTextColor={T.textMut}
          returnKeyType="send"
          onSubmitEditing={onSubmit}
        />
        <TouchableOpacity style={styles.sendBtn} onPress={onSubmit}>
          <Text style={styles.sendLabel}>↵</Text>
        </TouchableOpacity>
      </View>
    </View>
  );
}

// ─── Android-specific gesture injection ──────────────────────────────────────
async function androidDispatchPointer(type, normX, normY, button) {
  if (Platform.OS !== "android") return;
  const px = normX * SW;
  const py = normY * SH;
  try {
    if (type === "click" || type === "down" || type === "up") {
      await AccessibilityModule.dispatchTap(px, py);
    }
  } catch (err) {
    console.warn("[android:dispatch]", err.message);
  }
}

// ─── iOS-specific ReplayKit broadcast ────────────────────────────────────────
async function iosStartBroadcast() {
  if (Platform.OS !== "ios") return;
  try {
    await ScreenControlModule.startBroadcast();
  } catch (err) {
    console.warn("[ios:broadcast]", err.message);
  }
}

// ─── Main Screen ──────────────────────────────────────────────────────────────
export default function MobileApp() {
  const [phase,       setPhase]       = useState("landing"); // landing | session | connected
  const [mode,        setMode]        = useState("trackpad"); // trackpad | viewer
  const [sessionId,   setSessionId]   = useState("");
  const [inputId,     setInputId]     = useState("");
  const [socket,      setSocket]      = useState(null);
  const [peers,       setPeers]       = useState([]);
  const [connState,   setConnState]   = useState("idle");
  const [error,       setError]       = useState(null);
  const [accessOk,    setAccessOk]    = useState(false);
  const [showKbd,     setShowKbd]     = useState(false);
  const socketRef = useRef(null);

  const { remoteStream, rtcState, createPC, startScreenCapture } =
    useWebRTC(socket, sessionId);

  // ── Check accessibility permission (Android) ────────────────────────────
  useEffect(() => {
    if (Platform.OS === "android") {
      AccessibilityModule.isEnabled().then(setAccessOk).catch(() => setAccessOk(false));
    } else {
      setAccessOk(true); // iOS uses different permission model
    }
  }, []);

  // ── Connect to server ───────────────────────────────────────────────────
  const connect = useCallback((role = "mobile") => {
    const id = inputId.replace(/\s/g, "");
    if (!id || id.length !== 9) { setError("Enter a valid 9-digit session ID"); return; }

    setError(null);
    setConnState("connecting");

    const sock = io(SERVER_URL, {
      auth: { role, platform: Platform.OS === "ios" ? "ios" : "android" },
      transports: ["websocket"],
      reconnectionAttempts: 8,
      reconnectionDelay: 2000,
    });
    socketRef.current = sock;

    sock.on("connect", () => {
      sock.emit("session:join", { sessionId: id }, async (res) => {
        if (res.error) { setError(res.error); setConnState("error"); return; }
        setSessionId(id);
        setPeers(res.summary.peers);
        setConnState("connected");
        setSocket(sock);
        setPhase("connected");

        // Advertise screen dimensions
        sock.emit("peer:dimensions", { sessionId: id, width: SW, height: SH, dpr: 3 });

        // Platform: start WebRTC
        if (Platform.OS === "ios") await iosStartBroadcast();
        await createPC(false);
      });
    });

    sock.on("peer:joined",     ({ summary }) => setPeers(summary.peers));
    sock.on("peer:left",       ({ summary }) => setPeers(summary.peers));
    sock.on("session:expired", () => { setPhase("landing"); setConnState("idle"); });
    sock.on("disconnect",      () => { setConnState("disconnected"); });
    sock.on("connect_error",   (e) => { setError(e.message); setConnState("error"); });

    // Input echo for local dispatch (mobile-as-host mode)
    sock.on("input:pointer", async ({ type, x, y, button }) => {
      if (Platform.OS === "android" && accessOk) {
        await androidDispatchPointer(type, x, y, button);
      } else if (Platform.OS === "ios") {
        await ScreenControlModule.sendTap(x * SW, y * SH).catch(() => {});
      }
    });

    sock.on("input:gesture", ({ gesture }) => {
      if (Platform.OS === "android" && gesture.type === "swipe") {
        AccessibilityModule.dispatchSwipe(
          gesture.x1 * SW, gesture.y1 * SH,
          gesture.x2 * SW, gesture.y2 * SH,
          gesture.duration ?? 300,
        ).catch(() => {});
      }
    });
  }, [inputId, createPC, accessOk]);

  const disconnect = useCallback(() => {
    socketRef.current?.disconnect();
    setSocket(null);
    setPhase("landing");
    setConnState("idle");
    setSessionId("");
    setPeers([]);
  }, []);

  // ── Render: Landing ─────────────────────────────────────────────────────
  if (phase === "landing") {
    return (
      <SafeAreaView style={styles.safe}>
        <StatusBar barStyle="light-content" backgroundColor={T.bg} />
        <ScrollView contentContainerStyle={styles.landing}>
          <View style={styles.brandRow}>
            <View style={styles.brandIcon}>
              <Text style={styles.brandIconText}>⚡</Text>
            </View>
            <Text style={styles.brandName}>RemoteDesk</Text>
          </View>
          <Text style={styles.tagline}>Full-spectrum remote control{"\n"}for any device.</Text>

          {/* Android permission notice */}
          {Platform.OS === "android" && !accessOk && (
            <TouchableOpacity style={styles.permCard}
              onPress={() => AccessibilityModule.openSettings()}>
              <Text style={styles.permTitle}>⚠ Accessibility Permission Required</Text>
              <Text style={styles.permBody}>
                Enable RemoteDesk in Accessibility Services to allow input injection.
                Tap to open settings.
              </Text>
            </TouchableOpacity>
          )}

          <View style={styles.inputSection}>
            <Text style={styles.inputLabel}>Session ID</Text>
            <TextInput
              style={styles.sessionInput}
              value={inputId}
              onChangeText={setInputId}
              placeholder="123 – 456 – 789"
              placeholderTextColor={T.textMut}
              keyboardType="number-pad"
              maxLength={9}
            />
          </View>

          {error && (
            <View style={styles.errorRow}>
              <Text style={styles.errorText}>⚠ {error}</Text>
            </View>
          )}

          <TouchableOpacity style={styles.primaryBtn}
            onPress={() => connect("mobile")}
            disabled={connState === "connecting"}>
            <Text style={styles.primaryBtnText}>
              {connState === "connecting" ? "Connecting…" : "Join as Remote"}
            </Text>
          </TouchableOpacity>

          <Text style={styles.footnote}>
            Encrypted P2P via WebRTC · {Platform.OS.toUpperCase()}
          </Text>
        </ScrollView>
      </SafeAreaView>
    );
  }

  // ── Render: Connected ───────────────────────────────────────────────────
  return (
    <SafeAreaView style={styles.safe}>
      <StatusBar barStyle="light-content" backgroundColor={T.bg} />

      {/* Header */}
      <View style={styles.header}>
        <View>
          <Text style={styles.headerTitle}>RemoteDesk</Text>
          <Text style={styles.headerSub}>#{sessionId} · {peers.length} peer{peers.length !== 1 ? "s" : ""}</Text>
        </View>
        <View style={styles.headerRight}>
          <View style={[styles.dot, { backgroundColor: connState === "connected" ? T.green : T.yellow }]} />
          <TouchableOpacity style={styles.disconnectBtn} onPress={disconnect}>
            <Text style={styles.disconnectTxt}>✕</Text>
          </TouchableOpacity>
        </View>
      </View>

      {/* Mode tabs */}
      <View style={styles.modeTabs}>
        {["trackpad", "viewer"].map((m) => (
          <TouchableOpacity key={m} style={[styles.modeTab, mode === m && styles.modeTabActive]}
            onPress={() => setMode(m)}>
            <Text style={[styles.modeTabTxt, mode === m && styles.modeTabTxtActive]}>
              {m === "trackpad" ? "🖱 Trackpad" : "📺 Viewer"}
            </Text>
          </TouchableOpacity>
        ))}
      </View>

      {/* Main area */}
      {mode === "trackpad" ? (
        <View style={styles.flex1}>
          <TrackpadPanel socket={socket} sessionId={sessionId} enabled={connState === "connected"} />
          {showKbd && <KeyboardBar socket={socket} sessionId={sessionId} />}
          <View style={styles.kbdToggleRow}>
            <Text style={styles.kbdToggleLabel}>Keyboard</Text>
            <Switch
              value={showKbd}
              onValueChange={setShowKbd}
              trackColor={{ false: T.border, true: T.accent }}
              thumbColor={T.text}
            />
          </View>
        </View>
      ) : (
        <View style={styles.flex1}>
          {remoteStream ? (
            <RTCView
              streamURL={remoteStream.toURL()}
              style={styles.remoteVideo}
              objectFit="contain"
            />
          ) : (
            <View style={styles.noStream}>
              <Text style={styles.noStreamIcon}>📡</Text>
              <Text style={styles.noStreamText}>
                {rtcState === "connected" ? "No video track" : `WebRTC: ${rtcState}`}
              </Text>
            </View>
          )}
        </View>
      )}
    </SafeAreaView>
  );
}

// ─── Styles ───────────────────────────────────────────────────────────────────
const styles = StyleSheet.create({
  safe:            { flex: 1, backgroundColor: T.bg },
  flex1:           { flex: 1 },

  // Landing
  landing:         { flexGrow: 1, padding: 28, alignItems: "center", justifyContent: "center", gap: 24 },
  brandRow:        { flexDirection: "row", alignItems: "center", gap: 12 },
  brandIcon:       { width: 44, height: 44, borderRadius: 12, backgroundColor: T.accent, alignItems: "center", justifyContent: "center" },
  brandIconText:   { fontSize: 22 },
  brandName:       { fontSize: 28, fontWeight: "800", color: T.text, letterSpacing: -0.5 },
  tagline:         { fontSize: 16, color: T.textDim, textAlign: "center", lineHeight: 24 },

  permCard:        { backgroundColor: "#1a1100", borderWidth: 1, borderColor: "#3d2e00", borderRadius: 10, padding: 14, width: "100%" },
  permTitle:       { color: T.yellow, fontWeight: "700", marginBottom: 6 },
  permBody:        { color: T.textDim, fontSize: 13, lineHeight: 18 },

  inputSection:    { width: "100%", gap: 8 },
  inputLabel:      { color: T.textDim, fontSize: 12, fontWeight: "700", letterSpacing: 1, textTransform: "uppercase" },
  sessionInput:    {
    backgroundColor: T.bg2, borderWidth: 1, borderColor: T.border,
    borderRadius: 10, color: T.text, padding: 14,
    fontSize: 20, textAlign: "center", letterSpacing: 6, fontFamily: Platform.OS === "ios" ? "Courier New" : "monospace",
  },

  errorRow:        { backgroundColor: "rgba(239,68,68,.1)", borderRadius: 8, padding: 10, width: "100%" },
  errorText:       { color: T.red, fontSize: 13 },

  primaryBtn:      { backgroundColor: T.accent, borderRadius: 10, paddingVertical: 15, width: "100%", alignItems: "center" },
  primaryBtnText:  { color: "#fff", fontSize: 16, fontWeight: "700" },

  footnote:        { color: T.textMut, fontSize: 11, textAlign: "center" },

  // Connected header
  header:          { flexDirection: "row", alignItems: "center", padding: 14, borderBottomWidth: 1, borderBottomColor: T.border, backgroundColor: T.bg2 },
  headerTitle:     { color: T.text, fontWeight: "800", fontSize: 16 },
  headerSub:       { color: T.textDim, fontSize: 11, fontFamily: Platform.OS === "ios" ? "Courier New" : "monospace" },
  headerRight:     { marginLeft: "auto", flexDirection: "row", alignItems: "center", gap: 10 },
  dot:             { width: 8, height: 8, borderRadius: 4 },
  disconnectBtn:   { backgroundColor: "rgba(239,68,68,.15)", borderRadius: 6, width: 30, height: 30, alignItems: "center", justifyContent: "center" },
  disconnectTxt:   { color: T.red, fontWeight: "700" },

  // Mode tabs
  modeTabs:        { flexDirection: "row", gap: 6, padding: 10, backgroundColor: T.bg2, borderBottomWidth: 1, borderBottomColor: T.border },
  modeTab:         { flex: 1, paddingVertical: 8, borderRadius: 8, alignItems: "center", backgroundColor: T.bg3, borderWidth: 1, borderColor: T.border },
  modeTabActive:   { backgroundColor: T.accent, borderColor: T.accent },
  modeTabTxt:      { color: T.textDim, fontWeight: "600", fontSize: 13 },
  modeTabTxtActive:{ color: "#fff" },

  // Trackpad
  trackpadOuter:   { flex: 1, flexDirection: "row", padding: 12, gap: 10 },
  trackpad:        {
    flex: 1, backgroundColor: T.bg2, borderRadius: 16,
    borderWidth: 1, borderColor: T.border,
    alignItems: "center", justifyContent: "center",
  },
  trackpadHint:    { color: T.textMut, fontSize: 14, fontWeight: "600" },
  trackpadSubHint: { color: T.textMut, fontSize: 11, marginTop: 4 },
  scrollStrip:     {
    width: 40, backgroundColor: T.bg3, borderRadius: 12,
    borderWidth: 1, borderColor: T.border,
    alignItems: "center", justifyContent: "center",
  },
  scrollLabel:     { color: T.textDim, fontSize: 18 },

  // Keyboard
  keyboardBar:     { backgroundColor: T.bg2, borderTopWidth: 1, borderTopColor: T.border, padding: 10, gap: 8 },
  keyRow:          { flexDirection: "row", gap: 6, flexWrap: "wrap" },
  keyBtn:          { backgroundColor: T.bg3, borderRadius: 6, paddingVertical: 7, paddingHorizontal: 10, borderWidth: 1, borderColor: T.border },
  keyLabel:        { color: T.text, fontSize: 12, fontWeight: "600" },
  typeRow:         { flexDirection: "row", gap: 8 },
  typeInput:       { flex: 1, backgroundColor: T.bg, borderRadius: 8, borderWidth: 1, borderColor: T.border, color: T.text, padding: 10, fontSize: 13 },
  sendBtn:         { backgroundColor: T.accent, borderRadius: 8, width: 44, alignItems: "center", justifyContent: "center" },
  sendLabel:       { color: "#fff", fontSize: 18 },

  kbdToggleRow:    { flexDirection: "row", alignItems: "center", padding: 12, borderTopWidth: 1, borderTopColor: T.border, gap: 10 },
  kbdToggleLabel:  { color: T.textDim, fontSize: 13, flex: 1 },

  // Viewer
  remoteVideo:     { flex: 1, backgroundColor: "#000" },
  noStream:        { flex: 1, alignItems: "center", justifyContent: "center", gap: 12 },
  noStreamIcon:    { fontSize: 48 },
  noStreamText:    { color: T.textDim, fontSize: 14 },
});
