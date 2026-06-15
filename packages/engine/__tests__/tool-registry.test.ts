import { describe, it, expect } from 'vitest';
import { ToolRegistry } from '../src/tools/registry.js';

describe('ToolRegistry', () => {
  function createRegistry() {
    const registry = new ToolRegistry();
    registry.register({
      name: 'read_file',
      description: '读取文件',
      parameters: {
        type: 'object',
        properties: { path: { type: 'string', description: '文件路径' } },
        required: ['path'],
        additionalProperties: false,
      },
      requiresApproval: false,
      capabilities: ['read_code'],
      handler: async (args) => `读取: ${String(args.path)}`,
    });

    registry.register({
      name: 'modify_file',
      description: '修改文件',
      parameters: {
        type: 'object',
        properties: { path: { type: 'string', description: '文件路径' } },
        required: ['path'],
        additionalProperties: false,
      },
      requiresApproval: true,
      capabilities: ['write_code'],
      handler: async () => '修改成功',
    });

    return registry;
  }

  it('应正确注册和查找工具', () => {
    const registry = createRegistry();
    expect(registry.get('read_file')).toBeDefined();
    expect(registry.get('nonexistent')).toBeUndefined();
  });

  it('应正确列出所有工具', () => {
    const registry = createRegistry();
    const all = registry.listAll();
    expect(all).toHaveLength(2);
    expect(all.map(t => t.name).sort()).toEqual(['modify_file', 'read_file']);
  });

  it('应正确列出所有工具名', () => {
    const registry = createRegistry();
    expect(registry.listNames()).toContain('read_file');
    expect(registry.listNames()).toContain('modify_file');
  });

  it('应正确分发工具调用', async () => {
    const registry = createRegistry();
    const result = await registry.dispatch('read_file', { path: 'test.ts' });
    expect(result).toContain('读取: test.ts');
  });

  it('未知工具应返回错误提示', async () => {
    const registry = createRegistry();
    const result = await registry.dispatch('unknown_tool', {});
    expect(result).toContain('Unknown tool');
    expect(result).toContain('read_file');
    expect(result).toContain('modify_file');
  });

  it('重复注册应抛异常', () => {
    const registry = createRegistry();
    expect(() => registry.register({
      name: 'read_file',
      description: '重复',
      parameters: { type: 'object', properties: {}, additionalProperties: false },
      requiresApproval: false,
      capabilities: [],
      handler: async () => '',
    })).toThrow('already registered');
  });
});
