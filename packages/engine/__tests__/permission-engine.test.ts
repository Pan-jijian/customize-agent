import { describe, it, expect } from 'vitest';
import { PermissionEngine } from '../src/security/permissions.js';

describe('PermissionEngine', () => {
  const engine = new PermissionEngine();

  it('read_file 默认应 allow', () => {
    expect(engine.check('read_file')).toBe('allow');
  });

  it('modify_file 默认应 ask (需要用户确认)', () => {
    expect(engine.check('modify_file')).toBe('ask');
  });

  it('.env 文件读取应 deny', () => {
    expect(engine.check('read_file', { path: '.env' })).toBe('deny');
  });

  it('secrets 目录下文件读取应 deny', () => {
    expect(engine.check('read_file', { path: 'config/secrets/db.yaml' })).toBe('deny');
  });

  it('密钥文件读取应 deny', () => {
    expect(engine.check('read_file', { path: 'aws.key' })).toBe('deny');
  });

  it('rm -rf / 命令应 deny', () => {
    expect(engine.check('execute_command', { input: 'rm -rf /' })).toBe('deny');
  });

  it('mkfs 命令应 deny', () => {
    expect(engine.check('execute_command', { input: 'mkfs.ext4 /dev/sda' })).toBe('deny');
  });

  it('危险系统命令应 deny', () => {
    expect(engine.check('execute_command', { input: 'rm -rf /etc' })).toBe('deny');
  });

  it('已注册搜索工具应 allow', () => {
    expect(engine.check('search_symbol')).toBe('allow');
    expect(engine.check('web_search')).toBe('allow');
  });

  it('Git 操作默认应 allow（只读）或 ask（写）', () => {
    expect(engine.check('git_status')).toBe('allow');
    expect(engine.check('git_diff')).toBe('allow');
    expect(engine.check('git_commit')).toBe('ask');
  });

  it('未知工具默认应 ask', () => {
    expect(engine.check('unknown_tool')).toBe('ask');
  });

  it('合并外部配置后应生效', () => {
    const custom = new PermissionEngine();
    custom.mergeConfig({
      defaults: { modify_file: 'allow' },
    });
    expect(custom.check('modify_file')).toBe('allow');
  });

  it('角色限制应 deny 无权限的工具', () => {
    // explorer 只有 read_code, search_symbol, lsp_query, embedding_search
    expect(engine.check('modify_file', {}, 'explorer')).toBe('deny');
    expect(engine.check('execute_command', {}, 'explorer')).toBe('deny');
    expect(engine.check('read_file', {}, 'explorer')).toBe('allow');
  });
});
