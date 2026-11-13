# Bolt Journal

## 2026-11-12 - Bound push-only WebSocket queues by bytes and items
**Learning:** The AI WebSocket socket callback cannot apply backpressure, and Bun may deliver over 1,000 small frames synchronously. A queue capacity by item count alone misses large frames; a byte cap alone misses per-item overhead from empty or tiny frames.
**Action:** Keep both cumulative queued-byte and queued-message limits, decrement accounting when the consumer takes a frame, and explicitly fail/close on overflow rather than silently dropping protocol frames.
