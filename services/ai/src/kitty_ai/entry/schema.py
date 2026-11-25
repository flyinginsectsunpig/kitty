"""What the model must return for one sentence. Anything that doesn't fit is rejected, never guessed at."""

import datetime
from typing import Literal

from pydantic import BaseModel, Field

Category = Literal[
    "food", "groceries", "transport", "accommodation", "utilities", "rent", "entertainment", "shopping", "other"
]


class Person(BaseModel):
    name: str = Field(description='A name exactly as written, or "me" for the person speaking.')
    amount: str | None = Field(default=None, description="Their own amount as a plain decimal (e.g. 50 or 12.50).")


class ParsedSentence(BaseModel):
    intent: Literal["expense", "reminder", "unclear"]
    group: str | None = Field(default=None, description='The group as written, e.g. "family", or null.')
    description: str | None = Field(default=None, description='A short title, e.g. "Dinner", "Petrol".')
    category: Category | None = None
    currency: str | None = Field(default=None, pattern=r"^[A-Z]{3}$", description="ISO 4217; R means ZAR.")
    amount: str | None = Field(default=None, description="The total as a plain decimal, when stated.")
    date: datetime.date | None = None  # a field named date: the type comes from the module
    payer: str | None = Field(default=None, description='Who paid: a name as written, or "me".')
    people: list[Person] = Field(default_factory=list)
    split: Literal["equal", "amounts"] | None = None
    reminder_amount: str | None = Field(default=None, description="For a reminder: the amount mentioned, if any.")
