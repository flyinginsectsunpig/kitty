"use client";

import { describeRate } from "@kitty/core";
import { convertMinor, formatMoney, parseRate } from "@kitty/money";
import { useEffect, useState } from "react";

/**
 * Extra fields for settling a foreign-currency debt: today's ECB rate (the ledger stores it on the payment), an option to
 * pay in the group's currency instead, and a rate box. The box is sent only when the person types in it; it's shown
 * when they pay in the group's currency or when the ECB rate couldn't be fetched (the ledger then needs one).
 */
export function ForeignSettleFields({ groupId, currency, groupCurrency, amountMinor, fetchRate }: {
  groupId: string;
  currency: string;
  groupCurrency: string;
  amountMinor: number;
  fetchRate: (groupId: string, currency: string, date: string) => Promise<{ rate: string; rateDate: string } | null>;
}) {
  const [quote, setQuote] = useState<{ rate: string; rateDate: string } | "failed" | null>(null);
  const [inGroupCurrency, setInGroupCurrency] = useState(false);
  const [typed, setTyped] = useState("");

  useEffect(() => {
    let live = true;
    fetchRate(groupId, currency, new Date().toISOString().slice(0, 10))
      .then((q) => live && setQuote(q ?? "failed"))
      .catch(() => live && setQuote("failed"));
    return () => {
      live = false;
    };
  }, [groupId, currency, fetchRate]);

  const ecb = quote && quote !== "failed" ? quote : null;
  const rate = parseRate(typed.trim()) ?? ecb?.rate ?? null;
  const showRateBox = inGroupCurrency || quote === "failed";

  return (
    <div className="space-y-2 text-sm">
      <label className="flex items-center gap-2">
        <input type="checkbox" name="paidInGroupCurrency" className="size-4 accent-brand-600" checked={inGroupCurrency}
          onChange={(e) => setInGroupCurrency(e.target.checked)} />
        <span>Pay in {groupCurrency} instead</span>
      </label>
      <p className="text-stone-600 dark:text-stone-400">
        {ecb ? describeRate({ from: currency, to: groupCurrency, rate: ecb.rate, rateDate: ecb.rateDate, source: "ecb" })
          : quote === "failed" ? "Couldn't get today's ECB rate. Enter the rate you used."
          : "Getting today's rate…"}
      </p>
      {inGroupCurrency && rate && (
        <p className="font-semibold tabular-nums">
          Pay {formatMoney(convertMinor(amountMinor, rate, currency, groupCurrency), groupCurrency)}
        </p>
      )}
      {showRateBox && (
        <div>
          <label htmlFor={`rate-${currency}`} className="label">Rate (1 {currency} in {groupCurrency})</label>
          <input id={`rate-${currency}`} name="fxRate" inputMode="decimal" className="field" placeholder={ecb?.rate ?? "e.g. 19.5"}
            value={typed} onChange={(e) => setTyped(e.target.value)} />
        </div>
      )}
    </div>
  );
}
