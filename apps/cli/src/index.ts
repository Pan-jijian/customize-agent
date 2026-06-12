import { Command } from 'commander';
import inquirer from 'inquirer';
import { DeepSeekProvider } from '@code-agent/llm-provider';
import { Message } from '@code-agent/shared';
import dotenv from 'dotenv';
import { ToolKit } from '@code-agent/tool-kit';
import * as glob from 'fast-glob'; // 如果没装可以用 fs 替代，这里用最稳妥的动态寻找
import { StorageManager, RepositoryIndexer } from '@code-agent/context-engine';
//加载环境变量
dotenv.config({ path: '../../.env' });

const program = new Command();
const dbManager = new StorageManager();
const indexer = new RepositoryIndexer(dbManager);


// 自动化全仓扫描函数
async function scanWorkspace() {
  process.stdout.write('🔍 正在构建本地源码语法图谱 (AST)...');
  // 扫描 apps 和 packages 下所有 ts 文件，排除编译产物
  const files = glob.globSync(['apps/**/*.ts', 'packages/**/*.ts'], {
    ignore: ['**/dist/**', '**/node_modules/**']
  });
  
  for (const file of files) {
    await indexer.indexFile(file);
  }
  console.log(` 成功！已建立 ${files.length} 个源码文件的关系索引。`);
}

// 托管当前运行 CLI 的目录
const toolKit = new ToolKit(process.cwd());

// 系统级提示词：确立 Agent 的工具使用规范
const SYSTEM_PROMPT = `你是一个拥有本地文件读写能力的工程 Code Agent。
当你需要修改代码时，你**必须且只能**输出以下格式的 SEARCH/REPLACE 块来通知系统执行：

<<<<<<< SEARCH
这里写当前文件中现有的、需要被替换的精准代码片段
=======
这里写你想替换成的新代码
>>>>>>> REPLACE

注意：SEARCH 块的代码必须与原文件一模一样。一次可以输出多个块。`;


program.name('code-agent')
  .description('A CLI tool for Code Agent')
  .version('0.0.1');

