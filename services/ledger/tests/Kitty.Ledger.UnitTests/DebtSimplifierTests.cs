using FsCheck;
using FsCheck.Xunit;
using Kitty.Ledger.Domain.Balances;
using static Kitty.Ledger.UnitTests.SplitCalculatorTests;

namespace Kitty.Ledger.UnitTests;

public class DebtSimplifierTests
{
    [Fact]
    public void Simplify_chain_collapses() =>
        Assert.Equal([new Transfer(A, C, 100)],
            DebtSimplifier.Simplify(new Dictionary<Guid, long> { [A] = -100, [B] = 0, [C] = 100 }));

    [Fact]
    public void Simplify_rejects_unbalanced() =>
        Assert.Throws<ArgumentException>(() => DebtSimplifier.Simplify(new Dictionary<Guid, long> { [A] = 1 }));

    [Fact]
    public void Everyone_settled_means_no_transfers() =>
        Assert.Empty(DebtSimplifier.Simplify(new Dictionary<Guid, long> { [A] = 0, [B] = 0 }));

    [Fact]
    public void Ties_are_broken_by_member_order()
    {
        // B and C each owe 50 to A: the larger-debtor tie is broken by member order (B before C).
        var transfers = DebtSimplifier.Simplify(new Dictionary<Guid, long> { [C] = -50, [B] = -50, [A] = 100 });
        Assert.Equal([new Transfer(B, A, 50), new Transfer(C, A, 50)], transfers);
    }

    [Property(MaxTest = 500)]
    public bool Simplify_preserves_every_net_position(NonEmptyArray<int> raw)
    {
        var nets = Balanced(raw);
        var remaining = new Dictionary<Guid, long>(nets);
        foreach (var t in DebtSimplifier.Simplify(nets))
        {
            if (t.Minor <= 0 || t.From == t.To) return false;
            remaining[t.From] += t.Minor; // debtor pays → less negative
            remaining[t.To] -= t.Minor;   // creditor receives → less positive
        }
        return remaining.Values.All(v => v == 0);
    }

    [Property(MaxTest = 500)]
    public bool Simplify_uses_at_most_n_minus_1_transfers(NonEmptyArray<int> raw)
    {
        var nets = Balanced(raw);
        var nonZero = nets.Values.Count(v => v != 0);
        return DebtSimplifier.Simplify(nets).Count <= Math.Max(0, nonZero - 1);
    }

    /// <summary>Random member nets that sum to zero: the last member absorbs the remainder.</summary>
    private static Dictionary<Guid, long> Balanced(NonEmptyArray<int> raw)
    {
        var values = raw.Get.Take(30).Select(v => (long)(v % 1_000_000)).ToList();
        values.Add(-values.Sum());
        return values.ToDictionary(_ => Guid.NewGuid(), v => v);
    }
}
