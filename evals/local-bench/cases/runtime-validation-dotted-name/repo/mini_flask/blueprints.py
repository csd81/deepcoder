class Blueprint:
    """A minimal Flask-like Blueprint."""

    def __init__(self, name, import_name=None):
        # BUG: a blueprint name containing "." breaks nested-blueprint routing,
        # but it is accepted here without any validation.
        self.name = name
        self.import_name = import_name
