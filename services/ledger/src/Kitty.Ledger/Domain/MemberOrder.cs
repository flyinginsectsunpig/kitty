namespace Kitty.Ledger.Domain;

/// <summary>
/// The one deterministic ordering of members used for remainder distribution and output:
/// ordinal comparison of the lowercase "D" string form. TypeScript uses the same rule.
/// </summary>
public static class MemberOrder
{
    public static int Compare(Guid a, Guid b) =>
        string.CompareOrdinal(a.ToString("D"), b.ToString("D"));

    public static IReadOnlyList<Guid> Sort(IEnumerable<Guid> ids) =>
        ids.OrderBy(id => id.ToString("D"), StringComparer.Ordinal).ToList();
}
