import { NextResponse, type NextRequest } from "next/server";
import { loadTable } from "@/lib/table";

const noStore = { "Cache-Control": "no-store" };

/**
 * The bill for the person making this request (member session or this table's guest cookie), for the live
 * refresh in the browser. 404 means they can no longer see it. A Route Handler, not a Server Function,
 * because it is a read: it must not queue behind the viewer's own taps.
 */
export async function GET(request: NextRequest, { params }: { params: Promise<{ sessionId: string }> }) {
  const { sessionId } = await params;
  const table = await loadTable(sessionId, request.nextUrl.searchParams.get("g"));
  return table.status === "ok"
    ? NextResponse.json(table.session, { headers: noStore })
    : NextResponse.json({ code: "not_found" }, { status: 404, headers: noStore });
}
