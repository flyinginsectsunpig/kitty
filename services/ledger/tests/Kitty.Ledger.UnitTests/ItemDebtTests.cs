using Kitty.Ledger.Data.Entities;
using Kitty.Ledger.Domain.Balances;

namespace Kitty.Ledger.UnitTests;

public class ItemDebtTests
{
    private static readonly Guid Me = new(3, 0, 0, new byte[8]);
    private static readonly Guid Joe = new(1, 0, 0, new byte[8]);
    private static readonly Guid Sam = new(2, 0, 0, new byte[8]);

    private static ExpensePayer P(Guid member, long amount) => new() { MemberId = member, AmountMinor = amount };
    private static ExpenseShare S(Guid member, long amount) => new() { MemberId = member, AmountMinor = amount };

    [Fact]
    public void One_payer_gets_the_whole_share() =>
        Assert.Equal(2500, ItemDebt.Owed([P(Joe, 5000)], [S(Me, 2500), S(Joe, 2500)], Me, Joe));

    [Fact]
    public void Nobody_owes_themselves() =>
        Assert.Equal(0, ItemDebt.Owed([P(Joe, 5000)], [S(Joe, 5000)], Joe, Joe));

    [Fact]
    public void Not_a_payer_is_owed_nothing() =>
        Assert.Equal(0, ItemDebt.Owed([P(Joe, 5000)], [S(Me, 5000)], Me, Sam));

    [Fact]
    public void Two_payers_split_the_share_by_what_they_paid()
    {
        // Share 100 between payers who paid 2 and 1: 66,67 -> floors 66 and 33, the leftover 1 goes to the larger remainder (Joe's ,67).
        var payers = new[] { P(Joe, 200), P(Sam, 100) };
        var shares = new[] { S(Me, 100), S(Joe, 100), S(Sam, 100) };
        Assert.Equal((67L, 33L), (ItemDebt.Owed(payers, shares, Me, Joe), ItemDebt.Owed(payers, shares, Me, Sam)));
    }

    [Fact]
    public void Equal_remainders_go_to_the_lower_member_id()
    {
        var payers = new[] { P(Sam, 100), P(Joe, 100) };
        var shares = new[] { S(Me, 1) };
        Assert.Equal((1L, 0L), (ItemDebt.Owed(payers, shares, Me, Joe), ItemDebt.Owed(payers, shares, Me, Sam)));
    }
}
