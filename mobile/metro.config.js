// metro.config.js — RemoteDesk Mobile
// Stubs out react-native-webrtc so Expo Go can bundle the app.
// Full WebRTC works in a custom dev build / production APK.

const { getDefaultConfig } = require("expo/metro-config");

const config = getDefaultConfig(__dirname);

// When running in Expo Go, react-native-webrtc's native modules
// aren't present. Block it from crashing the bundler by resolving
// it to an empty module stub.
const originalResolver = config.resolver.resolveRequest;
config.resolver.resolveRequest = (context, moduleName, platform) => {
  if (moduleName === "react-native-webrtc") {
    return {
      type: "empty",
    };
  }
  if (originalResolver) {
    return originalResolver(context, moduleName, platform);
  }
  return context.resolveRequest(context, moduleName, platform);
};

module.exports = config;
