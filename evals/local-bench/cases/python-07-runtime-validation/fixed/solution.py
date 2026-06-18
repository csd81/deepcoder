def make_user(name):
    if not name:
        raise ValueError("name is required")
    return {"name": name}
