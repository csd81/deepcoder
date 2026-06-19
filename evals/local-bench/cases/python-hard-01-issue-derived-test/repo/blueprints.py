class Blueprint:
    def __init__(self, name):
        self.name = name

    def __repr__(self):
        return f"Blueprint({self.name!r})"
