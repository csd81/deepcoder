<!-- adapted-from: tool-description-background-monitor-streaming-events.md -->
Start a background monitor that streams stdout events from a long-running script.
Each line is a notification — you keep working while events arrive in chat.

Pick the right approach:
- **One notification** ("tell me when ready") → use Bash with `run_in_background` and an `until` loop instead
- **One per occurrence, indefinitely** ("tell me every ERROR") → Monitor with `tail -f`, `inotifywait -m`, or `while true`
- **One per occurrence, until done** ("each CI step") → Monitor with a command that emits lines then exits

Script quality:
- Every pipe stage must flush per line: `grep --line-buffered`, `awk` with `fflush()`
- In poll loops, handle transient failures (`curl ... || true`)
- Poll intervals: 30s+ for remote APIs, 0.5-1s for local files
- Only stdout is the event stream; stderr goes to output file but won't trigger notifications

Coverage — silence is not success: your filter must match every terminal state, not just happy path. If the process crashes, your filter should emit something.

Output volume: every line is a conversation message — filter selectively. Stdout lines within 200ms are batched into one notification.

The script runs in the same shell as Bash. Exit ends the watch. Timeout → killed.
Set `persistent: true` for session-length monitors. Use TaskStop to cancel early.
