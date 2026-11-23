import { notFound } from "next/navigation";
import QRCode from "qrcode";
import { HostTable } from "@/components/table/HostTable";
import { loadGroup } from "@/lib/group-context";
import { isUuid } from "@kitty/core";
import { unwrap } from "@/lib/ledger";
import { hubUrl, tableLink } from "@/lib/table";

export default async function HostTablePage({ params }: { params: Promise<{ id: string; sessionId: string }> }) {
  const { id, sessionId } = await params;
  if (!isUuid(id) || !isUuid(sessionId)) notFound();

  const { ledger, group } = await loadGroup(id);
  const session = unwrap(await ledger.GET("/groups/{groupId}/table-sessions/{sessionId}", { params: { path: { groupId: id, sessionId } } }));
  const link = tableLink(sessionId, id);
  const qrDataUrl = await QRCode.toDataURL(link, { margin: 1, width: 320 });

  return (
    <HostTable
      initial={session}
      groupId={id}
      members={group.members.map((m) => ({ id: m.id, displayName: m.displayName }))}
      hubUrl={hubUrl()}
      link={link}
      qrDataUrl={qrDataUrl}
    />
  );
}
