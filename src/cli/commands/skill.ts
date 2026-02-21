import chalk from 'chalk';
import path from 'path';
import inquirer from 'inquirer';
import { loadConfig, saveConfig, type RemoteSkill } from '../../core/config.js';
import { getAgentConfig } from '../../core/agents.js';
import { getAvailableSkills, installRemoteSkill } from '../../core/installer.js';
import { parseRemoteSource, formatSourceUri, downloadAndExtract, resolveCommitHash, detectSkills, cleanupTemp, type DetectedSkill } from '../../core/remote-skill.js';
import { removeDirectory } from '../../utils/fs.js';

// ─── skill add ───────────────────────────────────────────────

export async function skillAddCommand(source: string): Promise<void> {
  const projectDir = process.cwd();

  console.log(chalk.bold.blue('\n🏭 AI Factory - Add Remote Skill\n'));

  const config = await loadConfig(projectDir);
  if (!config || config.agents.length === 0) {
    console.log(chalk.red('Error: No .ai-factory.json found or no agents configured.'));
    console.log(chalk.dim('Run "ai-factory init" first.'));
    process.exit(1);
  }

  // 1. Parse source
  let parsed;
  try {
    parsed = parseRemoteSource(source);
  } catch (error) {
    console.log(chalk.red((error as Error).message));
    process.exit(1);
  }

  // 2. Download
  console.log(chalk.dim(`Downloading ${parsed.owner}/${parsed.repo}...`));
  let repoDir: string;
  try {
    repoDir = await downloadAndExtract(parsed);
  } catch (error) {
    console.log(chalk.red((error as Error).message));
    process.exit(1);
  }

  try {
    // 3. Detect skills
    const allDetected = await detectSkills(repoDir);

    // 4. Filter by skillPath if specified
    let selectedSkills: DetectedSkill[];

    if (parsed.skillPath) {
      const match = allDetected.find(s =>
        s.relativePath === parsed.skillPath || s.name === parsed.skillPath
      );
      if (!match) {
        console.log(chalk.red(`Skill "${parsed.skillPath}" not found in repository.`));
        console.log(chalk.dim('Available skills:'));
        for (const s of allDetected) {
          console.log(chalk.dim(`  - ${s.name} (${s.relativePath || 'root'})`));
        }
        process.exit(1);
      }
      selectedSkills = [match];
    } else if (allDetected.length === 1) {
      selectedSkills = allDetected;
      console.log(chalk.dim(`Detected skill: ${allDetected[0].name}`));
    } else {
      // Interactive selection for collections
      console.log(chalk.dim(`Found ${allDetected.length} skills:\n`));

      const { chosen } = await inquirer.prompt([{
        type: 'checkbox',
        name: 'chosen',
        message: 'Select skills to install:',
        choices: allDetected.map(s => ({
          name: `${s.name}${s.description ? chalk.dim(` — ${s.description}`) : ''}`,
          value: s.name,
          checked: true,
        })),
        validate: (input: string[]) => input.length > 0 || 'Select at least one skill.',
      }]);

      selectedSkills = allDetected.filter(s => chosen.includes(s.name));
    }

    // 5. Check for conflicts with built-in skills
    const builtInSkills = await getAvailableSkills();
    for (const skill of selectedSkills) {
      if (builtInSkills.includes(skill.name)) {
        console.log(chalk.red(`Skill "${skill.name}" conflicts with a built-in skill. Skipping.`));
        selectedSkills = selectedSkills.filter(s => s.name !== skill.name);
      }
    }

    if (selectedSkills.length === 0) {
      console.log(chalk.yellow('No skills to install.'));
      return;
    }

    // 6. Resolve commit hash for versioning
    const version = await resolveCommitHash(parsed);

    // 7. Install for each agent
    console.log('');
    for (const agent of config.agents) {
      const agentConfig = getAgentConfig(agent.id);

      for (const skill of selectedSkills) {
        // Check if already installed — update it
        const existingIdx = agent.remoteSkills.findIndex(r => r.name === skill.name);

        await installRemoteSkill({
          skillDir: skill.dirPath,
          skillName: skill.name,
          projectDir,
          agentId: agent.id,
        });

        const remoteEntry: RemoteSkill = {
          name: skill.name,
          source: `github:${parsed.owner}/${parsed.repo}`,
          path: skill.relativePath,
          ref: parsed.ref,
          version,
          installedAt: new Date().toISOString(),
        };

        if (existingIdx >= 0) {
          agent.remoteSkills[existingIdx] = remoteEntry;
        } else {
          agent.remoteSkills.push(remoteEntry);
        }
      }

      const names = selectedSkills.map(s => s.name).join(', ');
      console.log(chalk.green(`  ✓ [${agentConfig.displayName}] Installed: ${names}`));
    }

    // 8. Save config
    await saveConfig(projectDir, config);
    console.log(chalk.green('\n✓ Configuration saved'));

  } finally {
    await cleanupTemp(repoDir);
  }
}

