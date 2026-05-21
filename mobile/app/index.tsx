/**
 * ╔══════════════════════════════════════════════════════════╗
 * ║      RemoteDesk — Mobile Client (Expo / React Native)   ║
 * ║  Trackpad Mode · Viewer Mode · Android & iOS Support    ║
 * ╚══════════════════════════════════════════════════════════╝
 */

import React, {
  useState, useEffect, useRef, useCallback, useMemo,
} from "react";
import {
  View, Text, TextInput, TouchableOpacity, StyleSheet,
  Dimensions, Platform, PanResponder,
  StatusBar, SafeAreaView, ScrollView, Switch,
  NativeModules, Vibration,
} from "react-native";
import { io, Socket } from "socket.io-client";

// ─── WebRTC detection ─────────────────────────────────────────────────────────
// Strategy: try react-native-webrtc first (custom dev build), then browser native
let RTC: any = null;
let RTCSD: any = null;
let RTCIC: any = null;
let RTCViewComponent: any = null;
let nativeMediaDevices: any = null; // react-native-webrtc's mediaDevices
let webRTCAvailable = false;
let canShareScreen = false;
let isNativeWebRTC = false; // true = react-native-webrtc loaded

try {
  const webrtc = require("react-native-webrtc");
  RTC   = webrtc.RTCPeerConnection;
  RTCSD = webrtc.RTCSessionDescription;
  RTCIC = webrtc.RTCIceCandidate;
  RTCViewComponent = webrtc.RTCView;
  nativeMediaDevices = webrtc.mediaDevices;
  if (RTC) {
    webRTCAvailable = true;
    isNativeWebRTC = true;
  }
} catch {}

// Fallback: browser native WebRTC (works in Expo web)
if (!webRTCAvailable && typeof window !== "undefined" && (window as any).RTCPeerConnection) {
  RTC   = (window as any).RTCPeerConnection;
  RTCSD = (window as any).RTCSessionDescription;
  RTCIC = (window as any).RTCIceCandidate;
  webRTCAvailable = true;
}

// Screen sharing: native webrtc's getDisplayMedia OR browser's getDisplayMedia
if (isNativeWebRTC && nativeMediaDevices?.getDisplayMedia) {
  canShareScreen = true;
} else if (typeof navigator !== "undefined" && navigator.mediaDevices && (navigator.mediaDevices as any).getDisplayMedia) {
  canShareScreen = true;
}

// ─── Config ───────────────────────────────────────────────────────────────────
// ⚠️  Your PC's local IP on this WiFi network. Run `ipconfig` on Windows to verify.
const SERVER_URL = "http://192.168.3.107:4000";

const ICE_SERVERS = [
  { urls: "stun:stun.l.google.com:19302" },
  { urls: "stun:stun1.l.google.com:19302" },
  { urls: "stun:stun2.l.google.com:19302" },
  { urls: "stun:stun3.l.google.com:19302" },
];
const { width: SW, height: SH } = Dimensions.get("screen");

// ─── Native module stubs ──────────────────────────────────────────────────────
const AccessibilityModule = (NativeModules as any).RemoteDeskAccessibility ?? {
  isEnabled:         async () => false,
  openSettings:      async () => {},
  dispatchTap:       async (_x: number, _y: number) => {},
  dispatchLongTap:   async (_x: number, _y: number) => {},
  dispatchSwipe:     async (_x1: number, _y1: number, _x2: number, _y2: number, _dur: number) => {},
  dispatchPinch:     async (_cx: number, _cy: number, _factor: number) => {},
  dispatchText:      async (_text: string) => {},
  pressBack:         async () => {},
  pressHome:         async () => {},
  pressRecents:      async () => {},
  openNotifications: async () => {},
  lockScreen:        async () => {},
  powerDialog:       async () => {},
  takeScreenshot:    async () => {},
  toggleSplitScreen: async () => {},
  openQuickSettings: async () => {},
};

