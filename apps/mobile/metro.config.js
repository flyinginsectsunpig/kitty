// Expo's defaults already understand the pnpm workspace (packages resolved through node_modules symlinks).
const { getDefaultConfig } = require("expo/metro-config");

module.exports = getDefaultConfig(__dirname);
