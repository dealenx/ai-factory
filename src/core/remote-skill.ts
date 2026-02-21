import path from 'path';
import os from 'os';
import fs from 'fs';
import zlib from 'zlib';
import { fileExists, readTextFile, listDirectories, removeDirectory, ensureDir } from '../utils/fs.js';

/** Timeout controller helper for fetch calls. */
function fetchWithTimeout(url: string, init: RequestInit & { timeout?: number } = {}): Promise<Response> {
  const { timeout = 15000, ...rest } = init;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  return fetch(url, { ...rest, signal: controller.signal }).finally(() => clearTimeout(timer));
}

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
 * Convert a GitHub URL to the internal github: format.
 *
 * Examples:
 *   https://github.com/owner/repo          → github:owner/repo
 *   https://github.com/owner/repo.git      → github:owner/repo
 *   https://github.com/owner/repo/tree/dev → github:owner/repo#dev
 *   https://github.com/owner/repo/tree/dev/path/to/skill → github:owner/repo/path/to/skill#dev
 */
function normalizeGitHubUrl(url: string): string {
  // Strip trailing slash and .git suffix
  let cleaned = url.replace(/\/+$/, '').replace(/\.git$/, '');

  // Remove protocol + host
  const match = cleaned.match(/^https?:\/\/github\.com\/(.+)$/);
  if (!match) return url;

  const segments = match[1].split('/');
  if (segments.length < 2) return url;

  const owner = segments[0];
  const repo = segments[1];

  // /tree/<ref>[/path...] pattern
  if (segments.length >= 4 && segments[2] === 'tree') {
    const ref = segments[3];
    const skillPath = segments.length > 4 ? segments.slice(4).join('/') : '';
    let result = `github:${owner}/${repo}`;
    if (skillPath) result += `/${skillPath}`;
    result += `#${ref}`;
    return result;
  }

  return `github:${owner}/${repo}`;
}

/**
 * Parse a remote source URI.
 *
 * Supported formats:
 *   github:owner/repo
 *   github:owner/repo#ref
 *   github:owner/repo/skill-path
 *   github:owner/repo/skill-path#ref
 *   https://github.com/owner/repo
 *   https://github.com/owner/repo/tree/branch
 *   https://github.com/owner/repo/tree/branch/skill-path
 */
export function parseRemoteSource(uri: string): RemoteSource {
  // Normalize GitHub URLs to github: format
  if (uri.startsWith('https://github.com/') || uri.startsWith('http://github.com/')) {
    uri = normalizeGitHubUrl(uri);
  }

  if (!uri.startsWith('github:')) {
    throw new Error(`Unsupported source format: "${uri}". Use github:owner/repo or https://github.com/owner/repo`);
  }

  let body = uri.slice('github:'.length);
  let ref = '';

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
  if (source.ref && source.ref !== 'main') {
    uri += `#${source.ref}`;
  }
  return uri;
}

/**
 * Format a RemoteSource back to a URI string.
 */
function toPosixPath(p: string): string {
  if (process.platform !== 'win32') return p;
  return p.replace(/\\/g, '/').replace(/^([A-Za-z]):/, (_m, d: string) => '/' + d.toLowerCase());
}

/**
 * Resolve the default branch for a GitHub repository.
 * Falls back to 'main' if the API call fails.
 */
async function resolveDefaultBranch(owner: string, repo: string): Promise<string> {
  try {
    const res = await fetchWithTimeout(`https://api.github.com/repos/${owner}/${repo}`, {
      headers: { Accept: 'application/vnd.github.v3+json' },
    });
    if (res.ok) {
      const data = await res.json() as { default_branch?: string };
      if (data.default_branch) return data.default_branch;
    }
  } catch {
    // API failed, fall back to 'main'
  }
  return 'main';
}

/**
 * Download a repository archive and extract it to a temp directory.
 * Returns the path to the extracted repo root.
 * Also mutates source.ref to the resolved branch if it was empty.
 *
 * Uses Node.js native fetch + zlib + tar parser — no shell dependencies.
 */
