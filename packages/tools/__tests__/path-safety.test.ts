import { describe, it, expect } from 'vitest';
import { ToolKit } from '../src/index.js';
import * as path from 'path';

describe('ToolKit 路径安全', () => {
  const cwd = process.cwd();
  const toolkit = new ToolKit(cwd);

  it('正常路径应在项目目录内', async () => {
    const content = await toolkit.readFile('package.json');
    expect(content).toBeTruthy();
    expect(typeof content).toBe('string');
  });

  it('路径遍历攻击应被拦截', async () => {
    await expect(toolkit.readFile('../../../etc/passwd')).rejects.toThrow('Path traversal detected');
  });

  it('listFiles 应返回文件列表', async () => {
    const files = await toolkit.listFiles();
    expect(Array.isArray(files)).toBe(true);
    expect(files.length).toBeGreaterThan(0);
  });

  it('listFiles 应过滤隐藏目录', async () => {
    const files = await toolkit.listFiles();
    const hiddenFiles = files.filter(f => f.startsWith('[DIR] .') || f.startsWith('[FILE] .'));
    expect(hiddenFiles).toHaveLength(0);
  });
});
