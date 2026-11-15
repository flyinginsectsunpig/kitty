using System.Net.Http.Json;
using System.Text.Json;

namespace Kitty.Ledger.IntegrationTests;

/// <summary>Mutation helpers that always send an Idempotency-Key (a fresh one unless given).</summary>
public static class ApiClientExtensions
{
    public static readonly JsonSerializerOptions Json = new(JsonSerializerDefaults.Web);

    private static CancellationToken Ct => TestContext.Current.CancellationToken;

    public static Task<HttpResponseMessage> PostJsonAsync(this HttpClient c, string url, object body, string? key = null) =>
        c.SendAsync(Build(HttpMethod.Post, url, body, key), Ct);

    public static Task<HttpResponseMessage> PutJsonAsync(this HttpClient c, string url, object body, string? key = null) =>
        c.SendAsync(Build(HttpMethod.Put, url, body, key), Ct);

    public static Task<HttpResponseMessage> PatchJsonAsync(this HttpClient c, string url, object body, string? key = null) =>
        c.SendAsync(Build(HttpMethod.Patch, url, body, key), Ct);

    public static Task<HttpResponseMessage> DeleteAsync(this HttpClient c, string url, string? key) =>
        c.SendAsync(Build(HttpMethod.Delete, url, null, key), Ct);

    public static async Task<T> ReadAsync<T>(this HttpResponseMessage r) =>
        (await r.Content.ReadFromJsonAsync<T>(Json, Ct))!;

    /// <summary>The problem-details <c>code</c> extension of an error response.</summary>
    public static async Task<string?> ReadCodeAsync(this HttpResponseMessage r)
    {
        using var doc = JsonDocument.Parse(await r.Content.ReadAsStringAsync(Ct));
        return doc.RootElement.TryGetProperty("code", out var code) ? code.GetString() : null;
    }

    private static HttpRequestMessage Build(HttpMethod method, string url, object? body, string? key)
    {
        var request = new HttpRequestMessage(method, url);
        if (body is not null) request.Content = JsonContent.Create(body, options: Json);
        request.Headers.Add("Idempotency-Key", key ?? Guid.NewGuid().ToString());
        return request;
    }
}
