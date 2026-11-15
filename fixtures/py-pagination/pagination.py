"""Split a sequence into fixed-size pages."""


def page(items, page_number, page_size):
    """Return one page of items. Pages are numbered from one."""
    start = page_number * page_size
    return items[start : start + page_size]
