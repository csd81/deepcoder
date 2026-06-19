class Blueprint:
    def __init__(self, name):
        if "." in name:
            raise ValueError("blueprint name may not contain a '.'")
        self.name = name

    def __repr__(self):
        return f"Blueprint({self.name!r})"
