/**
 * ╔══════════════════════════════════════════════════════════╗
 * ║          RemoteDesk Omni-System — Signaling Hub          ║
 * ║     Node.js + Socket.io | WebRTC Relay + Session Mgmt   ║
 * ╚══════════════════════════════════════════════════════════╝
 */

"use strict";

const http = require("http");
const { Server } = require("socket.io");
const crypto = require("crypto");

// ─── Constants ────────────────────────────────────────────────────────────────
const PORT           = process.env.PORT || 4000;
const SESSION_TTL_MS = 30 * 60 * 1000;   // 30 min idle expiry
const HEARTBEAT_MS   = 25 * 1000;
const MAX_SESSIONS   = 1000;

// ─── Session Store ────────────────────────────────────────────────────────────
/** @type {Map<string, Session>} sessionId → Session */
const sessions = new Map();
/** @type {Map<string, string>} socketId → sessionId */
const socketToSession = new Map();

// ─── Helpers ──────────────────────────────────────────────────────────────────
function generateSessionId() {
  let id, attempts = 0;
  do {
    const raw = crypto.randomBytes(4).readUInt32BE(0);
    id = String(100_000_000 + (raw % 900_000_000)); // 9 digits, no leading zero
    if (++attempts > 2000) throw new Error("Session ID space exhausted");
  } while (sessions.has(id));
  return id;
}

function now() { return Date.now(); }

function resetExpiry(session) {
  session.lastActivity = now();
  clearTimeout(session.expiryTimer);
  session.expiryTimer = setTimeout(() => expireSession(session.id), SESSION_TTL_MS);
}

function expireSession(sessionId) {
  const session = sessions.get(sessionId);
  if (!session) return;
  console.log(`[session] Expiring ${sessionId} (idle timeout)`);
  for (const [socketId] of session.peers) {
    const sock = io.sockets.sockets.get(socketId);
    if (sock) { sock.emit("session:expired", { sessionId, reason: "idle_timeout" }); sock.disconnect(true); }
    socketToSession.delete(socketId);
  }
  clearTimeout(session.expiryTimer);
  sessions.delete(sessionId);
}

function sessionSummary(session) {
  const peers = [];
  for (const [, p] of session.peers)
    peers.push({ role: p.role, platform: p.platform, ready: p.ready });
  return { id: session.id, peers, createdAt: session.createdAt, lastActivity: session.lastActivity };
}

// ─── HTTP Server ──────────────────────────────────────────────────────────────
const httpServer = http.createServer((req, res) => {
  // CORS headers for all requests
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") { res.writeHead(204); return res.end(); }

  if (req.url === "/health") {
    res.writeHead(200, { "Content-Type": "application/json" });
    return res.end(JSON.stringify({ status: "ok", sessions: sessions.size, uptime: process.uptime() }));
  }

  // REST endpoint to create a session (bypasses Socket.IO for reliability)
  if (req.url === "/api/create-session" && req.method === "POST") {
    try {
      if (sessions.size >= MAX_SESSIONS) {
        res.writeHead(503, { "Content-Type": "application/json" });
        return res.end(JSON.stringify({ error: "SERVER_CAPACITY" }));
      }
      const sessionId = generateSessionId();
      const session = {
        id: sessionId,
        peers: new Map(),
        createdAt: now(),
        lastActivity: now(),
        expiryTimer: null,
      };
      sessions.set(sessionId, session);
      resetExpiry(session);
      console.log(`[session] Created ${sessionId} via REST`);
      res.writeHead(200, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({ sessionId, summary: sessionSummary(session) }));
    } catch (err) {
      res.writeHead(500, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({ error: "CREATE_FAILED" }));
    }
  }

  // List active sessions (for debugging)
  if (req.url === "/api/sessions") {
    const list = [];
    for (const [id, s] of sessions) list.push(sessionSummary(s));
    res.writeHead(200, { "Content-Type": "application/json" });
    return res.end(JSON.stringify({ sessions: list }));
  }

  res.writeHead(404); res.end("RemoteDesk Signaling Server");
});

const io = new Server(httpServer, {
  cors: { origin: "*", methods: ["GET", "POST"] },
  pingInterval: HEARTBEAT_MS,
  pingTimeout: 10_000,
  transports: ["websocket", "polling"],
});

