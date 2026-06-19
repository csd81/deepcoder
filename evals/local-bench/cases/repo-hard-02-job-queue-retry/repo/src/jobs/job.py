# A job record model. NOT involved in retry classification — decoy.
class Job:
    def __init__(self, name, payload=None):
        self.name = name
        self.payload = payload or {}

    def describe(self):
        return f"{self.name}({self.payload})"
