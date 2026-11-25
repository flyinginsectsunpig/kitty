import { Slot } from "expo-router";
import { StatusBar } from "expo-status-bar";
import { AuthProvider } from "../auth/AuthProvider";
import { createKeycloakClient } from "../auth/client";
import { secureTokenStore } from "../auth/secure-store";
import { config } from "../config";
import { AiProvider } from "../ai";
import { LedgerProvider } from "../ledger";

const keycloak = createKeycloakClient(config.authIssuer);

export default function RootLayout() {
  return (
    <AuthProvider client={keycloak} store={secureTokenStore}>
      <LedgerProvider>
        <AiProvider>
          <StatusBar style="auto" />
          <Slot />
        </AiProvider>
      </LedgerProvider>
    </AuthProvider>
  );
}
