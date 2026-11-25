"use server";

import { notificationWrite } from "@kitty/core";
import { redirect } from "next/navigation";
import { getLedger, problemCode, unwrap } from "@/lib/ledger";

/** Saves the form's switches; an unticked checkbox isn't sent, so absent means off. */
export async function saveNotifications(form: FormData) {
  const ledger = await getLedger();
  const current = unwrap(await ledger.GET("/me/notifications"));
  const body = notificationWrite((field) => form.get(field) === "on", current);
  const key = form.get("idempotencyKey");
  const { error } = await ledger.PUT("/me/notifications", {
    body,
    ...(typeof key === "string" && key ? { headers: { "Idempotency-Key": key } } : {}),
  });
  if (error) redirect(`/settings/notifications?error=${problemCode(error)}`);
  redirect("/settings/notifications?saved=1");
}
