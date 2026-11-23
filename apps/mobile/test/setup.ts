// expo-crypto is a native module (stubbed under jest); give tests real UUIDs from Node.
jest.mock("expo-crypto", () => ({ randomUUID: () => require("node:crypto").randomUUID() }));
// expo-network is native too: no network events under jest.
jest.mock("expo-network", () => ({ addNetworkStateListener: () => ({ remove: () => {} }) }));
