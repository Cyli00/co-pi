# Retry and recovery boundaries

`requestId` is unique within one MCP connection. Reusing the same ID and parameters retrieves the same execution rather than launching another batch; different parameters conflict. A new connection does not preserve this guarantee.

After timeout, disconnect, cancellation, or failure, establish which tasks ran and what effects remain before deciding whether a retry is appropriate. Cancellation does not undo file changes. Preserve completed handoffs and finish or retry only the remaining authorized work when safe; do not automatically rerun the entire batch under a new ID or switch models.

A failed batch can contain successful tasks. Report that distinction, any storage/runtime errors, missing evidence, and work that remains. Never infer success from a transport acknowledgement or a last chat message.
