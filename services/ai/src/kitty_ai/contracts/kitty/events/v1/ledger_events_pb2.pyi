import datetime

from google.protobuf import timestamp_pb2 as _timestamp_pb2
from google.protobuf.internal import enum_type_wrapper as _enum_type_wrapper
from google.protobuf import descriptor as _descriptor
from google.protobuf import message as _message
from collections.abc import Mapping as _Mapping
from typing import ClassVar as _ClassVar, Optional as _Optional, Union as _Union

DESCRIPTOR: _descriptor.FileDescriptor

class ExpenseChanged(_message.Message):
    __slots__ = ("event_id", "occurred_at", "group_id", "expense_id", "change")
    class Change(int, metaclass=_enum_type_wrapper.EnumTypeWrapper):
        __slots__ = ()
        CHANGE_UNSPECIFIED: _ClassVar[ExpenseChanged.Change]
        CREATED: _ClassVar[ExpenseChanged.Change]
        UPDATED: _ClassVar[ExpenseChanged.Change]
        DELETED: _ClassVar[ExpenseChanged.Change]
    CHANGE_UNSPECIFIED: ExpenseChanged.Change
    CREATED: ExpenseChanged.Change
    UPDATED: ExpenseChanged.Change
    DELETED: ExpenseChanged.Change
    EVENT_ID_FIELD_NUMBER: _ClassVar[int]
    OCCURRED_AT_FIELD_NUMBER: _ClassVar[int]
    GROUP_ID_FIELD_NUMBER: _ClassVar[int]
    EXPENSE_ID_FIELD_NUMBER: _ClassVar[int]
    CHANGE_FIELD_NUMBER: _ClassVar[int]
    event_id: str
    occurred_at: _timestamp_pb2.Timestamp
    group_id: str
    expense_id: str
    change: ExpenseChanged.Change
    def __init__(self, event_id: _Optional[str] = ..., occurred_at: _Optional[_Union[datetime.datetime, _timestamp_pb2.Timestamp, _Mapping]] = ..., group_id: _Optional[str] = ..., expense_id: _Optional[str] = ..., change: _Optional[_Union[ExpenseChanged.Change, str]] = ...) -> None: ...
