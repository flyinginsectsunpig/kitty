import { Slot } from "expo-router";
import { StatusBar } from "expo-status-bar";
import { AuthProvider } from "../auth/AuthProvider";
import { createKeycloakClient } from "../auth/client";
import { secureTokenStore } from "../auth/secure-store";
import { config } from "../config";
import { LedgerProvider } from "../ledger";

const keycloak = createKeycloakClient(config.authIssuer);

export default function RootLayout() {
  return (
    <AuthProvider client={keycloak} store={secureTokenStore}>
      <LedgerProvider>
        <StatusBar style="auto" />
        <Slot />
      </LedgerProvider>
    </AuthProvider>
  );
}