// ─── skill remove ────────────────────────────────────────────

export async function skillRemoveCommand(name?: string): Promise<void> {
  const projectDir = process.cwd();

  console.log(chalk.bold.blue('\n🏭 AI Factory - Remove Remote Skill\n'));

  const config = await loadConfig(projectDir);
  if (!config || config.agents.length === 0) {
    console.log(chalk.red('Error: No .ai-factory.json found or no agents configured.'));
    process.exit(1);
  }

  // Collect all unique remote skill names across agents
  const allRemoteNames = new Set<string>();
  for (const agent of config.agents) {
    for (const rs of agent.remoteSkills) {
      allRemoteNames.add(rs.name);
    }
  }

  if (allRemoteNames.size === 0) {
    console.log(chalk.yellow('No remote skills installed.'));
    return;
  }

  // Determine which skills to remove
  let skillsToRemove: string[];

  if (name) {
    // Explicit name provided
    if (!allRemoteNames.has(name)) {
      console.log(chalk.yellow(`Remote skill "${name}" not found in any agent configuration.`));
      return;
    }
    skillsToRemove = [name];
  } else {
    // Interactive checkbox selection
    const { chosen } = await inquirer.prompt([{
      type: 'checkbox',
      name: 'chosen',
      message: 'Select remote skills to remove:',
      choices: Array.from(allRemoteNames).map(n => {
        const sample = config.agents.find(a => a.remoteSkills.some(r => r.name === n));
        const rs = sample?.remoteSkills.find(r => r.name === n);
        const source = rs ? chalk.dim(` (${rs.source})`) : '';
        return { name: `${n}${source}`, value: n };
      }),
      validate: (input: string[]) => input.length > 0 || 'Select at least one skill to remove.',
    }]);

    skillsToRemove = chosen;
  }

  // Remove selected skills from all agents
  const affectedAgents = new Set<string>();

  for (const skillName of skillsToRemove) {
    for (const agent of config.agents) {
      const agentConfig = getAgentConfig(agent.id);
      const idx = agent.remoteSkills.findIndex(r => r.name === skillName);

      if (idx >= 0) {
        const skillDir = path.join(projectDir, agentConfig.skillsDir, skillName);
        await removeDirectory(skillDir);

        agent.remoteSkills.splice(idx, 1);
        affectedAgents.add(agent.id);
        console.log(chalk.green(`  ✓ Removed "${skillName}" from ${agentConfig.displayName}`));
      }
    }
  }

  await saveConfig(projectDir, config);

  const skillLabel = skillsToRemove.length === 1 ? `"${skillsToRemove[0]}"` : `${skillsToRemove.length} skill(s)`;
  const agentLabel = affectedAgents.size === 1 ? '1 agent' : `${affectedAgents.size} agents`;
  console.log(chalk.green(`\n✓ Removed ${skillLabel} from ${agentLabel}`));
}

// ─── skill list ──────────────────────────────────────────────

export async function skillListCommand(): Promise<void> {
  const projectDir = process.cwd();

  const config = await loadConfig(projectDir);
  if (!config || config.agents.length === 0) {
    console.log(chalk.red('Error: No .ai-factory.json found or no agents configured.'));
    process.exit(1);
  }

  console.log(chalk.bold.blue('\n🏭 AI Factory - Installed Skills\n'));

  for (const agent of config.agents) {
    const agentConfig = getAgentConfig(agent.id);

    console.log(chalk.bold(`${agentConfig.displayName} (${agent.skillsDir}):`));

    // Built-in skills
    const baseSkills = agent.installedSkills.filter(s => !s.includes('/'));
    const customSkills = agent.installedSkills.filter(s => s.includes('/'));

    console.log(chalk.dim(`  Built-in: ${baseSkills.length} skills`));
    if (customSkills.length > 0) {
      console.log(chalk.dim(`  Custom: ${customSkills.join(', ')}`));
    }

    // Remote skills
    if (agent.remoteSkills.length > 0) {
      console.log(chalk.cyan('  Remote:'));
      for (const rs of agent.remoteSkills) {
        const age = timeSince(rs.installedAt);
        console.log(chalk.dim(`    ${rs.name}  ${rs.source}  ${rs.version}  ${age}`));
      }
    } else {
      console.log(chalk.dim('  Remote: none'));
    }
    console.log('');
  }
}

