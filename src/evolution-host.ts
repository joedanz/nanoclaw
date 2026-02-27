/**
 * Evolution Host — fork-owned module for personality evolution on the host side.
 * Extracted from container-runner.ts to minimize upstream merge conflicts.
 *
 * Contains:
 * - syncAgentRunner(): version-based sync of agent-runner source per group
 * - snapshotPersonality(): SHA-256 change-detection snapshots of personality.md
 */

import crypto from 'crypto';
import fs from 'fs';
import path from 'path';

import { logger } from './logger.js';

// IMPORTANT: Bump this version string whenever agent-runner source changes
// that need to propagate to existing groups (e.g., new hooks, new tools).
export const AGENT_RUNNER_BASE_VERSION = '2026-02-27c';

export const MAX_PERSONALITY_HISTORY = 30;

/**
 * Sync agent-runner source into a per-group writable location so agents
 * can customize it (add tools, change behavior) without affecting other
 * groups. Recompiled on container startup via entrypoint.sh.
 *
 * Returns true if the directory is safe to mount (sync succeeded or
 * was skipped with valid existing content).
 */
export function syncAgentRunner(
  groupAgentRunnerDir: string,
  agentRunnerSrc: string,
  groupFolder: string,
): boolean {
  // Version-based sync: update runner when base version changes.
  // .keep-local-agent-runner escape hatch for intentionally customized groups.
  const versionFile = path.join(groupAgentRunnerDir, '.base-version');
  const localOverride = path.join(
    groupAgentRunnerDir,
    '.keep-local-agent-runner',
  );

  let currentVersion: string | null = null;
  try {
    currentVersion = fs.readFileSync(versionFile, 'utf-8').trim();
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      logger.warn(
        { group: groupFolder, versionFile, error: err },
        'Failed to read agent-runner base version, will re-sync',
      );
    }
    currentVersion = null;
  }

  const shouldSync =
    !fs.existsSync(groupAgentRunnerDir) ||
    currentVersion !== AGENT_RUNNER_BASE_VERSION;

  let syncFailed = false;
  if (
    shouldSync &&
    !fs.existsSync(localOverride) &&
    fs.existsSync(agentRunnerSrc)
  ) {
    // Full refresh to prevent stale deleted/renamed files from lingering
    try {
      fs.rmSync(groupAgentRunnerDir, { recursive: true, force: true });
      fs.mkdirSync(groupAgentRunnerDir, { recursive: true });
      fs.cpSync(agentRunnerSrc, groupAgentRunnerDir, {
        recursive: true,
        force: true,
      });
      fs.writeFileSync(versionFile, `${AGENT_RUNNER_BASE_VERSION}\n`);
    } catch (err) {
      syncFailed = true;
      logger.error(
        { group: groupFolder, error: err },
        'Failed to sync agent-runner source; container may use stale code',
      );
    }
  }

  // Skip mount if sync failed mid-way (rmSync succeeded but cpSync didn't),
  // leaving an empty/partial directory that would crash the container.
  if (
    !syncFailed ||
    fs.existsSync(path.join(groupAgentRunnerDir, 'index.ts'))
  ) {
    return true;
  }

  logger.error(
    { group: groupFolder },
    'Skipping agent-runner mount due to broken sync; container will use baked-in runner',
  );
  return false;
}

/**
 * Snapshot personality.md into evolution/history/ when content changes.
 * Runs on the host before container start for reliability.
 * Uses SHA-256 hash to detect changes, caps history at MAX_PERSONALITY_HISTORY files.
 */
export function snapshotPersonality(groupDir: string, groupFolder: string): void {
  const personalityPath = path.join(groupDir, 'evolution', 'personality.md');

  let content: string;
  try {
    content = fs.readFileSync(personalityPath, 'utf-8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return;
    logger.warn(
      { group: groupFolder, err },
      'Failed to read personality.md for versioning',
    );
    return;
  }

  const hash = crypto.createHash('sha256').update(content).digest('hex');
  const hashFile = path.join(groupDir, 'evolution', '.personality-hash');

  try {
    const existingHash = fs.readFileSync(hashFile, 'utf-8').trim();
    if (existingHash === hash) return; // No change
  } catch {
    // Hash file missing — first snapshot
  }

  try {
    const historyDir = path.join(groupDir, 'evolution', 'history');
    fs.mkdirSync(historyDir, { recursive: true });

    // Write snapshot with ISO date filename
    const dateStr = new Date().toISOString().replace(/[:.]/g, '-');
    fs.writeFileSync(path.join(historyDir, `${dateStr}.md`), content);

    // Update hash
    fs.writeFileSync(hashFile, hash);

    // Cap at MAX_PERSONALITY_HISTORY files
    const files = fs
      .readdirSync(historyDir)
      .filter((f) => f.endsWith('.md'))
      .sort();
    while (files.length > MAX_PERSONALITY_HISTORY) {
      const oldest = files.shift()!;
      try {
        fs.unlinkSync(path.join(historyDir, oldest));
      } catch {
        continue;
      }
    }

    logger.debug({ group: groupFolder }, 'Personality snapshot created');
  } catch (err) {
    logger.warn(
      { group: groupFolder, err },
      'Failed to create personality snapshot',
    );
  }
}
