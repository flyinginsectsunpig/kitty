namespace Kitty.Ledger.Domain;

/// <summary>An amount in integer minor units (e.g. cents) of a supported currency.</summary>
public readonly record struct Money
{
    public Money(long minor, string currency)
    {
        if (!Currencies.IsSupported(currency))
            throw new ArgumentException($"Unsupported currency '{currency}'.", nameof(currency));
        Minor = minor;
        Currency = currency;
    }

    public long Minor { get; }
    public string Currency { get; }

    public static Money operator +(Money a, Money b) => new(checked(a.Minor + b.Minor), SameCurrency(a, b));
    public static Money operator -(Money a, Money b) => new(checked(a.Minor - b.Minor), SameCurrency(a, b));

    private static string SameCurrency(Money a, Money b) =>
        a.Currency == b.Currency
            ? a.Currency
            : throw new InvalidOperationException($"Cannot combine {a.Currency} with {b.Currency}.");
}
