using Confluent.SchemaRegistry;
using Confluent.SchemaRegistry.Serdes;
using Google.Protobuf;
using Kitty.Contracts.Events.V1;

namespace Kitty.Ledger.Infrastructure.Messaging;

/// <summary>Where Kafka and its schema registry are (ConnectionStrings:kafka, Kafka:SchemaRegistryUrl).</summary>
public sealed record KafkaOptions(string BootstrapServers, string SchemaRegistryUrl)
{
    public static KafkaOptions? From(IConfiguration config) =>
        config.GetConnectionString("kafka") is { Length: > 0 } bootstrap
            ? new KafkaOptions(bootstrap, config["Kafka:SchemaRegistryUrl"]
                ?? throw new InvalidOperationException("Kafka:SchemaRegistryUrl must be set when Kafka is configured."))
            : null;
}

/// <summary>
/// Turns stored Protobuf bytes into Kafka values in the schema registry's wire format, by message type.
/// Every event type the outbox may hold is listed here; an unknown type is a bug, so it throws.
/// </summary>
public sealed class EventSerializers(ISchemaRegistryClient registry)
{
    private readonly Dictionary<string, Func<byte[], string, Task<byte[]>>> _byType = new()
    {
        [ExpenseChanged.Descriptor.FullName] = For(ExpenseChanged.Parser, registry),
        [ReceiptUploaded.Descriptor.FullName] = For(ReceiptUploaded.Parser, registry),
        [Kitty.Contracts.Recurring.V1.RecurringScheduleChanged.Descriptor.FullName] =
            For(Kitty.Contracts.Recurring.V1.RecurringScheduleChanged.Parser, registry),
        [Kitty.Contracts.Notify.V1.NotifySettingsChanged.Descriptor.FullName] =
            For(Kitty.Contracts.Notify.V1.NotifySettingsChanged.Parser, registry),
        [Kitty.Contracts.Notify.V1.NotificationRequested.Descriptor.FullName] =
            For(Kitty.Contracts.Notify.V1.NotificationRequested.Parser, registry),
    };

    public Task<byte[]> SerializeAsync(string type, byte[] payload, string topic) =>
        _byType.TryGetValue(type, out var serialize)
            ? serialize(payload, topic)
            : throw new InvalidOperationException($"No serializer for event type {type}.");

    private static Func<byte[], string, Task<byte[]>> For<T>(MessageParser<T> parser, ISchemaRegistryClient registry)
        where T : class, IMessage<T>, new()
    {
        var serializer = new ProtobufSerializer<T>(registry, new ProtobufSerializerConfig { AutoRegisterSchemas = true });
        return (payload, topic) => serializer.SerializeAsync(parser.ParseFrom(payload),
            new Confluent.Kafka.SerializationContext(Confluent.Kafka.MessageComponentType.Value, topic));
    }
}
