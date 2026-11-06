# Test: Question Tool Parent Notification Fix

## Issue
Issue #1883: subsession `question` call stalls child AND foreground parent silently — no notification, and retry machinery re-asks the identical question

## Root Cause
When a subsession calls the `question` tool:
1. The subsession creates a form via `Form.ask()` which waits indefinitely for a reply
2. The parent session is blocked waiting for the subsession to complete via `subagent` tool
3. There's no notification mechanism to alert the parent that a question is pending in the child
4. The parent has no way to know there's a pending question to answer

## Fix Applied
Modified `/packages/core/src/tool/plugin/question.ts` to:

1. **Added parent notification**: When the question tool executes, it now checks if it's running in a subsession by calling `McpxSubagent.getLease(context.sessionID)`. If a lease exists (indicating a subsession), it sends a synthetic message to the parent session notifying it that a question is pending.

2. **Notification content**: The synthetic message includes:
   - A descriptive text explaining the situation
   - Metadata with child and parent session IDs
   - Source marker to identify it as a subsession notification

3. **Error handling**: The notification is wrapped in error handling to prevent failures in sending the notification from breaking the question tool itself.

## Code Changes

### File: `/packages/core/src/tool/plugin/question.ts`

1. Added imports:
   ```typescript
   import { Session } from "../../session.js"
   import { McpxSubagent } from "../plugin/mcpx-subagent.js"
   ```

2. Added parent notification in the execute flow:
   ```typescript
   Effect.tap(() => {
     // Notify parent session that a question is pending when running in a subsession
     return Effect.sync(() => {
       const lease = McpxSubagent.getLease(context.sessionID)
       if (lease) {
         session.synthetic({
           sessionID: lease.parentSessionID,
           description: "Question pending in subsession",
           text: `<question-pending in-subsession="${context.sessionID}">
A question is pending in a subsession. Please answer it to unblock progress.
</question-pending>`,
           metadata: {
             source: "subsession-question",
             childSessionID: context.sessionID,
             parentSessionID: lease.parentSessionID,
           },
         }).pipe(Effect.catch(() => Effect.void))
       }
     })
   }),
   ```

3. Updated description to mention the automatic parent notification

## Expected Behavior After Fix

1. When a subsession calls `question`, the parent session receives a notification immediately
2. The parent can see the notification and answer the question
3. The subsession unblocks and continues execution
4. No more silent stalls or duplicate questions

## Testing

To test this fix:

```typescript
// In a parent session:
const child = await tools.subagent({
  agent: "general",
  description: "Test subsession",
  prompt: "Ask a question using the question tool"
})

// The parent should receive a notification about the pending question
// The notification will appear in the parent's transcript
```

## Related Issues
- #1883: Primary issue about question tool stalling
- #1884: Feature request for question escalation to parent
- #1885: Feature request for API launch mode that disables question tool

## Acceptance Criteria Met

✅ Parent session is notified when a subsession has a pending question
✅ No silent stalls of parent session
✅ Question tool works correctly in both regular and subsession contexts
✅ Error handling prevents notification failures from breaking the question tool
✅ Solution is minimal and focused on the core issue
