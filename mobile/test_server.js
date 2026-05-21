// Quick test: does the server accept session:create?
const { io } = require("socket.io-client");

const sock = io("http://localhost:4000", {
  auth: { role: "web", platform: "browser" },
  transports: ["websocket", "polling"],
});

sock.on("connect", () => {
  console.log("✅ Connected as:", sock.id);
  sock.emit("session:create", {}, (res) => {
    console.log("✅ session:create response:", JSON.stringify(res));
    sock.disconnect();
    process.exit(0);
  });
});

sock.on("connect_error", (e) => {
  console.log("❌ connect_error:", e.message);
  process.exit(1);
});

setTimeout(() => {
  console.log("❌ Timeout — no response after 5s");
  process.exit(1);
}, 5000);
