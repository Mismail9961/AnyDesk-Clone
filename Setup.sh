#!/usr/bin/env bash
# ╔══════════════════════════════════════════════════════════════════════════╗
# ║              RemoteDesk Omni-System — Environment Setup                 ║
# ║         Run from the monorepo root. Node 18+ required.                  ║
# ╚══════════════════════════════════════════════════════════════════════════╝

set -euo pipefail
RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; CYAN='\033[0;36m'; NC='\033[0m'
info()  { echo -e "${CYAN}▶ $*${NC}"; }
ok()    { echo -e "${GREEN}✔ $*${NC}"; }
warn()  { echo -e "${YELLOW}⚠ $*${NC}"; }
error() { echo -e "${RED}✖ $*${NC}" >&2; exit 1; }

# ── Prerequisites check ────────────────────────────────────────────────────────
command -v node  &>/dev/null || error "Node.js not found. Install from https://nodejs.org (v18+)"
command -v npm   &>/dev/null || error "npm not found"
command -v npx   &>/dev/null || error "npx not found"

NODE_VER=$(node -e "process.stdout.write(process.version.slice(1))")
MAJOR=$(echo "$NODE_VER" | cut -d. -f1)
[ "$MAJOR" -ge 18 ] || error "Node.js v18+ required (found v$NODE_VER)"
ok "Node.js v$NODE_VER"

# ── Directory layout ──────────────────────────────────────────────────────────
info "Creating project structure…"
mkdir -p server web mobile desktop

# ══════════════════════════════════════════════════════════════════════════════
# 1. SIGNALING SERVER
# ══════════════════════════════════════════════════════════════════════════════
info "Installing Signaling Server dependencies…"
cd server
cat > package.json << 'PKGJSON'
{
  "name": "remotedesk-server",
  "version": "1.0.0",
  "description": "RemoteDesk WebRTC Signaling Hub",
  "main": "server.js",
  "scripts": {
    "start":   "node server.js",
    "dev":     "nodemon server.js",
    "pm2":     "pm2 start server.js --name remotedesk-server"
  },
  "engines": { "node": ">=18" }
}
PKGJSON

npm install socket.io@4
npm install --save-dev nodemon
ok "Server dependencies installed"
cd ..

# ══════════════════════════════════════════════════════════════════════════════
# 2. WEB APP (React 18 + Vite + Tailwind + Lucide)
# ══════════════════════════════════════════════════════════════════════════════
info "Scaffolding Web App with Vite (React + TypeScript)…"
cd web

# Create Vite project non-interactively
npm create vite@latest . -- --template react-ts --yes 2>/dev/null || true

npm install
npm install lucide-react socket.io-client
npm install -D tailwindcss@3 postcss autoprefixer @types/node

# Tailwind init
npx tailwindcss init -p 2>/dev/null || true

# Patch tailwind.config.js
cat > tailwind.config.js << 'TWCONF'
/** @type {import('tailwindcss').Config} */
export default {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        brand: { DEFAULT: "#3b82f6", dark: "#1d4ed8" },
        surface: { DEFAULT: "#111318", raised: "#181b22" },
        bg: "#0b0c10",
      },
    },
  },
  plugins: [],
};
TWCONF

# .env template
cat > .env.example << 'ENVFILE'
VITE_SERVER_URL=http://localhost:4000
ENVFILE

ok "Web App dependencies installed"
cd ..

# ══════════════════════════════════════════════════════════════════════════════
# 3. MOBILE APP (Expo + React Native + WebRTC + NativeWind)
# ══════════════════════════════════════════════════════════════════════════════
info "Setting up Expo Mobile App…"
cd mobile

# Bootstrap Expo project if not already created
if [ ! -f "package.json" ]; then
  npx create-expo-app@latest . --template blank 2>/dev/null || true
fi

# Core runtime deps
npx expo install \
  react-native-webrtc \
  socket.io-client \
  expo-screen-capture \
  expo-camera \
  expo-av \
  expo-haptics \
  expo-clipboard \
  expo-modules-core

# NativeWind (Tailwind for React Native)
npm install nativewind tailwindcss@3
npm install --save-dev babel-plugin-module-resolver

# NativeWind Tailwind config
cat > tailwind.config.js << 'TWCONF'
/** @type {import('tailwindcss').Config} */
module.exports = {
  content: ["./App.{js,jsx}", "./src/**/*.{js,jsx}"],
  presets: [require("nativewind/preset")],
  theme: { extend: {} },
  plugins: [],
};
TWCONF

# Babel config for NativeWind
cat > babel.config.js << 'BCONF'
module.exports = function(api) {
  api.cache(true);
  return {
    presets: [
      ["babel-preset-expo", { jsxImportSource: "nativewind" }],
      "nativewind/babel",
    ],
  };
};
BCONF

