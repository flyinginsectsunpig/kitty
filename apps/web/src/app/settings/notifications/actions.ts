"use server";

import { NOTIFICATION_ROWS } from "@kitty/core";
import type { NotificationSettingsWriteDto } from "@kitty/api-client";
import { redirect } from "next/navigation";
import { getLedger, problemCode } from "@/lib/ledger";

/** Saves the form's switches; an unticked checkbox isn't sent, so absent means off. */
export async function saveNotifications(form: FormData) {
  const body = Object.fromEntries(
    NOTIFICATION_ROWS.flatMap((r) => [r.push, r.email]).map((field) => [field, form.get(field) === "on"]),
  ) as NotificationSettingsWriteDto;
  const ledger = await getLedger();
  const key = form.get("idempotencyKey");
  const { error } = await ledger.PUT("/me/notifications", {
    body,
    ...(typeof key === "string" && key ? { headers: { "Idempotency-Key": key } } : {}),
  });
  if (error) redirect(`/settings/notifications?error=${problemCode(error)}`);
  redirect("/settings/notifications?saved=1");
}
