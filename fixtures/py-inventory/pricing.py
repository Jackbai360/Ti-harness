"""Per-line pricing and tier discounts."""

DISCOUNTS = {"standard": 1.0, "silver": 0.95, "gold": 0.9}


def line_total(item):
    """Price for one order line before discounts."""
    return item["price"] * item["qty"]


def apply_discount(amount, tier):
    """Apply the tier's discount factor to an amount."""
    factor = DISCOUNTS.get(tier)
    if factor is None:
        raise ValueError(f"unknown tier: {tier}")
    return amount * factor