# app.json patch reminder
cat > SETUP_NOTES.md << 'NOTES'
# Mobile Setup Notes

## Android — Accessibility Service
1. Create `android/app/src/main/java/com/remotedesk/AccessibilityModule.java`
2. Extend `AccessibilityService`, implement `dispatchGesture()` calls
3. Register in AndroidManifest.xml with BIND_ACCESSIBILITY_SERVICE permission
4. Register native module in MainApplication.java

## iOS — ReplayKit + ScreenControl
1. Add Broadcast Upload Extension target in Xcode
2. Implement `SampleHandler.swift` to push CMSampleBuffer frames via WebRTC
3. Add `NSMicrophoneUsageDescription` and `NSCameraUsageDescription` to Info.plist
4. For MDM-managed devices: implement ScreenControl protocol via XCTest
5. ScreenControlModule.swift bridges Swift → React Native via RCTBridgeModule

## Required app.json additions
```json
{
  "expo": {
    "plugins": [
      ["react-native-webrtc", {
        "cameraPermission": "Allow RemoteDesk to access camera",
        "microphonePermission": "Allow RemoteDesk to access microphone"
      }]
    ],
    "android": {
      "permissions": [
        "android.permission.CAMERA",
        "android.permission.RECORD_AUDIO",
        "android.permission.INTERNET",
        "android.permission.FOREGROUND_SERVICE",
        "android.permission.BIND_ACCESSIBILITY_SERVICE"
      ]
    },
    "ios": {
      "infoPlist": {
        "NSCameraUsageDescription": "Required for screen sharing",
        "NSMicrophoneUsageDescription": "Required for audio relay"
      }
    }
  }
}
```
NOTES

ok "Mobile dependencies installed"
cd ..

# ══════════════════════════════════════════════════════════════════════════════
# 4. DESKTOP APP (Electron + RobotJS + wrtc)
# ══════════════════════════════════════════════════════════════════════════════
info "Setting up Electron Desktop Host…"
cd desktop

cat > package.json << 'PKGJSON'
{
  "name": "remotedesk-desktop",
  "version": "1.0.0",
  "description": "RemoteDesk Desktop Host (Electron + RobotJS)",
  "main": "DesktopMain.js",
  "scripts": {
    "start":   "electron .",
    "dev":     "cross-env NODE_ENV=development electron .",
    "build":   "electron-builder",
    "rebuild": "electron-rebuild -f -w robotjs,wrtc"
  },
  "build": {
    "appId": "com.remotedesk.host",
    "productName": "RemoteDesk",
    "mac":     { "category": "public.app-category.utilities" },
    "win":     { "target": "nsis" },
    "linux":   { "target": "AppImage" }
  }
}
PKGJSON

npm install \
  electron@latest \
  socket.io-client \
  wrtc \
  robotjs

npm install --save-dev \
  electron-builder \
  electron-rebuild \
  cross-env

# Rebuild native modules against Electron's Node ABI
./node_modules/.bin/electron-rebuild -f -w robotjs,wrtc 2>/dev/null || \
  warn "electron-rebuild failed — run 'npm run rebuild' manually after ensuring python/build-tools are installed"

