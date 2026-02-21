import { Command } from 'commander';
import { initCommand } from './commands/init.js';
import { updateCommand } from './commands/update.js';
import { upgradeCommand } from './commands/upgrade.js';
import { skillAddCommand, skillRemoveCommand, skillListCommand, skillUpdateCommand } from './commands/skill.js';
import { getCurrentVersion } from '../core/config.js';

const program = new Command();

program
  .name('ai-factory')
  .description('CLI tool for automating AI agent context setup')
  .version(getCurrentVersion());

program
  .command('init')
  .description('Initialize ai-factory in current project')
  .action(initCommand);

program
  .command('update')
  .description('Update installed skills to latest version')
  .action(updateCommand);

program
  .command('upgrade')
  .description('Upgrade from v1 to v2 (removes old-format skills, installs new)')
  .action(upgradeCommand);

const skill = program
  .command('skill')
  .description('Manage remote skills');

skill
  .command('add')
  .argument('<source>', 'Skill source (e.g. github:owner/repo)')
  .description('Install a remote skill')
  .action(skillAddCommand);

skill
  .command('remove')
  .argument('[name]', 'Skill name to remove (interactive if omitted)')
  .description('Remove a remote skill')
  .action(skillRemoveCommand);

skill
  .command('list')
  .description('List installed skills')
  .action(skillListCommand);

skill
  .command('update')
  .argument('[name]', 'Skill name to update (all if omitted)')
  .description('Update remote skills')
  .action(skillUpdateCommand);

program.parse();
