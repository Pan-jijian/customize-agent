/**
 * English translation pack
 */
const en: Record<string, string | string[]> = {
  // ── Language Selection ──
  'lang.select.title': 'Language / 语言',
  'lang.select.prompt': '↑↓ Select  Enter Confirm',
  'lang.select.zh': '中文',
  'lang.select.en': 'English',

  // ── CLI ──
  'cli.description': 'Customize Agent v0.0.3 — interactive REPL',
  'cli.prompt_desc': 'Single-shot execution mode',
  'cli.plan_desc': 'Plan mode: read-only exploration (requires -p)',
  'cli.mcp_server_desc': 'Start MCP Server (stdio JSON-RPC)',
  'cli.mcp_server_start': '[MCP Server] Starting stdio JSON-RPC 2.0...',
  'cli.single_shot_header': '🚀 Customize Agent v0.0.3 [{provider}]',
  'cli.task_label': 'Task',
  'cli.result_label': '📋 Result',

  // ── Welcome ──
  'welcome.ready': '✅ Ready.',
  'welcome.goodbye': '👋 Goodbye.',
  'welcome.title': 'Customize Agent',
  'welcome.provider_label': 'Provider',
  'welcome.no_model': 'No model configured',
  'welcome.start_hint': 'Type a task to begin',
  'welcome.usage_hints': '@ attach files   / commands   ↑↓ history',

  // ── Mode Labels ──
  'mode.agent': 'AGENT',
  'mode.plan': 'PLAN',
  'message.user': 'User',
  'message.queued': 'Queued',

  // ── Help ──
  'help.title': 'Commands',
  'help.plan': 'Create a plan and optionally execute it',
  'help.rewind': 'Rewind recent turns',
  'help.resume': 'Resume a previous session',
  'help.clear': 'Reset session',
  'help.sessions': 'View session history',
  'help.model': 'Model management',
  'help.provider': 'Provider config',
  'help.memory': 'Memory management',
  'help.language': 'Switch UI language',
  'help.help': 'Show help',
  'help.exit': 'Exit',
  'help.tips': 'Tips',
  'help.file_tip': 'Attach file + inject content',
  'help.line_tip': 'Reference specific lines',
  'help.key_tip': 'Browse history / dropdown',
  'help.tab_tip': 'Confirm dropdown selection',

  // ── Dropdown ──
  'dropdown.files_header': 'Files',
  'dropdown.commands_header': 'Commands',
  'dropdown.more': '… {count} more',

  // ── Hint Bar ──
  'hint.tab_select': 'Tab select',
  'hint.arrow_navigate': '↑↓ navigate',
  'hint.enter_confirm': 'Enter confirm',
  'hint.esc_dismiss': 'Esc dismiss',
  'hint.separator': '  ·  ',

  // ── Tool Names ──
  'tool.search': 'Search',
  'tool.read_file': 'Read File',
  'tool.list_files': 'List Files',
  'tool.write_file': 'Write File',
  'tool.execute_command': 'Execute Command',
  'tool.git_commit': 'Git Commit',
  'tool.lsp_definition': 'Go to Definition',
  'tool.lsp_references': 'Find References',
  'tool.lsp_diagnostics': 'Diagnostics',
  'tool.count_label': 'tools',


  // ── Approval ──
  'approval.box_title': '⚠ Approval Required',
  'approval.allow': 'Allow execution?',
  'approval.run': 'Run',
  'approval.cancel': 'Cancel',
  'approval.file_detail': 'File: {path}',
  'approval.command_detail': 'Command: {cmd}',

  // ── Context ──
  'context.compact_none': 'Context usage normal, no compaction needed.',
  'context.compacting': 'Context at {pct}% ({usedK}K / {limitK}K tokens), compacting…',
  'context.compacted': 'Compacted, freed ~{removedK}K tokens → {currentK}K tokens',
  'context.usage': 'Context',
  'context.session_cleared': '✓ Session cleared.',

  // ── Stream / Tool Execution ──
  'tool_call.success': '└ ✓',
  'tool_call.error': '└ ✗',
  'tool_call.truncated': '\n...[Truncated {count} chars]',
  'stream.thinking': 'Thinking…',
  'think.thinking': 'Thinking…',
  'think.thought_for': 'Thought for',
  'think.tokens': 'tokens',
  'token.prompt': 'prompt',
  'token.output': 'output',
  'token.rounds': 'rounds',
  'think.expand_hint': '(ctrl+o to expand thinking)',
  'think.no_content': 'No thinking to show.',
  'search.fallback': '[Search] ripgrep unavailable, falling back to JS search',
  'search.no_matches': 'No matches found for "{pattern}".',
  'lsp.no_definition': 'No definition found.',
  'lsp.no_references': 'No references found.',
  'lsp.no_diagnostics': 'No diagnostics.',
  'git.not_installed': 'Git not installed.',
  'git.not_initialized': 'Git not initialized in this directory.',
  'git.committed': 'Committed: {msg}',
  'git.commit_failed': 'Commit failed: {detail}',
  'git.error': 'Git error: {msg}',
  'think.box_title': 'Thinking',
  'think.tips': [
    '/clear  clears session history',
    '@file  attaches a file to context',
    '↑↓  browse history / dropdown',
    '/language zh|en  switches UI language',
    '/model  manage AI models & API keys',
    '/plan  create execution plan first',
  ],

  // ── Diff Preview ──
  'diff.more_lines': '… {count} more lines',

  // ── Status ──
  'status.task_complete': 'Task complete',
  'status.warning': '⚠',
  'status.error': '✗',
  'status.info': 'ℹ',
  'status.cancelled': 'Current task cancelled',

  // ── File References ──
  'file.not_found': 'File not found',
  'file.reference': 'Reference Files',
  'file.binary': '[File: {path}] ({size} KB, binary/large — use read_file to read chunks)',
  'file.inline': '[File: {path}{lineRange}]\n{content}',
  'file.please_analyze': 'Please analyze the following files',

  // ── Memory ──
  'memory.feedback': 'Feedback',
  'memory.user_preference': 'Preference',
  'memory.project_fact': 'Project Knowledge',
  'memory.pattern': 'Solution Pattern',
  'memory.section_header': '--- Related Memory ---',
  'memory.section_footer': '--- End Memory ---',
  'memory.count': '{count} memories',
  'memory.cleared': '✓ Memories cleared',
  'memory.clear_usage': 'Usage: /memory clear [feedback|project_fact|user_preference|pattern]',

  // ── Model Management ──
  'model.add_usage': 'Usage: /model add <reader|reasoning|action> <provider> <model-name>',
  'model.invalid_tier': 'Invalid tier: "{tier}". Must be: reader, reasoning, action',
  'model.added': '✓ Added {name} ({provider}) to {tier}',
  'model.set_usage': 'Usage: /model set <reader|reasoning|action> <model-name>',
  'model.active_set': '✓ {tier} active model set to: {name}',
  'model.rm_usage': 'Usage: /model rm <reader|reasoning|action> <model-name>',
  'model.removed': '✓ Removed {name} from {tier}',
  'model.key_usage': 'Usage: /model key <provider-name> <api-key>',
  'model.key_set': '✓ API key set for {provider}: {masked}',
  'model.unknown_subcmd': 'Unknown subcommand: "/model {sub}". Use: add, set, rm, key, fallback',
  'model.quick_start': 'Quick start:',
  'model.example_add': '/model add action deepseek deepseek-v4-flash',
  'model.example_key': '/model key deepseek sk-xxx',
  'model.example_more': '/model set reader deepseek-v4-flash  |  rm  |  fallback',

  // ── Provider ──
  'provider.key_usage': 'Usage: /provider key <name> <api-key>',
  'provider.key_set': '✓ API key set for {name}',
  'provider.url_usage': 'Usage: /provider url <name> <base-url>',
  'provider.url_set': '✓ Endpoint set for {name}',
  'provider.protocol_usage': 'Usage: /provider protocol <name> <openai|anthropic|google>',
  'provider.protocol_set': '✓ {name} protocol set to: {protocol}',
  'provider.unknown_subcmd': 'Unknown subcommand: "/provider {sub}". Use: key, url, protocol',
  'provider.none': 'No providers. They are auto-created when you add models.',
  'provider.hint': '/provider key <name> <key>  |  protocol <name> <p>  |  url <name> <url>',
  'model.no_active': '(none)',
  'model.empty': '(empty)',
  'model.commands_hint': 'Commands: /model add <tier> <provider> <name>  |  set  |  rm  |  key  |  fallback',
  'model.fallback_label': '→ fallback:',
  'model.chain_separator': ' → ',

  // ── Session History ──
  'session.date_label': 'Date',
  'session.events_label': 'Events',
  'session.task_label': 'Task',

  // ── Tier Labels ──
  'tier.reader': 'Reader',
  'tier.reader_desc': 'Read files, search symbols',
  'tier.reasoning': 'Reasoning',
  'tier.reasoning_desc': 'Analyze code, make plans',
  'tier.action': 'Action',
  'tier.action_desc': 'Modify files, run commands',

  // ── Slash Commands ──
  'cmd.unknown': 'Unknown command',
  'cmd.language_changed': '✓ Language switched to: {lang}',
  'cmd.language_usage': 'Usage: /language zh | en (no args = show selector)',
  'cmd.no_sessions': 'No session history.',
  'cmd.sessions_total': 'Total',
  'cmd.plan_usage': 'Usage: /plan <task description>',
  'cmd.no_api_key': '⚠ No API key configured. Set env var {env}.',
  'cmd.first_config': '/model  Add model & get started\n/model key <provider> <key>  Set API key\n/language  Switch UI language\n/help  Show all commands',
  'cmd.no_model_configured': '⚠ No model configured. Cannot execute tasks.',
  'cmd.no_rewind': 'No conversation turn to rewind.',
  'cmd.rewind_done': 'Rewound. The original user input has been restored to the input box.',
  'cmd.rewind_scope_chat': 'Chat only',
  'cmd.rewind_scope_chat_desc': 'Remove context after the selected turn and restore that input to the input box',
  'cmd.rewind_scope_all': 'Chat + changes',
  'cmd.rewind_scope_all_desc': 'Also restore the workspace snapshot captured before execution; no Git required',
  'cmd.rewind_snapshot_failed': 'Failed to restore file changes: workspace snapshot could not be fully restored.',
  'cmd.rewind_snapshot_missing': 'No workspace snapshot found for that turn; only conversation was rewound.',
  'cmd.resume_done': 'Resumed session: {id}',
  'cmd.resume_scope_chat': 'Chat only',
  'cmd.resume_scope_chat_desc': 'Restore conversation messages only',
  'cmd.resume_scope_all': 'Chat + changes',
  'cmd.resume_scope_all_desc': 'Restore conversation and the workspace snapshot saved for that session',
  'cmd.resume_changes_unavailable': 'No workspace snapshot found for that session; only conversation was restored.',
  'cmd.plan_execute': 'Execute plan',
  'cmd.plan_keep': 'Keep plan only',

  // ── Executor ──
  'executor.security_policy_deny': '[Denied by policy] {label}',
  'executor.user_cancelled': '[Cancelled] {label}',
  'executor.missing_approval_handler': '[Missing approval handler] {label}',
  'executor.truncated': '\n...[Truncated {count} chars]',
  'executor.exception': '[Exception] {msg}',

  // ── Plan Mode ──
  'plan.banner': 'Plan Mode',
  'plan.complete': 'Plan Complete',

  // ── Common ──
  'common.truncation': '…',
  'common.error': 'Error',
  'error.execution': 'Execution failed',
};

export default en;