# Renderer shell
mkdir -p renderer
cat > renderer/index.html << 'HTML'
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta http-equiv="Content-Security-Policy" content="default-src 'self'; script-src 'self'"/>
  <title>RemoteDesk Host</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { background: #0b0c10; color: #e2e8f0; font-family: 'SF Mono', monospace; padding: 24px; height: 100vh; display: flex; flex-direction: column; gap: 16px; }
    h1 { font-size: 20px; font-weight: 800; color: #3b82f6; letter-spacing: -0.5px; }
    .badge { display: inline-flex; align-items: center; gap: 6px; background: rgba(59,130,246,.12); border: 1px solid rgba(59,130,246,.3); border-radius: 100px; padding: 4px 12px; font-size: 12px; }
    .session { font-size: 28px; letter-spacing: 4px; color: #3b82f6; font-weight: 500; }
    .dim { color: #64748b; font-size: 12px; }
    button { background: #3b82f6; color: #fff; border: none; border-radius: 8px; padding: 10px 20px; font-size: 14px; font-weight: 700; cursor: pointer; width: 100%; margin-top: auto; }
    button:hover { background: #1d4ed8; }
    button.danger { background: rgba(239,68,68,.15); color: #ef4444; border: 1px solid rgba(239,68,68,.3); }
    #status { color: #64748b; font-size: 12px; }
    #peers  { font-size: 12px; color: #94a3b8; }
  </style>
</head>
<body>
  <h1>⚡ RemoteDesk Host</h1>
  <div id="badge-row"></div>
  <div id="session-id" class="session">—</div>
  <div class="dim">Share this ID with clients</div>
  <div id="status">Connecting…</div>
  <div id="peers"></div>
  <button id="copy-btn" onclick="copyId()">Copy Session ID</button>
  <button id="disc-btn" class="danger" onclick="disconnect()">Disconnect</button>
  <script>
    const { ipcRenderer } = require('electron');
    let _sessionId = null;

    ipcRenderer.on('status:update', (_, data) => {
      if (data.sessionId) { _sessionId = data.sessionId; document.getElementById('session-id').textContent = data.sessionId.replace(/(\d{3})(\d{3})(\d{3})/, '$1 – $2 – $3'); }
      if (data.connState) document.getElementById('status').textContent = `Status: ${data.connState}`;
      if (data.peers)     document.getElementById('peers').textContent  = `Peers: ${data.peers.map(p => p.role+'/'+p.platform).join(', ') || 'none'}`;
      if (data.error)     document.getElementById('status').textContent = `Error: ${data.error}`;
    });

    function copyId() { if (_sessionId) navigator.clipboard.writeText(_sessionId); }
    function disconnect() { ipcRenderer.send('host:disconnect'); }
  </script>
</body>
</html>
HTML

# preload.js
cat > preload.js << 'PRELOAD'
const { contextBridge, ipcRenderer } = require("electron");
contextBridge.exposeInMainWorld("rdHost", {
  onStatus:    (cb) => ipcRenderer.on("status:update", (_, d) => cb(d)),
  connect:     ()   => ipcRenderer.send("host:connect"),
  disconnect:  ()   => ipcRenderer.send("host:disconnect"),
  pushClipboard: (t) => ipcRenderer.send("clipboard:push", t),
});
PRELOAD

ok "Desktop dependencies installed"
cd ..

# ══════════════════════════════════════════════════════════════════════════════
# 5. Copy source files into place
# ══════════════════════════════════════════════════════════════════════════════
info "Copying source files…"

[ -f "../server.js" ]      && cp ../server.js      server/server.js
[ -f "../WebApp.tsx" ]     && cp ../WebApp.tsx      web/src/App.tsx
[ -f "../MobileApp.js" ]   && cp ../MobileApp.js    mobile/App.js
[ -f "../DesktopMain.js" ] && cp ../DesktopMain.js  desktop/DesktopMain.js

ok "Source files in place"

# ══════════════════════════════════════════════════════════════════════════════
# 6. Summary
# ══════════════════════════════════════════════════════════════════════════════
echo ""
echo -e "${GREEN}╔══════════════════════════════════════════════════════╗${NC}"
echo -e "${GREEN}║       RemoteDesk — Setup Complete ✔                  ║${NC}"
echo -e "${GREEN}╠══════════════════════════════════════════════════════╣${NC}"
echo -e "${GREEN}║${NC}  ${CYAN}Signaling Server${NC}                                    ${GREEN}║${NC}"
echo -e "${GREEN}║${NC}    cd server && npm start                           ${GREEN}║${NC}"
echo -e "${GREEN}║${NC}                                                     ${GREEN}║${NC}"
echo -e "${GREEN}║${NC}  ${CYAN}Web Dashboard${NC}                                       ${GREEN}║${NC}"
echo -e "${GREEN}║${NC}    cd web && npm run dev                            ${GREEN}║${NC}"
echo -e "${GREEN}║${NC}                                                     ${GREEN}║${NC}"
echo -e "${GREEN}║${NC}  ${CYAN}Desktop Host${NC}                                        ${GREEN}║${NC}"
echo -e "${GREEN}║${NC}    cd desktop && npm start                          ${GREEN}║${NC}"
echo -e "${GREEN}║${NC}                                                     ${GREEN}║${NC}"
echo -e "${GREEN}║${NC}  ${CYAN}Mobile (Expo)${NC}                                       ${GREEN}║${NC}"
echo -e "${GREEN}║${NC}    cd mobile && npx expo start                      ${GREEN}║${NC}"
echo -e "${GREEN}╠══════════════════════════════════════════════════════╣${NC}"
echo -e "${GREEN}║${NC}  ${YELLOW}⚠ Set VITE_SERVER_URL in web/.env${NC}                  ${GREEN}║${NC}"
echo -e "${GREEN}║${NC}  ${YELLOW}⚠ Set SERVER_URL in MobileApp.js${NC}                   ${GREEN}║${NC}"
echo -e "${GREEN}║${NC}  ${YELLOW}⚠ Review mobile/SETUP_NOTES.md for native modules${NC}  ${GREEN}║${NC}"
echo -e "${GREEN}╚══════════════════════════════════════════════════════╝${NC}"
