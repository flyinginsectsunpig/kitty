"""Reads receipt.uploaded, turns each photo into a ReceiptResult on receipt.parsed. At-least-once: an offset is
committed only after the result is published, and events already handled (ai.processed_events in Postgres) are
skipped, so a redelivered upload never costs a second model call. A rate-limited scan goes to
receipt.uploaded.retry with a not-before time, and that consumer pauses the partition rather than sleeping, so
waiting never stalls other scans; after the last retry the scan fails as RATE_LIMITED."""

import logging
import threading
import time
import uuid

import psycopg
from azure.core.exceptions import ResourceNotFoundError
from azure.storage.blob import BlobServiceClient
from confluent_kafka import Consumer, KafkaError, KafkaException, Producer, TopicPartition
from confluent_kafka.admin import AdminClient, NewTopic
from confluent_kafka.schema_registry import SchemaRegistryClient
from confluent_kafka.schema_registry.protobuf import ProtobufDeserializer, ProtobufSerializer
from confluent_kafka.serialization import MessageField, SerializationContext
from google.protobuf.timestamp_pb2 import Timestamp

from kitty_ai.contracts.kitty.events.v1 import receipts_pb2 as pb
from kitty_ai.receipts.extract import Extractor, RateLimited
from kitty_ai.receipts.ocr import Ocr
from kitty_ai.receipts.pipeline import process
from kitty_ai.settings import Settings, postgres_conninfo

log = logging.getLogger(__name__)

LEDGER_EVENTS = "ledger.events"
RECEIPT_UPLOADED = "receipt.uploaded"
RECEIPT_RETRY = "receipt.uploaded.retry"
RECEIPT_PARSED = "receipt.parsed"
CONTAINER = "receipts"
NOT_BEFORE = "not_before"
DEFAULT_RETRY_DELAYS = (30.0, 60.0, 120.0, 300.0)
MAX_PHOTO_BYTES = 10 * 1024 * 1024  # the ledger's limit; the upload URL stays valid after its check
# Starts of one attempt that never finished (the process died reading it) before it is failed as unreadable.
MAX_STARTS = 3
SERDE = {"use.deprecated.format": False}
Reason = pb.ScanFailure.Reason


class ProcessedEvents:
    """Which upload attempts have been handled (event id + attempt), in the ai schema of the shared Postgres."""

    def __init__(self, dsn: str):
        self._dsn = dsn
        self._lock = threading.Lock()
        with psycopg.connect(dsn, autocommit=True) as conn:
            # In production the schema already exists, owned by role "ai", which may not create schemas
            # (and CREATE SCHEMA IF NOT EXISTS checks that right even when the schema is there).
            if conn.execute("SELECT 1 FROM pg_namespace WHERE nspname = 'ai'").fetchone() is None:
                conn.execute("CREATE SCHEMA ai")
            conn.execute(
                "CREATE TABLE IF NOT EXISTS ai.processed_events "
                "(event_id text PRIMARY KEY, processed_at timestamptz NOT NULL DEFAULT now())"
            )
            conn.execute(
                "CREATE TABLE IF NOT EXISTS ai.event_attempts (event_id text PRIMARY KEY, attempts int NOT NULL)"
            )

    def seen(self, key: str) -> bool:
        with self._lock, psycopg.connect(self._dsn, autocommit=True) as conn:
            return conn.execute("SELECT 1 FROM ai.processed_events WHERE event_id = %s", (key,)).fetchone() is not None

    def started(self, key: str) -> int:
        """Counts a start of this attempt and returns how many there have been (crashes leave it counted)."""
        with self._lock, psycopg.connect(self._dsn, autocommit=True) as conn:
            row = conn.execute(
                "INSERT INTO ai.event_attempts (event_id, attempts) VALUES (%s, 1) "
                "ON CONFLICT (event_id) DO UPDATE SET attempts = ai.event_attempts.attempts + 1 RETURNING attempts",
                (key,),
            ).fetchone()
            return row[0]

    def mark(self, key: str) -> None:
        with self._lock, psycopg.connect(self._dsn, autocommit=True) as conn:
            conn.execute("INSERT INTO ai.processed_events (event_id) VALUES (%s) ON CONFLICT DO NOTHING", (key,))


