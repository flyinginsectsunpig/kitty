import type { ExpoConfig } from "expo/config";

const config: ExpoConfig = {
  name: "Kitty",
  slug: "kitty",
  scheme: "kitty",
  version: "0.1.0",
  orientation: "portrait",
  userInterfaceStyle: "automatic",
  android: { package: "za.kitty.app" },
  ios: { bundleIdentifier: "za.kitty.app" },
  plugins: [
    "expo-router",
    "expo-secure-store",
    ["expo-image-picker", { cameraPermission: "Kitty uses the camera to read receipts." }],
  ],
};

export default config;
