import * as SecureStore from "expo-secure-store";
import type { TokenStore } from "./tokens";

/** Tokens live only in the OS keystore (Android Keystore / iOS Keychain). */
export const secureTokenStore: TokenStore = {
  get: (key) => SecureStore.getItemAsync(key),
  set: (key, value) => SecureStore.setItemAsync(key, value),
  remove: (key) => SecureStore.deleteItemAsync(key),
};
