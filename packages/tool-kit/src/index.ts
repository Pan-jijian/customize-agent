import * as fs from 'fs/promises';
import * as path from 'path';
import { DiffEngine } from '@code-agent/diff-engine';
import { TerminalTool } from './terminal';
import { GitTool } from './git';
export class ToolKit {
  private cwd: string;
  public terminal: TerminalTool;
  public git: GitTool;
  constructor(cwd: string = process.cwd()) {
    this.cwd = cwd;
    this.terminal = new TerminalTool(cwd);
    this.git = new GitTool(cwd);
  }

  /**
   * 工具 列出当前目录下的文件
   */
  async listFiles(): Promise<string[]> {
    const entries = await fs.readdir(this.cwd, { withFileTypes: true });
    return entries.flatMap(entry => {
      if (entry.name.startsWith('.') || entry.name === 'node_modules') {
        return [];
      }
      const prefix = entry.isDirectory() ? '[DIR]' : '[FILE]';
      return [`${prefix} ${entry.name}`];
    });
  }

  /**
   * 工具 读取指定文件内容
   */
  async readFile(relativeFilePath:string):Promise<string>{
    const fullPath = path.resolve(this.cwd,relativeFilePath);
    try {
      return await fs.readFile(fullPath, 'utf-8');
    } catch (error) {
     throw new Error(`无法读取文件 ${relativeFilePath}: ${(error as Error).message}`); 
    }
  }

  /**
   * 工具，通过 search/replace 协议修改文件
   * 返回修改前后的对比预览
   */
  async modifyFileWithDiff(relativeFilePath:string,llmDiffOutput:string):Promise<{success:boolean,preview:string}>{
    const fullPath = path.resolve(this.cwd,relativeFilePath);
    const originalContent = await this.readFile(relativeFilePath);
    const blocks = DiffEngine.parseBlocks(llmDiffOutput);
    if(blocks.length === 0){
      throw new Error('没有找到任何修改块');
    }
    let newContent = originalContent;
    for(const block of blocks){
      newContent = DiffEngine.applyPatch(newContent,block);
    }
    //写入新内容
    await fs.writeFile(fullPath,newContent,'utf-8');
    return {
      success: true,
      preview: `文件 ${relativeFilePath} 修改成功！\n[改动块数量]: ${blocks.length}`
    }
  }
}