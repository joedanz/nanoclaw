// agent-skill-sync.ts — sync agent-created skills into .claude/skills/

import fs from 'fs';
import path from 'path';

const SKILL_NAME_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;
const MAX_SKILL_SIZE = 10_000; // 10KB per skill
const MAX_TOTAL_SIZE = 50_000; // 50KB total
const MAX_SKILL_COUNT = 20;

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

const DANGEROUS_PATTERNS = [
  'anthropic_api_key',
  'claude_code_oauth_token',
  'allowdangerouslyskippermissions',
  'dangerouslyskippermissions',
  'bypasspermissions',
  'permissionmode',
  'settingsources',
  'mcpservers',
];

interface SyncReportEntry {
  name: string;
  size?: number;
  reason?: string;
}

interface SyncReport {
  timestamp: string;
  accepted: SyncReportEntry[];
  rejected: SyncReportEntry[];
  pruned: string[];
}

export function syncAgentSkills(
  groupDir: string,
  skillsDst: string,
  builtInSkillNames: Set<string>,
  log: (msg: string) => void = (m) => console.error(`[agent-skill-sync] ${m}`),
): void {
  const report: SyncReport = {
    timestamp: new Date().toISOString(),
    accepted: [],
    rejected: [],
    pruned: [],
  };

  const agentSkillsSrc = path.join(groupDir, 'skills');
  if (!fs.existsSync(agentSkillsSrc)) {
    // Source gone — prune all agent-created skills from destination
    pruneOrphanedSkills(skillsDst, new Set(), builtInSkillNames, log, report);
    writeSyncReport(skillsDst, report, log);
    return;
  }

  let totalSize = 0;
  let count = 0;
  const syncedSkills = new Set<string>();

  let srcEntries: string[];
  try {
    srcEntries = fs.readdirSync(agentSkillsSrc).sort();
  } catch (err) {
    log(`Failed to read agent skills source ${agentSkillsSrc}: ${errMsg(err)}`);
    // Fall through to prune with empty synced set
    pruneOrphanedSkills(skillsDst, new Set(), builtInSkillNames, log, report);
    writeSyncReport(skillsDst, report, log);
    return;
  }

  for (const skillDir of srcEntries) {
    if (!SKILL_NAME_PATTERN.test(skillDir)) continue;
    if (builtInSkillNames.has(skillDir)) continue;

    const srcDir = path.join(agentSkillsSrc, skillDir);

    // Skip symlinks
    try {
      const stat = fs.lstatSync(srcDir);
      if (!stat.isDirectory() || stat.isSymbolicLink()) continue;
    } catch (err) {
      log(`Skipping skill dir ${skillDir}: stat failed: ${errMsg(err)}`);
      continue;
    }

    const skillMdPath = path.join(srcDir, 'SKILL.md');
    try {
      const stat = fs.lstatSync(skillMdPath);
      if (stat.isSymbolicLink() || !stat.isFile()) continue;
    } catch (err) {
      log(`Skipping skill ${skillDir}: SKILL.md stat failed: ${errMsg(err)}`);
      continue;
    }

    let content: string;
    try {
      content = fs.readFileSync(skillMdPath, 'utf-8');
    } catch (err) {
      log(`Skipping skill ${skillDir}: read failed: ${errMsg(err)}`);
      report.rejected.push({
        name: skillDir,
        reason: `read failed: ${errMsg(err)}`,
      });
      continue;
    }

    // Validate
    if (!content.startsWith('---')) {
      log(`Skipping skill ${skillDir}: missing frontmatter`);
      report.rejected.push({ name: skillDir, reason: 'missing frontmatter' });
      continue;
    }
    if (content.length > MAX_SKILL_SIZE) {
      log(
        `Skipping skill ${skillDir}: exceeds ${MAX_SKILL_SIZE} byte limit (${content.length} bytes)`,
      );
      report.rejected.push({
        name: skillDir,
        size: content.length,
        reason: `exceeds ${MAX_SKILL_SIZE} byte limit`,
      });
      continue;
    }
    // Case-insensitive check to prevent bypass via mixed casing
    const contentLower = content
      .replace(/[\u200b\u200c\u200d\ufeff\u00ad]/g, '')
      .toLowerCase();
    if (DANGEROUS_PATTERNS.some((p) => contentLower.includes(p))) {
      log(`Skipping skill ${skillDir}: contains dangerous pattern`);
      report.rejected.push({
        name: skillDir,
        reason: 'contains dangerous pattern',
      });
      continue;
    }

    if (
      totalSize + content.length > MAX_TOTAL_SIZE ||
      count + 1 > MAX_SKILL_COUNT
    ) {
      log(
        `Skipping skill ${skillDir}: cap exceeded (total ${totalSize + content.length} bytes, count ${count + 1})`,
      );
      report.rejected.push({
        name: skillDir,
        size: content.length,
        reason: 'cap exceeded',
      });
      break;
    }
    totalSize += content.length;
    count++;

    // Copy only SKILL.md (not entire directory).
    // Per-skill try-catch so one bad write doesn't kill sync for remaining skills.
    try {
      const dstDir = path.join(skillsDst, skillDir);
      fs.mkdirSync(dstDir, { recursive: true });
      fs.writeFileSync(path.join(dstDir, 'SKILL.md'), content);
      syncedSkills.add(skillDir);
      report.accepted.push({ name: skillDir, size: content.length });
    } catch (err) {
      log(`Failed to write skill ${skillDir}: ${errMsg(err)}`);
      report.rejected.push({
        name: skillDir,
        reason: `write failed: ${errMsg(err)}`,
      });
      continue;
    }
  }

  // Prune agent-created skills that no longer exist in source
  pruneOrphanedSkills(skillsDst, syncedSkills, builtInSkillNames, log, report);
  writeSyncReport(skillsDst, report, log);
}

