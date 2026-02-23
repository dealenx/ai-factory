import chalk from 'chalk';
import path from 'path';
import { loadConfig, saveConfig } from '../../core/config.js';
import {
  resolveExtension,
  commitExtensionInstall,
  removeExtensionFiles,
  getExtensionsDir,
  loadExtensionManifest,
  type ExtensionManifest,
} from '../../core/extensions.js';
import {
  applySingleExtensionInjections,
  stripAllExtensionInjections,
  stripInjectionsByExtensionName,
} from '../../core/injections.js';
import { configureExtensionMcpServers, removeExtensionMcpServers } from '../../core/mcp.js';
import { installExtensionSkills, removeExtensionSkills, installSkills, getAvailableSkills } from '../../core/installer.js';
import { readJsonFile } from '../../utils/fs.js';
import { getAgentConfig } from '../../core/agents.js';

export async function extensionAddCommand(source: string): Promise<void> {
  const projectDir = process.cwd();

  console.log(chalk.bold.blue('\n🏭 AI Factory - Install Extension\n'));

  const config = await loadConfig(projectDir);
  if (!config) {
    console.log(chalk.red('Error: No .ai-factory.json found.'));
    console.log(chalk.dim('Run "ai-factory init" to set up your project first.'));
    process.exit(1);
  }

  console.log(chalk.dim(`Installing from: ${source}\n`));

  try {
    const extensions = config.extensions ?? [];

    // Phase 1: Resolve source — download/clone and validate manifest WITHOUT writing to project
    const resolved = await resolveExtension(projectDir, source);
    const manifest = resolved.manifest;

    try {
      const existIdx = extensions.findIndex(e => e.name === manifest.name);
      const oldRecord = existIdx >= 0 ? { ...extensions[existIdx] } : null;

      // Load old manifest from installed dir (still intact — we haven't overwritten yet)
      const oldManifest = existIdx >= 0
        ? await loadExtensionManifest(path.join(getExtensionsDir(projectDir), manifest.name))
        : null;

      // Block conflicting replacements BEFORE copying any files
      if (manifest.replaces) {
        for (const [, baseSkillName] of Object.entries(manifest.replaces)) {
          for (const other of extensions) {
            if (other.name === manifest.name) continue;
            if (other.replacedSkills?.includes(baseSkillName)) {
              throw new Error(`Conflict: skill "${baseSkillName}" is already replaced by extension "${other.name}". Remove it first.`);
            }
          }
        }
      }

      // Phase 2: Commit — copy resolved files to .ai-factory/extensions/<name>/
      await commitExtensionInstall(projectDir, resolved);

    // Clean up old state on re-install
    if (existIdx >= 0) {
      for (const agent of config.agents) {
        await stripInjectionsByExtensionName(projectDir, agent, manifest.name);
      }

      // Remove old replacement skills (installed under base names)
      if (oldRecord?.replacedSkills?.length) {
        for (const agent of config.agents) {
          await removeExtensionSkills(projectDir, agent, oldRecord.replacedSkills);
        }
        const available = await getAvailableSkills();
        const toRestore = oldRecord.replacedSkills.filter(s => available.includes(s));
        if (toRestore.length > 0) {
          for (const agent of config.agents) {
            await installSkills({ projectDir, skillsDir: agent.skillsDir, skills: toRestore, agentId: agent.id });
          }
        }
      }

      // Remove old extension custom skills using the OLD manifest (not the new one)
      if (oldManifest?.skills?.length) {
        const oldReplacesPaths = new Set(Object.keys(oldManifest.replaces ?? {}));
        const oldCustomSkills = oldManifest.skills.filter(s => !oldReplacesPaths.has(s));
        if (oldCustomSkills.length > 0) {
          for (const agent of config.agents) {
            await removeExtensionSkills(projectDir, agent, oldCustomSkills);
          }
        }
      }
    }

    console.log(chalk.green(`✓ Extension "${manifest.name}" v${manifest.version} installed`));

    const extensionDir = path.join(getExtensionsDir(projectDir), manifest.name);

    // Install replacement skills — only track successfully installed ones
    const replacedSkills: string[] = [];
    const replacesPaths = new Set<string>();
    if (manifest.replaces && Object.keys(manifest.replaces).length > 0) {
      const nameOverrides: Record<string, string> = { ...manifest.replaces };
      const replacePaths = Object.keys(manifest.replaces);

      // Track per-agent success: only count as replaced if installed on ALL agents
      const perAgentResults = new Map<string, number>(); // baseName → success count
      for (const agent of config.agents) {
        const installed = await installExtensionSkills(projectDir, agent, extensionDir, replacePaths, nameOverrides);
        for (const name of installed) {
          perAgentResults.set(name, (perAgentResults.get(name) ?? 0) + 1);
        }
      }

      const agentCount = config.agents.length;
      for (const [extSkillPath, baseSkillName] of Object.entries(manifest.replaces)) {
        replacesPaths.add(extSkillPath);
        const successCount = perAgentResults.get(baseSkillName) ?? 0;
        if (successCount === agentCount) {
          replacedSkills.push(baseSkillName);
          console.log(chalk.green(`✓ Replaced skill "${baseSkillName}" with "${path.basename(extSkillPath)}"`));
        } else if (successCount > 0) {
          // Rollback: remove the replacement from agents where it did install, restore base skill
          for (const agent of config.agents) {
            await removeExtensionSkills(projectDir, agent, [baseSkillName]);
          }
          const available = await getAvailableSkills();
          if (available.includes(baseSkillName)) {
            for (const agent of config.agents) {
              await installSkills({ projectDir, skillsDir: agent.skillsDir, skills: [baseSkillName], agentId: agent.id });
            }
          }
          console.log(chalk.yellow(`⚠ Replacement "${baseSkillName}" only installed on ${successCount}/${agentCount} agents — rolled back, base skill restored`));
        } else {
          console.log(chalk.yellow(`⚠ Failed to replace skill "${baseSkillName}" — base skill preserved`));
        }
      }
    }

    // Install extension custom skills (excluding replacements)
    if (manifest.skills?.length) {
      const nonReplacementSkills = manifest.skills.filter(s => !replacesPaths.has(s));
      if (nonReplacementSkills.length > 0) {
        for (const agent of config.agents) {
          const installed = await installExtensionSkills(projectDir, agent, extensionDir, nonReplacementSkills);
          if (installed.length > 0) {
            console.log(chalk.green(`✓ Skills installed for ${agent.id}: ${installed.join(', ')}`));
          }
        }
      }
    }

    // Save config AFTER all installations succeed
    const record = { name: manifest.name, source, version: manifest.version, replacedSkills: replacedSkills.length > 0 ? replacedSkills : undefined };
    if (existIdx >= 0) {
      extensions[existIdx] = record;
    } else {
      extensions.push(record);
    }
    config.extensions = extensions;
    await saveConfig(projectDir, config);

    // Apply injections for all agents
    if (manifest.injections?.length) {
      let totalInjections = 0;

      for (const agent of config.agents) {
        const count = await applySingleExtensionInjections(projectDir, agent, extensionDir, manifest);
        totalInjections += count;
      }

      if (totalInjections > 0) {
        console.log(chalk.green(`✓ Applied ${totalInjections} injection(s)`));
      }
    }

    // Configure MCP servers for all agents that support it
    if (manifest.mcpServers?.length) {
      const mcpConfigured = await applyExtensionMcp(projectDir, config.agents.map(a => a.id), extensionDir, manifest);
      if (mcpConfigured.length > 0) {
        console.log(chalk.green(`✓ MCP servers configured: ${mcpConfigured.join(', ')}`));
        for (const srv of manifest.mcpServers) {
          if (srv.instruction) {
            console.log(chalk.dim(`    ${srv.instruction}`));
          }
        }
      }
    }

    if (manifest.agents?.length) {
      console.log(chalk.dim(`  Agents provided: ${manifest.agents.map(a => a.displayName).join(', ')}`));
    }
    if (manifest.commands?.length) {
      console.log(chalk.dim(`  Commands provided: ${manifest.commands.map(c => c.name).join(', ')}`));
    }
    if (manifest.skills?.length) {
      console.log(chalk.dim(`  Skills provided: ${manifest.skills.join(', ')}`));
    }

    console.log('');
    } finally {
      await resolved.cleanup();
    }
  } catch (error) {
    console.log(chalk.red(`Error installing extension: ${(error as Error).message}`));
    process.exit(1);
  }
}

