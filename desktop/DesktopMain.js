/**
 * RemoteDesk — Desktop Host (Electron, no native modules)
 * WebRTC runs in the Chromium renderer. Input is injected via PowerShell/shell.
 */
"use strict";

const { app, BrowserWindow, ipcMain, Tray, Menu, nativeImage, screen } = require("electron");
const path   = require("path");
const { execFile, exec } = require("child_process");
const io_client = require("socket.io-client");

const SERVER_URL = process.env.REMOTEDESK_SERVER ?? "http://localhost:4000";
const ICE_SERVERS = [
  { urls: "stun:stun.l.google.com:19302" },
  { urls: "stun:stun1.l.google.com:19302" },
];

let mainWindow   = null;
let tray         = null;
let socket       = null;
let sessionId    = null;
let screenDim    = { width: 1920, height: 1080 };

// ─── Input injection (no native modules) ─────────────────────────────────────
function normToScreen(nx, ny) {
  return { x: Math.round(nx * screenDim.width), y: Math.round(ny * screenDim.height) };
}

// Reusable PowerShell type definitions (cached in a persistent PS process via -Command)
function runPS(script) {
  if (process.platform !== "win32") return;
  exec(`powershell -NoProfile -NonInteractive -WindowStyle Hidden -Command "${script.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`,
    (err) => { if (err) console.error("[input]", err.message); });
}

function runBash(script) {
  exec(script, (err) => { if (err) console.error("[input]", err.message); });
}

function moveMouse(x, y) {
  if (process.platform === "win32") {
    runPS(`Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.Cursor]::Position = [System.Drawing.Point]::new(${x},${y})`);
  } else if (process.platform === "linux") {
    runBash(`xdotool mousemove ${x} ${y}`);
  } else if (process.platform === "darwin") {
    runBash(`osascript -e 'tell application "System Events" to set the mouse location to {${x}, ${y}}'`);
  }
}

function clickMouse(x, y, btn = "left", down = true) {
  if (process.platform === "win32") {
    const d = down ? (btn === "right" ? 8 : 2) : (btn === "right" ? 16 : 4);
    runPS(`Add-Type -TypeDefinition 'using System;using System.Runtime.InteropServices;public class M{[DllImport("user32.dll")]public static extern void mouse_event(uint f,int x,int y,int d,int e);}'; Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.Cursor]::Position=[System.Drawing.Point]::new(${x},${y}); [M]::mouse_event(${d},0,0,0,0)`);
  } else if (process.platform === "linux") {
    runBash(`xdotool mousemove ${x} ${y} ${down ? "mousedown" : "mouseup"} ${btn === "right" ? 3 : 1}`);
  }
}

function pressKey(key, modifiers = []) {
  if (process.platform === "win32") {
    const KEY_MAP = { " ": "SPACE", "Enter": "ENTER", "Backspace": "BACKSPACE", "Tab": "TAB", "Escape": "ESCAPE", "Delete": "DELETE", "ArrowUp": "UP", "ArrowDown": "DOWN", "ArrowLeft": "LEFT", "ArrowRight": "RIGHT" };
    const MOD_MAP = { ctrl: "^", alt: "%", shift: "+", meta: "" };
    const mapped = KEY_MAP[key] ?? (key.length === 1 ? key : null);
    if (!mapped) return;
    const mods = modifiers.map(m => MOD_MAP[m] ?? "").join("");
    runPS(`Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.SendKeys]::SendWait('${mods}{${mapped.length > 1 ? mapped : mapped}}')`);
  } else if (process.platform === "linux") {
    const xMods = modifiers.map(m => ({ ctrl: "ctrl", alt: "alt", shift: "shift", meta: "super" }[m] ?? "")).filter(Boolean);
    const combo = [...xMods, key].join("+");
    runBash(`xdotool key ${combo}`);
  }
}

