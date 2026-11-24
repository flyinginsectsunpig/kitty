using Kitty.Ledger.Data.Entities;
using Kitty.Ledger.Domain;
using Kitty.Ledger.Domain.Splits;

namespace Kitty.Ledger.Features.Expenses;

public sealed record PayerDto(Guid MemberId, long AmountMinor);

/// <summary>Value: null for equal; minor units for exact; basis points for percent; weight for shares.</summary>
public sealed record ParticipantDto(Guid MemberId, long? Value);

public sealed record SplitDto(SplitMethod Method, IReadOnlyList<ParticipantDto> Participants);

public sealed record ExpenseWriteDto(
    Guid Id,
    string Description,
    string Category,
    string Currency,
    long AmountMinor,
    DateOnly OccurredOn,
    IReadOnlyList<PayerDto> Payers,
    SplitDto Split,
    int? Version,
    string? FxRate = null);

public sealed record ShareDto(Guid MemberId, long AmountMinor);

public sealed record ExpenseDto(
    Guid Id,
    string Description,
    string Category,
    string Currency,
    long AmountMinor,
    DateOnly OccurredOn,
    IReadOnlyList<PayerDto> Payers,
    SplitDto Split,
    IReadOnlyList<ShareDto> Shares,
    int Version,
    Guid CreatedBy,
    DateTimeOffset CreatedAt,
    DateTimeOffset UpdatedAt,
    string? FxRate,
    DateOnly? FxRateDate,
    string? FxRateSource,
    long? ConvertedAmountMinor);

public sealed record ExpensePageDto(IReadOnlyList<ExpenseDto> Items, string? NextCursor);

public static class ExpenseMapping
{
    public static ExpenseDto ToDto(this Expense e)
    {
        var shares = e.Shares.OrderBy(s => s.MemberId, Comparer<Guid>.Create(MemberOrder.Compare)).ToList();
        return new ExpenseDto(
            e.Id, e.Description, e.Category, e.Currency.Trim(), e.AmountMinor, e.OccurredOn,
            e.Payers.OrderBy(p => p.MemberId, Comparer<Guid>.Create(MemberOrder.Compare))
                .Select(p => new PayerDto(p.MemberId, p.AmountMinor)).ToList(),
            new SplitDto(e.SplitMethod, shares.Select(s => new ParticipantDto(s.MemberId, s.InputValue)).ToList()),
            shares.Select(s => new ShareDto(s.MemberId, s.AmountMinor)).ToList(),
            e.Version, e.CreatedByUserId, e.CreatedAt, e.UpdatedAt,
            e.FxRate is { } rate ? Domain.Fx.FxRate.Format(rate) : null, e.FxRateDate, e.FxRateSource, e.ConvertedAmountMinor);
    }
}
