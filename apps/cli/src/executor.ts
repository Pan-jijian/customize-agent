import { DeepSeekProvider } from '@code-agent/llm-provider';
import { ToolKit } from '@code-agent/tool-kit';
import { StorageManager } from '@code-agent/context-engine';
import { Message } from '@code-agent/shared';
import { AUTONOMOUS_SYSTEM_PROMPT } from './prompt.js';

export class AgentExecutor {
  private provider: DeepSeekProvider;
  private toolkit: ToolKit;
  private dbManager: StorageManager;
  private maxLoops = 8; // 防止死循环暴走设置的熔断阈值

  constructor(provider: DeepSeekProvider, toolkit: ToolKit, dbManager: StorageManager) {
    this.provider = provider;
    this.toolkit = toolkit;
    this.dbManager = dbManager;
  }

  /**
   * 启动自治循环，直到任务成功或触发熔断
   */
  async runTask(userRequirement: string) {
    const history: Message[] = [
      { role: 'system', content: AUTONOMOUS_SYSTEM_PROMPT },
      { role: 'user', content: `请帮我完成以下任务：${userRequirement}` }
    ];

    console.log(`\n🤖 [Agent 核心激活] 收到初始任务: "${userRequirement}"`);
    console.log(`--------------------------------------------------`);

    for (let i = 1; i <= this.maxLoops; i++) {
      console.log(`\n🔄 [第 ${i}/${this.maxLoops} 轮多轮迭代循环]`);
      process.stdout.write('Thinking...');

      // 1. 呼叫大模型做出决策
      const response = await this.provider.chat(history);
      process.stdout.write('\r'); // 清除 Thinking...
      
      console.log(`\n💡 Agent 思考与应答:\n${response.content}\n`);
      history.push({ role: 'assistant', content: response.content });

      // 2. 检查任务是否宣布终结
      if (response.content.includes('<task_finish>')) {
        console.log('🎉 ====== [任务宣告圆满完成！] ======');
        break;
      }

      // 3. 解析并分发工具调用
      let observation = '';
      try {
        observation = await this.dispatchTool(response.content);
      } catch (err) {
        observation = `[工具执行异常报错]: ${(err as Error).message}`;
      }

      console.log(`\n🧐 [系统执行反馈 Observation]:`);
      console.log(`\x1b[33m${observation}\x1b[0m\n`);

      // 4. 将工具的执行结果当作下一轮的上下文灌回给大模型
      history.push({ role: 'user', content: `[Observation]:\n${observation}` });

      if (i === this.maxLoops) {
        console.log('🚨 [警告] 达到了最大迭代次数限制，Agent 自动熔断退出。');
      }
    }
  }

  /**
   * 解析大模型输出的自定义 XML 标签并调用对应的方法
   */
  private async dispatchTool(text: string): Promise<string> {
    // 匹配 <call_tool name="...">...</call_tool>
    const toolRegex = /<call_tool\s+name="([^"]+)"(?:\s+path="([^"]+)")?>([\s\S]*?)<\/call_tool>/;
    const match = text.match(toolRegex);

    if (!match) {
      return '系统提示：你这一轮没有输出任何有效的 <call_tool> 标签。如果你已经做完了，请输出 <task_finish>；如果没做完，请必须输出一个工具调用块！';
    }

    const [_, toolName, filePathAttribute, toolBody] = match;
    const bodyContent = toolBody.trim();

    console.log(`🛠️ [系统动作] 正在自动执行工具: \x1b[36m${toolName}\x1b[0m ...`);

    switch (toolName) {
      case 'search_symbol':
        const symbols = this.dbManager.searchSymbol(bodyContent);
        if (symbols.length === 0) return `未在全仓查找到符号 "${bodyContent}"`;
        return JSON.stringify(symbols, null, 2);

      case 'read_file':
        return await this.toolkit.readFile(bodyContent);

      case 'modify_file':
        if (!filePathAttribute) throw new Error('使用 modify_file 工具必须显式指定 path="..." 属性！');
        const modifyRes = await this.toolkit.modifyFileWithDiff(filePathAttribute, bodyContent);
        return `${modifyRes.preview}。请立刻运行终端编译命令（如 pnpm build）来验证修改是否正确。`;

      case 'execute_command':
        const execRes = await this.toolkit.terminal.executeCommand(bodyContent);
        return `[Exit Code]: ${execRes.code}\n[Stdout]:\n${execRes.stdout}\n[Stderr]:\n${execRes.stderr}`;

      default:
        return `未知的工具名称: "${toolName}"`;
    }
  }
}