def ensure_topics(bootstrap: str) -> None:
    admin = AdminClient({"bootstrap.servers": bootstrap})
    existing = set(admin.list_topics(timeout=10).topics)
    topics = (LEDGER_EVENTS, RECEIPT_UPLOADED, RECEIPT_RETRY, RECEIPT_PARSED)
    missing = [NewTopic(t, num_partitions=3, replication_factor=1) for t in topics if t not in existing]
    if not missing:
        return
    for topic, future in admin.create_topics(missing).items():
        try:
            future.result()
        except KafkaException as e:
            if e.args[0].code() != KafkaError.TOPIC_ALREADY_EXISTS:
                raise
            log.debug("topic %s already exists", topic)


def _now() -> Timestamp:
    ts = Timestamp()
    ts.GetCurrentTime()
    return ts


class Worker:
    def __init__(
        self, settings: Settings, ocr: Ocr, extractor: Extractor, retry_delays=DEFAULT_RETRY_DELAYS, restart_delay=5.0
    ):
        self._settings = settings
        self._ocr = ocr
        self._extractor = extractor
        self._retry_delays = tuple(retry_delays)
        self._restart_delay = restart_delay
        registry = SchemaRegistryClient({"url": settings.schema_registry_url})
        self._read_upload = ProtobufDeserializer(pb.ReceiptUploaded, SERDE)
        self._write_upload = ProtobufSerializer(pb.ReceiptUploaded, registry, SERDE)
        self._write_result = ProtobufSerializer(pb.ReceiptResult, registry, SERDE)
        self._producer = Producer(
            {"bootstrap.servers": settings.kafka_bootstrap, "enable.idempotence": True, "acks": "all"}
        )
        self._photos = BlobServiceClient.from_connection_string(settings.blob_connection_string).get_container_client(
            CONTAINER
        )
        self._processed = ProcessedEvents(postgres_conninfo(settings.postgres_dsn))
        self._stop = threading.Event()
        self._threads: list[threading.Thread] = []

    @property
    def running(self) -> bool:
        return bool(self._threads) and all(t.is_alive() for t in self._threads)

    def start(self) -> None:
        ensure_topics(self._settings.kafka_bootstrap)
        group = self._settings.consumer_group
        self._threads = [
            threading.Thread(target=self._keep_running, args=(RECEIPT_UPLOADED, group), name="receipts", daemon=True),
            threading.Thread(
                target=self._keep_running, args=(RECEIPT_RETRY, f"{group}.retry"), name="receipt-retries", daemon=True
            ),
        ]
        for t in self._threads:
            t.start()

    def stop(self) -> None:
        self._stop.set()
        for t in self._threads:
            t.join(timeout=10)
        self._producer.flush(10)

    def _keep_running(self, topic: str, group: str) -> None:
        """Runs a reader until stopped; anything unexpected (a failed commit, a lost connection) starts it afresh."""
        while not self._stop.is_set():
            try:
                self._run(topic, group)
            except Exception:
                log.exception("The %s reader failed; restarting it", topic)
                self._stop.wait(self._restart_delay)

    def _run(self, topic: str, group: str) -> None:
        consumer = Consumer(
            {
                "bootstrap.servers": self._settings.kafka_bootstrap,
                "group.id": group,
                "auto.offset.reset": "earliest",
                "enable.auto.commit": False,
            }
        )
        consumer.subscribe([topic])
        paused: dict[tuple[str, int], tuple[TopicPartition, float]] = {}
        try:
            while not self._stop.is_set():
                due = [k for k, (_, at) in paused.items() if at <= time.time()]
                if due:
                    consumer.resume([paused.pop(k)[0] for k in due])
                msg = consumer.poll(0.5)
                if msg is None:
                    continue
                if msg.error():
                    if msg.error().code() != KafkaError.UNKNOWN_TOPIC_OR_PART:
                        log.warning("Reading %s failed: %s", topic, msg.error())
                    continue
                not_before = dict(msg.headers() or []).get(NOT_BEFORE)
                if not_before and float(not_before) > time.time():
                    tp = TopicPartition(msg.topic(), msg.partition(), msg.offset())
                    consumer.pause([tp])
                    consumer.seek(tp)
                    paused[(msg.topic(), msg.partition())] = (tp, float(not_before))
                    continue
                try:
                    self._handle(msg.value())
                except Exception:
                    log.exception("Handling a %s message failed; will retry it", topic)
                    consumer.seek(TopicPartition(msg.topic(), msg.partition(), msg.offset()))
                    self._stop.wait(1)
                    continue
                consumer.commit(message=msg, asynchronous=False)
        finally:
            consumer.close()

    def _handle(self, value: bytes) -> None:
        event = self._read_upload(value, SerializationContext(RECEIPT_UPLOADED, MessageField.VALUE))
        key = f"{event.event_id}:{event.attempt}"
        if self._processed.seen(key):
            return
        outcome = self._read_receipt(event, key)
        if outcome is None:  # rate limited, and another retry is due
            self._retry_later(event)
        else:
            self._publish(event, outcome)
        self._processed.mark(key)

    def _read_receipt(self, event: pb.ReceiptUploaded, key: str) -> pb.ParsedReceipt | int | None:
        if self._processed.started(key) > MAX_STARTS:
            log.error("Scan %s crashed the reader %d times; failing it", event.scan_id, MAX_STARTS)
            return Reason.UNREADABLE
        try:
            # Never more than the limit plus one byte, however big the blob has grown.
            image = self._photos.download_blob(event.blob_name, offset=0, length=MAX_PHOTO_BYTES + 1).readall()
        except ResourceNotFoundError:
            return Reason.UNREADABLE
        if len(image) > MAX_PHOTO_BYTES:
            return Reason.UNREADABLE
        try:
            return process(image, self._ocr, self._extractor, event.currency)
        except RateLimited:
            return None if event.attempt < len(self._retry_delays) else Reason.RATE_LIMITED
        except Exception:
            log.exception("Could not read scan %s", event.scan_id)
            return Reason.UNREADABLE

    def _retry_later(self, event: pb.ReceiptUploaded) -> None:
        retry = pb.ReceiptUploaded()
        retry.CopyFrom(event)
        retry.attempt = event.attempt + 1
        not_before = time.time() + self._retry_delays[event.attempt]
        value = self._write_upload(retry, SerializationContext(RECEIPT_RETRY, MessageField.VALUE))
        self._producer.produce(
            RECEIPT_RETRY, key=event.session_id, value=value, headers=[(NOT_BEFORE, str(not_before))]
        )
        if self._producer.flush(10):
            raise RuntimeError("retry was not delivered")

    def _publish(self, event: pb.ReceiptUploaded, outcome: pb.ParsedReceipt | int) -> None:
        result = pb.ReceiptResult(
            event_id=str(uuid.uuid4()), occurred_at=_now(), scan_id=event.scan_id, session_id=event.session_id
        )
        if isinstance(outcome, pb.ParsedReceipt):
            result.parsed.CopyFrom(outcome)
        else:
            result.failed.reason = outcome
        value = self._write_result(result, SerializationContext(RECEIPT_PARSED, MessageField.VALUE))
        self._producer.produce(RECEIPT_PARSED, key=event.session_id, value=value)
        if self._producer.flush(10):
            raise RuntimeError("result was not delivered")
