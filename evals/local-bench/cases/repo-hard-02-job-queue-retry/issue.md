Our job runner gives up immediately on flaky network failures that would have
succeeded on a retry, yet it keeps doing nothing useful for jobs that fail
validation. The retry behavior is backwards.

Transient failures should be retried up to the attempt limit; permanent
validation failures should not be retried at all. Please add a regression test
covering both.
