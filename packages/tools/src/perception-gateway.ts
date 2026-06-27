/**
 * 感知网关 — 所有非文本输入的统一入口。
 * 格式校验 + 注入攻击检测。
 */
export class PerceptionGateway {
  static ALLOWED_MIMES = new Map([
    ['png', 'image/png'], ['jpg', 'image/jpeg'], ['jpeg', 'image/jpeg'],
    ['gif', 'image/gif'], ['webp', 'image/webp'],
    ['pdf', 'application/pdf'],
    ['wav', 'audio/wav'], ['mp3', 'audio/mpeg'],
  ]);

  static INJECTION_PATTERNS = [
    /ignore\s+(all\s+)?previous\s+instructions/i,
    /<\|im_start\|>/i,
    /<\|endoftext\|>/i,
    /\[system\]/i,
  ];

  static validateExt(ext: string): boolean {
    return this.ALLOWED_MIMES.has(ext.toLowerCase());
  }

  static mimeType(ext: string): string | undefined {
    return this.ALLOWED_MIMES.get(ext.toLowerCase());
  }

  static scanInjection(text: string): string[] {
    return this.INJECTION_PATTERNS.filter(p => p.test(text)).map(p => p.source);
  }
}
