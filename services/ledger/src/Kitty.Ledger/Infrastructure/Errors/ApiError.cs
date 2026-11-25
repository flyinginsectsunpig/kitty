namespace Kitty.Ledger.Infrastructure.Errors;

/// <summary>RFC 7807 problem responses carrying a stable machine-readable <c>code</c>.</summary>
public static class ApiError
{
    public static IResult Problem(int status, string code, string? detail = null) =>
        Results.Problem(
            statusCode: status,
            title: code,
            detail: detail,
            extensions: new Dictionary<string, object?> { ["code"] = code });

    public static IResult Validation(string detail) => Problem(StatusCodes.Status400BadRequest, ErrorCodes.ValidationFailed, detail);
    public static IResult NotFound() => Problem(StatusCodes.Status404NotFound, ErrorCodes.NotFound);
    public static IResult Conflict(string code, string? detail = null) => Problem(StatusCodes.Status409Conflict, code, detail);
    public static IResult BadRequest(string code, string? detail = null) => Problem(StatusCodes.Status400BadRequest, code, detail);
}

public static class ErrorCodes
{
    public const string ValidationFailed = "validation_failed";
    public const string CurrencyUnsupported = "currency_unsupported";
    public const string MemberNotInGroup = "member_not_in_group";
    public const string CoverInvalid = "cover_invalid";
    public const string PayersSumMismatch = "payers_sum_mismatch";
    public const string IdempotencyKeyRequired = "idempotency_key_required";
    public const string NotFound = "not_found";
    public const string VersionConflict = "version_conflict";
    public const string AlreadyExists = "already_exists";
    public const string AlreadyMember = "already_member";
    public const string InviteUsed = "invite_used";
    public const string InviteExpired = "invite_expired";
    public const string PlaceholderClaimed = "placeholder_claimed";
    public const string RequestInProgress = "request_in_progress";
    public const string IdempotencyKeyReused = "idempotency_key_reused";
    public const string RateLimited = "rate_limited";
    public const string EditInTable = "edit_in_table";
    public const string SessionLocked = "session_locked";
    public const string SessionClosed = "session_closed";
    public const string HostOnly = "host_only";
    public const string GuestsUnmapped = "guests_unmapped";
    public const string UploadMissing = "upload_missing";
    public const string UploadTooLarge = "upload_too_large";
    public const string UploadNotImage = "upload_not_image";
    public const string NoSuggestion = "no_suggestion";
    public const string FxRateUnavailable = "fx_rate_unavailable";
    public const string NothingOwed = "nothing_owed";
    public const string NoAccount = "no_account";
    public const string AlreadyReminded = "already_reminded";
    public const string FxRateRequired = "fx_rate_required";
    public const string FxRateInvalid = "fx_rate_invalid";
    public const string ScheduleStarted = "schedule_started";
    public const string ServiceTokenNotAllowed = "service_token_not_allowed";
}
