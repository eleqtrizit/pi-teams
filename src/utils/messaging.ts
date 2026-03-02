import fs from 'node:fs';
import path from 'node:path';
import { withLock } from './lock';
import { InboxMessage } from './models';
import { inboxPath, lastAwokenPath, lastMessagePath, lastReminderPath } from './paths';
import { readConfig } from './teams';

export function nowIso(): string {
    return new Date().toISOString();
}

const REMINDER_TEXT =
    'What is your report/feedback/questions? You report to the team-lead, not a human. Send a message to the team-lead immediately and then wait for further instructions.';

/**
 * Get the timestamp of the last message sent by this agent.
 * @param teamName The name of the team
 * @param agentName The name of the agent
 * @returns The timestamp in milliseconds, or null if no message has been sent
 */
export function getLastMessageTime(teamName: string, agentName: string): number | null {
    const p = lastMessagePath(teamName, agentName);
    if (!fs.existsSync(p)) return null;
    try {
        const content = fs.readFileSync(p, 'utf-8').trim();
        const timestamp = parseInt(content, 10);
        return isNaN(timestamp) ? null : timestamp;
    } catch {
        return null;
    }
}

/**
 * Update the last message sent timestamp for this agent.
 * @param teamName The name of the team
 * @param agentName The name of the agent
 */
export function updateLastMessageTime(teamName: string, agentName: string): void {
    const p = lastMessagePath(teamName, agentName);
    fs.writeFileSync(p, Date.now().toString());
}

/**
 * Get the timestamp when the agent last went from inactive to active.
 * @param teamName The name of the team
 * @param agentName The name of the agent
 * @returns The timestamp in milliseconds, or null if the agent has never been active
 */
export function getLastAwokenTime(teamName: string, agentName: string): number | null {
    const p = lastAwokenPath(teamName, agentName);
    if (!fs.existsSync(p)) return null;
    try {
        const content = fs.readFileSync(p, 'utf-8').trim();
        const timestamp = parseInt(content, 10);
        return isNaN(timestamp) ? null : timestamp;
    } catch {
        return null;
    }
}

/**
 * Update the last awoken timestamp for this agent.
 * @param teamName The name of the team
 * @param agentName The name of the agent
 */
export function updateLastAwokenTime(teamName: string, agentName: string): void {
    const p = lastAwokenPath(teamName, agentName);
    fs.writeFileSync(p, Date.now().toString());
}

/**
 * Get the timestamp of the last reminder sent to this agent.
 * @param teamName The name of the team
 * @param agentName The name of the agent
 * @returns The timestamp in milliseconds, or null if no reminder has been sent
 */
export function getLastReminderTime(teamName: string, agentName: string): number | null {
    const p = lastReminderPath(teamName, agentName);
    if (!fs.existsSync(p)) return null;
    try {
        const content = fs.readFileSync(p, 'utf-8').trim();
        const timestamp = parseInt(content, 10);
        return isNaN(timestamp) ? null : timestamp;
    } catch {
        return null;
    }
}

/**
 * Update the last reminder sent timestamp for this agent.
 * @param teamName The name of the team
 * @param agentName The name of the agent
 */
export function updateLastReminderTime(teamName: string, agentName: string): void {
    const p = lastReminderPath(teamName, agentName);
    fs.writeFileSync(p, Date.now().toString());
}

/**
 * Determine whether the agent needs a reminder to report back to the team-lead.
 *
 * The check anchors on the latest team-lead instruction timestamp rather than
 * the wake-cycle timestamp, so incidental idle→active transitions after the
 * agent has already responded never cause false-positive reminders.
 *
 * @param teamName The name of the team
 * @param agentName The name of the agent
 * @param latestInstructionTs Epoch-ms timestamp of the most recent team-lead message, or null if none exist
 * @param allInstructionsRead True when every team-lead message has been marked read
 * @returns true if a reminder message should be added
 */
export function needsReminderMessage(
    teamName: string,
    agentName: string,
    latestInstructionTs: number | null,
    allInstructionsRead: boolean
): boolean {
    if (latestInstructionTs === null) return false;
    if (!allInstructionsRead) return false;

    const lastReminderTime = getLastReminderTime(teamName, agentName);
    if (lastReminderTime !== null && lastReminderTime >= latestInstructionTs) return false;

    const lastMessageTime = getLastMessageTime(teamName, agentName);
    if (lastMessageTime === null) return true;

    return lastMessageTime < latestInstructionTs;
}

/**
 * Ensure a reminder message exists when the teammate finished a cycle without reporting.
 * @param teamName The name of the team
 * @param agentName The name of the agent
 * @returns true if a reminder was added
 */
