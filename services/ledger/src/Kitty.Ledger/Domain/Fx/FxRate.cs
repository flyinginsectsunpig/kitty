using System.Globalization;
using System.Text.RegularExpressions;

namespace Kitty.Ledger.Domain.Fx;

/// <summary>
/// An exchange rate as people and pulse write it: a plain decimal string, above 0, at most 1,000,000 and at most 10
/// decimal places ("19.1987"). Never a float. TypeScript's parseRate uses the same rule (contracts/fixtures/fx.json).
/// </summary>
public static partial class FxRate
{
    public const int Places = 10;
    public const decimal Max = 1_000_000m;

    [GeneratedRegex(@"^(0|[1-9]\d{0,6})(\.\d{1,10})?$", RegexOptions.CultureInvariant)]
    private static partial Regex Shape();

    public static bool TryParse(string? s, out decimal rate)
    {
        rate = 0;
        if (s is null || !Shape().IsMatch(s)) return false;
        var value = decimal.Parse(s, NumberStyles.AllowDecimalPoint, CultureInfo.InvariantCulture);
        if (value <= 0 || value > Max) return false;
        rate = value;
        return true;
    }

    /// <summary>The canonical text: no trailing zeros ("19.1987", "20").</summary>
    public static string Format(decimal rate) => rate.ToString("0.##########", CultureInfo.InvariantCulture);
}
