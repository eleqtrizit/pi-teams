# Pi Teams

The team-lead is the coordinator.

The team-leader will spawn a team member. The team member will sit idle until a message is recieved in the inbox.

We use a programmatic loop to watch the inbox and trigger the agent.

If the team member finishes work and has not sent a message back to the team leader, we will send a reminder "What is your report/feedback/questions? You report to the team-lead, not a human. Send a message to the team-lead immediately."

The reminder is only if the last active time is greater than the last sent message time. We also only send one reminder.

Team members should never see read messages. Use `read_inbox` to list unread messages (shows a table with subject, sender, and ID). Then call `read_message` with the message ID to read the full body — this marks the message as read. The reminder system relies on messages being marked read via `read_message`; skipping it will trigger false reminders.