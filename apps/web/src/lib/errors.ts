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
  session_locked: "The host has locked this bill.",
  session_closed: "This bill is already split or was cancelled.",
  host_only: "Only the person running the table can do that.",
  guests_unmapped: "Match every guest who claimed something to someone in the group first.",
  edit_in_table: "This bill was split at the table. Delete it and split it again to change it.",
  upload_not_image: "That isn't a photo Kitty can read. Use a JPEG, PNG or WebP picture of the receipt.",
  upload_too_large: "That photo is over 10 MB. Try a smaller one.",
  upload_missing: "The photo didn't arrive. Try again.",
  upload_failed: "The photo couldn't be uploaded. Check your connection and try again.",
  no_suggestion: "There's nothing from the scan to use.",
  network: "Couldn't reach Kitty. Check your connection and try again.",
};

export function errorMessage(code: string | undefined): string | null {
  if (!code) return null;
  return messages[code] ?? "Something went wrong. Please try again.";
}
