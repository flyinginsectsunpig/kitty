using Kitty.Ledger.Domain;

namespace Kitty.Ledger.Features.Common;

/// <summary>An amount in minor units with the text the apps would show for it ("R 150,00"), so nothing downstream formats money.</summary>
public sealed record MoneyDto(string Currency, long Minor, string Text)
{
    public static MoneyDto Of(long minor, string currency) => new(currency, minor, MoneyText.Format(minor, currency));
}
