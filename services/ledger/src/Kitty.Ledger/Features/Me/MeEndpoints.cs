using Kitty.Ledger.Data;
using Kitty.Ledger.Infrastructure.Auth;
using Kitty.Ledger.Infrastructure.Errors;

namespace Kitty.Ledger.Features.Me;

public sealed record MeDto(Guid Id, string DisplayName, string? Email);

public sealed record UpdateMeDto(string DisplayName);

public static class MeEndpoints
{
    public static RouteGroupBuilder MapMe(this IEndpointRouteBuilder app)
    {
        var group = app.MapGroup("/me").WithTags("Me");

        group.MapGet("/", async (ICurrentUser current, CancellationToken ct) =>
        {
            var u = await current.GetAsync(ct);
            return TypedResults.Ok(new MeDto(u.Id, u.DisplayName, u.Email));
        }).WithName("GetMe");

        group.MapPatch("/", async (UpdateMeDto body, ICurrentUser current, LedgerDbContext db, CancellationToken ct) =>
        {
            var name = body.DisplayName?.Trim() ?? "";
            if (name.Length is < 1 or > 100) return ApiError.Validation("displayName must be 1–100 characters.");

            var u = await current.GetAsync(ct);
            u.DisplayName = name;
            await db.SaveChangesAsync(ct);
            return Results.Ok(new MeDto(u.Id, u.DisplayName, u.Email));
        }).WithName("UpdateMe").Produces<MeDto>();

        return group;
    }
}
