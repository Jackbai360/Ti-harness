from pagination import page

ITEMS = list(range(1, 11))


def test_first_page():
    assert page(ITEMS, 1, 3) == [1, 2, 3]


def test_second_page():
    assert page(ITEMS, 2, 3) == [4, 5, 6]


def test_last_partial_page():
    assert page(ITEMS, 4, 3) == [10]
