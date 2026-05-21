const { contextBridge, ipcRenderer, desktopCapturer } = require("electron");

contextBridge.exposeInMainWorld("rd", {
  on:  (ch, cb) => ipcRenderer.on(ch, (_, ...a) => cb(...a)),
  off: (ch, cb) => ipcRenderer.removeListener(ch, cb),
  send: (ch, ...a) => ipcRenderer.send(ch, ...a),
  getSources: () => desktopCapturer.getSources({ types: ["screen"], thumbnailSize: { width: 1, height: 1 } }),
});
