<!-- adapted-from: tool-description-taskupdate.md -->
Updates a task in the task list. Status flow: pending → in_progress → completed.

Mark completed when FULLY done. Keep in_progress if blocked, tests fail, or partial.
Use "deleted" status to permanently remove irrelevant tasks.

Fields you can update: status, subject, description, activeForm, owner, metadata, addBlocks, addBlockedBy.

Use TaskGet before updating to get the latest state.
