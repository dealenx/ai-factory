import chalk from 'chalk';
import path from 'path';
import { loadConfig, saveConfig } from '../../core/config.js';
import {
  installExtension,
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
import { installExtensionSkills, removeExtensionSkills } from '../../core/installer.js';
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

    const manifest = await installExtension(projectDir, source);

    // Strip old injections by manifest.name (handles upgrade from any source)
    const existingIndex = extensions.findIndex(e => e.name === manifest.name);
    if (existingIndex >= 0) {
      for (const agent of config.agents) {
        await stripInjectionsByExtensionName(projectDir, agent, manifest.name);
      }
    }

    // Register in config
    const record = { name: manifest.name, source, version: manifest.version };

    if (existingIndex >= 0) {
      extensions[existingIndex] = record;
    } else {
      extensions.push(record);
    }
    config.extensions = extensions;
    await saveConfig(projectDir, config);

    console.log(chalk.green(`✓ Extension "${manifest.name}" v${manifest.version} installed`));

    // Install extension skills for all agents
    if (manifest.skills?.length) {
      const extensionDir = path.join(getExtensionsDir(projectDir), manifest.name);
      for (const agent of config.agents) {
        const installed = await installExtensionSkills(projectDir, agent, extensionDir, manifest.skills);
        if (installed.length > 0) {
          console.log(chalk.green(`✓ Skills installed for ${agent.id}: ${installed.join(', ')}`));
        }
      }
    }

    // Apply injections for all agents
    if (manifest.injections?.length) {
      const extensionDir = path.join(getExtensionsDir(projectDir), manifest.name);
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
      const extensionDir = path.join(getExtensionsDir(projectDir), manifest.name);
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

    // Remove extension skills
    if (manifest?.skills?.length) {
      for (const agent of config.agents) {
        const removed = await removeExtensionSkills(projectDir, agent, manifest.skills);
        if (removed.length > 0) {
          console.log(chalk.green(`✓ Skills removed for ${agent.id}: ${removed.join(', ')}`));
        }
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
