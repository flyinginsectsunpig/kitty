using Kitty.Ledger.Data;
using Kitty.Ledger.Data.Entities;
using Kitty.Ledger.Domain;
using Kitty.Ledger.Domain.Fx;
using Kitty.Ledger.Domain.Splits;
using Kitty.Ledger.Features.Expenses;
using Kitty.Ledger.Features.Fx;
using Kitty.Ledger.Features.Groups;
using Kitty.Ledger.Infrastructure;
using Kitty.Ledger.Infrastructure.Audit;
using Kitty.Ledger.Infrastructure.Errors;
using Microsoft.EntityFrameworkCore;

namespace Kitty.Ledger.Features.Settlements;

/// <summary>FxRate: typed by a person (omit to use the ECB rate). PaidInGroupCurrency: paid in the group's currency instead.</summary>
public sealed record SettlementWriteDto(Guid Id, Guid FromMemberId, Guid ToMemberId, string Currency, long AmountMinor,
    string? FxRate = null, bool PaidInGroupCurrency = false);

public sealed record SettlementDto(Guid Id, Guid FromMemberId, Guid ToMemberId, string Currency, long AmountMinor,
    Guid CreatedBy, DateTimeOffset CreatedAt, string? FxRate, DateOnly? FxRateDate, string? FxRateSource,
    long? ConvertedAmountMinor, bool PaidInGroupCurrency);

/// <summary>"From paid To back" — recorded by either party (or anyone in the group) when money changed hands outside Kitty.</summary>
public static class SettlementEndpoints
{
    public const string EntityType = "settlement";

    public static void MapSettlements(this RouteGroupBuilder group)
    {
        var settlements = group.MapGroup("/settlements").WithTags("Settlements");
        settlements.MapPost("/", CreateAsync).WithName("CreateSettlement").Produces<SettlementDto>(StatusCodes.Status201Created);
        settlements.MapDelete("/{settlementId:guid}", DeleteAsync).WithName("DeleteSettlement").Produces(StatusCodes.Status204NoContent);
    }

    private static async Task<IResult> CreateAsync(Guid groupId, SettlementWriteDto body, HttpContext http, LedgerDbContext db,
        AuditWriter audit, ExpenseRates rates, TimeProvider clock, CancellationToken ct)
    {
        if (body.Id == Guid.Empty) return ApiError.Validation("id must be a client-generated UUID.");
        if (body.FromMemberId == body.ToMemberId) return ApiError.Validation("A member cannot settle with themselves.");
        if (body.AmountMinor is < 1 or > SplitCalculator.MaxTotalMinor) return ApiError.Validation("amountMinor must be between 1 and 10,000,000,000.");
        if (!Currencies.IsSupported(body.Currency ?? ""))
            return ApiError.BadRequest(ErrorCodes.CurrencyUnsupported, $"'{body.Currency}' is not a supported currency.");

        var inGroup = await db.Members.CountAsync(m => m.GroupId == groupId && (m.Id == body.FromMemberId || m.Id == body.ToMemberId), ct);
        if (inGroup != 2) return ApiError.BadRequest(ErrorCodes.MemberNotInGroup, "Both members must be in this group.");
        if (await db.Settlements.AnyAsync(s => s.Id == body.Id, ct)) return ApiError.Conflict(ErrorCodes.AlreadyExists);

        var groupCurrency = await ExpenseEndpoints.GroupCurrencyAsync(db, groupId, ct);
        if (body.PaidInGroupCurrency && body.Currency == groupCurrency)
            return ApiError.Validation("Paying in the group's currency only applies to a debt in another currency.");
        // Settlements have no date and can't be edited, so a foreign one always gets today's rate, or one typed in.
        var today = DateOnly.FromDateTime(clock.GetUtcNow().UtcDateTime);
        var decision = await rates.DecideAsync(body.Currency!, groupCurrency, today, body.FxRate, null, ct);
        long? converted = null;
        switch (decision)
        {
            case RateDecision.Invalid invalid:
                return ApiError.BadRequest(ErrorCodes.FxRateInvalid, invalid.Detail);
            case RateDecision.Missing:
                return ApiError.Problem(StatusCodes.Status422UnprocessableEntity, ErrorCodes.FxRateRequired,
                    "We couldn't look up the exchange rate. Enter it to record this payment.");
            case RateDecision.Rate r:
                converted = FxConverter.Convert(body.AmountMinor, r.Value, body.Currency!, groupCurrency);
                if (converted > SplitCalculator.MaxTotalMinor) return ApiError.BadRequest(ErrorCodes.FxRateInvalid, "Converted amount is too large.");
                break;
        }
        var rate = decision as RateDecision.Rate;

        var caller = GroupMemberFilter.CallerMember(http);
        var settlement = new Settlement
        {
            Id = body.Id, GroupId = groupId, FromMemberId = body.FromMemberId, ToMemberId = body.ToMemberId,
            Currency = body.Currency!, AmountMinor = body.AmountMinor, CreatedByUserId = caller.User.Id, CreatedAt = clock.NowMicros(),
            FxRate = rate?.Value, FxRateDate = rate?.EcbDate, FxRateSource = rate?.Source, ConvertedAmountMinor = converted,
            PaidInGroupCurrency = body.PaidInGroupCurrency,
        };
        db.Settlements.Add(settlement);

        var dto = ToDto(settlement);
        audit.Record(caller.User.Id, groupId, EntityType, settlement.Id, AuditActions.Created, null, dto);
        await db.SaveChangesAsync(ct);
        return Results.Created($"/groups/{groupId}/settlements/{settlement.Id}", dto);
    }

    private static async Task<IResult> DeleteAsync(Guid groupId, Guid settlementId, HttpContext http, LedgerDbContext db,
        AuditWriter audit, TimeProvider clock, CancellationToken ct)
    {
        var settlement = await db.Settlements.SingleOrDefaultAsync(s => s.Id == settlementId && s.GroupId == groupId && s.DeletedAt == null, ct);
        if (settlement is null) return ApiError.NotFound();

        var caller = GroupMemberFilter.CallerMember(http);
        settlement.DeletedAt = clock.NowMicros();
        audit.Record(caller.User.Id, groupId, EntityType, settlement.Id, AuditActions.Deleted, ToDto(settlement), null);
        await db.SaveChangesAsync(ct);
        return Results.NoContent();
    }

    private static SettlementDto ToDto(Settlement s) =>
        new(s.Id, s.FromMemberId, s.ToMemberId, s.Currency.Trim(), s.AmountMinor, s.CreatedByUserId, s.CreatedAt,
            s.FxRate is { } rate ? Domain.Fx.FxRate.Format(rate) : null, s.FxRateDate, s.FxRateSource, s.ConvertedAmountMinor,
            s.PaidInGroupCurrency);
}
