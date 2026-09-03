/**
 * isContextOverflowLlmError 组合矩阵（4.12.7 前补齐）：
 * 用「provider 报错变体 × 上下文关键词」的笛卡尔积生成 true 矩阵，
 * 用「瞬态/鉴权/语法错误/空值」变体生成 false 矩阵，
 * 确保降级重试闸门只对「压缩输入即可成功」的失败形态放行。
 */
import { describe, expect, it } from 'vitest';
import { isContextOverflowLlmError } from '@/services/document-workflow/llmClient';

/** 组合生成器：provider 短语 × 关键词 全笛卡尔（语义均属“输入超窗口/输出截断可压缩降级”类） */
const OVERFLOW_PHRASES = [
  'maximum context length exceeded',
  'context length exceeded',
  'context window exceeded',
  'This model\'s maximum context length is 8192 tokens',
  'too many tokens',
  'input is too long',
  'prompt too long',
  '请求体超长',
  '上下文长度超出模型限制',
  '上下文超出限制',
  '上下文窗口已满',
];
const OVERFLOW_KEYS = [
  '',
  ' (400)',
  ' [HTTP 400]',
];
const TRUNCATION_VARIANTS = [
  'JSON 解析失败：JSON 被截断（{ 未闭合 2 个），截断位置响应末段：…',
  'JSON 解析失败：JSON 被截断（[ 未闭合 1 个），截断位置响应末段：…',
  'JSON解析失败：输出被截断',
  'JSON 被截断',
  'json 被截断',
  'JSON 被截断（{ 未闭合 3 个、[ 未闭合 2 个）',
  'JSON 输出未闭合',
  'json 输出未闭合',
  'JSON 解析失败：JSON 被截断（截断位置响应末段：}',
];
const FALSE_VARIANTS = [
  'fetch failed',
  'connection error',
  'ECONNREFUSED',
  'ECONNRESET',
  'ETIMEDOUT',
  'ENOTFOUND',
  'EAI_AGAIN',
  'socket hang up',
  '429 too many requests',
  '502 Bad Gateway',
  '503 Service Unavailable',
  '504 Gateway Timeout',
  'rate limit exceeded',
  '服务繁忙，请稍后重试',
  'invalid api key',
  '401 unauthorized',
  '403 forbidden',
  'insufficient balance',
  '余额不足',
  'JSON 解析失败：JSON 语法错误，出错位置响应末段：…',
  'JSON 语法错误',
  'JSON 解析失败：意外字符',
  'unknown error',
  '请求失败',
  'internal server error',
  'timeout after 60s',
  '',
];

describe('isContextOverflowLlmError 上下文超长组合矩阵（短语 × 状态码后缀）', () => {
  const cases: Array<[string]> = [];
  for (const phrase of OVERFLOW_PHRASES) {
    for (const key of OVERFLOW_KEYS) {
      cases.push([`${phrase}${key}`]);
    }
  }
  it.each(cases)('识别 #%#：%s', (input) => {
    expect(isContextOverflowLlmError(input)).toBe(true);
    expect(isContextOverflowLlmError(new Error(input))).toBe(true);
  });
});

describe('isContextOverflowLlmError JSON 截断变体矩阵', () => {
  it.each(TRUNCATION_VARIANTS.map(v => [v] as const))('识别 #%#：%s', (input) => {
    expect(isContextOverflowLlmError(input)).toBe(true);
    expect(isContextOverflowLlmError(new Error(input))).toBe(true);
  });
});

describe('isContextOverflowLlmError 非降级形态矩阵（不误放行）', () => {
  it.each(FALSE_VARIANTS.map(v => [v] as const))('不识别 #%#：%s', (input) => {
    expect(isContextOverflowLlmError(input)).toBe(false);
    expect(isContextOverflowLlmError(new Error(input))).toBe(false);
  });
});

describe('isContextOverflowLlmError 空值与非字符串矩阵（安全 false 不抛异常）', () => {
  it.each([
    [undefined],
    [null],
    [0],
    [400],
    [500],
    [{}],
    [{ code: 400, message: 'context length' }],
    [[1, 2]],
    [true],
  ] as Array<[unknown]>)('安全 #%#', (input) => {
    expect(isContextOverflowLlmError(input)).toBe(false);
  });
});