program.command('chat')
  .description('启动与DeepSeek v4的多轮代码对话交互')
  .action(async () => {
   // 启动时触发扫描
    await scanWorkspace();
    console.log('🚀 Code Agent v0.5 [本地上下文图谱增强版] 准备就绪！');

    const provider = new DeepSeekProvider();
    const history: Message[] = [
      { role: "system", content: "你是一个资深架构师 Agent,请简明扼要的回答问题" }
    ];

    while (true) {
      // 1. 让用户选择是直接聊天，还是让 Agent 执行某些文件操作
      const { actionType } = await inquirer.prompt([
        {
          type: 'select',
          name: 'actionType',
          message: '请选择操作',
          choices: [
            { name: '💬 提问 / 吩咐修改代码', value: 'chat' },
            { name: '📂 查看当前目录文件', value: 'list' },
            { name: '📄 查看具体文件内容', value: 'read' },
            { name: '💻 执行终端命令 (如 pnpm test/build)', value: 'terminal' },
            { name: '🌿 查看 Git 状态与 Diff', value: 'git_status' },
            { name: '🤖 叫 Agent 帮我提交代码 (Auto Commit)', value: 'git_commit' },
            { name: '🚪 退出', value: 'exit' }
          ]
        }
      ]);
      if (actionType === 'exit') {
        console.log('bye');
        break;
      }
      // 1. 处理终端命令执行
      if (actionType === 'terminal') {
        const { cmd } = await inquirer.prompt([{ type: 'input', name: 'cmd', message: '请输入要在项目根目录运行的命令:' }]);
        if (!cmd) continue;
        
        console.log(`正在安全执行: "${cmd}" ...`);
        const result = await toolKit.terminal.executeCommand(cmd);
        
        console.log(`\n--- 执行结果 [Exit Code: ${result.code}] ---`);
        if (result.stdout) console.log(`\x1b[32m${result.stdout}\x1b[0m`);
        if (result.stderr) console.log(`\x1b[31m${result.stderr}\x1b[0m`);
        console.log('----------------------------------------\n');
      }
      // 2. 查看 Git 状态
      if (actionType === 'git_status') {
        const status = await toolKit.git.getStatus();
        const diff = await toolKit.git.getDiff();
        console.log('\n--- Git 状态简述 ---');
        console.log(status);
        console.log('\n--- 详细 Diff 变更 ---');
        console.log(diff);
        console.log('---------------------\n');
      }

      // 3. 智能托管 Commit 提交
      if (actionType === 'git_commit') {
        const diff = await toolKit.git.getDiff();
        if (diff === '暂无代码级 Diff 变动') {
          console.log('😅 暂无任何改动需要提交。');
          continue;
        }

        console.log('正在让 DeepSeek V4 审阅你的代码变动并构思 Commit Message...');
        const prompt: Message[] = [
          { role: 'system', content: '你是一个严格遵守 Conventional Commits 规范的资深工程师。请根据用户提供的代码 diff，生成一行精简的 commit 信息（形如 fix(scope): description 或 feat(scope): description）。不要输出任何额外的废话、解释或 Markdown 标签，只输出那一行 commit 文本。' },
          { role: 'user', content: `这是我的代码改动 Diff：\n${diff}` }
        ];

        const aiResponse = await provider.chat(prompt);
        const commitMsg = aiResponse.content.trim();

        const { confirmCommit } = await inquirer.prompt([
          {
            type: 'confirm',
            name: 'confirmCommit',
            message: `🤖 Agent 生成的 Commit 信息为:\n   "\x1b[36m${commitMsg}\x1b[0m"\n 是否确认提交？`,
            default: true
          }
        ]);

        if (confirmCommit) {
          const summary = await toolKit.git.commitAll(commitMsg);
          console.log(`✨ ${summary}\n`);
        }
      }
      //处理：列出文件
      if (actionType === 'list') {
        const files = await toolKit.listFiles();
        console.log('\n--- 当前目录文件 ---');
        files.forEach((f: any) => {
          console.log(f);
        })
        continue;
      }
      //处理，读文件
      if (actionType === 'read') {
        const { filename } = await inquirer.prompt([{ type: 'input', name: 'filename', message: '请输入相对文件路径：' }])
        try {
          const content = await toolKit.readFile(filename);
          console.log(`\n--- 文件: ${filename} 开始 ---`);
          console.log(content);
          console.log(`--- 文件: ${filename} 结束 ---\n`);
          history.push({ role: 'system', content: `用户向你展示了文件 ${filename} 的内容如下：\n${content}` });
        } catch (e) {
          console.log(`❌ ${(e as Error).message}`);
        }
        continue;
      }
       //处理：对话与改写代码核心
       if(actionType === 'chat'){
        const { prompt } = await inquirer.prompt([{ type: 'input', name: 'prompt', message: '请输入你的问题：' }]);
        if(!prompt) continue;
        history.push({role:"user",content:prompt});
        console.log('Agent 正在思考并分析代码...');
        try {
          const response = await provider.chat(history);
          console.log(`\nAgent 应答:\n${response.content}\n`);
          // 核心检测：判断 DeepSeek 的回答里是否包含了代码修改申请 (SEARCH/REPLACE)
          if(response.content.includes('<<<<<<< SEARCH')){
            const { confirmModify } = await inquirer.prompt([
              {
                type:'confirm',
                name:'confirmModify',
                message:'🚨 检测到 Agent 提出了代码修改申请，是否允许它应用到本地文件？',
                default:false
              }
            ])
            if(confirmModify){
              const { targetFile } = await inquirer.prompt([{ type: 'input', name: 'targetFile', message: '请输入它想修改的目标文件相对路径:' }]);
              const result = await toolKit.modifyFileWithDiff(targetFile, response.content);
              console.log(`✅ ${result.preview}`);
            }else {
              console.log('❌ 用户拒绝了代码修改申请。');
            }
          }
          history.push({ role: 'assistant', content: response.content });
        } catch (error) {
          console.log(`❌ 执行失败: ${(error as Error).message}`);
        }
       }
    }
  });
// 如果没有提供命令，默认运行 chat
if (process.argv.length === 2) {
  program.parse(['node', 'dist/index.js', 'chat']);
} else {
  program.parse();
}