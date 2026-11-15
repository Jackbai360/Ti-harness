from logstats import count_levels


def test_counts_each_level():
    lines = ["[INFO] started", "[INFO] ready", "[ERROR] boom"]
    assert count_levels(lines) == {"INFO": 2, "ERROR": 1}


def test_ignores_lines_without_level():
    lines = ["plain text", "[WARN] slow", "no bracket here"]
    assert count_levels(lines) == {"WARN": 1}


def test_empty_input():
    assert count_levels([]) == {}
