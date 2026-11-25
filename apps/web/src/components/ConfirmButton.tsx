"use client";

import type { ReactNode } from "react";

/** A submit button that asks first; the form isn't sent unless the person says OK. */
export function ConfirmButton({ question, className, children }: { question: string; className?: string; children: ReactNode }) {
  return (
    <button
      className={className}
      onClick={(e) => {
        if (!confirm(question)) e.preventDefault();
      }}
    >
      {children}
    </button>
  );
}
