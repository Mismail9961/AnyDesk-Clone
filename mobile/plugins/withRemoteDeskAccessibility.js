/**
 * Expo Config Plugin — RemoteDesk Accessibility Service
 * 
 * Automatically injects the AccessibilityService declaration into
 * AndroidManifest.xml and registers the native package during expo prebuild.
 * 
 * Usage: Add to app.json plugins: ["./plugins/withRemoteDeskAccessibility"]
 */
const { withAndroidManifest, withMainApplication } = require("expo/config-plugins");

function withRemoteDeskAccessibility(config) {
  // 1. Add AccessibilityService to AndroidManifest.xml
  config = withAndroidManifest(config, (config) => {
    const manifest = config.modResults;
    const application = manifest.manifest.application?.[0];
    if (!application) return config;

    // Check if service already exists
    const services = application.service ?? [];
    const exists = services.some(
      (s) => s.$?.["android:name"] === ".RemoteDeskAccessibilityService"
    );

    if (!exists) {
      services.push({
        $: {
          "android:name": ".RemoteDeskAccessibilityService",
          "android:label": "RemoteDesk Remote Control",
          "android:permission": "android.permission.BIND_ACCESSIBILITY_SERVICE",
          "android:exported": "false",
        },
        "intent-filter": [
          {
            action: [
              { $: { "android:name": "android.accessibilityservice.AccessibilityService" } },
            ],
          },
        ],
        "meta-data": [
          {
            $: {
              "android:name": "android.accessibilityservice",
              "android:resource": "@xml/accessibility_service_config",
            },
          },
        ],
      });
      application.service = services;
    }

    return config;
  });

  // 2. Register RemoteDeskPackage in MainApplication
  config = withMainApplication(config, (config) => {
    const contents = config.modResults.contents;

    // Add import
    if (!contents.includes("RemoteDeskPackage")) {
      config.modResults.contents = contents
        .replace(
          "import java.util.List;",
          "import java.util.List;\nimport com.remotedesk.app.RemoteDeskPackage;"
        )
        .replace(
          "packages.add(new",
          "packages.add(new RemoteDeskPackage());\n      packages.add(new"
        );
    }

    return config;
  });

  return config;
}

module.exports = withRemoteDeskAccessibility;
