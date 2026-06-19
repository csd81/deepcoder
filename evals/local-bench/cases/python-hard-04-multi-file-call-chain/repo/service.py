from helper import normalize_tag


def process(record):
    return {"tag": normalize_tag(record.get("tag", ""))}
