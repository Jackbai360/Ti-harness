"""Count log lines by severity level."""


def count_levels(lines):
    """Return a mapping of severity level to the number of lines carrying it."""
    counts = {}
    for line in lines:
        if not line.startswith("["):
            continue
        closing = line.find("]")
        if closing == -1:
            continue
        level = line[1:closing]
        counts[level] = counts.get(level, 1) + 1
    return counts
