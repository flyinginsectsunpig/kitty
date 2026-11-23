// expo-crypto is a native module (stubbed under jest); give tests real UUIDs from Node.
jest.mock("expo-crypto", () => ({ randomUUID: () => require("node:crypto").randomUUID() }));
// expo-network is native too: no network events under jest.
jest.mock("expo-network", () => ({ addNetworkStateListener: () => ({ remove: () => {} }) }));
// Hermes (React Native's engine) has no global `crypto`; Node does. Remove it so tests fail the way a phone would.
Object.defineProperty(globalThis, "crypto", { value: undefined, configurable: true, writable: true });
