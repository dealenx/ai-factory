import path from 'path';
import os from 'os';
import { execSync } from 'child_process';
import { fileExists, readTextFile, listDirectories, removeDirectory, ensureDir } from '../utils/fs.js';

export interface RemoteSource {
  host: 'github';
  owner: string;
  repo: string;
  skillPath?: string;
  ref: string;
}

export interface DetectedSkill {
  name: string;
  description: string;
  dirPath: string;
  relativePath: string;
}

/**
 * Parse a remote source URI.
 *
 * Supported formats:
 *   github:owner/repo
 *   github:owner/repo#ref
 *   github:owner/repo/skill-path
 *   github:owner/repo/skill-path#ref
 */
export function parseRemoteSource(uri: string): RemoteSource {
  if (!uri.startsWith('github:')) {
    throw new Error(`Unsupported source format: "${uri}". Use github:owner/repo`);
  }

  let body = uri.slice('github:'.length);
  let ref = 'main';

  const hashIdx = body.indexOf('#');
  if (hashIdx !== -1) {
    ref = body.slice(hashIdx + 1);
    body = body.slice(0, hashIdx);
  }

  const parts = body.split('/');
  if (parts.length < 2) {
    throw new Error(`Invalid GitHub source: "${uri}". Expected github:owner/repo`);
  }

  const owner = parts[0];
  const repo = parts[1];
  const skillPath = parts.length > 2 ? parts.slice(2).join('/') : undefined;

  return { host: 'github', owner, repo, skillPath, ref };
}

/**
 * Format a RemoteSource back to a URI string.
 */
export function formatSourceUri(source: RemoteSource): string {
  let uri = `github:${source.owner}/${source.repo}`;
  if (source.skillPath) {
    uri += `/${source.skillPath}`;
  }
  if (source.ref !== 'main') {
    uri += `#${source.ref}`;
  }
  return uri;
}

/**
 * Download a repository archive and extract it to a temp directory.
 * Returns the path to the extracted repo root.
 */
export async function downloadAndExtract(source: RemoteSource): Promise<string> {
  const tmpBase = path.join(os.tmpdir(), `ai-factory-remote-${Date.now()}`);
  await ensureDir(tmpBase);

  const archiveUrl = `https://github.com/${source.owner}/${source.repo}/archive/refs/heads/${source.ref}.tar.gz`;

  try {
    // Download and extract using tar (available on macOS, Linux, and Windows with Git)
    const archivePath = path.join(tmpBase, 'archive.tar.gz');

    // Use curl for download (available on all modern OS)
    execSync(`curl -fsSL -o "${archivePath}" "${archiveUrl}"`, {
      timeout: 60000,
      stdio: 'pipe',
    });

    // Extract
    execSync(`tar -xzf "${archivePath}" -C "${tmpBase}"`, {
      timeout: 30000,
      stdio: 'pipe',
    });

    // GitHub archives extract to {repo}-{ref}/ directory
    const entries = await listDirectories(tmpBase);
    const repoDir = entries.find(e => e.startsWith(`${source.repo}-`));

    if (!repoDir) {
      throw new Error('Could not find extracted repository directory');
    }

    return path.join(tmpBase, repoDir);
  } catch (error) {
    await removeDirectory(tmpBase).catch(() => {});
    const msg = (error as Error).message;
    if (msg.includes('curl') || msg.includes('404')) {
      throw new Error(
        `Failed to download from ${archiveUrl}. ` +
        `Check that the repository "${source.owner}/${source.repo}" exists and branch "${source.ref}" is correct.`
      );
    }
    throw error;
  }
}

/**
 * Resolve the current commit hash for a remote source using the GitHub API.
 */
export async function resolveCommitHash(source: RemoteSource): Promise<string> {
  try {
    const output = execSync(
      `curl -fsSL "https://api.github.com/repos/${source.owner}/${source.repo}/commits/${source.ref}" -H "Accept: application/vnd.github.sha"`,
      { timeout: 15000, stdio: 'pipe', encoding: 'utf-8' },
    );
    return output.trim().slice(0, 12);
  } catch {
    // Fallback: use timestamp as version if API fails
    return `unknown-${Date.now()}`;
  }
}

/**
 * Extract the `name:` and `description:` from SKILL.md YAML frontmatter.
 */
function parseFrontmatter(content: string): { name: string; description: string } {
  const match = content.match(/^---\s*\n([\s\S]*?)\n---/);
  if (!match) {
    return { name: '', description: '' };
  }

  const frontmatter = match[1];
  const nameMatch = frontmatter.match(/^name:\s*(.+)$/m);
  const descMatch = frontmatter.match(/^description:\s*(.+)$/m);

  return {
    name: nameMatch ? nameMatch[1].trim() : '',
    description: descMatch ? descMatch[1].trim().slice(0, 100) : '',
  };
}

/**
 * Detect skills in a downloaded repository.
 *
 * Detection order:
 * 1. SKILL.md at root → single skill (entire repo is one skill)
 * 2. skills/\*\/SKILL.md → collection in skills/ subdirectory
 * 3. \*\/SKILL.md at first level → collection at root level
 */
export async function detectSkills(repoDir: string): Promise<DetectedSkill[]> {
  // Pattern 1: Single skill — SKILL.md at root
  const rootSkillMd = path.join(repoDir, 'SKILL.md');
  if (await fileExists(rootSkillMd)) {
    const content = await readTextFile(rootSkillMd);
    const { name, description } = parseFrontmatter(content ?? '');
    const dirName = path.basename(repoDir);
    return [{
      name: name || dirName,
      description,
      dirPath: repoDir,
      relativePath: '',
    }];
  }

  // Pattern 2: Collection in skills/ directory
  const skillsSubDir = path.join(repoDir, 'skills');
  if (await fileExists(skillsSubDir)) {
    const skills = await scanForSkills(skillsSubDir, 'skills');
    if (skills.length > 0) return skills;
  }

  // Pattern 3: Collection at root level
  const rootSkills = await scanForSkills(repoDir, '');
  if (rootSkills.length > 0) return rootSkills;

  throw new Error('No skills found in repository. Expected SKILL.md at root or in subdirectories.');
}

async function scanForSkills(parentDir: string, relativePrefx: string): Promise<DetectedSkill[]> {
  const skills: DetectedSkill[] = [];
  const dirs = await listDirectories(parentDir);

  for (const dir of dirs) {
    // Skip hidden directories and common non-skill directories
    if (dir.startsWith('.') || dir.startsWith('_') || dir === 'node_modules') continue;

    const skillMdPath = path.join(parentDir, dir, 'SKILL.md');
    if (await fileExists(skillMdPath)) {
      const content = await readTextFile(skillMdPath);
      const { name, description } = parseFrontmatter(content ?? '');
      skills.push({
        name: name || dir,
        description,
        dirPath: path.join(parentDir, dir),
        relativePath: relativePrefx ? `${relativePrefx}/${dir}` : dir,
      });
    }
  }

  return skills;
}

/**
 * Clean up a temp directory created by downloadAndExtract.
 */
export async function cleanupTemp(repoDir: string): Promise<void> {
  // Go up one level to remove the entire temp base (includes archive.tar.gz)
  const tmpBase = path.dirname(repoDir);
  if (tmpBase.includes('ai-factory-remote-')) {
    await removeDirectory(tmpBase).catch(() => {});
  }
}
