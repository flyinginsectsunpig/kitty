using System.Numerics;
using Kitty.Ledger.Domain.Splits;

namespace Kitty.Ledger.Domain.Fx;

/// <summary>
/// Converts minor units between currencies at a stored rate, exactly (integer arithmetic, no floats).
/// TypeScript's convertMinor uses the same rule; both run contracts/fixtures/fx.json.
/// </summary>
public static class FxConverter
{
    private static readonly BigInteger RateScale = BigInteger.Pow(10, FxRate.Places);

    /// <summary>minor × rate, rescaled between the currencies' minor units, rounded half away from zero.</summary>
    public static long Convert(long minor, decimal rate, string from, string to)
    {
        var (num, den) = Fraction(minor, rate, from, to);
        var quotient = BigInteger.DivRem(num, den, out var remainder);
        if (remainder * 2 >= den) quotient += 1;
        return (long)quotient;
    }

    /// <summary>
    /// Converts each part and makes them sum exactly to the converted total: floor each, then +1 to members in
    /// <see cref="MemberOrder"/> until the total is reached (the same rule splits use). Returned in member order.
    /// </summary>
    public static IReadOnlyList<Share> Spread(IReadOnlyList<Share> parts, decimal rate, string from, string to)
    {
        var ordered = parts.OrderBy(p => p.MemberId, Comparer<Guid>.Create(MemberOrder.Compare)).ToList();
        var total = Convert(ordered.Sum(p => p.Minor), rate, from, to);
        var floors = ordered.Select(p =>
        {
            var (num, den) = Fraction(p.Minor, rate, from, to);
            return (long)BigInteger.Divide(num, den);
        }).ToList();

        // Each floor loses less than 1 and the total rounds the exact sum, so 0 ≤ remainder ≤ parts.
        var remainder = total - floors.Sum();
        if (remainder < 0 || remainder > ordered.Count)
            throw new InvalidOperationException($"Remainder {remainder} is outside 0..{ordered.Count}.");
        return ordered.Select((p, i) => new Share(p.MemberId, floors[i] + (i < remainder ? 1 : 0))).ToList();
    }

    private static (BigInteger Num, BigInteger Den) Fraction(long minor, decimal rate, string from, string to)
    {
        ArgumentOutOfRangeException.ThrowIfNegative(minor);
        var scaled = rate * (decimal)RateScale;
        if (scaled != decimal.Truncate(scaled))
            throw new ArgumentException($"Rate {rate} has more than {FxRate.Places} decimal places.", nameof(rate));

        var shift = Currencies.Exponent(to) - Currencies.Exponent(from);
        var num = new BigInteger(minor) * new BigInteger(scaled) * BigInteger.Pow(10, Math.Max(0, shift));
        var den = RateScale * BigInteger.Pow(10, Math.Max(0, -shift));
        return (num, den);
    }
}
