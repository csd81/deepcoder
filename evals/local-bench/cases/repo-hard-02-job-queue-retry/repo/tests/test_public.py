from src.worker import process


def test_successful_job_runs_once():
    res = process(lambda attempt: "ok", max_attempts=3)
    assert res["value"] == "ok"
    assert res["attempts"] == 1
