from textutil import slugify


def test_slugify_lowercases_and_joins():
    assert slugify("Hello World") == "hello-world"


def test_slugify_collapses_separator_runs():
    assert slugify("a   b") == "a-b"
