import { NextResponse } from "next/server";

/** The Android app's package name (apps/mobile/app.config.ts). */
const PACKAGE = "za.kitty.app";
/** SHA-256 of the APK signing certificate, as keytool prints it: 32 colon-separated hex pairs. */
const FINGERPRINT = /^([0-9A-F]{2}:){31}[0-9A-F]{2}$/i;

/**
 * Android App Links: lets the installed Kitty app open this site's /invite and /t links. Published only when the
 * signing certificate's fingerprint is configured (ANDROID_CERT_SHA256); until then links simply open the web page.
 */
export async function GET() {
  const fingerprint = process.env.ANDROID_CERT_SHA256?.trim() ?? "";
  if (!FINGERPRINT.test(fingerprint)) return new NextResponse(null, { status: 404 });
  return NextResponse.json(
    [
      {
        relation: ["delegate_permission/common.handle_all_urls"],
        target: { namespace: "android_app", package_name: PACKAGE, sha256_cert_fingerprints: [fingerprint.toUpperCase()] },
      },
    ],
    { headers: { "Cache-Control": "public, max-age=3600" } },
  );
}
