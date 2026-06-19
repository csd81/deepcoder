# Periodic scheduler. NOT on the retry path — decoy. Has its own backoff knob
# that looks relevant but is unused by run_job.
class Scheduler:
    def __init__(self, backoff=1.0):
        self.backoff = backoff

    def next_delay(self, attempt):
        return self.backoff * attempt
