import fs from 'node:fs';
import path from 'node:path';
import { v4 as uuidv4 } from 'uuid';
import { withLock } from './lock';
import { InboxMessage } from './models';
import { inboxPath, lastAwokenPath, lastMessagePath, lastReminderPath, lastReportPath, notificationPath, notificationsDir } from './paths';
import { readConfig } from './teams';

export function nowIso(): string {
    return new Date().toISOString();
}

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
 * Get the timestamp of the last report sent by this agent to the team-lead.
 * @param teamName The name of the team
 * @param agentName The name of the agent
 * @returns The timestamp in milliseconds, or null if no report has been sent
 */
export function getLastReportTime(teamName: string, agentName: string): number | null {
    const p = lastReportPath(teamName, agentName);
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
 * Update the last report timestamp for this agent (messages sent to team-lead only).
 * @param teamName The name of the team
 * @param agentName The name of the agent
 */
export function updateLastReportTime(teamName: string, agentName: string): void {
    const p = lastReportPath(teamName, agentName);
    fs.writeFileSync(p, Date.now().toString());
}

/** Unread instructions older than this are considered stale enough to warrant a reminder even if not yet marked read. */
const UNREAD_STALE_MS = 2 * 60 * 1000;
/** Throttle repeated report reminders while a worker still has not reported. */
const REMINDER_COOLDOWN_MS = 30 * 1000;

/**
 * Determine whether the agent needs a reminder to report back to the team-lead.
 *
 * Three failure modes are covered:
 *  1. Worker never called read_message → allInstructionsRead stays false forever.
 *     Covered by: time-based fallback on oldestUnreadInstructionTs.
 *  2. Worker sent a message to a peer, not the team-lead.
 *     Covered by: only lastReportTime (team-lead messages) satisfies the reminder.
 *  3. Steer at turn_end didn't wake the agent.
 *     Covered by: reminder check also runs in the polling loop while agent is idle.
 *
 * @param teamName The name of the team
 * @param agentName The name of the agent
 * @param latestInstructionTs Epoch-ms timestamp of the most recent team-lead message, or null if none exist
 * @param allInstructionsRead True when every team-lead message has been marked read
 * @param oldestUnreadInstructionTs Epoch-ms timestamp of the oldest unread team-lead message, or null if all are read
 * @returns true if a reminder message should be added
 */
export function needsReminderMessage(
    teamName: string,
    agentName: string,
    latestInstructionTs: number | null,
    allInstructionsRead: boolean,
    oldestUnreadInstructionTs: number | null = null
): boolean {
    if (latestInstructionTs === null) return false;

    const lastReminderTime = getLastReminderTime(teamName, agentName);
    const lastReportTime = getLastReportTime(teamName, agentName);
    if (lastReportTime !== null && lastReportTime >= latestInstructionTs) return false;
    if (lastReminderTime !== null && lastReminderTime >= latestInstructionTs && Date.now() - lastReminderTime < REMINDER_COOLDOWN_MS) return false;

    // Time-based fallback (Failure Mode 1): if there are unread instructions older than
    // UNREAD_STALE_MS, fire even when the worker never marked them read.
    if (oldestUnreadInstructionTs !== null && Date.now() - oldestUnreadInstructionTs > UNREAD_STALE_MS) {
        return true;
    }

    // Normal path: only remind once all instructions are read.
    if (!allInstructionsRead) return false;

    return true;
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

/**
 * Read messages from an agent's inbox.
 *
 * This function does NOT modify read state. To mark a message as read,
 * use {@link readMessage} with the message's UUID.
 *
 * @param teamName The name of the team
 * @param agentName The name of the agent
 * @param unreadOnly When true, only return unread messages
 * @returns A list of inbox messages (shallow copies, read state preserved)
 */
export async function readInbox(
    teamName: string,
    agentName: string,
    unreadOnly = true
): Promise<InboxMessage[]> {
    const p = inboxPath(teamName, agentName);

    if (!fs.existsSync(p)) return [];

    return await withLock(p, async () => {
        const allMsgs: InboxMessage[] = JSON.parse(fs.readFileSync(p, 'utf-8'));

        const toReturn = unreadOnly ? allMsgs.filter((m) => !m.read) : allMsgs;
        return toReturn.map((m) => ({ ...m }));
    });
}

/**
 * Read a single message by its UUID and mark it as read.
 *
 * @param teamName The name of the team
 * @param agentName The name of the agent
 * @param messageId The short UUID of the message to read
 * @returns The full inbox message, or null if no message with that id exists
 */
export async function readMessage(
    teamName: string,
    agentName: string,
    messageId: string
): Promise<InboxMessage | null> {
    const p = inboxPath(teamName, agentName);

    if (!fs.existsSync(p)) return null;

    return await withLock(p, async () => {
        const allMsgs: InboxMessage[] = JSON.parse(fs.readFileSync(p, 'utf-8'));

        const idx = allMsgs.findIndex((m) => m.id === messageId);
        if (idx === -1) return null;

        const message = allMsgs[idx];
        message.read = true;
        fs.writeFileSync(p, JSON.stringify(allMsgs, null, 2));

        return { ...message };
    });
}

/**
 * Mark all unread messages as read.
 *
 * @param teamName The name of the team
 * @param agentName The name of the agent
 * @returns The number of messages that were marked as read
 */
export async function markAllAsRead(teamName: string, agentName: string): Promise<number> {
    const p = inboxPath(teamName, agentName);

    if (!fs.existsSync(p)) return 0;

    return await withLock(p, async () => {
        const allMsgs: InboxMessage[] = JSON.parse(fs.readFileSync(p, 'utf-8'));
        let count = 0;
        for (const m of allMsgs) {
            if (!m.read) {
                m.read = true;
                count++;
            }
        }
        if (count > 0) {
            fs.writeFileSync(p, JSON.stringify(allMsgs, null, 2));
        }
        return count;
    });
}

export async function sendPlainMessage(
    teamName: string,
    fromName: string,
    toName: string,
    subject: string,
    text: string,
    summary?: string,
    color?: string
) {
    const msg: InboxMessage = {
        // 8-char hex prefix of a v4 UUID — 32 bits of entropy. Collision
        // risk is accepted: ~1 in 42M per inbox; unambiguous in practice.
        id: uuidv4().slice(0, 8),
        from: fromName,
        to: toName,
        subject,
        text,
        timestamp: nowIso(),
        read: false,
        summary,
        color
    };
    await appendMessage(teamName, toName, msg);
    // Track that the sender has sent a message
    updateLastMessageTime(teamName, fromName);
    // Track reports to the team-lead separately (used by reminder logic)
    if (toName === 'team-lead') {
        updateLastReportTime(teamName, fromName);
    }
}

/**
 * Broadcasts a message to all team members except the sender.
 * @param teamName The name of the team
 * @param fromName The name of the sender
 * @param text The message text
 * @param summary A short summary of the message
 * @param color An optional color for the message
 */
/**
 * Send a near-real-time notification directly to a specific agent.
 * The notification is written to a shared file that the recipient polls.
 * This bypasses the inbox system for low-latency coordination.
 *
 * :param teamName: The name of the team
 * :param notification: The notification text to deliver
 * :param recipientName: The name of the recipient agent
 */
export function sendNotification(teamName: string, notification: string, recipientName: string): void {
    const dir = notificationsDir(teamName);
    if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
    }
    const p = notificationPath(teamName, recipientName);
    fs.writeFileSync(p, JSON.stringify({ notification, timestamp: Date.now() }));
}

/**
 * Send a near-real-time notification to all team members except the sender.
 *
 * :param teamName: The name of the team
 * :param notification: The notification text to deliver
 * :param fromName: The name of the sender (excluded from delivery)
 */
export async function sendNotificationToAll(teamName: string, notification: string, fromName: string): Promise<void> {
    const config = await readConfig(teamName);
    for (const member of config.members) {
        if (member.name !== fromName) {
            sendNotification(teamName, notification, member.name);
        }
    }
}

/**
 * Poll for notifications addressed to this agent.
 * Returns the oldest pending notification text, or null if none exist.
 * The notification file is deleted after reading (one notification per poll).
 *
 * :param teamName: The name of the team
 * :param agentName: The name of the agent
 * :returns The notification text, or null if none
 */
export function pollNotification(teamName: string, agentName: string): string | null {
    const p = notificationPath(teamName, agentName);
    if (!fs.existsSync(p)) return null;
    try {
        const content = fs.readFileSync(p, 'utf-8');
        const data = JSON.parse(content);
        fs.unlinkSync(p);
        return data.notification;
    } catch {
        // Corrupted file — delete and ignore
        try { fs.unlinkSync(p); } catch {}
        return null;
    }
}

export async function broadcastMessage(
    teamName: string,
    fromName: string,
    subject: string,
    text: string,
    summary?: string,
    color?: string
) {
    const config = await readConfig(teamName);
    updateLastMessageTime(teamName, fromName);

    // Create an array of delivery promises for all members except the sender
    const deliveryPromises = config.members
        .filter((member) => member.name !== fromName)
        .map((member) => sendPlainMessage(teamName, fromName, member.name, subject, text, summary, color));

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
