const NO_TRUNCATE_TOOLS = new Set(['read_file', 'list_files', 'search']);
const CMD_OUTPUT_LIMIT = 5000;
const OTHER_OUTPUT_LIMIT = 8000;

export function truncateToolResult(toolName: string, result: string): string {
  const limit = toolName === 'execute_command' ? CMD_OUTPUT_LIMIT : NO_TRUNCATE_TOOLS.has(toolName) ? Infinity : OTHER_OUTPUT_LIMIT;
  return result.length > limit
    ? result.slice(0, limit) + `\n\n[Output truncated: ${result.length} chars total, showing first ${limit} chars. ${result.length - limit} chars omitted.]`
    : result;
}
