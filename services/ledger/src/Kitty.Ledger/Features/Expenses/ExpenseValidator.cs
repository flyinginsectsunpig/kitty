using Kitty.Ledger.Data.Entities;
using Kitty.Ledger.Domain;
using Kitty.Ledger.Domain.Splits;
using Kitty.Ledger.Infrastructure.Errors;

namespace Kitty.Ledger.Features.Expenses;

public abstract record ExpenseValidation
{
    private ExpenseValidation() { }

    /// <summary>The computed shares, in member order, summing to the amount.</summary>
    public sealed record Valid(IReadOnlyList<Share> Shares) : ExpenseValidation;

    public sealed record Invalid(string Code, string Detail) : ExpenseValidation;
}

public static class ExpenseValidator
{
    public static ExpenseValidation Validate(ExpenseWriteDto e, IReadOnlySet<Guid> groupMemberIds)
    {
        static ExpenseValidation Fail(string detail, string code = ErrorCodes.ValidationFailed) =>
            new ExpenseValidation.Invalid(code, detail);

        if (e.Id == Guid.Empty) return Fail("id must be a client-generated UUID.");
        var description = e.Description?.Trim() ?? "";
        if (description.Length is < 1 or > 120) return Fail("description must be 1–120 characters.");
        if (!Categories.All.Contains(e.Category ?? "")) return Fail($"category must be one of: {string.Join(", ", Categories.All)}.");
        if (!Currencies.IsSupported(e.Currency ?? "")) return Fail($"'{e.Currency}' is not a supported currency.", ErrorCodes.CurrencyUnsupported);
        if (e.AmountMinor is < 1 or > SplitCalculator.MaxTotalMinor) return Fail("amountMinor must be between 1 and 10,000,000,000.");

        var payers = e.Payers ?? [];
        if (payers.Count == 0) return Fail("At least one payer is required.");
        if (payers.Select(p => p.MemberId).Distinct().Count() != payers.Count) return Fail("Each payer may appear only once.");
        // Bounding each amount keeps the sums below from overflowing on hostile input.
        if (payers.Any(p => p.AmountMinor is < 1 or > SplitCalculator.MaxTotalMinor))
            return Fail("Each payer must have paid between 1 and 10,000,000,000 minor units.");

        var participants = e.Split?.Participants ?? [];
        if (payers.Any(p => !groupMemberIds.Contains(p.MemberId)) || participants.Any(p => !groupMemberIds.Contains(p.MemberId)))
            return Fail("Every payer and participant must be a member of this group.", ErrorCodes.MemberNotInGroup);

        if (payers.Sum(p => p.AmountMinor) != e.AmountMinor)
            return Fail("Payer amounts must add up to the expense amount.", ErrorCodes.PayersSumMismatch);

        if (e.Split is null) return Fail("split is required.");
        if (!Enum.IsDefined(e.Split.Method)) return Fail("split.method is not supported.");
        return SplitCalculator.Calculate(e.AmountMinor, e.Split.Method,
                participants.Select(p => new SplitInput(p.MemberId, p.Value)).ToList()) switch
        {
            SplitResult.Ok ok => new ExpenseValidation.Valid(ok.Shares),
            SplitResult.Error err => Fail("The split is not valid for this amount.", err.Code),
            _ => throw new InvalidOperationException(),
        };
    }
}