const ScreenControlModule = (NativeModules as any).RemoteDeskScreenControl ?? {
  startBroadcast: async () => {},
  stopBroadcast:  async () => {},
  sendTap:        async (_x: number, _y: number) => {},
  sendSwipe:      async (_x1: number, _y1: number, _x2: number, _y2: number) => {},
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

// ─── WebRTC Hook ──────────────────────────────────────────────────────────────
function useWebRTC(socket: Socket | null, sessionId: string) {
  const pcRef = useRef<any>(null);
  const [remoteStream, setRemoteStream] = useState<any>(null);
  const [localStream, setLocalStream] = useState<any>(null);
  const [rtcState, setRtcState] = useState("unavailable");
  const [isSharing, setIsSharing] = useState(false);

  // Refs so the useEffect callbacks can read latest values without re-running
  const localStreamRef = useRef<any>(null);
  const isSharingRef = useRef(false);

  const createPC = useCallback(async (initiator = false) => {
    if (!webRTCAvailable || !RTC) return null;
    const pc = new RTC({
      iceServers: ICE_SERVERS,
      iceCandidatePoolSize: 2,
    });
    pcRef.current = pc;
    setRtcState("new");

    pc.onicecandidate = ({ candidate }: any) => {
      if (candidate && socket && sessionId) {
        console.log("[ice] Sending candidate:", candidate.candidate?.substring(0, 50));
        socket.emit("rtc:ice", { sessionId, candidate });
      }
    };
    pc.ontrack = (e: any) => {
      console.log("[rtc] ontrack fired, got remote stream");
      setRemoteStream(e.streams?.[0] ?? null);
    };
    pc.oniceconnectionstatechange = () => {
      console.log("[ice] iceConnectionState:", pc.iceConnectionState);
    };
    pc.onconnectionstatechange = () => {
      console.log("[rtc] connectionState:", pc.connectionState);
      setRtcState(pc.connectionState ?? "unknown");
    };

    if (initiator) {
      pc.addTransceiver("video", { direction: "recvonly" });
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      socket?.emit("rtc:offer", { sessionId, offer });
    }
    return pc;
  }, [socket, sessionId]);

  // Start screen sharing
  const startSharing = useCallback(async () => {
    if (!canShareScreen || !socket || !sessionId) return;
    try {
      let stream: any;

      if (isNativeWebRTC && nativeMediaDevices?.getDisplayMedia) {
        stream = await nativeMediaDevices.getDisplayMedia({ video: true, audio: false });
      } else {
        stream = await (navigator.mediaDevices as any).getDisplayMedia({
          video: { displaySurface: "monitor" },
          audio: false,
          preferCurrentTab: false,
        });
      }

      // Store in both state and ref
      setLocalStream(stream);
      localStreamRef.current = stream;
      setIsSharing(true);
      isSharingRef.current = true;

      // Create peer connection and add tracks
      // Close any existing PC first
      pcRef.current?.close();
      const pc = await createPC(false);
      if (pc) {
        stream.getTracks().forEach((t: any) => pc.addTrack(t, stream));
        const offer = await pc.createOffer();
        await pc.setLocalDescription(offer);
        socket.emit("rtc:offer", { sessionId, offer });
        console.log("[share] Offer sent with screen tracks");
      }

      // Notify server
      socket.emit("screen:start", { sessionId });

      // Handle user stopping via browser/system "Stop sharing" button
      stream.getVideoTracks()[0].onended = () => {
        stopSharing();
      };
    } catch (err: any) {
      console.warn("[screen:share]", err.message);
      setIsSharing(false);
      isSharingRef.current = false;
    }
  }, [socket, sessionId, createPC]);

  // Stop screen sharing
  const stopSharing = useCallback(() => {
    const stream = localStreamRef.current;
    if (stream) {
      stream.getTracks().forEach((t: any) => t.stop());
      setLocalStream(null);
      localStreamRef.current = null;
    }
    setIsSharing(false);
    isSharingRef.current = false;
    // Remove tracks from peer connection
    if (pcRef.current) {
      const senders = pcRef.current.getSenders?.() ?? [];
      senders.forEach((s: any) => { try { pcRef.current.removeTrack(s); } catch {} });
    }
    socket?.emit("screen:stop", { sessionId });
  }, [socket, sessionId]);

  // RTC signaling event listeners — deps do NOT include isSharing/localStream
  useEffect(() => {
    if (!socket || !sessionId || !webRTCAvailable) return;

    const onOffer = async ({ offer }: any) => {
      console.log("[rtc] Received offer");
      // If we're sharing, don't overwrite our PC — we're the sender
      if (isSharingRef.current) {
        console.log("[rtc] Ignoring offer (we are the sharer)");
        return;
      }
      // ALWAYS create a fresh PC for receiving (old ones may be in failed state)
      if (pcRef.current) {
        pcRef.current.close();
        pcRef.current = null;
      }
      const pc = await createPC(false);
      if (!pc) return;
      await pc.setRemoteDescription(new RTCSD(offer));
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      socket.emit("rtc:answer", { sessionId, answer });
      console.log("[rtc] Sent answer");
    };
    const onAnswer = async ({ answer }: any) => {
      console.log("[rtc] Received answer");
      try { await pcRef.current?.setRemoteDescription(new RTCSD(answer)); } catch {}
    };
    const onIce = async ({ candidate }: any) => {
      try { await pcRef.current?.addIceCandidate(new RTCIC(candidate)); } catch {}
    };

    // When server asks us to re-offer (a new peer joined while we're sharing)
    const onReoffer = async () => {
      if (!isSharingRef.current || !localStreamRef.current) return;
      try {
        console.log("[reoffer] Re-sending offer for new peer");
        pcRef.current?.close();
        const pc = await createPC(false);
        if (!pc) return;
        localStreamRef.current.getTracks().forEach((t: any) => pc.addTrack(t, localStreamRef.current));
        const offer = await pc.createOffer();
        await pc.setLocalDescription(offer);
        socket.emit("rtc:offer", { sessionId, offer });
      } catch (err: any) {
        console.warn("[reoffer]", err.message);
      }
    };
    socket.on("rtc:offer",  onOffer);
    socket.on("rtc:answer", onAnswer);
    socket.on("rtc:ice",    onIce);
    socket.on("screen:reoffer", onReoffer);

    return () => {
      socket.off("rtc:offer",  onOffer);
      socket.off("rtc:answer", onAnswer);
      socket.off("rtc:ice",    onIce);
      socket.off("screen:reoffer", onReoffer);
      pcRef.current?.close();
      pcRef.current = null;
    };
  }, [socket, sessionId, createPC]);

  return { remoteStream, localStream, rtcState, pcRef, createPC, isSharing, startSharing, stopSharing };
}

// ─── Trackpad Panel ───────────────────────────────────────────────────────────
function TrackpadPanel({ socket, sessionId, enabled }: {
  socket: Socket | null; sessionId: string; enabled: boolean;
}) {
  const lastPos     = useRef({ x: 0, y: 0 });
  const tapTimer    = useRef<ReturnType<typeof setTimeout> | null>(null);
  const tapCount    = useRef(0);
  const SENSITIVITY = 1.8;

  const emit = useCallback((event: string, payload: object) => {
    if (!socket || !sessionId || !enabled) return;
    socket.emit(event, { sessionId, ...payload });
  }, [socket, sessionId, enabled]);

  const panResponder = useMemo(() => PanResponder.create({
    onStartShouldSetPanResponder:        () => true,
    onStartShouldSetPanResponderCapture: () => true,
    onMoveShouldSetPanResponder:         () => true,
    onMoveShouldSetPanResponderCapture:  () => true,

    onPanResponderGrant: (e) => {
      const { pageX, pageY } = e.nativeEvent;
      lastPos.current = { x: pageX, y: pageY };
    },

    onPanResponderMove: (e) => {
      const { pageX, pageY } = e.nativeEvent;
      const dx = (pageX - lastPos.current.x) * SENSITIVITY;
      const dy = (pageY - lastPos.current.y) * SENSITIVITY;
      lastPos.current = { x: pageX, y: pageY };
      emit("input:pointer", {
        type: "move",
        x: Math.max(0, Math.min(1, 0.5 + dx / SW)),
        y: Math.max(0, Math.min(1, 0.5 + dy / SH)),
      });
    },

    onPanResponderRelease: (e, gs) => {
      if (gs.numberActiveTouches === 0) {
        tapCount.current++;
        if (tapTimer.current) clearTimeout(tapTimer.current);
        tapTimer.current = setTimeout(() => {
          if (tapCount.current === 2) {
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
      <View style={styles.trackpad} {...panResponder.panHandlers}>
        <Text style={styles.trackpadHint}>Tap · Drag · Scroll</Text>
        <Text style={styles.trackpadSubHint}>Double-tap = right click</Text>
      </View>
      <View style={styles.scrollStrip} {...scrollResponder.panHandlers}>
        <Text style={styles.scrollLabel}>↕</Text>
      </View>
    </View>
  );
}

// ─── Keyboard Bar ─────────────────────────────────────────────────────────────
function KeyboardBar({ socket, sessionId }: { socket: Socket | null; sessionId: string }) {
  const [text, setText] = useState("");

  const sendKey = (key: string, modifiers: string[] = []) => {
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
            onPress={() => sendKey(k.key, (k as any).mod ?? [])}>
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

// ─── Remote Control Overlay (touch capture on video) ──────────────────────────
function RemoteControlOverlay({ socket, sessionId, enabled }: {
  socket: Socket | null; sessionId: string; enabled: boolean;
}) {
  const startPos = useRef({ x: 0, y: 0 });
  const startTime = useRef(0);
  const longTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const layoutRef = useRef({ w: 1, h: 1 });
  const [touchDot, setTouchDot] = useState<{ x: number; y: number } | null>(null);

  const panResponder = useMemo(() => PanResponder.create({
    onStartShouldSetPanResponder: () => enabled,
    onMoveShouldSetPanResponder: () => enabled,
    onPanResponderGrant: (e) => {
      const { locationX, locationY } = e.nativeEvent;
      startPos.current = { x: locationX, y: locationY };
      startTime.current = Date.now();
      // Show touch indicator
      setTouchDot({ x: locationX, y: locationY });
      // Long press detection (500ms)
      longTimer.current = setTimeout(() => {
        const nx = locationX / layoutRef.current.w;
        const ny = locationY / layoutRef.current.h;
        socket?.emit("remote:tap", { sessionId, x: nx, y: ny, long: true });
        Vibration.vibrate(20);
        longTimer.current = null;
      }, 500);
    },
    onPanResponderMove: (e) => {
      const { locationX, locationY } = e.nativeEvent;
      setTouchDot({ x: locationX, y: locationY });
      // If moved significantly, cancel long press
      const dx = Math.abs(locationX - startPos.current.x);
      const dy = Math.abs(locationY - startPos.current.y);
      if ((dx > 15 || dy > 15) && longTimer.current) {
        clearTimeout(longTimer.current);
        longTimer.current = null;
      }
    },
    onPanResponderRelease: (e) => {
      if (longTimer.current) clearTimeout(longTimer.current);
      longTimer.current = null;
      const { locationX, locationY } = e.nativeEvent;
      const dx = Math.abs(locationX - startPos.current.x);
      const dy = Math.abs(locationY - startPos.current.y);
      const dur = Date.now() - startTime.current;
      const w = layoutRef.current.w;
      const h = layoutRef.current.h;

      if (dx < 15 && dy < 15 && dur < 400) {
        // TAP
        const nx = locationX / w;
        const ny = locationY / h;
        socket?.emit("remote:tap", { sessionId, x: nx, y: ny, long: false });
        Vibration.vibrate(5);
      } else if (dx > 15 || dy > 15) {
        // SWIPE
        socket?.emit("remote:swipe", {
          sessionId,
          x1: startPos.current.x / w,
          y1: startPos.current.y / h,
          x2: locationX / w,
          y2: locationY / h,
          duration: Math.min(dur, 1000),
        });
        Vibration.vibrate(10);
      }
      setTimeout(() => setTouchDot(null), 200);
    },
  }), [socket, sessionId, enabled]);

  return (
    <View
      style={styles.controlOverlay}
      onLayout={(e) => {
        layoutRef.current = { w: e.nativeEvent.layout.width, h: e.nativeEvent.layout.height };
      }}
      {...panResponder.panHandlers}
    >
      {touchDot && (
        <View style={[styles.touchDot, { left: touchDot.x - 15, top: touchDot.y - 15 }]} />
      )}
      {!enabled && (
        <View style={styles.controlDisabledOverlay}>
          <Text style={styles.controlDisabledText}>🔒 Control not granted</Text>
        </View>
      )}
    </View>
  );
}

// ─── Control Permission Modal ─────────────────────────────────────────────────
function ControlPermissionModal({ visible, requester, onGrant, onDeny }: {
  visible: boolean;
  requester: { from: string; fromPlatform: string } | null;
  onGrant: () => void;
  onDeny: () => void;
}) {
  if (!visible || !requester) return null;
  return (
    <View style={styles.modalOverlay}>
      <View style={styles.modalCard}>
        <Text style={styles.modalIcon}>🎮</Text>
        <Text style={styles.modalTitle}>Remote Control Request</Text>
        <Text style={styles.modalBody}>
          A {requester.fromPlatform?.toUpperCase()} peer wants to control your device.{"\n\n"}
          They will be able to tap, swipe, and type on your screen.
        </Text>
        <View style={styles.modalBtnRow}>
          <TouchableOpacity style={styles.modalDenyBtn} onPress={onDeny}>
            <Text style={styles.modalDenyTxt}>Deny</Text>
          </TouchableOpacity>
          <TouchableOpacity style={styles.modalGrantBtn} onPress={onGrant}>
            <Text style={styles.modalGrantTxt}>Allow Control</Text>
          </TouchableOpacity>
        </View>
      </View>
    </View>
  );
}
export default function RemoteDeskApp() {
  const [phase,     setPhase]     = useState<"landing" | "connected">("landing");
  const [mode, setMode] = useState<"trackpad" | "viewer" | "control">("trackpad");
  const [sessionId, setSessionId] = useState("");
  const [inputId,   setInputId]   = useState("");
  const [socket,    setSocket]    = useState<Socket | null>(null);
  const [peers,     setPeers]     = useState<any[]>([]);
  const [connState, setConnState] = useState("idle");
  const [error,     setError]     = useState<string | null>(null);
  const [accessOk,  setAccessOk]  = useState(false);
  const [showKbd,   setShowKbd]   = useState(false);
  const socketRef = useRef<Socket | null>(null);

  const { remoteStream, localStream, rtcState, createPC, isSharing, startSharing, stopSharing } = useWebRTC(socket, sessionId);
  const [screenState, setScreenState] = useState<{ sharing: boolean; sharer: string | null; sharerPlatform: string | null }>({ sharing: false, sharer: null, sharerPlatform: null });

  // ── Remote Control State ──────────────────────────────────────────────────
  const [controlState, setControlState] = useState<{ active: boolean; controller: string | null; sharer: string | null }>({ active: false, controller: null, sharer: null });
  const [controlRequest, setControlRequest] = useState<{ from: string; fromPlatform: string } | null>(null);
  const [controlRequesting, setControlRequesting] = useState(false);

  // Am I the one being controlled?
  const imBeingControlled = controlState.active && controlState.sharer === socket?.id;
  // Am I the controller?
  const imController = controlState.active && controlState.controller === socket?.id;

  // Listen for screen sharing + control events
  useEffect(() => {
    if (!socket) return;
    const onScreenState = (data: any) => setScreenState(data);
    const onScreenDenied = (data: any) => setError(data.reason);
    const onControlState = (data: any) => {
      setControlState(data);
      setControlRequesting(false);
    };
    const onControlRequest = (data: any) => setControlRequest(data);
    const onControlDenied = (data: any) => {
      setError(data.reason);
      setControlRequesting(false);
    };

    // Execute remote input on this device (when someone controls us)
    const onRemoteTap = ({ x, y, long }: any) => {
      const px = Math.round(x * SW);
      const py = Math.round(y * SH);
      console.log(`[remote:exec] tap (${px}, ${py}) long=${long}`);
      if (Platform.OS === "android") {
        if (long) {
          AccessibilityModule.dispatchLongTap?.(px, py) ?? AccessibilityModule.dispatchTap(px, py);
        } else {
          AccessibilityModule.dispatchTap(px, py);
        }
      }
    };
    const onRemoteSwipe = ({ x1, y1, x2, y2, duration }: any) => {
      const px1 = Math.round(x1 * SW), py1 = Math.round(y1 * SH);
      const px2 = Math.round(x2 * SW), py2 = Math.round(y2 * SH);
      console.log(`[remote:exec] swipe (${px1},${py1}) → (${px2},${py2})`);
      if (Platform.OS === "android") {
        AccessibilityModule.dispatchSwipe(px1, py1, px2, py2, duration ?? 300);
      }
    };
    const onRemoteBack = () => {
      console.log("[remote:exec] back");
      if (Platform.OS === "android") {
        AccessibilityModule.pressBack?.();
      }
    };
    const onRemoteHome = () => {
      console.log("[remote:exec] home");
      if (Platform.OS === "android") {
        AccessibilityModule.pressHome?.();
      }
    };
    const onRemoteRecents = () => {
      console.log("[remote:exec] recents");
      if (Platform.OS === "android") {
        AccessibilityModule.pressRecents?.();
      }
    };
    const onRemoteNotifications = () => {
      console.log("[remote:exec] notifications");
      if (Platform.OS === "android") {
        AccessibilityModule.openNotifications?.();
      }
    };
    const onRemoteText = ({ text }: any) => {
      console.log(`[remote:exec] text (${text?.length} chars)`);
      if (Platform.OS === "android" && text) {
        AccessibilityModule.dispatchText?.(text);
      }
    };
    const onRemotePinch = ({ centerX, centerY, factor }: any) => {
      const px = Math.round((centerX ?? 0.5) * SW);
      const py = Math.round((centerY ?? 0.5) * SH);
      console.log(`[remote:exec] pinch (${px}, ${py}) factor=${factor}`);
      if (Platform.OS === "android") {
        AccessibilityModule.dispatchPinch?.(px, py, factor ?? 1.5);
      }
    };
    const onRemoteLockScreen = () => {
      console.log("[remote:exec] lock screen");
      if (Platform.OS === "android") {
        AccessibilityModule.lockScreen?.();
      }
    };
    const onRemotePowerDialog = () => {
      console.log("[remote:exec] power dialog");
      if (Platform.OS === "android") {
        AccessibilityModule.powerDialog?.();
      }
    };
    const onRemoteScreenshot = () => {
      console.log("[remote:exec] screenshot");
      if (Platform.OS === "android") {
        AccessibilityModule.takeScreenshot?.();
      }
    };
    const onRemoteSplitScreen = () => {
      console.log("[remote:exec] split screen");
      if (Platform.OS === "android") {
        AccessibilityModule.toggleSplitScreen?.();
      }
    };

    socket.on("screen:state",       onScreenState);
    socket.on("screen:denied",      onScreenDenied);
    socket.on("control:state",      onControlState);
    socket.on("control:request",    onControlRequest);
    socket.on("control:denied",     onControlDenied);
    socket.on("remote:tap",         onRemoteTap);
    socket.on("remote:swipe",       onRemoteSwipe);
    socket.on("remote:back",        onRemoteBack);
    socket.on("remote:home",        onRemoteHome);
    socket.on("remote:recents",     onRemoteRecents);
    socket.on("remote:notifications", onRemoteNotifications);
    socket.on("remote:text",        onRemoteText);
    socket.on("remote:pinch",       onRemotePinch);
    socket.on("remote:lock_screen", onRemoteLockScreen);
    socket.on("remote:power_dialog",onRemotePowerDialog);
    socket.on("remote:screenshot",  onRemoteScreenshot);
    socket.on("remote:split_screen",onRemoteSplitScreen);
    return () => {
      socket.off("screen:state",       onScreenState);
      socket.off("screen:denied",      onScreenDenied);
      socket.off("control:state",      onControlState);
      socket.off("control:request",    onControlRequest);
      socket.off("control:denied",     onControlDenied);
      socket.off("remote:tap",         onRemoteTap);
      socket.off("remote:swipe",       onRemoteSwipe);
      socket.off("remote:back",        onRemoteBack);
      socket.off("remote:home",        onRemoteHome);
      socket.off("remote:recents",     onRemoteRecents);
      socket.off("remote:notifications", onRemoteNotifications);
      socket.off("remote:text",        onRemoteText);
      socket.off("remote:pinch",       onRemotePinch);
      socket.off("remote:lock_screen", onRemoteLockScreen);
      socket.off("remote:power_dialog",onRemotePowerDialog);
      socket.off("remote:screenshot",  onRemoteScreenshot);
      socket.off("remote:split_screen",onRemoteSplitScreen);
    };
  }, [socket]);

  // Control actions
  const requestControl = useCallback(() => {
    socket?.emit("control:request", { sessionId });
    setControlRequesting(true);
  }, [socket, sessionId]);

  const grantControl = useCallback(() => {
    if (controlRequest) {
      socket?.emit("control:grant", { sessionId, to: controlRequest.from });
      setControlRequest(null);
    }
  }, [socket, sessionId, controlRequest]);

  const denyControl = useCallback(() => {
    if (controlRequest) {
      socket?.emit("control:deny", { sessionId, to: controlRequest.from });
      setControlRequest(null);
    }
  }, [socket, sessionId, controlRequest]);

  const revokeControl = useCallback(() => {
    socket?.emit("control:revoke", { sessionId });
  }, [socket, sessionId]);

  // ── Check accessibility permission (Android) ──────────────────────────────
  useEffect(() => {
    if (Platform.OS === "android") {
      AccessibilityModule.isEnabled().then(setAccessOk).catch(() => setAccessOk(false));
    } else {
      setAccessOk(true);
    }
  }, []);

  // ── Connect ───────────────────────────────────────────────────────────────
  const connect = useCallback(() => {
    const id = inputId.replace(/\s/g, "");
    if (!id || id.length !== 9) { setError("Enter a valid 9-digit session ID"); return; }

    setError(null);
    setConnState("connecting");

    const isNative = Platform.OS === "ios" || Platform.OS === "android";
    const platform = Platform.OS === "ios" ? "ios" : Platform.OS === "android" ? "android" : "browser";
    const sock = io(SERVER_URL, {
      auth: { role: isNative ? "mobile" : "web", platform },
      transports: ["websocket", "polling"],
      reconnectionAttempts: 8,
      reconnectionDelay: 2000,
    });
    socketRef.current = sock;

    sock.on("connect", () => {
      sock.emit("session:join", { sessionId: id }, async (res: any) => {
        if (res.error) { setError(res.error); setConnState("error"); return; }
        setSessionId(id);
        setPeers(res.summary.peers);
        setConnState("connected");
        setSocket(sock);
        setPhase("connected");

        sock.emit("peer:dimensions", { sessionId: id, width: SW, height: SH, dpr: 3 });

        if (Platform.OS === "ios") {
          try { await ScreenControlModule.startBroadcast(); } catch {}
        }
        await createPC(false);
      });
    });

    sock.on("peer:joined",     ({ summary }: any) => setPeers(summary.peers));
    sock.on("peer:left",       ({ summary }: any) => setPeers(summary.peers));
    sock.on("session:expired", () => { setPhase("landing"); setConnState("idle"); });
    sock.on("disconnect",      () => setConnState("disconnected"));
    sock.on("connect_error",   (e: any) => { setError(e.message); setConnState("error"); });

    sock.on("input:pointer", async ({ type, x, y, button }: any) => {
      if (Platform.OS === "android" && accessOk) {
        try { await AccessibilityModule.dispatchTap(x * SW, y * SH); } catch {}
      } else if (Platform.OS === "ios") {
        try { await ScreenControlModule.sendTap(x * SW, y * SH); } catch {}
      }
    });
  }, [inputId, createPC, accessOk]);

  // ── Create Session (via REST then join via Socket.IO) ───────────────────────
  const createSession = useCallback(async () => {
    setError(null);
    setConnState("connecting");
    try {
      // Step 1: Create session via REST (works in every environment)
      const resp = await fetch(`${SERVER_URL}/api/create-session`, { method: "POST" });
      const data = await resp.json();
      if (data.error) { setError(data.error); setConnState("error"); return; }
      const id = data.sessionId;

      // Step 2: Connect via Socket.IO and join the session we just created
      const isNative = Platform.OS === "ios" || Platform.OS === "android";
      const platform = Platform.OS === "ios" ? "ios" : Platform.OS === "android" ? "android" : "browser";
      const sock = io(SERVER_URL, {
        auth: { role: isNative ? "mobile" : "web", platform },
        transports: ["websocket", "polling"],
        reconnectionAttempts: 8,
        reconnectionDelay: 2000,
      });
      socketRef.current = sock;

      sock.on("connect", () => {
        sock.emit("session:join", { sessionId: id }, async (res: any) => {
          if (res.error) { setError(res.error); setConnState("error"); return; }
          setSessionId(id);
          setInputId(id);
          setPeers(res.summary.peers);
          setConnState("connected");
          setSocket(sock);
          setPhase("connected");
          sock.emit("peer:dimensions", { sessionId: id, width: SW, height: SH, dpr: 3 });
          await createPC(false);
        });
      });
      sock.on("peer:joined",     ({ summary }: any) => setPeers(summary.peers));
      sock.on("peer:left",       ({ summary }: any) => setPeers(summary.peers));
      sock.on("session:expired", () => { setPhase("landing"); setConnState("idle"); });
      sock.on("disconnect",      () => setConnState("disconnected"));
      sock.on("connect_error",   (e: any) => { setError(e.message); setConnState("error"); });
    } catch (err: any) {
      setError(`Cannot reach server: ${err.message}`);
      setConnState("error");
    }
  }, [createPC]);

  const disconnect = useCallback(() => {
    socketRef.current?.disconnect();
    setSocket(null);
    setPhase("landing");
    setConnState("idle");
    setSessionId("");
    setPeers([]);
    setError(null);
  }, []);

  // ── Landing screen ────────────────────────────────────────────────────────
  if (phase === "landing") {
    return (
      <SafeAreaView style={styles.safe}>
        <StatusBar barStyle="light-content" backgroundColor={T.bg} />
        <ScrollView contentContainerStyle={styles.landing} keyboardShouldPersistTaps="handled">

          {/* Brand */}
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

          {/* Create Session */}
          <TouchableOpacity
            style={[styles.createBtn, connState === "connecting" && styles.primaryBtnDisabled]}
            onPress={createSession}
            disabled={connState === "connecting"}
          >
            <Text style={styles.createBtnText}>⚡ Create New Session</Text>
            <Text style={styles.createBtnSub}>This device becomes the host</Text>
          </TouchableOpacity>

          {/* Divider */}
          <View style={styles.orRow}>
            <View style={styles.orLine} />
            <Text style={styles.orText}>OR JOIN EXISTING</Text>
            <View style={styles.orLine} />
          </View>

          {/* Session input */}
          <View style={styles.inputSection}>
            <Text style={styles.inputLabel}>Session ID</Text>
            <TextInput
              style={styles.sessionInput}
              value={inputId}
              onChangeText={setInputId}
              placeholder="123456789"
              placeholderTextColor={T.textMut}
              keyboardType="number-pad"
              maxLength={9}
            />
            <Text style={styles.inputHint}>
              Enter ID from web console or another device
            </Text>
          </View>

          {/* Error */}
          {error && (
            <View style={styles.errorRow}>
              <Text style={styles.errorText}>⚠ {error}</Text>
            </View>
          )}

          {/* Join button */}
          <TouchableOpacity
            style={[styles.primaryBtn, (connState === "connecting" || inputId.length < 9) && styles.primaryBtnDisabled]}
            onPress={connect}
            disabled={connState === "connecting" || inputId.length < 9}
          >
            <Text style={styles.primaryBtnText}>
              {connState === "connecting" ? "Connecting…" : "Join Session"}
            </Text>
          </TouchableOpacity>

          {/* Info pills */}
          <View style={styles.pillRow}>
            <View style={styles.pill}><Text style={styles.pillTxt}>🔒 WebRTC Encrypted</Text></View>
            <View style={styles.pill}><Text style={styles.pillTxt}>📱 {Platform.OS.toUpperCase()}</Text></View>
          </View>

          <Text style={styles.footnote}>
            Server: {SERVER_URL}
          </Text>
        </ScrollView>
      </SafeAreaView>
    );
  }

  // ── Connected screen ──────────────────────────────────────────────────────
  return (
    <SafeAreaView style={styles.safe}>
      <StatusBar barStyle="light-content" backgroundColor={T.bg} />

      {/* Header */}
      <View style={styles.header}>
        <View>
          <Text style={styles.headerTitle}>RemoteDesk</Text>
          <Text style={styles.headerSub}>
            #{sessionId} · {peers.length} peer{peers.length !== 1 ? "s" : ""}
          </Text>
        </View>
        <View style={styles.headerRight}>
          <View style={[
            styles.dot,
            { backgroundColor: connState === "connected" ? T.green : T.yellow }
          ]} />
          <Text style={styles.rtcBadge}>{rtcState}</Text>
          <TouchableOpacity style={styles.disconnectBtn} onPress={disconnect}>
            <Text style={styles.disconnectTxt}>✕</Text>
          </TouchableOpacity>
        </View>
      </View>

      {/* Screen sharing bar */}
      <View style={styles.shareBar}>
        {screenState.sharing && screenState.sharer !== socket?.id ? (
          <View style={styles.shareInfo}>
            <Text style={styles.shareInfoIcon}>🔴</Text>
            <Text style={styles.shareInfoText}>
              {screenState.sharerPlatform?.toUpperCase()} peer is sharing screen
            </Text>
          </View>
        ) : isSharing ? (
          <TouchableOpacity style={styles.shareStopBtn} onPress={stopSharing}>
            <Text style={styles.shareStopTxt}>⏹ Stop Sharing</Text>
          </TouchableOpacity>
        ) : canShareScreen ? (
          <TouchableOpacity
            style={[styles.shareStartBtn, screenState.sharing && styles.shareDisabled]}
            onPress={startSharing}
            disabled={screenState.sharing}
          >
            <Text style={styles.shareStartTxt}>
              {screenState.sharing ? "🔒 Another peer is sharing" : "📺 Share My Screen"}
            </Text>
          </TouchableOpacity>
        ) : (
          <Text style={styles.shareUnavailTxt}>Screen sharing requires a browser or custom build</Text>
        )}
      </View>

      {/* Control status banner */}
      {imBeingControlled && (
        <View style={styles.controlBanner}>
          <Text style={styles.controlBannerTxt}>🔴 Your device is being controlled remotely</Text>
          <TouchableOpacity style={styles.controlRevokeSmall} onPress={revokeControl}>
            <Text style={styles.controlRevokeTxt}>Revoke</Text>
          </TouchableOpacity>
        </View>
      )}
      {imController && (
        <View style={styles.controlBannerGreen}>
          <Text style={styles.controlBannerGreenTxt}>🎮 You are controlling this device</Text>
        </View>
      )}

      {/* Mode tabs */}
      <View style={styles.modeTabs}>
        {(["trackpad", "viewer", "control"] as const).map((m) => (
          <TouchableOpacity
            key={m}
            style={[styles.modeTab, mode === m && styles.modeTabActive]}
            onPress={() => setMode(m)}
          >
            <Text style={[styles.modeTabTxt, mode === m && styles.modeTabTxtActive]}>
              {m === "trackpad" ? "🖱 Trackpad" : m === "viewer" ? "📺 Viewer" : "🎮 Control"}
            </Text>
          </TouchableOpacity>
        ))}
      </View>

      {/* Content */}
      {mode === "trackpad" ? (
        <View style={styles.flex1}>
          <TrackpadPanel socket={socket} sessionId={sessionId} enabled={connState === "connected"} />
          {showKbd && <KeyboardBar socket={socket} sessionId={sessionId} />}
          <View style={styles.kbdToggleRow}>
            <Text style={styles.kbdToggleLabel}>⌨ Keyboard</Text>
            <Switch
              value={showKbd}
              onValueChange={setShowKbd}
              trackColor={{ false: T.border, true: T.accent }}
              thumbColor={T.text}
            />
          </View>

          {/* Local preview when sharing */}
          {isSharing && localStream && Platform.OS === "web" && (
            <View style={styles.localPreviewContainer}>
              <Text style={styles.localPreviewLabel}>🔴 You are sharing</Text>
              <video
                ref={(el: any) => { if (el && localStream) el.srcObject = localStream; }}
                autoPlay
                playsInline
                muted
                style={{ width: "100%", height: 120, objectFit: "contain", backgroundColor: "#000", borderRadius: 8 } as any}
              />
            </View>
          )}
        </View>
      ) : mode === "viewer" ? (
        <View style={styles.flex1}>
          {/* Local preview — you are sharing your own screen */}
          {isSharing && localStream && Platform.OS === "web" ? (
            <View style={styles.flex1}>
              <View style={styles.sharingBanner}>
                <Text style={styles.sharingBannerTxt}>🔴 Sharing your screen — others can see this</Text>
              </View>
              <video
                ref={(el: any) => { if (el && localStream) el.srcObject = localStream; }}
                autoPlay
                playsInline
                muted
                style={{ width: "100%", flex: 1, objectFit: "contain", backgroundColor: "#000" } as any}
              />
            </View>
          ) : remoteStream && Platform.OS === "web" ? (
            <View style={styles.flex1}>
              <video
                ref={(el: any) => { if (el && remoteStream) el.srcObject = remoteStream; }}
                autoPlay
                playsInline
                style={{ width: "100%", flex: 1, objectFit: "contain", backgroundColor: "#000" } as any}
              />
            </View>
          ) : remoteStream && RTCViewComponent ? (
            <RTCViewComponent
              streamURL={(remoteStream as any).toURL()}
              style={styles.remoteVideo}
              objectFit="contain"
            />
          ) : (
            <View style={styles.noStream}>
              <Text style={styles.noStreamIcon}>{screenState.sharing ? "📡" : "📺"}</Text>
              <Text style={styles.noStreamText}>
                {screenState.sharing
                  ? "Receiving stream…"
                  : "No one is sharing their screen"}
              </Text>
              <Text style={styles.noStreamSub}>
                {screenState.sharing
                  ? "WebRTC peer connection establishing"
                  : "Tap \"📺 Share My Screen\" above to share, or wait for a peer"}
              </Text>
            </View>
          )}
        </View>
      ) : (
        /* ─── Control Tab ─── */
        <View style={styles.flex1}>
          {/* Video with touch overlay */}
          {remoteStream && Platform.OS === "web" ? (
            <View style={styles.flex1}>
              <View style={{ flex: 1, position: "relative" } as any}>
                <video
                  ref={(el: any) => { if (el && remoteStream) el.srcObject = remoteStream; }}
                  autoPlay
                  playsInline
                  style={{ width: "100%", height: "100%", objectFit: "contain", backgroundColor: "#000" } as any}
                />
                <RemoteControlOverlay socket={socket} sessionId={sessionId} enabled={imController} />
              </View>
            </View>
          ) : remoteStream && RTCViewComponent ? (
            <View style={styles.flex1}>
              <RTCViewComponent
                streamURL={(remoteStream as any).toURL()}
                style={styles.remoteVideo}
                objectFit="contain"
              />
              <RemoteControlOverlay socket={socket} sessionId={sessionId} enabled={imController} />
            </View>
          ) : (
            <View style={styles.noStream}>
              <Text style={styles.noStreamIcon}>🎮</Text>
              <Text style={styles.noStreamText}>
                {screenState.sharing ? "Waiting for video stream…" : "No screen being shared"}
              </Text>
              <Text style={styles.noStreamSub}>
                Someone needs to share their screen first, then you can request control
              </Text>
            </View>
          )}

          {/* Control action bar */}
          <View style={styles.controlBar}>
            {!controlState.active && screenState.sharing && screenState.sharer !== socket?.id ? (
              <TouchableOpacity
                style={[styles.controlRequestBtn, controlRequesting && styles.shareDisabled]}
                onPress={requestControl}
                disabled={controlRequesting}
              >
                <Text style={styles.controlRequestTxt}>
                  {controlRequesting ? "⏳ Waiting for approval…" : "🎮 Request Control"}
                </Text>
              </TouchableOpacity>
            ) : imController ? (
              <View style={styles.controlActiveRow}>
                <Text style={styles.controlActiveTxt}>🎮 Controlling — tap on screen above</Text>
                {/* Android nav buttons */}
                <View style={styles.controlNavRow}>
                  <TouchableOpacity style={styles.controlNavBtn}
                    onPress={() => socket?.emit("remote:back", { sessionId })}>
                    <Text style={styles.controlNavTxt}>◀ Back</Text>
                  </TouchableOpacity>
                  <TouchableOpacity style={styles.controlNavBtn}
                    onPress={() => socket?.emit("remote:home", { sessionId })}>
                    <Text style={styles.controlNavTxt}>◉ Home</Text>
                  </TouchableOpacity>
                </View>
              </View>
            ) : isSharing && imBeingControlled ? (
              <TouchableOpacity style={styles.controlRevokeBtn} onPress={revokeControl}>
                <Text style={styles.controlRevokeBtnTxt}>🛑 Revoke Remote Control</Text>
              </TouchableOpacity>
            ) : isSharing ? (
              <Text style={styles.controlInfoTxt}>📡 You're sharing — waiting for control request</Text>
            ) : (
              <Text style={styles.controlInfoTxt}>
                {screenState.sharing ? "Someone is sharing — request control above" : "No active screen share"}
              </Text>
            )}
          </View>
        </View>
      )}

      {/* Permission modal */}
      <ControlPermissionModal
        visible={!!controlRequest}
        requester={controlRequest}
        onGrant={grantControl}
        onDeny={denyControl}
      />
    </SafeAreaView>
  );
}

// ─── Styles ───────────────────────────────────────────────────────────────────
const styles = StyleSheet.create({
  safe:  { flex: 1, backgroundColor: T.bg },
  flex1: { flex: 1 },

  // Landing
  landing:    { flexGrow: 1, padding: 28, alignItems: "center", justifyContent: "center", gap: 20 },
  brandRow:   { flexDirection: "row", alignItems: "center", gap: 12 },
  brandIcon:  { width: 48, height: 48, borderRadius: 14, backgroundColor: T.accent, alignItems: "center", justifyContent: "center" },
  brandIconText: { fontSize: 24 },
  brandName:  { fontSize: 30, fontWeight: "800", color: T.text, letterSpacing: -0.5 },
  tagline:    { fontSize: 16, color: T.textDim, textAlign: "center", lineHeight: 24 },

  permCard:  { backgroundColor: "#1a1100", borderWidth: 1, borderColor: "#3d2e00", borderRadius: 10, padding: 14, width: "100%" },
  permTitle: { color: T.yellow, fontWeight: "700", marginBottom: 6 },
  permBody:  { color: T.textDim, fontSize: 13, lineHeight: 18 },

  inputSection: { width: "100%", gap: 8 },
  inputLabel:   { color: T.textDim, fontSize: 11, fontWeight: "700", letterSpacing: 1.2, textTransform: "uppercase" },
  sessionInput: {
    backgroundColor: T.bg2, borderWidth: 1, borderColor: T.border,
    borderRadius: 12, color: T.text, paddingVertical: 14, paddingHorizontal: 20,
    fontSize: 22, textAlign: "center", letterSpacing: 8,
    fontFamily: Platform.OS === "ios" ? "Courier New" : "monospace",
  },
  inputHint: { color: T.textMut, fontSize: 11, textAlign: "center" },

  errorRow:  { backgroundColor: "rgba(239,68,68,.1)", borderWidth: 1, borderColor: "rgba(239,68,68,.2)", borderRadius: 8, padding: 12, width: "100%" },
  errorText: { color: T.red, fontSize: 13 },

  primaryBtn:         { backgroundColor: T.accent, borderRadius: 12, paddingVertical: 16, width: "100%", alignItems: "center" },
  primaryBtnDisabled: { backgroundColor: T.accentD, opacity: 0.6 },
  primaryBtnText:     { color: "#fff", fontSize: 16, fontWeight: "700" },

  pillRow: { flexDirection: "row", gap: 8 },
  pill:    { backgroundColor: T.bg3, borderWidth: 1, borderColor: T.border, borderRadius: 100, paddingVertical: 5, paddingHorizontal: 12 },
  pillTxt: { color: T.textDim, fontSize: 11, fontWeight: "600" },

  footnote: { color: T.textMut, fontSize: 11, textAlign: "center", lineHeight: 16 },

  // Create Session button
  createBtn:     { backgroundColor: "rgba(59,130,246,0.12)", borderWidth: 1, borderColor: "rgba(59,130,246,0.3)", borderRadius: 12, paddingVertical: 14, width: "100%", alignItems: "center", gap: 3 },
  createBtnText: { color: T.accent, fontSize: 15, fontWeight: "700" },
  createBtnSub:  { color: T.textDim, fontSize: 11 },

  // OR divider
  orRow:  { flexDirection: "row", alignItems: "center", width: "100%", gap: 10 },
  orLine: { flex: 1, height: 1, backgroundColor: T.border },
  orText: { color: T.textMut, fontSize: 10, fontWeight: "700", letterSpacing: 1 },

  // Header
  header:       { flexDirection: "row", alignItems: "center", padding: 14, borderBottomWidth: 1, borderBottomColor: T.border, backgroundColor: T.bg2 },
  headerTitle:  { color: T.text, fontWeight: "800", fontSize: 16 },
  headerSub:    { color: T.textDim, fontSize: 11, fontFamily: Platform.OS === "ios" ? "Courier New" : "monospace" },
  headerRight:  { marginLeft: "auto", flexDirection: "row", alignItems: "center", gap: 8 },
  dot:          { width: 8, height: 8, borderRadius: 4 },
  rtcBadge:     { color: T.textDim, fontSize: 10, fontFamily: Platform.OS === "ios" ? "Courier New" : "monospace" },
  disconnectBtn:{ backgroundColor: "rgba(239,68,68,.15)", borderRadius: 6, width: 30, height: 30, alignItems: "center", justifyContent: "center" },
  disconnectTxt:{ color: T.red, fontWeight: "700" },

  // Tabs
  modeTabs:       { flexDirection: "row", gap: 6, padding: 10, backgroundColor: T.bg2, borderBottomWidth: 1, borderBottomColor: T.border },
  modeTab:        { flex: 1, paddingVertical: 9, borderRadius: 8, alignItems: "center", backgroundColor: T.bg3, borderWidth: 1, borderColor: T.border },
  modeTabActive:  { backgroundColor: T.accent, borderColor: T.accent },
  modeTabTxt:     { color: T.textDim, fontWeight: "600", fontSize: 13 },
  modeTabTxtActive: { color: "#fff" },

  // Trackpad
  trackpadOuter:   { flex: 1, flexDirection: "row", padding: 12, gap: 10 },
  trackpad:        { flex: 1, backgroundColor: T.bg2, borderRadius: 16, borderWidth: 1, borderColor: T.border, alignItems: "center", justifyContent: "center" },
  trackpadHint:    { color: T.textMut, fontSize: 15, fontWeight: "600" },
  trackpadSubHint: { color: T.textMut, fontSize: 12, marginTop: 6 },
  scrollStrip:     { width: 44, backgroundColor: T.bg3, borderRadius: 12, borderWidth: 1, borderColor: T.border, alignItems: "center", justifyContent: "center" },
  scrollLabel:     { color: T.textDim, fontSize: 20 },

  // Keyboard
  keyboardBar: { backgroundColor: T.bg2, borderTopWidth: 1, borderTopColor: T.border, padding: 10, gap: 8 },
  keyRow:      { flexDirection: "row", gap: 6, flexWrap: "wrap" },
  keyBtn:      { backgroundColor: T.bg3, borderRadius: 6, paddingVertical: 8, paddingHorizontal: 12, borderWidth: 1, borderColor: T.border },
  keyLabel:    { color: T.text, fontSize: 12, fontWeight: "600" },
  typeRow:     { flexDirection: "row", gap: 8 },
  typeInput:   { flex: 1, backgroundColor: T.bg, borderRadius: 8, borderWidth: 1, borderColor: T.border, color: T.text, padding: 10, fontSize: 13 },
  sendBtn:     { backgroundColor: T.accent, borderRadius: 8, width: 44, alignItems: "center", justifyContent: "center" },
  sendLabel:   { color: "#fff", fontSize: 18 },
  kbdToggleRow:   { flexDirection: "row", alignItems: "center", padding: 12, borderTopWidth: 1, borderTopColor: T.border, gap: 10 },
  kbdToggleLabel: { color: T.textDim, fontSize: 13, flex: 1 },

  // Screen sharing bar
  shareBar:       { padding: 8, borderBottomWidth: 1, borderBottomColor: T.border, backgroundColor: T.bg2, alignItems: "center" },
  shareStartBtn:  { backgroundColor: "rgba(34,197,94,0.12)", borderWidth: 1, borderColor: "rgba(34,197,94,0.3)", borderRadius: 8, paddingVertical: 8, paddingHorizontal: 16 },
  shareStartTxt:  { color: T.green, fontSize: 13, fontWeight: "700" },
  shareStopBtn:   { backgroundColor: "rgba(239,68,68,0.12)", borderWidth: 1, borderColor: "rgba(239,68,68,0.3)", borderRadius: 8, paddingVertical: 8, paddingHorizontal: 16 },
  shareStopTxt:   { color: T.red, fontSize: 13, fontWeight: "700" },
  shareDisabled:  { opacity: 0.4 },
  shareInfo:      { flexDirection: "row", alignItems: "center", gap: 6 },
  shareInfoIcon:  { fontSize: 10 },
  shareInfoText:  { color: T.yellow, fontSize: 12, fontWeight: "600" },
  shareUnavailTxt:{ color: T.textMut, fontSize: 11 },

  // Viewer
  remoteVideo:  { flex: 1, backgroundColor: "#000" },
  noStream:     { flex: 1, alignItems: "center", justifyContent: "center", gap: 10 },
  noStreamIcon: { fontSize: 48 },
  noStreamText: { color: T.textDim, fontSize: 15, fontWeight: "600" },
  noStreamSub:  { color: T.textMut, fontSize: 12, textAlign: "center", paddingHorizontal: 40 },

  // Local preview
  localPreviewContainer: { padding: 8, borderTopWidth: 1, borderTopColor: T.border, backgroundColor: T.bg2 },
  localPreviewLabel:     { color: T.red, fontSize: 11, fontWeight: "700", marginBottom: 4, textAlign: "center" },

  // Sharing banner
  sharingBanner:    { backgroundColor: "rgba(239,68,68,0.1)", padding: 8, alignItems: "center", borderBottomWidth: 1, borderBottomColor: "rgba(239,68,68,0.2)" },
  sharingBannerTxt: { color: T.red, fontSize: 12, fontWeight: "700" },

  // Control banners
  controlBanner:         { flexDirection: "row", alignItems: "center", justifyContent: "space-between", padding: 8, backgroundColor: "rgba(239,68,68,0.12)", borderBottomWidth: 1, borderBottomColor: "rgba(239,68,68,0.25)" },
  controlBannerTxt:      { color: T.red, fontSize: 12, fontWeight: "700", flex: 1 },
  controlRevokeSmall:    { backgroundColor: "rgba(239,68,68,0.2)", borderRadius: 6, paddingVertical: 4, paddingHorizontal: 10 },
  controlRevokeTxt:      { color: T.red, fontSize: 11, fontWeight: "700" },
  controlBannerGreen:    { padding: 8, backgroundColor: "rgba(34,197,94,0.12)", borderBottomWidth: 1, borderBottomColor: "rgba(34,197,94,0.25)", alignItems: "center" },
  controlBannerGreenTxt: { color: T.green, fontSize: 12, fontWeight: "700" },

  // Control overlay (transparent layer on video for touch capture)
  controlOverlay:         { position: "absolute", top: 0, left: 0, right: 0, bottom: 0, zIndex: 10 },
  touchDot:               { position: "absolute", width: 30, height: 30, borderRadius: 15, backgroundColor: "rgba(59,130,246,0.4)", borderWidth: 2, borderColor: "rgba(59,130,246,0.8)" },
  controlDisabledOverlay: { ...StyleSheet.absoluteFillObject, alignItems: "center", justifyContent: "center", backgroundColor: "rgba(0,0,0,0.3)" },
  controlDisabledText:    { color: T.textDim, fontSize: 14, fontWeight: "700" },

  // Control action bar
  controlBar:          { padding: 10, borderTopWidth: 1, borderTopColor: T.border, backgroundColor: T.bg2, alignItems: "center", gap: 8 },
  controlRequestBtn:   { backgroundColor: "rgba(139,92,246,0.15)", borderWidth: 1, borderColor: "rgba(139,92,246,0.3)", borderRadius: 10, paddingVertical: 10, paddingHorizontal: 20, width: "100%", alignItems: "center" },
  controlRequestTxt:   { color: "#a78bfa", fontSize: 14, fontWeight: "700" },
  controlActiveRow:    { alignItems: "center", gap: 8, width: "100%" },
  controlActiveTxt:    { color: T.green, fontSize: 13, fontWeight: "700" },
  controlNavRow:       { flexDirection: "row", gap: 10, justifyContent: "center" },
  controlNavBtn:       { backgroundColor: T.bg3, borderWidth: 1, borderColor: T.border, borderRadius: 8, paddingVertical: 8, paddingHorizontal: 20 },
  controlNavTxt:       { color: T.text, fontSize: 13, fontWeight: "600" },
  controlRevokeBtn:    { backgroundColor: "rgba(239,68,68,0.12)", borderWidth: 1, borderColor: "rgba(239,68,68,0.3)", borderRadius: 10, paddingVertical: 10, paddingHorizontal: 20, width: "100%", alignItems: "center" },
  controlRevokeBtnTxt: { color: T.red, fontSize: 14, fontWeight: "700" },
  controlInfoTxt:      { color: T.textDim, fontSize: 12, textAlign: "center" },

  // Permission modal
  modalOverlay:  { position: "absolute", top: 0, left: 0, right: 0, bottom: 0, backgroundColor: "rgba(0,0,0,0.7)", alignItems: "center", justifyContent: "center", zIndex: 100 },
  modalCard:     { backgroundColor: T.bg2, borderRadius: 16, borderWidth: 1, borderColor: T.border, padding: 24, width: "85%", alignItems: "center", gap: 12 },
  modalIcon:     { fontSize: 48 },
  modalTitle:    { color: T.text, fontSize: 18, fontWeight: "800" },
  modalBody:     { color: T.textDim, fontSize: 13, textAlign: "center", lineHeight: 20 },
  modalBtnRow:   { flexDirection: "row", gap: 12, marginTop: 8 },
  modalDenyBtn:  { flex: 1, backgroundColor: "rgba(239,68,68,0.12)", borderWidth: 1, borderColor: "rgba(239,68,68,0.3)", borderRadius: 10, paddingVertical: 12, alignItems: "center" },
  modalDenyTxt:  { color: T.red, fontSize: 14, fontWeight: "700" },
  modalGrantBtn: { flex: 1, backgroundColor: "rgba(34,197,94,0.15)", borderWidth: 1, borderColor: "rgba(34,197,94,0.3)", borderRadius: 10, paddingVertical: 12, alignItems: "center" },
  modalGrantTxt: { color: T.green, fontSize: 14, fontWeight: "700" },
});
