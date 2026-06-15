import { describe, it, expect } from 'vitest';
import { DiffEngine } from '../../packages/diff/src/diff.js';
import { UnifiedSyntaxValidator } from '../../packages/tools/src/validator/syntax.js';
import * as fs from 'fs';
import * as path from 'path';

const FIXTURES = path.resolve(import.meta.dirname, '../../fixtures/mock-projects');

describe('E2E: Mock 项目验证', () => {
  describe('calculator-app', () => {
    it('TypeScript calc.ts 应存在并被 tree-sitter 解析', () => {
      const filePath = path.join(FIXTURES, 'calculator-app/ts/calc.ts');
      const content = fs.readFileSync(filePath, 'utf-8');

      const validator = new UnifiedSyntaxValidator();
      const result = validator.validate(filePath, content);

      // 文件本身应有语法错误（缺少类型注解不算语法错误，tree-sitter 应能解析）
      expect(result.language).toBe('TypeScript');
      // TS 的语法错误检测由 tree-sitter ERROR 节点负责
    });

    it('Python calc.py 应检测到缺少冒号的语法错误', () => {
      const filePath = path.join(FIXTURES, 'calculator-app/py/calc.py');
      const content = fs.readFileSync(filePath, 'utf-8');

      const validator = new UnifiedSyntaxValidator();
      const result = validator.validate(filePath, content);

      expect(result.language).toBe('Python');
      expect(result.valid).toBe(false);
      expect(result.errors).toBeDefined();
      expect(result.errors!.length).toBeGreaterThan(0);
    });

    it('Go calc.go 应检测到语法错误', () => {
      const filePath = path.join(FIXTURES, 'calculator-app/go/calc.go');
      const content = fs.readFileSync(filePath, 'utf-8');

      const validator = new UnifiedSyntaxValidator();
      const result = validator.validate(filePath, content);

      expect(result.language).toBe('Go');
      expect(result.valid).toBe(false);
      expect(result.errors).toBeDefined();
    });
  });

  describe('broken-api', () => {
    it('routes.ts 的 bug 可以通过 SEARCH/REPLACE 修复', () => {
      const filePath = path.join(FIXTURES, 'broken-api/src/routes.ts');
      const content = fs.readFileSync(filePath, 'utf-8');

      // 模拟修复：为 getUser 添加 NaN 检查
      const patched = DiffEngine.applyPatch(content, {
        search: `  const numId = parseInt(id);  // 未处理 NaN 情况`,
        replace: `  const numId = parseInt(id);
  if (isNaN(numId)) return undefined;`,
      });

      expect(patched).toContain('isNaN(numId)');
      expect(patched).not.toContain('未处理 NaN 情况');
    });
  });

  describe('refactor-target', () => {
    it('user-service.ts 应能被正确解析', () => {
      const filePath = path.join(FIXTURES, 'refactor-target/src/user-service.ts');
      const content = fs.readFileSync(filePath, 'utf-8');

      const validator = new UnifiedSyntaxValidator();
      const result = validator.validate(filePath, content);

      expect(result.language).toBe('TypeScript');
    });

    it('SEARCH/REPLACE 应能拆分 validateEmail 为独立工具函数', () => {
      const filePath = path.join(FIXTURES, 'refactor-target/src/user-service.ts');
      const content = fs.readFileSync(filePath, 'utf-8');

      // 模拟在文件顶部插入独立验证函数
      const searchBlock = `// 这些函数应拆分到不同模块
export class UserService {`;

      const replaceBlock = `// 独立验证工具函数
export function isValidEmail(email: string): boolean {
  return email.includes('@');
}

export class UserService {`;

      const patched = DiffEngine.applyPatch(content, { search: searchBlock, replace: replaceBlock });

      expect(patched).toContain('isValidEmail');
      expect(patched).toContain('独立验证工具函数');
    });
  });
});
