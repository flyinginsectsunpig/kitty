using System.Net;
using System.Text.Json;
using System.Text.Json.Nodes;

namespace Kitty.Ledger.IntegrationTests;

/// <summary>
/// The committed services/ledger/openapi/ledger.json is the contract the TypeScript client is generated from.
/// Run with KITTY_UPDATE_OPENAPI=1 to rewrite it after changing the API.
/// </summary>
[Collection(ApiCollection.Name)]
public class OpenApiTests(LedgerApiFactory factory)
{
    private static CancellationToken Ct => TestContext.Current.CancellationToken;

    private static string CommittedPath([System.Runtime.CompilerServices.CallerFilePath] string here = "") =>
        Path.GetFullPath(Path.Combine(Path.GetDirectoryName(here)!, "..", "..", "openapi", "ledger.json"));

    [Fact]
    public async Task Document_is_served_anonymously() =>
        Assert.Equal(HttpStatusCode.OK, (await factory.CreateClient().GetAsync("/openapi/v1.json", Ct)).StatusCode);

    [Fact]
    public async Task Committed_document_is_current()
    {
        var live = Normalize(await factory.CreateClient().GetStringAsync("/openapi/v1.json", Ct));
        var path = CommittedPath();

        if (Environment.GetEnvironmentVariable("KITTY_UPDATE_OPENAPI") == "1")
        {
            Directory.CreateDirectory(Path.GetDirectoryName(path)!);
            await File.WriteAllTextAsync(path, live, Ct);
        }

        Assert.True(File.Exists(path), $"Missing {path}; run tests with KITTY_UPDATE_OPENAPI=1.");
        Assert.Equal(live, Normalize(await File.ReadAllTextAsync(path, Ct)));
    }

    [Fact]
    public async Task Money_amounts_are_plain_integers()
    {
        var doc = JsonNode.Parse(await factory.CreateClient().GetStringAsync("/openapi/v1.json", Ct))!;
        var amount = doc["components"]!["schemas"]!["ExpenseWriteDto"]!["properties"]!["amountMinor"]!;
        Assert.Equal("integer", amount["type"]!.GetValue<string>());
    }

    private static string Normalize(string json)
    {
        var node = JsonNode.Parse(json)!;
        node["servers"] = null; // test-server URL differs between runs
        return node.ToJsonString(new JsonSerializerOptions { WriteIndented = true }).ReplaceLineEndings("\n") + "\n";
    }
}
