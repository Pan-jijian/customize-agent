import { Command } from 'commander';
import inquirer from 'inquirer';
import dotenv from 'dotenv';
import { fileURLToPath } from 'url';
import { dirname, resolve } from 'path';
import { DeepSeekProvider } from '@code-agent/llm-provider';
import { ToolKit } from '@code-agent/tool-kit';
import { StorageManager, RepositoryIndexer } from '@code-agent/context-engine';
import { AgentExecutor } from './executor.js';
import glob from 'fast-glob';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const envPath = resolve(__dirname, '../../../.env');
dotenv.config({ path: envPath });

const program = new Command();
const dbManager = new StorageManager();
const indexer = new RepositoryIndexer(dbManager);
const toolkit = new ToolKit(process.cwd());
const provider = new DeepSeekProvider();

// 实例化我们的全自动核心
const executor = new AgentExecutor(provider, toolkit, dbManager);

async function scanWorkspace() {
  process.stdout.write('🔍 正在构建本地源码语法图谱 (AST)...');
  const files = glob.globSync(['apps/**/*.ts', 'packages/**/*.ts'], {
    ignore: ['**/dist/**', '**/node_modules/**']
  });
  for (const file of files) {
    await indexer.indexFile(file);
  }
  console.log(` 成功！(共索引 ${files.length} 个文件)`);
}

program
  .name('code-agent')
  .description('企业级开源 Code Agent v1.0 全自治版')
  .command('agent')
  .action(async () => {
    await scanWorkspace();
    console.log('🚀 Code Agent v1.0 [自治闭环模式] 启动成功！');

    while (true) {
      const { mode } = await inquirer.prompt([
        {
          type: 'select',
          name: 'mode',
          message: '请选择运行模式:',
          choices: [
            { name: '🤖 托管模式：丢给 Agent 一个任务让它自己去修去改', value: 'autonomous' },
            { name: '💻 手动模式：执行单个终端命令', value: 'terminal' },
            { name: '🚪 退出', value: 'exit' }
          ]
        }
      ]);

      if (mode === 'exit') break;

      if (mode === 'terminal') {
        const { cmd } = await inquirer.prompt([{ type: 'input', name: 'cmd', message: '输入命令:' }]);
        if (cmd) {
          const res = await toolkit.terminal.executeCommand(cmd);
          console.log(res.stdout || res.stderr);
        }
        continue;
      }

      if (mode === 'autonomous') {
        const { requirement } = await inquirer.prompt([
          { 
            type: 'input', 
            name: 'requirement', 
            message: '请输入你要吩咐给 Agent 的开发指令\n (例如: "修复 packages/diff-engine/src/index.ts 里的一个拼写错误并运行 pnpm build 确保编译通过"): ' 
          }
        ]);

        if (requirement) {
          await executor.runTask(requirement);
        }
      }
    }
  });

program.parse();