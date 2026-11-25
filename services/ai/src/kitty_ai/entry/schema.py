"""What the model must return for one sentence. Anything that doesn't fit is rejected, never guessed at. Date and
currency are plain text (as in the receipt schema the model is known to accept) and checked when the draft is built."""

from typing import Literal

from pydantic import BaseModel, Field

Category = Literal[
    "food", "groceries", "transport", "accommodation", "utilities", "rent", "entertainment", "shopping", "other"
]


class Person(BaseModel):
    name: str = Field(description='A name exactly as written, or "me" for the person speaking.')
    amount: str | None = Field(default=None, description="Their own amount as a plain decimal (e.g. 50 or 12.50).")


class ParsedSentence(BaseModel):
    intent: Literal["expense", "reminder", "question", "unclear"]
    group: str | None = Field(default=None, description='The group as written, e.g. "family", or null.')
    description: str | None = Field(default=None, description='A short title, e.g. "Dinner", "Petrol".')
    category: Category | None = None
    currency: str | None = Field(default=None, description="ISO 4217 code; R means ZAR.")
    amount: str | None = Field(default=None, description="The total as a plain decimal, when stated.")
    date: str | None = Field(default=None, description="YYYY-MM-DD, or empty for today.")
    payer: str | None = Field(default=None, description='Who paid: a name as written, or "me".')
    people: list[Person] = Field(default_factory=list)
    split: Literal["equal", "amounts"] | None = None
    reminder_amount: str | None = Field(default=None, description="For a reminder: the amount mentioned, if any.")
