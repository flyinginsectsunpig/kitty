import { describe, expect, test } from "vitest";
import { keycloakLogoutUrl } from "@/auth/logout";

describe("keycloakLogoutUrl", () => {
  test("ends the Keycloak session and comes back to the app", () => {
    const url = new URL(keycloakLogoutUrl("http://kc.test/realms/kitty", "id.token.value", "http://localhost:3000"));
    expect(url.origin + url.pathname).toBe("http://kc.test/realms/kitty/protocol/openid-connect/logout");
    expect(url.searchParams.get("id_token_hint")).toBe("id.token.value");
    expect(url.searchParams.get("post_logout_redirect_uri")).toBe("http://localhost:3000/");
  });

  test("without an id token it still logs out, using the client id instead", () => {
    const url = new URL(keycloakLogoutUrl("http://kc.test/realms/kitty", undefined, "http://localhost:3000", "kitty-web"));
    expect(url.searchParams.has("id_token_hint")).toBe(false);
    expect(url.searchParams.get("client_id")).toBe("kitty-web");
  });
});
