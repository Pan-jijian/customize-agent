export type AgentErrorKind =
  | 'tool_error'
  | 'tool_warning'
  | 'execution_error'
  | 'cleanup_error'
  | 'fallback_warning';

export interface AgentErrorInfo {
  kind: AgentErrorKind;
  source: string;
  message: string;
  cause?: string;
  retryable?: boolean;
  modelVisible: boolean;
  userVisible: boolean;
  details?: Record<string, unknown>;
  suggestion?: string;
}

export interface ToolErrorFormatOptions {
  toolName: string;
  args?: Record<string, unknown>;
  error: Error;
  label?: string;
  suggestion?: string;
}

export interface ExecutionErrorFormatOptions {
  scope: string;
  error: Error;
  suggestion?: string;
}

export interface NonFatalErrorOptions {
  source: string;
  error: unknown;
  details?: Record<string, unknown>;
}

type MinimalProcess = {
  env?: Record<string, string | undefined>;
  stderr?: { write(text: string): unknown };
};

function stringifyArgs(args: Record<string, unknown> | undefined): string | undefined {
  if (!args) return undefined;
  const argText = JSON.stringify(args);
  return argText.length > 500 ? argText.slice(0, 497) + '...' : argText;
}

function normalizeError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

export function createToolErrorInfo(options: ToolErrorFormatOptions): AgentErrorInfo {
  return {
    kind: 'tool_error',
    source: options.toolName,
    message: options.error.message,
    retryable: true,
    modelVisible: true,
    userVisible: true,
    details: {
      ...(options.label ? { label: options.label } : {}),
      ...(options.args ? { args: stringifyArgs(options.args) } : {}),
    },
    suggestion: options.suggestion ?? 'inspect the latest project state, adjust the tool arguments, and retry the failed step.',
  };
}

export function createExecutionErrorInfo(options: ExecutionErrorFormatOptions): AgentErrorInfo {
  return {
    kind: 'execution_error',
    source: options.scope,
    message: options.error.message,
    retryable: true,
    modelVisible: true,
    userVisible: true,
    suggestion: options.suggestion ?? 'inspect the previous task state and continue with a corrected approach.',
  };
}

export function formatErrorForModel(error: AgentErrorInfo): string {
  const title = error.kind.split('_').map(part => part.charAt(0).toUpperCase() + part.slice(1)).join('');
  const sourceKey = error.kind === 'tool_error' ? 'tool' : error.kind === 'execution_error' ? 'scope' : 'source';
  const lines = [`[${title}]`, `${sourceKey}: ${error.source}`, `error: ${error.message}`];
  if (error.cause) lines.push(`cause: ${error.cause}`);
  if (error.details) {
    for (const [key, value] of Object.entries(error.details)) {
      lines.push(`${key}: ${typeof value === 'string' ? value : JSON.stringify(value)}`);
    }
  }
  if (typeof error.retryable === 'boolean') lines.push(`retryable: ${error.retryable}`);
  if (error.suggestion) lines.push(`suggestion: ${error.suggestion}`);
  return lines.join('\n');
}

export function formatToolErrorForModel(options: ToolErrorFormatOptions): string {
  return formatErrorForModel(createToolErrorInfo(options));
}

export function formatExecutionErrorForModel(options: ExecutionErrorFormatOptions): string {
  return formatErrorForModel(createExecutionErrorInfo(options));
}

export function reportNonFatalError(options: NonFatalErrorOptions): AgentErrorInfo {
  const error = normalizeError(options.error);
  const info: AgentErrorInfo = {
    kind: 'cleanup_error',
    source: options.source,
    message: error.message,
    modelVisible: false,
    userVisible: false,
    details: options.details,
  };
  const runtimeProcess = (globalThis as typeof globalThis & { process?: MinimalProcess }).process;
  if (runtimeProcess?.env?.CUSTOMIZE_AGENT_DEBUG) {
    runtimeProcess.stderr?.write(`${formatErrorForModel(info)}\n`);
  }
  return info;
}
