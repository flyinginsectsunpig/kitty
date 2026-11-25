using Kitty.Ledger.Domain.Balances;

namespace Kitty.Ledger.UnitTests;

public class LastSquareTests
{
    private static List<(string Row, long MyDelta)> Rows(params (string, long)[] rows) => [.. rows];

    [Fact]
    public void Never_square_returns_everything() =>
        Assert.Equal(["a", "b"], LastSquare.Since(Rows(("a", -100), ("b", -50))));

    [Fact]
    public void Returns_rows_after_the_last_zero() =>
        Assert.Equal(["d", "e"], LastSquare.Since(Rows(("a", -100), ("b", 100), ("c", 0), ("d", -40), ("e", 10))));

    [Fact]
    public void Square_now_returns_nothing()
    {
        Assert.Empty(LastSquare.Since(Rows(("a", -100), ("b", 100))));
        Assert.Empty(LastSquare.Since(Rows()));
    }

    [Fact]
    public void Part_payment_stays_in_the_list() =>
        Assert.Equal(["uber", "groceries", "paid 50"],
            LastSquare.Since(Rows(("old", -30), ("settled", 30), ("uber", -2500), ("groceries", -9500), ("paid 50", 5000))));
}
