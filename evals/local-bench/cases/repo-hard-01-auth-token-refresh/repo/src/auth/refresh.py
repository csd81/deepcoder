def refresh(store):
    """Rotate the stored token (simulates fetching a fresh one) and return it."""
    new_token = store.get() + "+refreshed"
    store.set(new_token)
    return new_token
