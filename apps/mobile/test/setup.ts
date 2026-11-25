// expo-crypto is a native module (stubbed under jest); give tests real UUIDs from Node.
jest.mock("expo-crypto", () => ({ randomUUID: () => require("node:crypto").randomUUID() }));
// expo-network is native too: no network events under jest.
jest.mock("expo-network", () => ({ addNetworkStateListener: () => ({ remove: () => {} }) }));
// Hermes (React Native's engine) has no global `crypto`; Node does. Remove it so tests fail the way a phone would.
Object.defineProperty(globalThis, "crypto", { value: undefined, configurable: true, writable: true });
// expo-notifications is native: by default nobody has said yes to notifications, and there's no Firebase config.
// Tests that need more set these mocks up themselves.
jest.mock("expo-notifications", () => ({
  AndroidImportance: { DEFAULT: 3 },
  setNotificationChannelAsync: jest.fn(async () => null),
  getPermissionsAsync: jest.fn(async () => ({ granted: false, canAskAgain: true })),
  requestPermissionsAsync: jest.fn(async () => ({ granted: false, canAskAgain: false })),
  getDevicePushTokenAsync: jest.fn(async () => Promise.reject(new Error("no Firebase config"))),
  addNotificationResponseReceivedListener: jest.fn(() => ({ remove: () => {} })),
  getLastNotificationResponseAsync: jest.fn(async () => null),
  unregisterForNotificationsAsync: jest.fn(async () => {}),
}));
