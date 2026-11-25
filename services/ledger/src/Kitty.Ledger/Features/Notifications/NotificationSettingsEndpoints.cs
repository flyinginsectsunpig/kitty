using Kitty.Ledger.Data;
using Kitty.Ledger.Data.Entities;
using Kitty.Ledger.Infrastructure;
using Kitty.Ledger.Infrastructure.Auth;
using Kitty.Ledger.Infrastructure.Errors;
using Microsoft.EntityFrameworkCore;

namespace Kitty.Ledger.Features.Notifications;

/// <summary>Per kind, push and email on or off. EmailAvailable: the person has a verified address.</summary>
public sealed record NotificationSettingsDto(bool ExpensePush, bool ExpenseEmail, bool PaymentPush, bool PaymentEmail,
    bool WeeklyPush, bool WeeklyEmail, bool EmailAvailable);

public sealed record NotificationSettingsWriteDto(bool ExpensePush, bool ExpenseEmail, bool PaymentPush, bool PaymentEmail,
    bool WeeklyPush, bool WeeklyEmail);

/// <summary>A phone's push token. Always in the body: URLs end up in logs and traces.</summary>
public sealed record DeviceDto(string Token, string Platform);

public sealed record ForgetDeviceDto(string Token);

public static class NotificationSettingsEndpoints
{
    private const int MaxTokenLength = 4096;

    public static void MapNotificationSettings(this IEndpointRouteBuilder app)
    {
        var me = app.MapGroup("/me").WithTags("Notifications");
        me.MapGet("/notifications", GetAsync).WithName("GetNotificationSettings").Produces<NotificationSettingsDto>();
        me.MapPut("/notifications", PutAsync).WithName("UpdateNotificationSettings").Produces<NotificationSettingsDto>();
        me.MapPost("/devices", RegisterAsync).WithName("RegisterDevice").Produces(StatusCodes.Status204NoContent);
        me.MapPost("/devices/forget", ForgetAsync).WithName("ForgetDevice").Produces(StatusCodes.Status204NoContent);
    }

    private static NotificationSettingsDto ToDto(NotificationSettings s, User u) =>
        new(s.ExpensePush, s.ExpenseEmail, s.PaymentPush, s.PaymentEmail, s.WeeklyPush, s.WeeklyEmail,
            EmailAvailable: u.EmailVerified && !string.IsNullOrEmpty(u.Email));

    private static async Task<IResult> GetAsync(ICurrentUser current, NotifySettingsPublisher publisher, LedgerDbContext db, CancellationToken ct)
    {
        var user = await current.GetAsync(ct);
        var settings = await publisher.SettingsAsync(user.Id, ct);
        if (db.Entry(settings).State == EntityState.Added)
        {
            await publisher.QueueAsync(user, ct);
            await db.SaveChangesAsync(ct);
        }
        return Results.Ok(ToDto(settings, user));
    }

    private static async Task<IResult> PutAsync(NotificationSettingsWriteDto body, ICurrentUser current, NotifySettingsPublisher publisher,
        LedgerDbContext db, CancellationToken ct)
    {
        var user = await current.GetAsync(ct);
        var s = await publisher.SettingsAsync(user.Id, ct);
        (s.ExpensePush, s.ExpenseEmail, s.PaymentPush, s.PaymentEmail, s.WeeklyPush, s.WeeklyEmail) =
            (body.ExpensePush, body.ExpenseEmail, body.PaymentPush, body.PaymentEmail, body.WeeklyPush, body.WeeklyEmail);
        await publisher.QueueAsync(user, ct);
        if (!await SaveAsync(db, ct)) return Conflict();
        return Results.Ok(ToDto(s, user));
    }

    private static async Task<IResult> RegisterAsync(DeviceDto body, ICurrentUser current, NotifySettingsPublisher publisher,
        LedgerDbContext db, TimeProvider clock, CancellationToken ct)
    {
        if (string.IsNullOrWhiteSpace(body.Token) || body.Token.Length > MaxTokenLength) return ApiError.Validation("token is required.");
        if (body.Platform != "android") return ApiError.Validation("platform must be android.");
        var user = await current.GetAsync(ct);
        var now = clock.NowMicros();

        var device = await db.PushDevices.SingleOrDefaultAsync(d => d.Token == body.Token, ct);
        User? previousOwner = null;
        if (device is null)
            db.PushDevices.Add(new PushDevice { Token = body.Token, UserId = user.Id, Platform = body.Platform, CreatedAt = now, LastSeenAt = now });
        else
        {
            if (device.UserId != user.Id)
            {
                // A shared phone: the token now belongs to whoever signed in last.
                previousOwner = await db.Users.SingleAsync(u => u.Id == device.UserId, ct);
                device.UserId = user.Id;
            }
            device.LastSeenAt = now;
        }

        if (device is null || previousOwner is not null)
        {
            await publisher.QueueAsync(user, ct);
            if (previousOwner is not null) await publisher.QueueAsync(previousOwner, ct);
        }
        if (!await SaveAsync(db, ct)) return Conflict();
        return Results.NoContent();
    }

    private static async Task<IResult> ForgetAsync(ForgetDeviceDto body, ICurrentUser current, NotifySettingsPublisher publisher,
        LedgerDbContext db, CancellationToken ct)
    {
        var user = await current.GetAsync(ct);
        var device = await db.PushDevices.SingleOrDefaultAsync(d => d.Token == body.Token && d.UserId == user.Id, ct);
        if (device is null) return Results.NoContent();
        db.PushDevices.Remove(device);
        await publisher.QueueAsync(user, ct);
        if (!await SaveAsync(db, ct)) return Conflict();
        return Results.NoContent();
    }

    /// <summary>False when another change to the person's settings or phones saved first (the caller may retry).</summary>
    private static async Task<bool> SaveAsync(LedgerDbContext db, CancellationToken ct)
    {
        try
        {
            await db.SaveChangesAsync(ct);
            return true;
        }
        catch (DbUpdateConcurrencyException)
        {
            return false;
        }
    }

    private static IResult Conflict() =>
        ApiError.Conflict(ErrorCodes.VersionConflict, "Your notification settings changed at the same moment. Try again.");
}
