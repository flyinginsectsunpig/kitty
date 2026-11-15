using Kitty.Ledger.Domain.Balances;
using Kitty.Ledger.Domain.Splits;
using static Kitty.Ledger.UnitTests.SplitCalculatorTests;

namespace Kitty.Ledger.UnitTests;

public class BalanceCalculatorTests
{
    private static LedgerExpense DinnerPaidByA(string currency = "ZAR") =>
        new(currency, [new Share(A, 900)], [new Share(A, 300), new Share(B, 300), new Share(C, 300)]);

    [Fact]
    public void Payer_is_owed_others_share()
    {
        var n = BalanceCalculator.NetByCurrency([DinnerPaidByA()], [])["ZAR"];
        Assert.Equal(600, n[A]);
        Assert.Equal(-300, n[B]);
        Assert.Equal(-300, n[C]);
    }

    [Fact]
    public void Settlement_reduces_debt()
    {
        var n = BalanceCalculator.NetByCurrency([DinnerPaidByA()], [new LedgerSettlement("ZAR", B, A, 300)])["ZAR"];
        Assert.Equal(0, n[B]);
        Assert.Equal(300, n[A]);
        Assert.Equal(-300, n[C]);
    }

    [Fact]
    public void Currencies_are_never_mixed()
    {
        var nets = BalanceCalculator.NetByCurrency([DinnerPaidByA("ZAR"), DinnerPaidByA("USD")], []);
        Assert.Equal(["USD", "ZAR"], nets.Keys.Order());
        Assert.All(nets.Values, n => Assert.Equal(0, n.Values.Sum()));
        Assert.Equal(600, nets["USD"][A]);
    }

    [Fact]
    public void Settlement_alone_creates_a_currency_entry()
    {
        var n = BalanceCalculator.NetByCurrency([], [new LedgerSettlement("EUR", A, B, 50)])["EUR"];
        Assert.Equal(50, n[A]);
        Assert.Equal(-50, n[B]);
    }
}
