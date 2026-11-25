"use client";

import type { ReactNode } from "react";

/** A submit button that asks first; the form isn't sent unless the person says OK. label: its accessible name. */
export function ConfirmButton({
  question,
  label,
  className,
  children,
}: {
  question: string;
  label?: string;
  className?: string;
  children: ReactNode;
}) {
  return (
    <button
      className={className}
      aria-label={label}
      onClick={(e) => {
        if (!confirm(question)) e.preventDefault();
      }}
    >
      {children}
    </button>
  );
}
