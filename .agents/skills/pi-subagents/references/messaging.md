# Corrections and follow-ups

Use `send_message` for new requirements, corrections, or additional authorized work, not for status queries or reminders.

- `steer` (default) takes effect at a tool boundary; it does not interrupt the tool currently running.
- `followUp` is processed after the current turn.
- For a transport retry, reuse the same `messageId`, content, and mode. Changing them can inject duplicate work; conflicting parameters under one ID are rejected.
- `accepted` and `queued` describe SDK acceptance or queueing. `delivered` means the message entered the session. None means the model understood it or completed the request.
- `unknown` is inconclusive, not a reason to resend automatically. Do not poll receipts; collect the original delegation result.

The final handoff, checked against the updated acceptance criteria, determines the outcome.
