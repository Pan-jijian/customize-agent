import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';

/** Skill Frontmatter */
interface SkillMetadata {
  name: string;
  description: string;
  /** 允许的工具列表 */
  tools?: string[];
  /** 关键词权重（用于匹配） */
  keywords?: string[];
}

/** 已加载的 Skill */
interface LoadedSkill {
  metadata: SkillMetadata;
  /** Skill 指令内容（Markdown body，注入 System Prompt） */
  content: string;
  /** 来源文件路径 */
  source: string;
}

/**
 * Skills 系统 — Markdown 格式的领域特定指令。
 *
 * 格式:
 *   ---
 *   name: fix-typo
 *   description: 修复拼写错误
 *   tools: read_file, modify_file, execute_command
 *   keywords: typo, 拼写, 错字, fix spelling
 *   ---
 *   ## 流程
 *   1. 使用 read_file 读取目标文件
 *   2. 识别拼写错误
 *   3. 使用 modify_file 修正
 *   4. 编译验证
 *
 * 存放位置:
 *   - .customize-agent/skills/  (项目级)
 *   - ~/.customize-agent/skills/ (用户级)
 */
export class SkillsLoader {
  private skills: LoadedSkill[] = [];

  /**
   * 从目录加载所有 .md Skill 文件。
   * 项目级覆盖用户级同名 Skill。
   */
  async loadFromDir(dir: string): Promise<void> {
    try {
      const entries = await fs.readdir(dir, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.isFile() && entry.name.endsWith('.md')) {
          const filePath = path.join(dir, entry.name);
          const skill = await this._parseSkillFile(filePath);
          if (skill) {
            // 项目级覆盖用户级
            const existing = this.skills.findIndex(s => s.metadata.name === skill.metadata.name);
            if (existing >= 0) {
              this.skills[existing] = skill;
            } else {
              this.skills.push(skill);
            }
          }
        }
      }
    } catch {
      // 目录不存在或无法读取
    }
  }

  /**
   * 加载所有 Skill 目录（项目级 → 用户级，前者覆盖后者）。
   */
  async loadAll(projectRoot: string): Promise<void> {
    // 先加载用户级
    await this.loadFromDir(path.join(os.homedir(), '.customize-agent', 'skills'));
    // 再加载项目级（覆盖同名 Skill）
    await this.loadFromDir(path.join(projectRoot, '.customize-agent', 'skills'));
  }

  /**
   * 根据任务描述匹配最合适的 Skill。
   * 匹配机制：任务词汇与 Skill description + keywords 做交集匹配。
   * 返回匹配度最高的 Skill 内容（用于注入 System Prompt）。
   */
  matchSkills(task: string, maxResults: number = 3): LoadedSkill[] {
    const taskLower = task.toLowerCase();
    const taskWords = new Set(
      taskLower
        .split(/[\s,，。.]+/)
        .filter(w => w.length > 1),
    );

    const scored = this.skills.map(skill => {
      const descLower = skill.metadata.description.toLowerCase();
      const keywords = (skill.metadata.keywords ?? []).map(k => k.toLowerCase());

      // 计算匹配分：description 命中 + keywords 命中
      let score = 0;
      for (const word of taskWords) {
        if (descLower.includes(word)) score += 2;
        for (const kw of keywords) {
          if (kw.includes(word) || word.includes(kw)) score += 3;
        }
      }

      return { skill, score };
    });

    return scored
      .filter(s => s.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, maxResults)
      .map(s => s.skill);
  }

  /**
   * 将匹配的 Skill 内容注入 System Prompt 前缀。
   */
  injectSkills(systemPrompt: string, task: string): string {
    const matched = this.matchSkills(task, 2);
    if (matched.length === 0) return systemPrompt;

    const skillTexts = matched.map(s =>
      `[Skill·${s.metadata.name}]:\n${s.content}`
    );

    return `${systemPrompt}\n\n--- 匹配的领域技能 ---\n${skillTexts.join('\n\n---\n\n')}\n--- 技能结束 ---`;
  }

  /** 列出所有已加载的 Skill */
  listSkills(): Array<{ name: string; description: string; source: string }> {
    return this.skills.map(s => ({
      name: s.metadata.name,
      description: s.metadata.description,
      source: s.source,
    }));
  }

  /** 解析单个 Skill 文件 */
  private async _parseSkillFile(filePath: string): Promise<LoadedSkill | null> {
    try {
      const content = await fs.readFile(filePath, 'utf-8');

      // 解析 frontmatter（YAML --- 块）
      const fmMatch = content.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
      if (!fmMatch) return null;

      const fmText = fmMatch[1] ?? '';
      const body = fmMatch[2] ?? '';

      // 简单 YAML 解析（仅支持 key: value 格式）
      const metadata: SkillMetadata = { name: '', description: '' };
      for (const line of fmText.split('\n')) {
        const colonIdx = line.indexOf(':');
        if (colonIdx < 0) continue;
        const key = line.slice(0, colonIdx).trim();
        const value = line.slice(colonIdx + 1).trim();

        if (key === 'tools') {
          metadata.tools = value.split(',').map(t => t.trim());
        } else if (key === 'keywords') {
          metadata.keywords = value.split(',').map(k => k.trim());
        } else {
          (metadata as unknown as Record<string, string>)[key] = value;
        }
      }

      if (!metadata.name) return null;

      return { metadata, content: body.trim(), source: filePath };
    } catch {
      return null;
    }
  }
}