function writeSyncReport(
  skillsDst: string,
  report: SyncReport,
  log: (msg: string) => void,
): void {
  try {
    fs.mkdirSync(skillsDst, { recursive: true });
    fs.writeFileSync(
      path.join(skillsDst, '.sync-report.json'),
      JSON.stringify(report, null, 2),
    );
  } catch (err) {
    log(`Failed to write sync report: ${errMsg(err)}`);
  }
}

/**
 * Remove destination skills that are not in the synced set and not built-in.
 * This prevents deleted/renamed skills from persisting in .claude/skills/.
 */
function pruneOrphanedSkills(
  skillsDst: string,
  syncedSkills: Set<string>,
  builtInSkillNames: Set<string>,
  log?: (msg: string) => void,
  report?: SyncReport,
): void {
  if (!fs.existsSync(skillsDst)) return;

  let entries: string[];
  try {
    entries = fs.readdirSync(skillsDst);
  } catch (err) {
    log?.(`Failed to read skills destination ${skillsDst}: ${errMsg(err)}`);
    return;
  }

  for (const dir of entries) {
    if (!SKILL_NAME_PATTERN.test(dir)) continue;
    if (builtInSkillNames.has(dir)) continue;
    if (syncedSkills.has(dir)) continue;

    const dirPath = path.join(skillsDst, dir);
    try {
      const st = fs.lstatSync(dirPath);
      if (!st.isDirectory() || st.isSymbolicLink()) continue;
    } catch {
      continue;
    }

    const skillMdPath = path.join(dirPath, 'SKILL.md');
    try {
      const st = fs.lstatSync(skillMdPath);
      if (!st.isFile() || st.isSymbolicLink()) continue;
    } catch {
      continue;
    }

    try {
      fs.rmSync(dirPath, { recursive: true, force: true });
      log?.(`Pruned orphaned agent skill: ${dir}`);
      report?.pruned.push(dir);
    } catch (err) {
      log?.(`Failed to prune skill ${dir}: ${errMsg(err)}`);
    }
  }
}