export async function extensionRemoveCommand(name: string): Promise<void> {
  const projectDir = process.cwd();

  console.log(chalk.bold.blue('\n🏭 AI Factory - Remove Extension\n'));

  const config = await loadConfig(projectDir);
  if (!config) {
    console.log(chalk.red('Error: No .ai-factory.json found.'));
    process.exit(1);
  }

  const extensions = config.extensions ?? [];
  const index = extensions.findIndex(e => e.name === name);

  if (index < 0) {
    console.log(chalk.red(`Extension "${name}" is not installed.`));
    process.exit(1);
  }

  try {
    // Strip injections before removing files
    const extensionDir = path.join(getExtensionsDir(projectDir), name);
    const manifest = await loadExtensionManifest(extensionDir);

    for (const agent of config.agents) {
      if (manifest) {
        await stripAllExtensionInjections(projectDir, agent, name, manifest);
      } else {
        // Manifest missing/broken — scan skill files for markers
        await stripInjectionsByExtensionName(projectDir, agent, name);
      }
    }

    // Fix 6: Remove replacement skills independently from manifest.skills
    // Replacements are installed under the base skill name, so remove by base name
    const extRecord = extensions[index];
    if (extRecord.replacedSkills?.length) {
      for (const agent of config.agents) {
        const removed = await removeExtensionSkills(projectDir, agent, extRecord.replacedSkills);
        if (removed.length > 0) {
          console.log(chalk.green(`✓ Replacement skills removed for ${agent.id}: ${removed.join(', ')}`));
        }
      }
    }

    // Remove extension custom skills
    if (manifest?.skills?.length) {
      const replacesPaths = new Set(Object.keys(manifest.replaces ?? {}));
      const customSkillPaths = manifest.skills.filter(s => !replacesPaths.has(s));
      if (customSkillPaths.length > 0) {
        for (const agent of config.agents) {
          const removed = await removeExtensionSkills(projectDir, agent, customSkillPaths);
          if (removed.length > 0) {
            console.log(chalk.green(`✓ Skills removed for ${agent.id}: ${removed.join(', ')}`));
          }
        }
      }
    }

    // Fix 4: Only restore base skills if no other extension replaces them
    if (extRecord.replacedSkills?.length) {
      const otherExtensions = extensions.filter((_, i) => i !== index);
      const stillReplaced = new Set<string>();
      for (const other of otherExtensions) {
        if (other.replacedSkills?.length) {
          for (const s of other.replacedSkills) stillReplaced.add(s);
        }
      }

      const available = await getAvailableSkills();
      const toRestore = extRecord.replacedSkills.filter(s => available.includes(s) && !stillReplaced.has(s));
      if (toRestore.length > 0) {
        for (const agent of config.agents) {
          await installSkills({
            projectDir,
            skillsDir: agent.skillsDir,
            skills: toRestore,
            agentId: agent.id,
          });
        }
        console.log(chalk.green(`✓ Restored base skills: ${toRestore.join(', ')}`));
      }
    }

    // Remove MCP servers
    if (manifest?.mcpServers?.length) {
      const mcpKeys = manifest.mcpServers.map(s => s.key);
      for (const agent of config.agents) {
        await removeExtensionMcpServers(projectDir, agent.id, mcpKeys);
      }
    }

    await removeExtensionFiles(projectDir, name);

    extensions.splice(index, 1);
    config.extensions = extensions;
    await saveConfig(projectDir, config);

    console.log(chalk.green(`✓ Extension "${name}" removed`));
    console.log('');
  } catch (error) {
    console.log(chalk.red(`Error removing extension: ${(error as Error).message}`));
    process.exit(1);
  }
}

