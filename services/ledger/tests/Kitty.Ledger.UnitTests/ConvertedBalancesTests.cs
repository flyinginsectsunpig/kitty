using Kitty.Ledger.Domain.Balances;
using Kitty.Ledger.Domain.Splits;

namespace Kitty.Ledger.UnitTests;

public class ConvertedBalancesTests
{
    private static readonly Guid A = Guid.Parse("00000001-0000-0000-0000-000000000000");
    private static readonly Guid B = Guid.Parse("00000002-0000-0000-0000-000000000000");

    private static ConvertibleExpense Equal(string currency, decimal? rate, long amount, Guid payer) =>
        new(currency, rate, [new Share(payer, amount)], [new Share(A, amount / 2 + amount % 2), new Share(B, amount / 2)]);

    [Fact]
    public void Converted_nets_sum_to_zero()
    {
        var random = new Random(24112026);
        for (var i = 0; i < 500; i++)
        {
            var expenses = Enumerable.Range(0, random.Next(1, 6)).Select(_ =>
            {
                var currency = random.Next(3) switch { 0 => "ZAR", 1 => "EUR", _ => "JPY" };
                var rate = currency == "ZAR" ? (decimal?)null : Math.Round((decimal)random.NextDouble() * 30 + 0.01m, 4);
                return Equal(currency, rate, random.NextInt64(2, 1_000_000), random.Next(2) == 0 ? A : B);
            }).ToList();

            var (nets, excluded) = ConvertedBalances.Compute("ZAR", expenses, []);

            Assert.Equal(0, nets.Values.Sum());
            Assert.Equal(0, excluded);
        }
    }

    [Fact]
    public void Rows_without_rate_are_excluded_and_counted()
    {
        var (nets, excluded) = ConvertedBalances.Compute("ZAR",
            [Equal("ZAR", null, 1000, A), Equal("EUR", null, 4000, A)],
            [new ConvertibleSettlement("EUR", B, A, 100, ConvertedMinor: null)]);

        Assert.Equal(2, excluded);
        Assert.Equal(500, nets[A]);
        Assert.Equal(-500, nets[B]);
    }

    [Fact]
    public void Drift_shows_as_a_leftover()
    {
        // EUR 40.00 at 19.1987, paid by A, split equally: converted shares 38398 (A) and 38397 (B).
        // B settles EUR 20.00, paid in ZAR at 19.5 → 39000. Per-currency EUR is square; the rand total isn't.
        var (nets, excluded) = ConvertedBalances.Compute("ZAR",
            [new ConvertibleExpense("EUR", 19.1987m, [new Share(A, 4000)], [new Share(A, 2000), new Share(B, 2000)])],
            [new ConvertibleSettlement("EUR", B, A, 2000, ConvertedMinor: 39000)]);

        Assert.Equal(0, excluded);
        Assert.Equal(-603, nets[A]);
        Assert.Equal(603, nets[B]);
    }
}
