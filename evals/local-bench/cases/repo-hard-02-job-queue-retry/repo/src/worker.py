from src.jobs.queue import run_job


def process(fn, max_attempts=3):
    return run_job(fn, max_attempts)
