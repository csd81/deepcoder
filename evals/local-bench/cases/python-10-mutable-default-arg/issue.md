append_item uses a mutable default argument, so the list is shared across calls. Each call with no list should start empty.
