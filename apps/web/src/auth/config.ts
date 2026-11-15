import NextAuth from "next-auth";
import Keycloak from "next-auth/providers/keycloak";
import { refreshAccessToken, type AuthToken } from "./refresh";

declare module "next-auth" {
  interface Session {
    error?: "RefreshAccessTokenError";
  }
}

/**
 * Keycloak sign-in (Authorization Code + PKCE). Tokens live only in the encrypted session cookie;
 * the browser-visible session carries no tokens, just whether a refresh failed.
 */
export const { handlers, auth, signIn, signOut } = NextAuth({
  providers: [Keycloak],
  session: { strategy: "jwt" },
  trustHost: true,
  pages: { signIn: "/" },
  callbacks: {
    async jwt({ token, account }) {
      if (account) {
        return { ...token, accessToken: account.access_token, refreshToken: account.refresh_token, expiresAt: account.expires_at };
      }
      return refreshAccessToken(token as AuthToken, Math.floor(Date.now() / 1000));
    },
    session({ session, token }) {
      const error = (token as AuthToken).error;
      return error ? { ...session, error } : session;
    },
  },
});
