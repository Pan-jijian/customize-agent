import { describe, it, expect } from 'vitest';
import { PermissionEngine } from '../src/security/permissions.js';

describe('PermissionEngine', () => {
  const engine = new PermissionEngine();

  it('read_file 默认应 allow', () => {
    expect(engine.check('read_file')).toBe('allow');
  });

  it('write_file 默认应 ask (需要用户确认)', () => {
    expect(engine.check('write_file')).toBe('ask');
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

  it('已注册读文件工具应 allow', () => {
    expect(engine.check('read_file')).toBe('allow');
  });

  it('Git 操作默认应 ask', () => {
    expect(engine.check('git_commit')).toBe('ask');
  });

  it('未知工具默认应 ask', () => {
    expect(engine.check('unknown_tool')).toBe('ask');
  });

  it('合并外部配置后应生效', () => {
    const custom = new PermissionEngine();
    custom.mergeConfig({
      defaults: { write_file: 'allow' },
    });
    expect(custom.check('write_file')).toBe('allow');
  });

  it('角色限制应 deny 无权限的工具', () => {
    // explorer 只有 read_code, search_symbol, lsp_query, embedding_search
    expect(engine.check('write_file', {}, 'explorer')).toBe('deny');
    expect(engine.check('execute_command', {}, 'explorer')).toBe('deny');
    expect(engine.check('read_file', {}, 'explorer')).toBe('allow');
  });
});
