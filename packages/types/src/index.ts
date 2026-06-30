// @customize-agent/types — 跨包类型契约层
// 零外部依赖，任何包都可以安全导入

export type { Message, LLMResponse, ToolCall, StreamChunk, FunctionDefinition } from './message.js';
export type { LifecycleAware, ComponentStatus, ComponentState } from './lifecycle.js';
export type { SessionConfig, SessionStatus, Session } from './session.js';
export { createSession } from './session.js';
export type { TaskStateEvent, Checkpoint, RuntimeConfig, TaskResult } from './task.js';
export { TaskState } from './task.js';
export { BINARY_EXTENSIONS } from './constants.js';
