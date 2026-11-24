using Kitty.Ledger.Domain;
using Kitty.Ledger.Domain.Fx;
using Kitty.Ledger.Domain.Splits;

namespace Kitty.Ledger.UnitTests;

public class FxConverterTests
{
    [Fact]
    public void Spread_always_sums_to_the_converted_total()
    {
        var random = new Random(20261124);
        var currencies = new[] { "ZAR", "EUR", "JPY", "KRW", "USD", "ISK" };
        for (var i = 0; i < 1000; i++)
        {
            var from = currencies[random.Next(currencies.Length)];
            var to = currencies[random.Next(currencies.Length)];
            // Rates from 0.0001 to 200000, with up to 10 decimal places.
            var rate = Math.Round((decimal)(random.NextDouble() * 200_000) + 0.0001m, random.Next(0, 11));
            var parts = Enumerable.Range(0, random.Next(1, 6))
                .Select(_ => new Share(Guid.NewGuid(), random.NextInt64(1, 1_000_000)))
                .ToList();

            var spread = FxConverter.Spread(parts, rate, from, to);

            Assert.Equal(FxConverter.Convert(parts.Sum(p => p.Minor), rate, from, to), spread.Sum(p => p.Minor));
            Assert.Equal(MemberOrder.Sort(parts.Select(p => p.MemberId)), spread.Select(p => p.MemberId));
        }
    }

    [Fact]
    public void Negative_amounts_are_rejected()
    {
        Assert.Throws<ArgumentOutOfRangeException>(() => FxConverter.Convert(-1, 19.1987m, "EUR", "ZAR"));
    }
}
