# Pi Teams

The team-lead is the coordinator.

The team-leader will spawn a team member. The team member will sit idle until a message is recieved in the inbox.

We use a programmatic loop to watch the inbox and trigger the agent.

If the team member finishes work and has not sent a message back to the team leader, we will send a reminder "What is your report/feedback/questions? You report to the team-lead, not a human. Send a message to the team-lead immediately."

The reminder is only if the last active time is greater than the last sent message time. We also only send one reminder.

Team members should never see read messages.  Messages get marked READ *after* they are displayed to the team member.