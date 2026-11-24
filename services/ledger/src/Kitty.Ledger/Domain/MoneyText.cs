using System.Collections.Frozen;
using System.Globalization;
using System.Text;

namespace Kitty.Ledger.Domain;

/// <summary>
/// Money as the apps show it (their formatMoney: Intl en-ZA), for text the ledger writes, such as notifications:
/// "R 1 234,56", "€20,00", "-R 5,00". No-break spaces, decimal comma. Pinned by contracts/fixtures/money-format.json.
/// </summary>
public static class MoneyText
{
    private const char Nbsp = ' ';

    // en-ZA's currency prefixes (from Intl, see the fixture); a trailing no-break space where Intl puts one.
    private static readonly FrozenDictionary<string, string> Prefixes = new Dictionary<string, string>
    {
        ["AUD"] = "A$", ["BRL"] = "R$", ["CAD"] = "CA$", ["CNY"] = "CN¥", ["EUR"] = "€", ["GBP"] = "£", ["HKD"] = "HK$",
        ["ILS"] = "₪", ["INR"] = "₹", ["JPY"] = "JP¥", ["KRW"] = "₩", ["MXN"] = "MX$", ["NZD"] = "NZ$", ["PHP"] = "₱",
        ["USD"] = "US$", ["ZAR"] = $"R{Nbsp}",
    }.ToFrozenDictionary(StringComparer.Ordinal);

    public static string Format(long minor, string currency)
    {
        var exponent = Currencies.Exponent(currency);
        var prefix = Prefixes.GetValueOrDefault(currency) ?? $"{currency}{Nbsp}";
        var digits = Math.Abs((decimal)minor).ToString(CultureInfo.InvariantCulture).PadLeft(exponent + 1, '0');
        var whole = digits[..^exponent];
        var fraction = exponent == 0 ? "" : digits[^exponent..];

        var grouped = new StringBuilder();
        for (var i = 0; i < whole.Length; i++)
        {
            if (i > 0 && (whole.Length - i) % 3 == 0) grouped.Append(Nbsp);
            grouped.Append(whole[i]);
        }
        var number = exponent == 0 ? grouped.ToString() : $"{grouped},{fraction}";
        return $"{(minor < 0 ? "-" : "")}{prefix}{number}";
    }
}
