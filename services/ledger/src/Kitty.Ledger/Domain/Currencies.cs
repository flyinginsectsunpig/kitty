using System.Collections.Frozen;
using System.Text.Json;

namespace Kitty.Ledger.Domain;

/// <summary>Supported ISO 4217 currencies and their minor-unit exponents, from contracts/currencies.json.</summary>
public static class Currencies
{
    private static readonly FrozenDictionary<string, int> Exponents = Load();

    public static bool IsSupported(string code) => Exponents.ContainsKey(code);

    public static int Exponent(string code) =>
        Exponents.TryGetValue(code, out var exponent)
            ? exponent
            : throw new ArgumentException($"Unsupported currency '{code}'.", nameof(code));

    public static IReadOnlyCollection<string> All => Exponents.Keys;

    private static FrozenDictionary<string, int> Load()
    {
        using var stream = typeof(Currencies).Assembly.GetManifestResourceStream("Kitty.Ledger.currencies.json")
            ?? throw new InvalidOperationException("Embedded currencies.json is missing.");
        var map = JsonSerializer.Deserialize<Dictionary<string, int>>(stream)
            ?? throw new InvalidOperationException("currencies.json is empty.");
        return map.ToFrozenDictionary(StringComparer.Ordinal);
    }
}
