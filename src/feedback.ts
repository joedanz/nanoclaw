/**
 * Feedback — fork-owned module for user feedback signal capture.
 * Extracted from index.ts and config.ts to minimize upstream merge conflicts.
 *
 * Intercepts !good/!bad commands, writes them to evolution/feedback/,
 * and filters them out so they never reach the agent.
 */

import fs from 'fs';
import path from 'path';

import { resolveGroupFolderPath } from './group-folder.js';
import { logger } from './logger.js';
import { NewMessage } from './types.js';

// Feedback commands — quick thumbs-up/thumbs-down signals for the evolution system.
// Intercepted in the message loop and NEVER forwarded to containers.
export const FEEDBACK_POSITIVE_PATTERN = /^!(good|great|perfect|thanks)\s*$/i;
export const FEEDBACK_NEGATIVE_PATTERN = /^!(bad|wrong|no|fix)\s*$/i;

export interface FeedbackEntry {
  rating: 'positive' | 'negative';
  timestamp: string;
  from: string;
  contextSummary: string;
}

const MAX_FEEDBACK_FILES = 100;

/** Write a feedback signal to the group's evolution/feedback/ directory. */
export function writeFeedback(groupFolder: string, entry: FeedbackEntry): void {
  try {
    const groupDir = resolveGroupFolderPath(groupFolder);
    const feedbackDir = path.join(groupDir, 'evolution', 'feedback');
    fs.mkdirSync(feedbackDir, { recursive: true });

    // Rotate: delete oldest when at cap
    const files = fs
      .readdirSync(feedbackDir)
      .filter((f) => f.endsWith('.json'))
      .sort();
    while (files.length >= MAX_FEEDBACK_FILES) {
      const oldest = files.shift();
      if (!oldest) break;
      try {
        fs.unlinkSync(path.join(feedbackDir, oldest));
      } catch {
        continue;
      }
    }

    const suffix = Math.random().toString(36).slice(2, 8);
    const filename = `${Date.now()}-${suffix}.json`;
    fs.writeFileSync(
      path.join(feedbackDir, filename),
      JSON.stringify(entry, null, 2),
    );
    logger.info(
      { groupFolder, rating: entry.rating },
      'Recorded user feedback',
    );
  } catch (err) {
    logger.error({ groupFolder, err }, 'Failed to write feedback file');
  }
}

/**
 * Filter feedback messages out of a group's incoming messages.
 * Feedback commands (!good, !bad, etc.) are written to evolution/feedback/
 * and removed from the returned array so they never reach the agent.
 *
 * @returns Messages that are NOT feedback commands (normal messages to forward).
 */
export function filterFeedbackMessages(
  messages: NewMessage[],
  groupFolder: string,
  chatJid: string,
  lastAgentTimestamp: Record<string, string>,
  lastAgentMessage?: Record<string, string>,
): NewMessage[] {
  return messages.filter((m) => {
    const content = m.content.trim();
    const isPositive = FEEDBACK_POSITIVE_PATTERN.test(content);
    const isNegative = FEEDBACK_NEGATIVE_PATTERN.test(content);
    if (!isPositive && !isNegative) return true;

    const agentMsg = lastAgentMessage?.[chatJid];
    writeFeedback(groupFolder, {
      rating: isPositive ? 'positive' : 'negative',
      timestamp: new Date().toISOString(),
      from: m.sender_name || 'unknown',
      contextSummary: agentMsg
        ? `Last agent response: ${agentMsg}`
        : lastAgentTimestamp[chatJid]
          ? `Last agent response at ${lastAgentTimestamp[chatJid]}`
          : 'No prior agent response in this session',
    });
    return false;
  });
}
