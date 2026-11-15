"""Small text helpers used by a pretend blog pipeline."""


def slugify(text):
    """Turn a title into a URL slug: lowercase, dashes between words."""
    out = []
    previous_dash = False
    for character in text.lower():
        if character.isalnum():
            out.append(character)
            previous_dash = False
        elif not previous_dash:
            out.append("-")
            previous_dash = True
    return "".join(out).strip("-")


def truncate(text, limit, suffix="..."):
    """Shorten text to at most `limit` characters, ending with `suffix` when cut."""
    if len(text) <= limit:
        return text
    if limit <= len(suffix):
        return suffix[:limit]
    return text[: limit - len(suffix)] + suffix


def word_count(text):
    """Count whitespace-separated words."""
    return len(text.split())


def title_case(text):
    """Capitalize the first letter of each word and leave the rest unchanged."""
    return " ".join(word[:1].upper() + word[1:] for word in text.split(" "))