/**
 * Append a reminder to the agent's inbox if they have read instructions but
 * never reported back. Safe to call repeatedly — only one reminder is added
 * per instruction cycle.
 *
 * @param teamName The name of the team
 * @param agentName The name of the agent
 * @returns true if a reminder was added
 */
export async function ensureReminderMessage(teamName: string, agentName: string): Promise<boolean> {
    const p = inboxPath(teamName, agentName);
    if (!fs.existsSync(p)) return false;

    return await withLock(p, async () => {
        const allMsgs: InboxMessage[] = JSON.parse(fs.readFileSync(p, 'utf-8'));

        const teamLeadMsgs = allMsgs.filter((m) => m.from === 'team-lead');
        const latestInstructionTs =
            teamLeadMsgs.length > 0 ? Math.max(...teamLeadMsgs.map((m) => new Date(m.timestamp).getTime())) : null;
        const allInstructionsRead = teamLeadMsgs.length > 0 && teamLeadMsgs.every((m) => m.read);

        const unreadMsgs = allMsgs.filter((m) => !m.read);
        if (unreadMsgs.some((m) => m.from === 'system')) return false;

        if (!needsReminderMessage(teamName, agentName, latestInstructionTs, allInstructionsRead)) {
            return false;
        }

        const reminderMsg: InboxMessage = {
            from: 'system',
            text: REMINDER_TEXT,
            timestamp: nowIso(),
            read: false,
            summary: 'Reminder: Report to team lead',
            color: 'yellow'
        };
        allMsgs.push(reminderMsg);
        fs.writeFileSync(p, JSON.stringify(allMsgs, null, 2));
        updateLastReminderTime(teamName, agentName);
        return true;
    });
}

export async function appendMessage(teamName: string, agentName: string, message: InboxMessage) {
    const p = inboxPath(teamName, agentName);
    const dir = path.dirname(p);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

    await withLock(p, async () => {
        let msgs: InboxMessage[] = [];
        if (fs.existsSync(p)) {
            msgs = JSON.parse(fs.readFileSync(p, 'utf-8'));
        }
        msgs.push(message);
        fs.writeFileSync(p, JSON.stringify(msgs, null, 2));
    });
}

export async function readInbox(
    teamName: string,
    agentName: string,
    unreadOnly = true,
    markAsRead = true
): Promise<InboxMessage[]> {
    const p = inboxPath(teamName, agentName);

    if (!fs.existsSync(p)) return [];

    return await withLock(p, async () => {
        const allMsgs: InboxMessage[] = JSON.parse(fs.readFileSync(p, 'utf-8'));

        // Identify which messages to surface (snapshot BEFORE any mutation so callers
        // always receive objects with their original read state).
        const unreadMsgs = allMsgs.filter((m) => !m.read);
        const toReturn = unreadOnly ? unreadMsgs : allMsgs;
        const resultSnapshot: InboxMessage[] = toReturn.map((m) => ({ ...m }));

        if (markAsRead && unreadMsgs.length > 0) {
            for (const m of allMsgs) {
                if (unreadMsgs.includes(m)) {
                    m.read = true;
                }
            }
            fs.writeFileSync(p, JSON.stringify(allMsgs, null, 2));
        }

        return resultSnapshot;
    });
}

export async function sendPlainMessage(
    teamName: string,
    fromName: string,
    toName: string,
    text: string,
    summary: string,
    color?: string
) {
    const msg: InboxMessage = {
        from: fromName,
        text,
        timestamp: nowIso(),
        read: false,
        summary,
        color
    };
    await appendMessage(teamName, toName, msg);
    // Track that the sender has sent a message
    updateLastMessageTime(teamName, fromName);
}

/**
 * Broadcasts a message to all team members except the sender.
 * @param teamName The name of the team
 * @param fromName The name of the sender
 * @param text The message text
 * @param summary A short summary of the message
 * @param color An optional color for the message
 */
export async function broadcastMessage(
    teamName: string,
    fromName: string,
    text: string,
    summary: string,
    color?: string
) {
    const config = await readConfig(teamName);

    // Create an array of delivery promises for all members except the sender
    const deliveryPromises = config.members
        .filter((member) => member.name !== fromName)
        .map((member) => sendPlainMessage(teamName, fromName, member.name, text, summary, color));

    // Execute deliveries in parallel and wait for all to settle
    const results = await Promise.allSettled(deliveryPromises);

    // Log failures for diagnostics
    const failures = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected');
    if (failures.length > 0) {
        console.error(`Broadcast partially failed: ${failures.length} messages could not be delivered.`);
        // Optionally log individual errors
        failures.forEach((f) => console.error(`- Delivery error:`, f.reason));
    }
}
