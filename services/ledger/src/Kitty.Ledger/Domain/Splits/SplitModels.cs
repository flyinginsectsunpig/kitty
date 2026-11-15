namespace Kitty.Ledger.Domain.Splits;

/// <summary>Itemized shares come from a confirmed table session, never from a split request.</summary>
public enum SplitMethod { Equal, Exact, Percent, Shares, Itemized }

/// <summary>
/// One participant's split input. Value meaning depends on the method:
/// Equal = ignored; Exact = minor units; Percent = basis points (10000 = 100%); Shares = weight 1–1000.
/// </summary>
public sealed record SplitInput(Guid MemberId, long? Value);

public sealed record Share(Guid MemberId, long Minor);

public abstract record SplitResult
{
    private SplitResult() { }

    /// <summary>Shares in member order; they always sum to the total.</summary>
    public sealed record Ok(IReadOnlyList<Share> Shares) : SplitResult;

    public sealed record Error(string Code) : SplitResult;
}

public static class SplitErrors
{
    public const string Empty = "split_empty";
    public const string DuplicateMember = "split_duplicate_member";
    public const string SumMismatch = "split_sum_mismatch";
    public const string InvalidValue = "split_invalid_value";
}
