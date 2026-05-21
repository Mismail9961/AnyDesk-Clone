#!/bin/bash
# RemoteDesk Desktop — Setup & Launch (macOS / Linux)

set -e
BOLD="\033[1m"
CYAN="\033[0;36m"
GREEN="\033[0;32m"
RED="\033[0;31m"
RESET="\033[0m"

clear
echo ""
echo -e "  ${CYAN}================================================${RESET}"
echo -e "  ${BOLD}  RemoteDesk Desktop Host — Setup & Launch${RESET}"
echo -e "  ${CYAN}================================================${RESET}"
echo ""

# Check for Node.js
if ! command -v node &>/dev/null; then
    echo -e "  ${RED}[!] Node.js is not installed.${RESET}"
    echo ""
    echo "  Please install Node.js first:"
    echo "    macOS:  brew install node"
    echo "    Linux:  sudo apt install nodejs npm"
    echo ""
    echo "  Or download from: https://nodejs.org"
    echo ""
    read -p "  Press Enter to open nodejs.org..." _dummy
    open "https://nodejs.org" 2>/dev/null || xdg-open "https://nodejs.org" 2>/dev/null
    exit 1
fi

NODE_VER=$(node --version)
echo -e "  ${GREEN}[OK]${RESET} Node.js $NODE_VER found."
echo ""

# Install dependencies
if [ ! -f "node_modules/electron/dist/electron" ] && [ ! -f "node_modules/electron/dist/Electron.app/Contents/MacOS/Electron" ]; then
    echo -e "  [>>] Installing dependencies (this may take a few minutes)..."
    echo ""
    npm install --no-fund --no-audit
    echo ""
    echo -e "  ${GREEN}[OK]${RESET} Dependencies installed!"
    echo ""
else
    echo -e "  ${GREEN}[OK]${RESET} Dependencies already installed."
    echo ""
fi

echo -e "  [>>] Starting RemoteDesk..."
echo ""
echo -e "  ${CYAN}================================================${RESET}"
echo -e "    RemoteDesk is running. Check the app window"
echo -e "    for your session ID to share with viewers."
echo -e "  ${CYAN}================================================${RESET}"
echo ""

npx electron .