// ─── Auth Middleware ──────────────────────────────────────────────────────────
io.use((socket, next) => {
  const { role, platform } = socket.handshake.auth;
  const validRoles     = ["host", "mobile", "web"];
  const validPlatforms = ["desktop", "android", "ios", "browser"];
  if (!validRoles.includes(role))     return next(new Error("AUTH_INVALID_ROLE"));
  if (!validPlatforms.includes(platform)) return next(new Error("AUTH_INVALID_PLATFORM"));
  socket.data.role     = role;
  socket.data.platform = platform;
  next();
});

// ─── Connection Handler ───────────────────────────────────────────────────────
io.on("connection", (socket) => {
  console.log(`[+] ${socket.id} role=${socket.data.role} platform=${socket.data.platform}`);

  // ── session:create ───────────────────────────────────────────────────────
  socket.on("session:create", (_, ack) => {
    try {
      if (sessions.size >= MAX_SESSIONS) return ack?.({ error: "SERVER_CAPACITY" });
      const sessionId = generateSessionId();
      const session = {
        id: sessionId,
        peers: new Map(),
        createdAt: now(),
        lastActivity: now(),
        expiryTimer: null,
      };
      session.peers.set(socket.id, {
        socketId: socket.id, role: socket.data.role,
        platform: socket.data.platform, joinedAt: now(), ready: false,
      });
      sessions.set(sessionId, session);
      socketToSession.set(socket.id, sessionId);
      socket.join(sessionId);
      resetExpiry(session);
      console.log(`[session] Created ${sessionId} by ${socket.data.role}`);
      ack?.({ sessionId, summary: sessionSummary(session) });
    } catch (err) {
      console.error("[session:create]", err.message);
      ack?.({ error: "CREATE_FAILED" });
    }
  });

  // ── session:join ─────────────────────────────────────────────────────────
  socket.on("session:join", ({ sessionId }, ack) => {
    try {
      const session = sessions.get(String(sessionId));
      if (!session) return ack?.({ error: "SESSION_NOT_FOUND" });
      // Only one host allowed
      if (socket.data.role === "host") {
        for (const [, p] of session.peers)
          if (p.role === "host" && p.socketId !== socket.id)
            return ack?.({ error: "HOST_ALREADY_CONNECTED" });
      }
      session.peers.set(socket.id, {
        socketId: socket.id, role: socket.data.role,
        platform: socket.data.platform, joinedAt: now(), ready: false,
      });
      socketToSession.set(socket.id, String(sessionId));
      socket.join(String(sessionId));
      resetExpiry(session);
      socket.to(String(sessionId)).emit("peer:joined", {
        role: socket.data.role, platform: socket.data.platform,
        summary: sessionSummary(session),
      });
      console.log(`[session] ${socket.data.role} joined ${sessionId}`);

      // If someone is already sharing, tell the new joiner AND ask sharer to re-offer
      if (session.sharer) {
        const sharerPeer = session.peers.get(session.sharer);
        socket.emit("screen:state", {
          sharing: true,
          sharer: session.sharer,
          sharerRole: sharerPeer?.role,
          sharerPlatform: sharerPeer?.platform,
        });
        // Tell the sharer to re-send their WebRTC offer for the new peer
        io.to(session.sharer).emit("screen:reoffer", { newPeer: socket.id });
        console.log(`[screen] Asking sharer ${session.sharer} to re-offer for ${socket.id}`);
      }

      ack?.({ ok: true, summary: sessionSummary(session) });
    } catch (err) {
      console.error("[session:join]", err.message);
      ack?.({ error: "JOIN_FAILED" });
    }
  });

  // ── WebRTC Signaling relay ────────────────────────────────────────────────
  socket.on("rtc:offer",   ({ sessionId, offer })     => relay(socket, sessionId, "rtc:offer",   { from: socket.id, offer }));
  socket.on("rtc:answer",  ({ sessionId, answer })    => relay(socket, sessionId, "rtc:answer",  { from: socket.id, answer }));
  socket.on("rtc:ice",     ({ sessionId, candidate }) => relay(socket, sessionId, "rtc:ice",     { from: socket.id, candidate }));
  socket.on("rtc:ready",   ({ sessionId }) => {
    const session = sessions.get(sessionId);
    if (!session) return;
    const p = session.peers.get(socket.id);
    if (p) p.ready = true;
    relay(socket, sessionId, "rtc:peer_ready", { from: socket.id, summary: sessionSummary(session) });
  });

  // ── Normalized Input Events (0.0–1.0 coordinate space) ───────────────────
  socket.on("input:pointer", ({ sessionId, type, x, y, button }) => {
    if (typeof x !== "number" || typeof y !== "number" || x < 0 || x > 1 || y < 0 || y > 1) return;
    relay(socket, sessionId, "input:pointer", { from: socket.id, type, x, y, button: button ?? "left" });
  });
  socket.on("input:scroll",  ({ sessionId, dx, dy })              => relay(socket, sessionId, "input:scroll",  { from: socket.id, dx, dy }));
  socket.on("input:key",     ({ sessionId, key, modifiers, eventType }) =>
    relay(socket, sessionId, "input:key", { from: socket.id, key, modifiers: modifiers ?? [], eventType }));
  socket.on("input:gesture", ({ sessionId, gesture })             => relay(socket, sessionId, "input:gesture", { from: socket.id, gesture }));

  // ── Clipboard sync ────────────────────────────────────────────────────────
  socket.on("clipboard:sync", ({ sessionId, text }) => {
    if (typeof text !== "string" || text.length > 100_000) return;
    relay(socket, sessionId, "clipboard:sync", { from: socket.id, text });
  });

  // ── Screen sharing management ─────────────────────────────────────────────
  socket.on("screen:start", ({ sessionId }) => {
    const session = sessions.get(sessionId);
    if (!session) return;
    // Only one sharer at a time
    if (session.sharer && session.sharer !== socket.id) {
      socket.emit("screen:denied", { reason: "Another peer is already sharing" });
      return;
    }
    session.sharer = socket.id;
    const p = session.peers.get(socket.id);
    console.log(`[screen] ${socket.id} started sharing in ${sessionId}`);
    io.to(sessionId).emit("screen:state", {
      sharing: true,
      sharer: socket.id,
      sharerRole: p?.role,
      sharerPlatform: p?.platform,
    });
  });

  socket.on("screen:stop", ({ sessionId }) => {
    const session = sessions.get(sessionId);
    if (!session) return;
    if (session.sharer === socket.id) {
      session.sharer = null;
      console.log(`[screen] ${socket.id} stopped sharing in ${sessionId}`);
      io.to(sessionId).emit("screen:state", {
        sharing: false,
        sharer: null,
        sharerRole: null,
        sharerPlatform: null,
      });
    }
  });

  // ── Remote Control ────────────────────────────────────────────────────────
  // Host requests control of the sharer's device
  socket.on("control:request", ({ sessionId }) => {
    const session = sessions.get(sessionId);
    if (!session || !session.sharer) return;
    if (session.controller) {
      socket.emit("control:denied", { reason: "Another peer already has control" });
      return;
    }
    // Send request to the sharer
    const sharerPeer = session.peers.get(session.sharer);
    io.to(session.sharer).emit("control:request", {
      from: socket.id,
      fromPlatform: socket.data.platform,
      fromRole: socket.data.role,
    });
    console.log(`[control] ${socket.id} requests control of ${session.sharer} in ${sessionId}`);
  });

  // Sharer grants control
  socket.on("control:grant", ({ sessionId, to }) => {
    const session = sessions.get(sessionId);
    if (!session || session.sharer !== socket.id) return;
    session.controller = to;
    console.log(`[control] ${socket.id} granted control to ${to} in ${sessionId}`);
    io.to(sessionId).emit("control:state", {
      active: true,
      controller: to,
      sharer: socket.id,
    });
  });

  // Sharer denies control
  socket.on("control:deny", ({ sessionId, to }) => {
    const session = sessions.get(sessionId);
    if (!session) return;
    io.to(to).emit("control:denied", { reason: "Access denied by the device owner" });
    console.log(`[control] ${socket.id} denied control to ${to} in ${sessionId}`);
  });

  // Sharer revokes control
  socket.on("control:revoke", ({ sessionId }) => {
    const session = sessions.get(sessionId);
    if (!session) return;
    const oldController = session.controller;
    session.controller = null;
    console.log(`[control] Control revoked in ${sessionId}`);
    io.to(sessionId).emit("control:state", {
      active: false,
      controller: null,
      sharer: session.sharer,
    });
  });

  // Remote input events — routed ONLY to the sharer (not broadcast)
  socket.on("remote:tap", ({ sessionId, x, y, long }) => {
    const session = sessions.get(sessionId);
    if (!session || session.controller !== socket.id) return;
    if (typeof x !== "number" || typeof y !== "number" || x < 0 || x > 1 || y < 0 || y > 1) return;
    io.to(session.sharer).emit("remote:tap", { from: socket.id, x, y, long: !!long });
    console.log(`[remote] tap (${x.toFixed(2)}, ${y.toFixed(2)}) ${long ? "LONG" : ""}`);
  });

  socket.on("remote:swipe", ({ sessionId, x1, y1, x2, y2, duration }) => {
    const session = sessions.get(sessionId);
    if (!session || session.controller !== socket.id) return;
    io.to(session.sharer).emit("remote:swipe", { from: socket.id, x1, y1, x2, y2, duration: duration ?? 300 });
    console.log(`[remote] swipe (${x1?.toFixed(2)},${y1?.toFixed(2)}) → (${x2?.toFixed(2)},${y2?.toFixed(2)})`);
  });

  socket.on("remote:key", ({ sessionId, key, modifiers }) => {
    const session = sessions.get(sessionId);
    if (!session || session.controller !== socket.id) return;
    io.to(session.sharer).emit("remote:key", { from: socket.id, key, modifiers: modifiers ?? [] });
    console.log(`[remote] key "${key}"`);
  });

  socket.on("remote:back", ({ sessionId }) => {
    const session = sessions.get(sessionId);
    if (!session || session.controller !== socket.id) return;
    io.to(session.sharer).emit("remote:back", { from: socket.id });
    console.log(`[remote] back button`);
  });

  socket.on("remote:home", ({ sessionId }) => {
    const session = sessions.get(sessionId);
    if (!session || session.controller !== socket.id) return;
    io.to(session.sharer).emit("remote:home", { from: socket.id });
    console.log(`[remote] home button`);
  });

  socket.on("remote:recents", ({ sessionId }) => {
    const session = sessions.get(sessionId);
    if (!session || session.controller !== socket.id) return;
    io.to(session.sharer).emit("remote:recents", { from: socket.id });
    console.log(`[remote] recents`);
  });

  socket.on("remote:notifications", ({ sessionId }) => {
    const session = sessions.get(sessionId);
    if (!session || session.controller !== socket.id) return;
    io.to(session.sharer).emit("remote:notifications", { from: socket.id });
    console.log(`[remote] notifications`);
  });

  socket.on("remote:text", ({ sessionId, text }) => {
    const session = sessions.get(sessionId);
    if (!session || session.controller !== socket.id) return;
    if (typeof text !== "string" || text.length > 10_000) return;
    io.to(session.sharer).emit("remote:text", { from: socket.id, text });
    console.log(`[remote] text (${text.length} chars)`);
  });

  socket.on("remote:pinch", ({ sessionId, centerX, centerY, factor }) => {
    const session = sessions.get(sessionId);
    if (!session || session.controller !== socket.id) return;
    io.to(session.sharer).emit("remote:pinch", { from: socket.id, centerX, centerY, factor });
    console.log(`[remote] pinch factor=${factor}`);
  });

  socket.on("remote:lock_screen", ({ sessionId }) => {
    const session = sessions.get(sessionId);
    if (!session || session.controller !== socket.id) return;
    io.to(session.sharer).emit("remote:lock_screen", { from: socket.id });
    console.log(`[remote] lock screen`);
  });

  socket.on("remote:power_dialog", ({ sessionId }) => {
    const session = sessions.get(sessionId);
    if (!session || session.controller !== socket.id) return;
    io.to(session.sharer).emit("remote:power_dialog", { from: socket.id });
    console.log(`[remote] power dialog`);
  });

  socket.on("remote:screenshot", ({ sessionId }) => {
    const session = sessions.get(sessionId);
    if (!session || session.controller !== socket.id) return;
    io.to(session.sharer).emit("remote:screenshot", { from: socket.id });
    console.log(`[remote] screenshot`);
  });

  socket.on("remote:split_screen", ({ sessionId }) => {
    const session = sessions.get(sessionId);
    if (!session || session.controller !== socket.id) return;
    io.to(session.sharer).emit("remote:split_screen", { from: socket.id });
    console.log(`[remote] split screen`);
  });

  // ── Browser commands (controller → sharer) ────────────────────────────────
  // Allows the active controller to send browser-level commands to the sharer
  socket.on("browser:cmd", ({ sessionId, type, payload }) => {
    const session = sessions.get(sessionId);
    if (!session || session.controller !== socket.id) return;
    if (!session.sharer) return;
    const ALLOWED = ["navigate","reload","back","forward","close","open","scroll_top","scroll_bottom","execute_js"];
    if (!ALLOWED.includes(type)) return;
    io.to(session.sharer).emit("browser:cmd", { from: socket.id, type, payload: payload ?? {} });
    console.log(`[browser:cmd] ${type} → ${session.sharer}`);
  });

  // ── Screen dimensions for coordinate mapping ──────────────────────────────
  socket.on("peer:dimensions", ({ sessionId, width, height, dpr }) => {
    const session = sessions.get(sessionId);
    if (!session) return;
    const p = session.peers.get(socket.id);
    if (p) Object.assign(p, { screenWidth: width, screenHeight: height, dpr });
    relay(socket, sessionId, "peer:dimensions", { from: socket.id, width, height, dpr });
  });

  // ── Disconnect ────────────────────────────────────────────────────────────
  socket.on("disconnect", (reason) => {
    console.log(`[-] ${socket.id} disconnected: ${reason}`);
    const sessionId = socketToSession.get(socket.id);
    if (!sessionId) return;
    const session = sessions.get(sessionId);
    if (!session) return;
    const peer = session.peers.get(socket.id);

    // If the disconnecting peer was the screen sharer, clear sharing + control
    if (session.sharer === socket.id) {
      session.sharer = null;
      session.controller = null;
      console.log(`[screen] Sharer ${socket.id} disconnected, sharing + control stopped`);
      io.to(sessionId).emit("screen:state", {
        sharing: false, sharer: null, sharerRole: null, sharerPlatform: null,
      });
      io.to(sessionId).emit("control:state", {
        active: false, controller: null, sharer: null,
      });
    }

    // If the disconnecting peer was the controller, clear control
    if (session.controller === socket.id) {
      session.controller = null;
      console.log(`[control] Controller ${socket.id} disconnected, control stopped`);
      io.to(sessionId).emit("control:state", {
        active: false, controller: null, sharer: session.sharer,
      });
    }

    session.peers.delete(socket.id);
    socketToSession.delete(socket.id);
    if (session.peers.size === 0) {
      clearTimeout(session.expiryTimer);
      sessions.delete(sessionId);
      console.log(`[session] Destroyed ${sessionId} (all peers left)`);
    } else {
      resetExpiry(session);
      io.to(sessionId).emit("peer:left", {
        role: peer?.role, platform: peer?.platform, summary: sessionSummary(session),
      });
    }
  });

  socket.on("error", (err) => console.error(`[socket:error] ${socket.id}:`, err.message));
});

// ─── Relay helper ─────────────────────────────────────────────────────────────
function relay(socket, sessionId, event, payload) {
  const session = sessions.get(sessionId);
  if (!session) return socket.emit("error", { code: "SESSION_NOT_FOUND" });
  resetExpiry(session);
  socket.to(sessionId).emit(event, payload);
}

// ─── Safety-net sweep ─────────────────────────────────────────────────────────
setInterval(() => {
  const cutoff = now() - SESSION_TTL_MS;
  for (const [id, s] of sessions) if (s.lastActivity < cutoff) expireSession(id);
}, 60_000);

// ─── Boot ─────────────────────────────────────────────────────────────────────
httpServer.listen(PORT, () => {
  console.log(`\n  ╔══════════════════════════════════════╗`);
  console.log(`  ║   RemoteDesk Signaling Server v1.0   ║`);
  console.log(`  ║   http://localhost:${PORT}              ║`);
  console.log(`  ╚══════════════════════════════════════╝\n`);
});

process.on("uncaughtException",  (err)    => console.error("[uncaughtException]",  err));
process.on("unhandledRejection", (reason) => console.error("[unhandledRejection]", reason));
