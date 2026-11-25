using Kitty.Ledger.Features.Notifications;

namespace Kitty.Ledger.UnitTests;

public class NotificationIdsTests
{
    // Python: uuid.uuid5(UUID("3b8c4f2e-6a1d-4e0b-9a57-2f1c8d6e4b90"), "weekly:00000000-0000-0000-0000-000000000001:2026-W49")
    [Fact]
    public void Weekly_is_the_name_based_uuid_of_person_and_week() =>
        Assert.Equal(new Guid("76dfa3f9-dd9e-592f-87d0-cc5ef5ca7630"),
            NotificationIds.Weekly(new Guid("00000000-0000-0000-0000-000000000001"), "2026-W49"));

    [Fact]
    public void Another_week_is_another_id() =>
        Assert.NotEqual(NotificationIds.Weekly(Guid.Empty, "2026-W49"), NotificationIds.Weekly(Guid.Empty, "2026-W50"));
}