export async function extensionListCommand(): Promise<void> {
  const projectDir = process.cwd();

  const config = await loadConfig(projectDir);
  if (!config) {
    console.log(chalk.red('Error: No .ai-factory.json found.'));
    process.exit(1);
  }

  const extensions = config.extensions ?? [];

  if (extensions.length === 0) {
    console.log(chalk.dim('\nNo extensions installed.\n'));
    return;
  }

  console.log(chalk.bold('\nInstalled extensions:\n'));

  for (const ext of extensions) {
    console.log(`  ${chalk.bold(ext.name)} ${chalk.dim(`v${ext.version}`)}`);
    console.log(chalk.dim(`    Source: ${ext.source}`));

    const extensionDir = path.join(getExtensionsDir(projectDir), ext.name);
    const manifest = await loadExtensionManifest(extensionDir);
    if (manifest) {
      if (manifest.description) {
        console.log(chalk.dim(`    ${manifest.description}`));
      }
      const features: string[] = [];
      if (manifest.commands?.length) features.push(`${manifest.commands.length} command(s)`);
      if (manifest.agents?.length) features.push(`${manifest.agents.length} agent(s)`);
      if (manifest.injections?.length) features.push(`${manifest.injections.length} injection(s)`);
      if (manifest.skills?.length) features.push(`${manifest.skills.length} skill(s)`);
      if (manifest.mcpServers?.length) features.push(`${manifest.mcpServers.length} MCP server(s)`);
      if (features.length > 0) {
        console.log(chalk.dim(`    Provides: ${features.join(', ')}`));
      }
    }
  }
  console.log('');
}

interface McpServerConfig {
  command: string;
  args?: string[];
  env?: Record<string, string>;
}

async function applyExtensionMcp(
  projectDir: string,
  agentIds: string[],
  extensionDir: string,
  manifest: ExtensionManifest,
): Promise<string[]> {
  if (!manifest.mcpServers?.length) return [];

  const allConfigured: string[] = [];

  for (const srv of manifest.mcpServers) {
    const templatePath = path.join(extensionDir, srv.template);
    const template = await readJsonFile<McpServerConfig>(templatePath);
    if (!template) continue;

    for (const agentId of agentIds) {
      const agentConfig = getAgentConfig(agentId);
      if (!agentConfig.supportsMcp) continue;

      const configured = await configureExtensionMcpServers(projectDir, agentId, [
        { key: srv.key, template },
      ]);
      if (configured.length > 0 && !allConfigured.includes(srv.key)) {
        allConfigured.push(srv.key);
      }
    }
  }

  return allConfigured;
}