function timeSince(isoDate: string): string {
  const diff = Date.now() - new Date(isoDate).getTime();
  const days = Math.floor(diff / 86400000);
  if (days === 0) return 'today';
  if (days === 1) return '1 day ago';
  if (days < 30) return `${days} days ago`;
  const months = Math.floor(days / 30);
  return months === 1 ? '1 month ago' : `${months} months ago`;
}

// ─── skill update ────────────────────────────────────────────

export async function skillUpdateCommand(name?: string): Promise<void> {
  const projectDir = process.cwd();

  console.log(chalk.bold.blue('\n🏭 AI Factory - Update Remote Skills\n'));

  const config = await loadConfig(projectDir);
  if (!config || config.agents.length === 0) {
    console.log(chalk.red('Error: No .ai-factory.json found or no agents configured.'));
    process.exit(1);
  }

  // Collect unique sources across all agents
  interface SourceGroup {
    source: string;
    ref: string;
    owner: string;
    repo: string;
    skills: Array<{ agentIdx: number; remoteIdx: number; skillPath: string; skillName: string }>;
    currentVersion: string;
  }

  const sourceGroups = new Map<string, SourceGroup>();

  for (let ai = 0; ai < config.agents.length; ai++) {
    const agent = config.agents[ai];
    for (let ri = 0; ri < agent.remoteSkills.length; ri++) {
      const rs = agent.remoteSkills[ri];

      // Filter by name if specified
      if (name && rs.name !== name) continue;

      const key = `${rs.source}#${rs.ref}`;
      if (!sourceGroups.has(key)) {
        const parsed = parseRemoteSource(rs.source + (rs.ref !== 'main' ? `#${rs.ref}` : ''));
        sourceGroups.set(key, {
          source: rs.source,
          ref: rs.ref,
          owner: parsed.owner,
          repo: parsed.repo,
          skills: [],
          currentVersion: rs.version,
        });
      }
      sourceGroups.get(key)!.skills.push({
        agentIdx: ai,
        remoteIdx: ri,
        skillPath: rs.path,
        skillName: rs.name,
      });
    }
  }

  if (sourceGroups.size === 0) {
    if (name) {
      console.log(chalk.yellow(`Remote skill "${name}" not found.`));
    } else {
      console.log(chalk.yellow('No remote skills installed.'));
    }
    return;
  }

  let updatedCount = 0;
  let upToDateCount = 0;

  for (const [, group] of sourceGroups) {
    const source: { host: 'github'; owner: string; repo: string; ref: string } = {
      host: 'github',
      owner: group.owner,
      repo: group.repo,
      ref: group.ref,
    };

    // Check for new version
    const latestVersion = await resolveCommitHash(source);

    if (latestVersion === group.currentVersion) {
      for (const s of group.skills) {
        console.log(chalk.dim(`  ${s.skillName}: already up to date (${group.currentVersion})`));
        upToDateCount++;
      }
      continue;
    }

    // Download and reinstall
    console.log(chalk.dim(`  Downloading ${group.owner}/${group.repo}...`));
    let repoDir: string;
    try {
      repoDir = await downloadAndExtract(source);
    } catch (error) {
      console.log(chalk.red(`  Failed to download ${group.source}: ${(error as Error).message}`));
      continue;
    }

    try {
      const allDetected = await detectSkills(repoDir);

      for (const s of group.skills) {
        const detected = allDetected.find(d =>
          d.name === s.skillName || d.relativePath === s.skillPath
        );

        if (!detected) {
          console.log(chalk.yellow(`  ${s.skillName}: not found in updated repo, skipping`));
          continue;
        }

        const agent = config.agents[s.agentIdx];

        await installRemoteSkill({
          skillDir: detected.dirPath,
          skillName: s.skillName,
          projectDir,
          agentId: agent.id,
        });

        agent.remoteSkills[s.remoteIdx].version = latestVersion;
        agent.remoteSkills[s.remoteIdx].installedAt = new Date().toISOString();

        console.log(chalk.green(`  ✓ ${s.skillName}: updated ${group.currentVersion} → ${latestVersion}`));
        updatedCount++;
      }
    } finally {
      await cleanupTemp(repoDir);
    }
  }

  await saveConfig(projectDir, config);

  console.log('');
  if (updatedCount > 0) {
    console.log(chalk.green(`✓ Updated ${updatedCount} skill(s)`));
  }
  if (upToDateCount > 0) {
    console.log(chalk.dim(`${upToDateCount} skill(s) already up to date`));
  }
}
