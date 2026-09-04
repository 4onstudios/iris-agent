import fs from "fs/promises";
import path from "path";

export type SkillEntry = { name: string; description: string; location: string };

const shouldLogSkillDiscoveryWarnings =
  process.env.IRIS_VERBOSE_SKILL_DISCOVERY === "true";

const logSkillDiscoveryWarning = (message: string) => {
  if (!shouldLogSkillDiscoveryWarnings) return;
  console.warn(message);
};

/**
 * Merge skills discovered across multiple directories.
 * Later directories have higher precedence and override earlier ones on name conflict.
 */
export async function loadSkillsFromDirectories(skillDirs: string[]): Promise<SkillEntry[]> {
  const skillsByName = new Map<string, SkillEntry>();

  for (const skillsDir of skillDirs) {
    try {
      const entries = await fs.readdir(skillsDir, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        const skillMdPath = path.join(skillsDir, entry.name, "SKILL.md");
        try {
          const content = await fs.readFile(skillMdPath, "utf8");
          const nameMatch = content.match(/^name:\s*(.+)$/m);
          const descMatch = content.match(/^description:\s*(.+)$/m);
          const name = nameMatch ? nameMatch[1].trim() : entry.name;
          const description = descMatch
            ? descMatch[1].trim()
            : "No description available";
          const location = `skills/${entry.name}/SKILL.md`;

          if (skillsByName.has(name)) {
            logSkillDiscoveryWarning(
              `[agent] overriding duplicated skill '${name}' from higher-precedence directory: ${skillsDir}`,
            );
          }

          skillsByName.set(name, {
            name,
            description,
            location: location.replace(/\\/g, "/"),
          });
        } catch {
          // skip skill if SKILL.md is unreadable
        }
      }
    } catch {
      // candidate directory does not exist in this runtime mode; try next
    }
  }

  return Array.from(skillsByName.values()).sort((a, b) =>
    a.name.localeCompare(b.name),
  );
}
