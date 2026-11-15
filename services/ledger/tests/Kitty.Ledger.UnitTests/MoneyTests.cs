using Kitty.Ledger.Domain;

namespace Kitty.Ledger.UnitTests;

public class MoneyTests
{
    [Fact]
    public void Unsupported_currency_throws() =>
        Assert.Throws<ArgumentException>(() => new Money(100, "XXX"));

    [Fact]
    public void Adding_different_currencies_throws() =>
        Assert.Throws<InvalidOperationException>(() => new Money(1, "ZAR") + new Money(1, "USD"));

    [Fact]
    public void Adding_same_currency_sums_minor_units() =>
        Assert.Equal(new Money(350, "ZAR"), new Money(100, "ZAR") + new Money(250, "ZAR"));

    [Fact]
    public void Jpy_has_zero_exponent() => Assert.Equal(0, Currencies.Exponent("JPY"));

    [Fact]
    public void Zar_has_two_exponent() => Assert.Equal(2, Currencies.Exponent("ZAR"));

    [Fact]
    public void Lowercase_code_is_not_supported() => Assert.False(Currencies.IsSupported("zar"));

    [Fact]
    public void MemberOrder_is_ordinal_on_lowercase_D_string()
    {
        var a = Guid.Parse("0000000a-0000-0000-0000-000000000000");
        var b = Guid.Parse("00000001-0000-0000-0000-000000000000");
        Assert.Equal(new[] { b, a }, MemberOrder.Sort(new[] { a, b }));
    }
}
