import datetime

from google.protobuf import timestamp_pb2 as _timestamp_pb2
from google.protobuf.internal import containers as _containers
from google.protobuf.internal import enum_type_wrapper as _enum_type_wrapper
from google.protobuf import descriptor as _descriptor
from google.protobuf import message as _message
from collections.abc import Iterable as _Iterable, Mapping as _Mapping
from typing import ClassVar as _ClassVar, Optional as _Optional, Union as _Union

DESCRIPTOR: _descriptor.FileDescriptor

class ReceiptUploaded(_message.Message):
    __slots__ = ("event_id", "occurred_at", "scan_id", "session_id", "group_id", "blob_name", "currency", "content_type", "attempt")
    EVENT_ID_FIELD_NUMBER: _ClassVar[int]
    OCCURRED_AT_FIELD_NUMBER: _ClassVar[int]
    SCAN_ID_FIELD_NUMBER: _ClassVar[int]
    SESSION_ID_FIELD_NUMBER: _ClassVar[int]
    GROUP_ID_FIELD_NUMBER: _ClassVar[int]
    BLOB_NAME_FIELD_NUMBER: _ClassVar[int]
    CURRENCY_FIELD_NUMBER: _ClassVar[int]
    CONTENT_TYPE_FIELD_NUMBER: _ClassVar[int]
    ATTEMPT_FIELD_NUMBER: _ClassVar[int]
    event_id: str
    occurred_at: _timestamp_pb2.Timestamp
    scan_id: str
    session_id: str
    group_id: str
    blob_name: str
    currency: str
    content_type: str
    attempt: int
    def __init__(self, event_id: _Optional[str] = ..., occurred_at: _Optional[_Union[datetime.datetime, _timestamp_pb2.Timestamp, _Mapping]] = ..., scan_id: _Optional[str] = ..., session_id: _Optional[str] = ..., group_id: _Optional[str] = ..., blob_name: _Optional[str] = ..., currency: _Optional[str] = ..., content_type: _Optional[str] = ..., attempt: _Optional[int] = ...) -> None: ...

class ReceiptResult(_message.Message):
    __slots__ = ("event_id", "occurred_at", "scan_id", "session_id", "parsed", "failed")
    EVENT_ID_FIELD_NUMBER: _ClassVar[int]
    OCCURRED_AT_FIELD_NUMBER: _ClassVar[int]
    SCAN_ID_FIELD_NUMBER: _ClassVar[int]
    SESSION_ID_FIELD_NUMBER: _ClassVar[int]
    PARSED_FIELD_NUMBER: _ClassVar[int]
    FAILED_FIELD_NUMBER: _ClassVar[int]
    event_id: str
    occurred_at: _timestamp_pb2.Timestamp
    scan_id: str
    session_id: str
    parsed: ParsedReceipt
    failed: ScanFailure
    def __init__(self, event_id: _Optional[str] = ..., occurred_at: _Optional[_Union[datetime.datetime, _timestamp_pb2.Timestamp, _Mapping]] = ..., scan_id: _Optional[str] = ..., session_id: _Optional[str] = ..., parsed: _Optional[_Union[ParsedReceipt, _Mapping]] = ..., failed: _Optional[_Union[ScanFailure, _Mapping]] = ...) -> None: ...

class ParsedReceipt(_message.Message):
    __slots__ = ("merchant", "receipt_date", "currency", "items", "charges", "total_minor")
    MERCHANT_FIELD_NUMBER: _ClassVar[int]
    RECEIPT_DATE_FIELD_NUMBER: _ClassVar[int]
    CURRENCY_FIELD_NUMBER: _ClassVar[int]
    ITEMS_FIELD_NUMBER: _ClassVar[int]
    CHARGES_FIELD_NUMBER: _ClassVar[int]
    TOTAL_MINOR_FIELD_NUMBER: _ClassVar[int]
    merchant: str
    receipt_date: str
    currency: str
    items: _containers.RepeatedCompositeFieldContainer[ParsedItem]
    charges: _containers.RepeatedCompositeFieldContainer[ParsedCharge]
    total_minor: int
    def __init__(self, merchant: _Optional[str] = ..., receipt_date: _Optional[str] = ..., currency: _Optional[str] = ..., items: _Optional[_Iterable[_Union[ParsedItem, _Mapping]]] = ..., charges: _Optional[_Iterable[_Union[ParsedCharge, _Mapping]]] = ..., total_minor: _Optional[int] = ...) -> None: ...

class ParsedItem(_message.Message):
    __slots__ = ("description", "quantity", "line_total_minor")
    DESCRIPTION_FIELD_NUMBER: _ClassVar[int]
    QUANTITY_FIELD_NUMBER: _ClassVar[int]
    LINE_TOTAL_MINOR_FIELD_NUMBER: _ClassVar[int]
    description: str
    quantity: int
    line_total_minor: int
    def __init__(self, description: _Optional[str] = ..., quantity: _Optional[int] = ..., line_total_minor: _Optional[int] = ...) -> None: ...

class ParsedCharge(_message.Message):
    __slots__ = ("kind", "amount_minor")
    KIND_FIELD_NUMBER: _ClassVar[int]
    AMOUNT_MINOR_FIELD_NUMBER: _ClassVar[int]
    kind: str
    amount_minor: int
    def __init__(self, kind: _Optional[str] = ..., amount_minor: _Optional[int] = ...) -> None: ...

class ScanFailure(_message.Message):
    __slots__ = ("reason",)
    class Reason(int, metaclass=_enum_type_wrapper.EnumTypeWrapper):
        __slots__ = ()
        REASON_UNSPECIFIED: _ClassVar[ScanFailure.Reason]
        UNREADABLE: _ClassVar[ScanFailure.Reason]
        NO_ITEMS: _ClassVar[ScanFailure.Reason]
        TOTALS_MISMATCH: _ClassVar[ScanFailure.Reason]
        RATE_LIMITED: _ClassVar[ScanFailure.Reason]
        MODEL_UNAVAILABLE: _ClassVar[ScanFailure.Reason]
    REASON_UNSPECIFIED: ScanFailure.Reason
    UNREADABLE: ScanFailure.Reason
    NO_ITEMS: ScanFailure.Reason
    TOTALS_MISMATCH: ScanFailure.Reason
    RATE_LIMITED: ScanFailure.Reason
    MODEL_UNAVAILABLE: ScanFailure.Reason
    REASON_FIELD_NUMBER: _ClassVar[int]
    reason: ScanFailure.Reason
    def __init__(self, reason: _Optional[_Union[ScanFailure.Reason, str]] = ...) -> None: ...
