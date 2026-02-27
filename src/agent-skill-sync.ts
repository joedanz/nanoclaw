// agent-skill-sync.ts — sync agent-created skills into .claude/skills/

import fs from 'fs';
import path from 'path';

const SKILL_NAME_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;
const MAX_SKILL_SIZE = 10_000; // 10KB per skill
const MAX_TOTAL_SIZE = 50_000; // 50KB total
const MAX_SKILL_COUNT = 20;

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

export function syncAgentSkills(
  groupDir: string,
  skillsDst: string,
  builtInSkillNames: Set<string>,
  log?: (msg: string) => void,
): void {
  const agentSkillsSrc = path.join(groupDir, 'skills');
  if (!fs.existsSync(agentSkillsSrc)) {
    // Source gone — prune all agent-created skills from destination
    pruneOrphanedSkills(skillsDst, new Set(), builtInSkillNames, log);
    return;
  }

  let totalSize = 0;
  let count = 0;
  const syncedSkills = new Set<string>();

  for (const skillDir of fs.readdirSync(agentSkillsSrc)) {
    if (!SKILL_NAME_PATTERN.test(skillDir)) continue;
    if (builtInSkillNames.has(skillDir)) continue;

    const srcDir = path.join(agentSkillsSrc, skillDir);

    // Skip symlinks
    try {
      const stat = fs.lstatSync(srcDir);
      if (!stat.isDirectory() || stat.isSymbolicLink()) continue;
    } catch (err) {
      log?.(
        `Skipping skill dir ${skillDir}: stat failed: ${err instanceof Error ? err.message : String(err)}`,
      );
      continue;
    }

    const skillMdPath = path.join(srcDir, 'SKILL.md');
    if (!fs.existsSync(skillMdPath)) continue;

    try {
      const stat = fs.lstatSync(skillMdPath);
      if (stat.isSymbolicLink() || !stat.isFile()) continue;
    } catch (err) {
      log?.(
        `Skipping skill ${skillDir}: SKILL.md stat failed: ${err instanceof Error ? err.message : String(err)}`,
      );
      continue;
    }

    let content: string;
    try {
      content = fs.readFileSync(skillMdPath, 'utf-8');
    } catch (err) {
      log?.(
        `Skipping skill ${skillDir}: read failed: ${err instanceof Error ? err.message : String(err)}`,
      );
      continue;
    }

    // Validate
    if (!content.startsWith('---') || content.length > MAX_SKILL_SIZE) continue;
    // Case-insensitive check to prevent bypass via mixed casing
    const contentLower = content.toLowerCase();
    if (DANGEROUS_PATTERNS.some((p) => contentLower.includes(p))) continue;

    totalSize += content.length;
    count++;
    if (totalSize > MAX_TOTAL_SIZE || count > MAX_SKILL_COUNT) break;

    // Copy only SKILL.md (not entire directory). Allow updates via atomic write.
    // Per-skill try-catch so one bad write doesn't kill sync for remaining skills.
    try {
      const dstDir = path.join(skillsDst, skillDir);
      fs.mkdirSync(dstDir, { recursive: true });
      const dstPath = path.join(dstDir, 'SKILL.md');
      const tmpPath = `${dstPath}.tmp`;
      fs.writeFileSync(tmpPath, content);
      fs.renameSync(tmpPath, dstPath);
      syncedSkills.add(skillDir);
    } catch (err) {
      log?.(
        `Failed to write skill ${skillDir}: ${err instanceof Error ? err.message : String(err)}`,
      );
      // Clean up partial .tmp file
      try {
        fs.unlinkSync(path.join(skillsDst, skillDir, 'SKILL.md.tmp'));
      } catch {
        /* best effort cleanup */
      }
      continue;
    }
  }

  // Prune agent-created skills that no longer exist in source
  pruneOrphanedSkills(skillsDst, syncedSkills, builtInSkillNames, log);
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
): void {
  if (!fs.existsSync(skillsDst)) return;

  for (const dir of fs.readdirSync(skillsDst)) {
    if (builtInSkillNames.has(dir)) continue;
    if (syncedSkills.has(dir)) continue;
    // Only prune directories that have a SKILL.md (agent-created skills)
    const skillMdPath = path.join(skillsDst, dir, 'SKILL.md');
    if (!fs.existsSync(skillMdPath)) continue;

    try {
      fs.rmSync(path.join(skillsDst, dir), { recursive: true, force: true });
      log?.(`Pruned orphaned agent skill: ${dir}`);
    } catch (err) {
      log?.(
        `Failed to prune skill ${dir}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
}
