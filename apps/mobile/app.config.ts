import type { ExpoConfig } from "expo/config";

// Android App Links: the site's /invite and /t links open in the app. Only for an https site (the deployed one);
// the site confirms it with /.well-known/assetlinks.json once ANDROID_CERT_SHA256 is set there.
const web = new URL(process.env.EXPO_PUBLIC_WEB_URL ?? "http://localhost:3000");
const appLinks =
  web.protocol === "https:"
    ? [
        {
          action: "VIEW",
          autoVerify: true,
          data: ["/invite/", "/t/"].map((pathPrefix) => ({ scheme: "https", host: web.host, pathPrefix })),
          category: ["BROWSABLE", "DEFAULT"],
        },
      ]
    : [];

const config: ExpoConfig = {
  name: "Kitty",
  slug: "kitty",
  scheme: "kitty",
  version: "0.1.0",
  orientation: "portrait",
  userInterfaceStyle: "automatic",
  android: { package: "za.kitty.app", intentFilters: appLinks },
  ios: { bundleIdentifier: "za.kitty.app" },
  plugins: [
    "expo-router",
    "expo-secure-store",
    // Photos only: no microphone (the picker asks for it by default, for video).
    ["expo-image-picker", { cameraPermission: "Kitty uses the camera to read receipts.", microphonePermission: false }],
  ],
};

export default config;
