/**
 * Session Lifecycle — fork-owned module for session tracking and metrics.
 * Extracted from agent-runner index.ts to minimize upstream merge conflicts.
 *
 * Provides a factory function that returns hooks for tracking session
 * metrics and staging evolution data at session end.
 */

import { stageSessionEndSummary, writeSessionMetrics } from './evolution.js';

export interface SessionTracker {
  /** Call at the start of each query to increment the counter. */
  onQueryStart(): void;
  /** Record SDK message count from a completed query. */
  addSdkMessages(count: number): void;
  /** Call at session end to stage summary and write metrics. */
  onSessionEnd(hadError: boolean): void;
}

/**
 * Create a session tracker that accumulates metrics across queries
 * and writes evolution data on session end.
 */
export function createSessionTracker(
  opts: {
    isScheduledTask: boolean;
    firstPrompt: string;
  },
  log: (msg: string) => void,
): SessionTracker {
  const sessionStartTime = Date.now();
  let totalQueryCount = 0;
  let totalSdkMessageCount = 0;

  return {
    onQueryStart() {
      totalQueryCount++;
    },
    addSdkMessages(count: number) {
      totalSdkMessageCount += count;
    },
    onSessionEnd(hadError: boolean) {
      stageSessionEndSummary({
        isScheduledTask: opts.isScheduledTask,
        messageCount: totalQueryCount,
        firstPrompt: opts.firstPrompt,
        startTime: sessionStartTime,
      }, log);
      writeSessionMetrics({
        sessionDuration: Date.now() - sessionStartTime,
        messageCount: totalQueryCount,
        hadError,
        isScheduledTask: opts.isScheduledTask,
        sdkMessageCount: totalSdkMessageCount,
      }, log);
    },
  };
}
