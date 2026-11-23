import time
import uuid

import pytest
from azure.storage.blob import BlobServiceClient
from confluent_kafka import Consumer, Producer
from confluent_kafka.schema_registry import SchemaRegistryClient
from confluent_kafka.schema_registry.protobuf import ProtobufDeserializer, ProtobufSerializer
from confluent_kafka.serialization import MessageField, SerializationContext

from kitty_ai.contracts.kitty.events.v1 import receipts_pb2 as pb
from kitty_ai.receipts.extract import RateLimited
from kitty_ai.receipts.worker import RECEIPT_PARSED, RECEIPT_UPLOADED, Worker
from kitty_ai.settings import Settings
from tests.test_pipeline import FakeExtractor, FakeOcr

pytestmark = pytest.mark.slow
Reason = pb.ScanFailure.Reason
SERDE = {"use.deprecated.format": False}


@pytest.fixture
def settings(infra) -> Settings:
    # A fresh consumer group per test; events from earlier tests are skipped as already processed.
    return Settings(**infra, consumer_group=f"ai-test-{uuid.uuid4()}")


def put_photo(settings: Settings, name: str, data: bytes = b"\xff\xd8\xff\xe0 photo") -> None:
    container = BlobServiceClient.from_connection_string(settings.blob_connection_string).get_container_client(
        "receipts"
    )
    if not container.exists():
        container.create_container()
    container.upload_blob(name, data, overwrite=True)


def publish_upload(settings: Settings, event: pb.ReceiptUploaded) -> None:
    registry = SchemaRegistryClient({"url": settings.schema_registry_url})
    serialize = ProtobufSerializer(pb.ReceiptUploaded, registry, SERDE)
    producer = Producer({"bootstrap.servers": settings.kafka_bootstrap})
    value = serialize(event, SerializationContext(RECEIPT_UPLOADED, MessageField.VALUE))
    producer.produce(RECEIPT_UPLOADED, key=event.session_id, value=value)
    producer.flush(10)


def results_for(settings: Settings, scan_id: str, wait: float = 20, count: int = 1) -> list[pb.ReceiptResult]:
    deserialize = ProtobufDeserializer(pb.ReceiptResult, SERDE)
    consumer = Consumer(
        {
            "bootstrap.servers": settings.kafka_bootstrap,
            "group.id": f"probe-{uuid.uuid4()}",
            "auto.offset.reset": "earliest",
        }
    )
    consumer.subscribe([RECEIPT_PARSED])
    found, end = [], time.monotonic() + wait
    try:
        while time.monotonic() < end and len(found) < count:
            msg = consumer.poll(0.5)
            if msg is None or msg.error():
                continue
            result = deserialize(msg.value(), SerializationContext(RECEIPT_PARSED, MessageField.VALUE))
            if result.scan_id == scan_id:
                found.append(result)
    finally:
        consumer.close()
    return found


def upload_event() -> pb.ReceiptUploaded:
    scan, session = str(uuid.uuid4()), str(uuid.uuid4())
    return pb.ReceiptUploaded(
        event_id=str(uuid.uuid4()),
        scan_id=scan,
        session_id=session,
        group_id=str(uuid.uuid4()),
        blob_name=f"{session}/{scan}",
        currency="ZAR",
        content_type="image/jpeg",
    )


def start(settings: Settings, ocr, extractor, event: pb.ReceiptUploaded, photo: bool = True, **kwargs) -> Worker:
    if photo:
        put_photo(settings, event.blob_name)
    worker = Worker(settings, ocr, extractor, **kwargs)
    worker.start()
    publish_upload(settings, event)
    return worker


def test_uploaded_receipt_produces_parsed_result(settings):
    event = upload_event()
    worker = start(settings, FakeOcr("Burger 120,00\nTOTAL 120,00"), FakeExtractor(), event)
    try:
        (result,) = results_for(settings, event.scan_id)
    finally:
        worker.stop()
    assert result.WhichOneof("outcome") == "parsed"
    assert (result.session_id, result.parsed.items[0].description) == (event.session_id, "Burger")
    assert result.parsed.total_minor == 12000


def test_rate_limited_scan_ends_failed_after_retries(settings):
    event = upload_event()
    extractor = FakeExtractor(error=RateLimited())
    worker = start(settings, FakeOcr("Burger 120,00"), extractor, event, retry_delays=(0.1, 0.1, 0.1, 0.1))
    try:
        (result,) = results_for(settings, event.scan_id, wait=30)
    finally:
        worker.stop()
    assert result.failed.reason == Reason.RATE_LIMITED
    assert len(extractor.seen) == 5  # the first try and 4 retries


def test_duplicate_upload_event_is_processed_once(settings):
    event = upload_event()
    extractor = FakeExtractor()
    worker = start(settings, FakeOcr("Burger 120,00\nTOTAL 120,00"), extractor, event)
    try:
        results_for(settings, event.scan_id)
        publish_upload(settings, event)
        results = results_for(settings, event.scan_id, wait=5, count=2)
    finally:
        worker.stop()
    assert len(results) == 1
    assert len(extractor.seen) == 1


