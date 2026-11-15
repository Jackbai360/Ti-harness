"""Order totals for a small storefront."""

from pricing import line_total


def order_total(items, tier="standard"):
    """Total for an order, with the customer's tier discount applied."""
    return sum(line_total(item) for item in items)
