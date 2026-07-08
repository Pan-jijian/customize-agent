// 不需要截断的工具（全文返回）
const NO_TRUNCATE_TOOLS = new Set(['read_file', 'list_files', 'search']);
// 命令输出截断上限（字符数）
const CMD_OUTPUT_LIMIT = 5000;
// 其他工具输出截断上限（字符数）
const OTHER_OUTPUT_LIMIT = 8000;

/**
 * 截断工具执行结果，防止超出上下文长度。
 * 命令输出截断到 CMD_OUTPUT_LIMIT，其余工具截断到 OTHER_OUTPUT_LIMIT，
 * 指定工具（read_file/list_files/search）不做截断。
 */
export function truncateToolResult(toolName: string, result: string): string {
  const limit = toolName === 'execute_command' ? CMD_OUTPUT_LIMIT : NO_TRUNCATE_TOOLS.has(toolName) ? Infinity : OTHER_OUTPUT_LIMIT;
  return result.length > limit
    ? result.slice(0, limit) + `\n\n[Output truncated: ${result.length} chars total, showing first ${limit} chars. ${result.length - limit} chars omitted.]`
    : result;
}