export async function downloadAndExtract(source: RemoteSource): Promise<string> {
  // Resolve default branch if not specified
  if (!source.ref) {
    source.ref = await resolveDefaultBranch(source.owner, source.repo);
  }

  const tmpBase = path.join(os.tmpdir(), `ai-factory-remote-${Date.now()}`);
  await ensureDir(tmpBase);

  const archiveUrl = `https://github.com/${source.owner}/${source.repo}/archive/refs/heads/${source.ref}.tar.gz`;

  try {
    // Download tarball via fetch
    const res = await fetchWithTimeout(archiveUrl, { timeout: 60000 });
    if (!res.ok) {
      throw new Error(`HTTP ${res.status} from ${archiveUrl}`);
    }

    const buffer = Buffer.from(await res.arrayBuffer());

    // Decompress gzip → raw tar
    const tarBuffer = zlib.gunzipSync(buffer);

    // Extract tar archive using pure Node.js parser
    extractTar(tarBuffer, tmpBase);

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
    if (msg.includes('HTTP') || msg.includes('fetch') || msg.includes('404')) {
      throw new Error(
        `Failed to download from ${archiveUrl}. ` +
        `Check that the repository "${source.owner}/${source.repo}" exists and branch "${source.ref}" is correct.`
      );
    }
    throw error;
  }
}

/**
 * Minimal tar extractor — reads a POSIX/UStar tar buffer and writes files to disk.
 * Supports regular files and directories. Handles long names via pax headers (type 'x').
 */
function extractTar(tar: Buffer, destDir: string): void {
  let offset = 0;
  let paxPath = '';

  while (offset + 512 <= tar.length) {
    const header = tar.subarray(offset, offset + 512);

    // End-of-archive: two consecutive zero blocks
    if (header.every(b => b === 0)) break;

    // Parse header fields
    const rawName = header.subarray(0, 100).toString('utf-8').replace(/\0+$/, '');
    const sizeStr = header.subarray(124, 136).toString('utf-8').replace(/\0+$/, '').trim();
    const typeFlag = String.fromCharCode(header[156]);
    const prefix = header.subarray(345, 500).toString('utf-8').replace(/\0+$/, '');

    const fileSize = sizeStr ? parseInt(sizeStr, 8) : 0;
    const entryName = paxPath || (prefix ? `${prefix}/${rawName}` : rawName);
    paxPath = ''; // reset after use

    offset += 512; // advance past header

    if (typeFlag === 'x' || typeFlag === 'g') {
      // Pax extended header — extract path= field
      const paxData = tar.subarray(offset, offset + fileSize).toString('utf-8');
      const pathMatch = paxData.match(/(?:^|\n)\d+ path=([^\n]+)/);
      if (pathMatch) paxPath = pathMatch[1];
      offset += Math.ceil(fileSize / 512) * 512;
      continue;
    }

    if (typeFlag === '5' || entryName.endsWith('/')) {
      // Directory
      const dirPath = path.join(destDir, entryName);
      fs.mkdirSync(dirPath, { recursive: true });
    } else if (typeFlag === '0' || typeFlag === '' || typeFlag === '\0') {
      // Regular file
      const filePath = path.join(destDir, entryName);
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      const data = tar.subarray(offset, offset + fileSize);
      fs.writeFileSync(filePath, data);
    }
    // Skip symlinks, hardlinks, etc.

    // Advance past data blocks (512-byte aligned)
    offset += Math.ceil(fileSize / 512) * 512;
  }
}

/**
 * Resolve the current commit hash for a remote source using the GitHub API.
 */
export async function resolveCommitHash(source: RemoteSource): Promise<string> {
  try {
    const res = await fetchWithTimeout(
      `https://api.github.com/repos/${source.owner}/${source.repo}/commits/${source.ref}`,
      { headers: { Accept: 'application/vnd.github.sha' } },
    );
    if (res.ok) {
      const text = await res.text();
      return text.trim().slice(0, 12);
    }
  } catch {
    // Fallback below
  }
  return `unknown-${Date.now()}`;
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
