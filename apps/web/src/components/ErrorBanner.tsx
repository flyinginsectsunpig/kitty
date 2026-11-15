import { errorMessage } from "@/lib/errors";

export function ErrorBanner({ code }: { code: string | undefined }) {
  const message = errorMessage(code);
  if (!message) return null;
  return (
    <p role="alert" className="rounded-xl bg-red-50 p-3 text-sm text-owes dark:bg-red-950">
      {message}
    </p>
  );
}