function executePointer({ type, x, y, button }) {
  const { x: px, y: py } = normToScreen(x, y);
  switch (type) {
    case "move":     moveMouse(px, py); break;
    case "down":     clickMouse(px, py, button, true);  break;
    case "up":       clickMouse(px, py, button, false); break;
    case "click":    moveMouse(px, py); clickMouse(px, py, button, true); setTimeout(() => clickMouse(px, py, button, false), 30); break;
    case "dblclick": moveMouse(px, py); clickMouse(px, py, button, true); setTimeout(() => clickMouse(px, py, button, false), 30); setTimeout(() => { clickMouse(px, py, button, true); setTimeout(() => clickMouse(px, py, button, false), 30); }, 100); break;
  }
}

function executeKey({ key, modifiers = [], eventType }) {
  if (eventType !== "keydown") return;
  pressKey(key, modifiers);
}

// ─── Socket.io signaling ──────────────────────────────────────────────────────
function connectToServer() {
  console.log("[socket] Connecting to", SERVER_URL);
  socket = io_client(SERVER_URL, {
    auth: { role: "host", platform: "desktop" },
    transports: ["websocket"],
    reconnectionAttempts: 10,
    reconnectionDelay: 3000,
  });

  socket.on("connect", () => {
    socket.emit("session:create", {}, (res) => {
      if (res.error) { sendStatus({ error: res.error }); return; }
      sessionId = res.sessionId;
      const primary = screen.getPrimaryDisplay();
      screenDim = { width: primary.bounds.width * primary.scaleFactor, height: primary.bounds.height * primary.scaleFactor };
      socket.emit("peer:dimensions", { sessionId, width: screenDim.width, height: screenDim.height, dpr: primary.scaleFactor });
      sendStatus({ connState: "connected", sessionId });
      // Tell renderer to start WebRTC host
      mainWindow?.webContents.send("start-capture", { sessionId, iceServers: ICE_SERVERS });
    });
  });

  // Forward WebRTC signals from server → renderer
  socket.on("rtc:offer",  (payload) => mainWindow?.webContents.send("rtc:offer",  payload));
  socket.on("rtc:answer", (payload) => mainWindow?.webContents.send("rtc:answer", payload));
  socket.on("rtc:ice",    (payload) => mainWindow?.webContents.send("rtc:ice",    payload));

  socket.on("input:pointer",  (p) => executePointer(p));
  socket.on("input:key",      (p) => executeKey(p));
  socket.on("input:scroll",   ({ dx, dy }) => {
    if (process.platform === "win32") runPS(`Add-Type -TypeDefinition 'using System;using System.Runtime.InteropServices;public class M{[DllImport("user32.dll")]public static extern void mouse_event(uint f,int x,int y,int d,int e);}';[M]::mouse_event(0x800,0,0,${dy > 0 ? -120 : 120},0)`);
    else if (process.platform === "linux") runBash(`xdotool click ${dy > 0 ? 5 : 4}`);
  });
  socket.on("clipboard:sync", ({ text }) => { const { clipboard } = require("electron"); clipboard.writeText(text); });
  socket.on("peer:joined",    ({ summary }) => sendStatus({ peers: summary.peers }));
  socket.on("peer:left",      ({ summary }) => sendStatus({ peers: summary.peers }));
  socket.on("disconnect",     () => sendStatus({ connState: "disconnected" }));
  socket.on("connect_error",  (e) => sendStatus({ connState: "error", error: e.message }));

  // ── Remote Control Events ───────────────────────────────────────────────
  // When a mobile user requests control of this desktop
  socket.on("control:request", ({ from, fromPlatform }) => {
    console.log(`[control] ${fromPlatform} peer ${from} requests control`);
    // Auto-grant for desktop (user can see what's happening on their screen)
    // Or show a dialog — for now we auto-grant and notify the renderer
    sendStatus({ controlRequest: { from, fromPlatform } });
    // Auto-grant after showing notification
    socket.emit("control:grant", { sessionId, to: from });
    console.log(`[control] Auto-granted control to ${from}`);
  });

  socket.on("control:state", (data) => {
    console.log("[control] State:", JSON.stringify(data));
    sendStatus({ controlState: data });
  });

  // Remote input — execute on this machine
  socket.on("remote:tap", ({ x, y, long }) => {
    const { x: px, y: py } = normToScreen(x, y);
    console.log(`[remote] tap (${px}, ${py}) long=${long}`);
    if (long) {
      // Long press = right click
      clickMouse(px, py, "right", true);
      setTimeout(() => clickMouse(px, py, "right", false), 30);
    } else {
      // Normal tap = left click
      moveMouse(px, py);
      clickMouse(px, py, "left", true);
      setTimeout(() => clickMouse(px, py, "left", false), 30);
    }
  });

  socket.on("remote:swipe", ({ x1, y1, x2, y2, duration }) => {
    const start = normToScreen(x1, y1);
    const end   = normToScreen(x2, y2);
    console.log(`[remote] swipe (${start.x},${start.y}) → (${end.x},${end.y})`);
    // Simulate drag: move to start, press, move to end, release
    moveMouse(start.x, start.y);
    clickMouse(start.x, start.y, "left", true);
    const steps = 10;
    for (let i = 1; i <= steps; i++) {
      setTimeout(() => {
        const mx = Math.round(start.x + (end.x - start.x) * (i / steps));
        const my = Math.round(start.y + (end.y - start.y) * (i / steps));
        moveMouse(mx, my);
        if (i === steps) {
          clickMouse(end.x, end.y, "left", false);
        }
      }, (duration / steps) * i);
    }
  });

  socket.on("remote:key", ({ key, modifiers }) => {
    console.log(`[remote] key "${key}" mods=${modifiers}`);
    pressKey(key, modifiers ?? []);
  });

  socket.on("remote:back", () => {
    console.log("[remote] back (Alt+Left on desktop)");
    pressKey("ArrowLeft", ["alt"]);
  });

  socket.on("remote:home", () => {
    console.log("[remote] home (Win key on desktop)");
    if (process.platform === "win32") {
      runPS(`Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.SendKeys]::SendWait('^{ESCAPE}')`);
    } else if (process.platform === "linux") {
      runBash("xdotool key super");
    }
  });
}

