# Retry and recovery boundaries

`requestId` is unique within one MCP connection. Reusing the same ID and parameters retrieves the same execution rather than launching another batch; different parameters conflict. A new connection does not preserve this guarantee.

After timeout, disconnect, cancellation, or failure, establish which tasks ran and what effects remain before continuing. Cancellation does not undo file changes. Preserve completed handoffs and avoid repeating completed work. A disconnect or timeout does not by itself prove that a worker has stopped; establish that before taking over its files. Respect user cancellation or pause requests.

Once a worker reaches terminal `failed`, the main agent must take over its remaining authorized work using the main agent's own current context, including work completed while the worker ran. Do not inherit or resume the worker's conversation. Use returned handoffs and existing file changes only as task evidence, verify their relevant claims, and continue against the original acceptance criteria. A model-request failure may leave no valid handoff; inspect the actual changes rather than assuming no work was done.

Model-request retries inside an active worker still follow pi settings. Once those retries end in `failed`, do not automatically redelegate the task, rerun the batch under a new ID, or switch worker models. Complete the remaining work yourself; if an unresolved blocker prevents that, report the blocker and remaining work accurately.

A failed batch can contain successful tasks. Report that distinction, any storage/runtime errors, missing evidence, and work that remains. Never infer success from a transport acknowledgement or a last chat message.