def test_unreadable_image_fails(settings):
    event = upload_event()
    worker = start(settings, FakeOcr(""), FakeExtractor(), event)
    try:
        (result,) = results_for(settings, event.scan_id)
    finally:
        worker.stop()
    assert result.failed.reason == Reason.UNREADABLE


def test_missing_photo_fails(settings):
    event = upload_event()
    worker = start(settings, FakeOcr("Burger"), FakeExtractor(), event, photo=False)
    try:
        (result,) = results_for(settings, event.scan_id)
    finally:
        worker.stop()
    assert result.failed.reason == Reason.UNREADABLE


class CountingOcr(FakeOcr):
    def __init__(self, text: str):
        super().__init__(text)
        self.calls = 0

    def read(self, image: bytes) -> str:
        self.calls += 1
        return super().read(image)


def test_oversized_photo_is_unreadable_and_never_reaches_ocr(settings):
    # The upload URL stays valid after the ledger checked the photo, so it may have grown since.
    event = upload_event()
    put_photo(settings, event.blob_name, b"\xff\xd8\xff" + b"\0" * (10 * 1024 * 1024))
    ocr = CountingOcr("Burger 120,00\nTOTAL 120,00")
    worker = start(settings, ocr, FakeExtractor(), event, photo=False)
    try:
        (result,) = results_for(settings, event.scan_id)
    finally:
        worker.stop()
    assert result.failed.reason == Reason.UNREADABLE
    assert ocr.calls == 0


def test_an_upload_that_keeps_crashing_the_service_is_failed(settings):
    # Each start is counted before the photo is read; after 3 the next delivery gives up instead of crashing again.
    import psycopg

    from kitty_ai.settings import postgres_conninfo

    event = upload_event()
    worker = Worker(settings, FakeOcr("Burger 120,00\nTOTAL 120,00"), FakeExtractor())  # creates the tables
    with psycopg.connect(postgres_conninfo(settings.postgres_dsn), autocommit=True) as conn:
        conn.execute("INSERT INTO ai.event_attempts (event_id, attempts) VALUES (%s, 3)", (f"{event.event_id}:0",))
    put_photo(settings, event.blob_name)
    worker.start()
    publish_upload(settings, event)
    try:
        (result,) = results_for(settings, event.scan_id)
    finally:
        worker.stop()
    assert result.failed.reason == Reason.UNREADABLE


def test_reader_thread_restarts_after_an_unexpected_error(settings):
    event = upload_event()
    put_photo(settings, event.blob_name)
    worker = Worker(settings, FakeOcr("Burger 120,00\nTOTAL 120,00"), FakeExtractor(), restart_delay=0.1)
    real_run, failed = worker._run, []

    def flaky(topic, group):
        if topic == RECEIPT_UPLOADED and not failed:
            failed.append(topic)
            raise RuntimeError("consumer commit failed")
        real_run(topic, group)

    worker._run = flaky
    worker.start()
    publish_upload(settings, event)
    try:
        (result,) = results_for(settings, event.scan_id)
    finally:
        worker.stop()
    assert failed == [RECEIPT_UPLOADED]
    assert result.WhichOneof("outcome") == "parsed"


def test_dedupe_works_for_a_role_that_owns_only_schema_ai(settings):
    # Production connects as role "ai", which owns schema ai and may not create schemas (ai-db-setup.sql).
    import psycopg

    from kitty_ai.receipts.worker import ProcessedEvents
    from kitty_ai.settings import postgres_conninfo

    admin = postgres_conninfo(settings.postgres_dsn)
    ProcessedEvents(admin)  # schema and tables exist, as after an earlier version
    with psycopg.connect(admin, autocommit=True) as conn:
        conn.execute("DROP ROLE IF EXISTS ai_limited_test")
        conn.execute("CREATE ROLE ai_limited_test LOGIN PASSWORD 'limited'")
        conn.execute("ALTER SCHEMA ai OWNER TO ai_limited_test")
        for table in ("processed_events", "event_attempts"):
            conn.execute(f"ALTER TABLE ai.{table} OWNER TO ai_limited_test")
    limited = psycopg.conninfo.make_conninfo(admin, user="ai_limited_test", password="limited")
    try:
        events = ProcessedEvents(limited)
        key = f"{uuid.uuid4()}:0"
        assert events.started(key) == 1
        events.mark(key)
        assert events.seen(key)
    finally:
        with psycopg.connect(admin, autocommit=True) as conn:
            conn.execute("ALTER SCHEMA ai OWNER TO CURRENT_USER")
            for table in ("processed_events", "event_attempts"):
                conn.execute(f"ALTER TABLE ai.{table} OWNER TO CURRENT_USER")
            conn.execute("DROP ROLE ai_limited_test")
