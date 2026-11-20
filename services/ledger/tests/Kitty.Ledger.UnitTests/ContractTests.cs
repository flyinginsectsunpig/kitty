using Kitty.Contracts.Events.V1;

namespace Kitty.Ledger.UnitTests;

/// <summary>The golden bytes are written by the Python ai service's test, so this proves both sides agree on the wire.</summary>
public class ContractTests
{
    [Fact]
    public void Golden_parsed_result_reads_in_csharp()
    {
        var bytes = File.ReadAllBytes(Path.Combine(AppContext.BaseDirectory, "fixtures", "receipt_result_parsed.bin"));
        var result = ReceiptResult.Parser.ParseFrom(bytes);

        Assert.Equal(ReceiptResult.OutcomeOneofCase.Parsed, result.OutcomeCase);
        Assert.Equal("7b0c2a9e-1f4d-4c8a-b6e3-2d5f8a9c0e11", result.ScanId);
        Assert.Equal("c83939f5-2e2e-44b1-aa19-16707cb82a78", result.SessionId);
        Assert.Equal(1795046400, result.OccurredAt.Seconds);
        var parsed = result.Parsed;
        Assert.Equal(("Mzansi Grill", "2026-11-20", "ZAR", 18700L), (parsed.Merchant, parsed.ReceiptDate, parsed.Currency, parsed.TotalMinor));
        Assert.Equal([("Burger", 1, 12000L), ("Coke", 2, 5000L)], parsed.Items.Select(i => (i.Description, i.Quantity, i.LineTotalMinor)));
        Assert.Equal(("tip", 1700L), (parsed.Charges.Single().Kind, parsed.Charges.Single().AmountMinor));
    }
}
