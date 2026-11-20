"""What the model is asked to return: the receipt as printed. Amounts stay strings exactly as printed;
validate.py turns them into minor units and checks they add up."""

from pydantic import BaseModel, Field


class ExtractedItem(BaseModel):
    description: str = Field(description="The item as printed, e.g. 'Burger' or '2x Castle Lager'.")
    quantity: int = Field(default=1, description="How many, if printed; otherwise 1.")
    line_total: str = Field(description="The line's total price as printed, e.g. '120,00'.")


class ExtractedReceipt(BaseModel):
    merchant: str = Field(default="", description="The shop or restaurant name.")
    date: str = Field(default="", description="The receipt date as yyyy-mm-dd, or empty.")
    currency: str = Field(default="ZAR", description="ISO currency code, if shown.")
    items: list[ExtractedItem] = Field(default_factory=list)
    tip: str | None = Field(default=None, description="Tip or gratuity, if printed.")
    service_charge: str | None = Field(default=None, description="Service charge, if printed.")
    delivery: str | None = Field(default=None, description="Delivery fee, if printed.")
    tax: str | None = Field(default=None, description="VAT or tax amount, if printed.")
    total: str = Field(description="The total to pay, as printed.")
