import "server-only";
import type { GroupDto, LedgerClient, MemberDto } from "@kitty/api-client";
import { getLedger, unwrap } from "./ledger";

export type GroupContext = {
  ledger: LedgerClient;
  group: GroupDto;
  /** The signed-in user's member row in this group. */
  me: MemberDto;
  nameOf: (memberId: string) => string;
};

/** Loads a group the signed-in user belongs to (404 page otherwise) plus their own member row. */
export async function loadGroup(groupId: string): Promise<GroupContext> {
  const ledger = await getLedger();
  const [group, me] = await Promise.all([
    ledger.GET("/groups/{groupId}", { params: { path: { groupId } } }).then(unwrap),
    ledger.GET("/me").then(unwrap),
  ]);
  const myMember = group.members.find((m) => m.userId === me.id);
  if (!myMember) throw new Error("Signed-in user is not a member of this group.");

  const names = new Map(group.members.map((m) => [m.id, m.displayName]));
  return { ledger, group, me: myMember, nameOf: (id) => names.get(id) ?? "Someone" };
}
