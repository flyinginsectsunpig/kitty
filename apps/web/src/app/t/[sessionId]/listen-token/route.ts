import { NextResponse, type NextRequest } from "next/server";
import { listenTokenFor } from "@/lib/table";

const noStore = { "Cache-Control": "no-store" };

/** A read-only token for the browser's live connection to this one bill; 404 when there is nothing to listen to. */
export async function GET(request: NextRequest, { params }: { params: Promise<{ sessionId: string }> }) {
  const { sessionId } = await params;
  const token = await listenTokenFor(sessionId, request.nextUrl.searchParams.get("g"));
  return token
    ? NextResponse.json({ token }, { headers: noStore })
    : NextResponse.json({ code: "not_found" }, { status: 404, headers: noStore });
}
