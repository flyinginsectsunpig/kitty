using System.Security.Cryptography;
using System.Text;

namespace Kitty.Ledger.Features.Notifications;

/// <summary>
/// Notification ids that are the same every time they're made for the same thing (RFC 4122 name-based, version 5), so
/// pulse delivers a re-queued one once.
/// </summary>
public static class NotificationIds
{
    private static readonly Guid Namespace = new("3b8c4f2e-6a1d-4e0b-9a57-2f1c8d6e4b90");

    /// <summary>A person's weekly summary for an ISO week ("2026-W49").</summary>
    public static Guid Weekly(Guid userId, string week) => NameBased($"weekly:{userId}:{week}");

    private static Guid NameBased(string name)
    {
        var input = Namespace.ToByteArray(bigEndian: true).Concat(Encoding.UTF8.GetBytes(name)).ToArray();
        var hash = SHA1.HashData(input).AsSpan(0, 16).ToArray();
        hash[6] = (byte)((hash[6] & 0x0F) | 0x50); // version 5
        hash[8] = (byte)((hash[8] & 0x3F) | 0x80); // RFC 4122 variant
        return new Guid(hash, bigEndian: true);
    }
}
