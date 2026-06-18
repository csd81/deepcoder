class Blueprint:
    """A minimal Flask-like Blueprint."""

    def __init__(self, name, import_name=None):
        if "." in name:
            raise ValueError("Blueprint name should not contain dots")
        self.name = name
        self.import_name = import_name
