const NO_TRUNCATE_TOOLS = new Set(['read_file', 'list_files', 'search']);
const CMD_OUTPUT_LIMIT = 5000;
const OTHER_OUTPUT_LIMIT = 8000;

export function truncateToolResult(toolName: string, result: string): string {
  const limit = toolName === 'execute_command' ? CMD_OUTPUT_LIMIT : NO_TRUNCATE_TOOLS.has(toolName) ? Infinity : OTHER_OUTPUT_LIMIT;
  return result.length > limit
    ? result.slice(0, limit) + `\n\n[输出被截断：原始 ${result.length} 字符，仅显示前 ${limit} 字符。剩余 ${result.length - limit} 字符未显示。]`
    : result;
}
