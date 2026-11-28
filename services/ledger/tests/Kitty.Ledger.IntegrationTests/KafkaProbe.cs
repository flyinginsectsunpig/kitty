using Confluent.Kafka;
using Confluent.Kafka.SyncOverAsync;
using Confluent.SchemaRegistry.Serdes;
using Google.Protobuf;

namespace Kitty.Ledger.IntegrationTests;

/// <summary>Reads a topic from the start, in its own consumer group, until enough matching messages turn up.</summary>
public static class KafkaProbe
{
    public static async Task<List<(string Key, T Value)>> WaitForAsync<T>(LedgerApiFactory factory, string topic,
        Func<T, bool> match, int count = 1, TimeSpan? timeout = null) where T : class, IMessage<T>, new() =>
        (await WaitForWithHeadersAsync(factory, topic, match, count, timeout)).Select(m => (m.Key, m.Value)).ToList();

    /// <summary>Like <see cref="WaitForAsync{T}"/>, with each message's Kafka headers (e.g. traceparent).</summary>
    public static async Task<List<(string Key, T Value, Dictionary<string, string> Headers)>> WaitForWithHeadersAsync<T>(
        LedgerApiFactory factory, string topic, Func<T, bool> match, int count = 1, TimeSpan? timeout = null)
        where T : class, IMessage<T>, new()
    {
        using var consumer = new ConsumerBuilder<string, T>(new ConsumerConfig
            {
                BootstrapServers = factory.KafkaBootstrap,
                GroupId = $"probe-{Guid.NewGuid()}",
                AutoOffsetReset = AutoOffsetReset.Earliest,
                AllowAutoCreateTopics = true,
            })
            .SetValueDeserializer(new ProtobufDeserializer<T>().AsSyncOverAsync())
            .Build();
        consumer.Subscribe(topic);
        var found = new List<(string, T, Dictionary<string, string>)>();
        var end = DateTime.UtcNow + (timeout ?? TimeSpan.FromSeconds(20));
        try
        {
            while (DateTime.UtcNow < end && found.Count < count)
            {
                try
                {
                    var r = await Task.Run(() => consumer.Consume(TimeSpan.FromMilliseconds(500)));
                    if (r?.Message?.Value is { } v && match(v))
                    {
                        var headers = (r.Message.Headers ?? [])
                            .ToDictionary(h => h.Key, h => System.Text.Encoding.UTF8.GetString(h.GetValueBytes()));
                        found.Add((r.Message.Key, v, headers));
                    }
                }
                catch (ConsumeException e) when (e.Error.Code == ErrorCode.UnknownTopicOrPart)
                {
                    await Task.Delay(250); // nothing published to the topic yet
                }
            }
        }
        finally
        {
            consumer.Close();
        }
        return found;
    }
}
