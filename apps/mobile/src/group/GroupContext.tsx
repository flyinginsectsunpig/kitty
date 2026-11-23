import type { GroupDto, MemberDto } from "@kitty/api-client";
import { createContext, useContext, type ReactNode } from "react";

export type GroupContextValue = {
  group: GroupDto;
  /** The signed-in user's member row in this group. */
  me: MemberDto;
  nameOf: (memberId: string) => string;
  /** Re-fetch the group (after adding a person, editing details). */
  reload: () => Promise<void>;
};

const GroupContext = createContext<GroupContextValue | null>(null);

export function GroupProvider({ value, children }: { value: GroupContextValue; children: ReactNode }) {
  return <GroupContext.Provider value={value}>{children}</GroupContext.Provider>;
}

export function useGroup(): GroupContextValue {
  const value = useContext(GroupContext);
  if (!value) throw new Error("useGroup must be used inside a group's screens.");
  return value;
}

/** Builds the context from the group and the signed-in user's id; null when they aren't a member. */
export function groupContext(group: GroupDto, userId: string, reload: () => Promise<void>): GroupContextValue | null {
  const me = group.members.find((m) => m.userId === userId);
  if (!me) return null;
  const names = new Map(group.members.map((m) => [m.id, m.displayName]));
  return { group, me, nameOf: (id) => names.get(id) ?? "Someone", reload };
}