// IPC: renderer → relay WebRTC signals to server
ipcMain.on("rtc:offer",  (_, offer)     => socket?.emit("rtc:offer",  { sessionId, offer }));
ipcMain.on("rtc:answer", (_, answer)    => socket?.emit("rtc:answer", { sessionId, answer }));
ipcMain.on("rtc:ice",    (_, candidate) => socket?.emit("rtc:ice",    { sessionId, candidate }));
ipcMain.on("rtc:ready",  ()             => socket?.emit("rtc:ready",  { sessionId }));
ipcMain.on("clipboard:push", (_, text)  => { if (socket && sessionId) socket.emit("clipboard:sync", { sessionId, text }); });

function sendStatus(data) { mainWindow?.webContents?.send("status:update", data); }

// ─── Window ───────────────────────────────────────────────────────────────────
function createWindow() {
  mainWindow = new BrowserWindow({
    width: 420, height: 580, minWidth: 380, minHeight: 500,
    backgroundColor: "#0b0c10",
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, "renderer", "preload.js"),
    },
  });
  mainWindow.loadFile(path.join(__dirname, "renderer", "index.html"));
  mainWindow.on("closed", () => { mainWindow = null; });
}

function createTray() {
  const icon = nativeImage.createEmpty();
  tray = new Tray(icon);
  tray.setToolTip("RemoteDesk");
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: "Show", click: () => mainWindow?.show() },
    { type: "separator" },
    { label: "Quit", click: () => app.quit() },
  ]));
  tray.on("double-click", () => mainWindow?.show());
}

app.whenReady().then(() => { createWindow(); createTray(); connectToServer(); });
app.on("window-all-closed", () => { if (process.platform !== "darwin") app.quit(); });
app.on("activate", () => { if (!mainWindow) createWindow(); });
app.on("before-quit", () => { socket?.disconnect(); });
process.on("uncaughtException",  (e) => console.error("[uncaught]",  e));
process.on("unhandledRejection", (e) => console.error("[unhandled]", e));
