const messages: Record<string, string> = {
  validation_failed: "Some details aren't valid. Check the form and try again.",
  currency_unsupported: "That currency isn't supported yet.",
  member_not_in_group: "Everyone on an expense must be in this group.",
  payers_sum_mismatch: "What people paid must add up to the total.",
  split_sum_mismatch: "The split must add up to the total.",
  split_invalid_value: "Each person's share needs a positive number.",
  split_empty: "Pick at least one person to split with.",
  split_duplicate_member: "Each person can appear only once.",
  version_conflict: "Someone else changed this expense. Reload to see their version.",
  already_member: "You're already in this group.",
  invite_used: "This invite link has already been used. Ask for a new one.",
  invite_expired: "This invite link has expired. Ask for a new one.",
  placeholder_claimed: "Someone has already claimed this spot in the group.",
  rate_limited: "That's a lot of changes at once. Wait a minute and try again.",
  request_in_progress: "Still saving your last change. Try again in a moment.",
  not_found: "We couldn't find that.",
};

export function errorMessage(code: string | undefined): string | null {
  if (!code) return null;
  return messages[code] ?? "Something went wrong. Please try again.";
}
