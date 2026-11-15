from inventory import order_total


def test_standard_total():
    items = [{"price": 10, "qty": 2}, {"price": 5, "qty": 1}]
    assert order_total(items) == 25


def test_gold_discount():
    items = [{"price": 100, "qty": 1}]
    assert order_total(items, tier="gold") == 90


def test_silver_discount():
    items = [{"price": 200, "qty": 1}, {"price": 50, "qty": 2}]
    assert order_total(items, tier="silver") == 285
