/**
 * English translation pack
 */
const en: Record<string, string> = {
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
  'welcome.start_hint': 'Type a task to begin',
  'welcome.usage_hints': '@ attach files   / commands   ↑↓ history',

  // ── Mode Labels ──
  'mode.agent': 'AGENT',
  'mode.plan': 'PLAN',

  // ── Help ──
  'help.title': 'Commands',
  'help.plan': 'Create execution plan (read-only)',
  'help.clear': 'Reset session',
  'help.sessions': 'View session history',
  'help.model': 'Model management',
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
  'tool.search_symbol': 'Search Symbol',
  'tool.read_file': 'Read File',
  'tool.list_files': 'List Files',
  'tool.modify_file': 'Modify File',
  'tool.write_file': 'Write File',
  'tool.execute_command': 'Execute Command',
  'tool.git_status': 'Git Status',
  'tool.git_diff': 'Git Diff',
  'tool.git_commit': 'Git Commit',
  'tool.web_search': 'Web Search',
  'tool.lsp_definition': 'Go to Definition',
  'tool.lsp_references': 'Find References',
  'tool.lsp_diagnostics': 'Diagnostics',
  'tool.no_symbols': 'No symbols found matching "{input}".',
  'tool.validate_build': 'Please run the build command to validate this change.',

  // ── Approval ──
  'approval.box_title': '⚠ Approval Required',
  'approval.allow': 'Allow execution? [y/N]',
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

  // ── Diff Preview ──
  'diff.more_lines': '… {count} more lines',

  // ── Status ──
  'status.task_complete': 'Task complete',
  'status.warning': '⚠',
  'status.error': '✗',
  'status.info': 'ℹ',

  // ── File References ──
  'file.not_found': 'File not found',
  'file.reference': 'Reference Files',
  'file.binary': '[File: {path}] ({size} KB, binary/large — use read_file to read chunks)',
  'file.inline': '[File: {path}{lineRange}]\n{content}',
  'file.please_analyze': 'Please analyze the following files',

  // ── Memory ──
  'memory.feedback': 'Feedback',
  'memory.user_preference': 'Preference',
  'memory.project_knowledge': 'Project Knowledge',
  'memory.section_header': '--- Related Memory ---',
  'memory.section_footer': '--- End Memory ---',

  // ── Model Management ──
  'model.add_usage': 'Usage: /model add <reader|reasoning|action> <provider> <model-name>',
  'model.invalid_tier': 'Invalid tier: "{tier}". Must be: reader, reasoning, action',
  'model.added': '✓ Added {name} ({provider}) to {tier}',
  'model.set_usage': 'Usage: /model set <reader|reasoning|action> <model-name>',
  'model.active_set': '✓ {tier} active model set to: {name}',
  'model.rm_usage': 'Usage: /model rm <reader|reasoning|action> <model-name>',
  'model.removed': '✓ Removed {name} from {tier}',
  'model.key_usage': 'Usage: /model key <reader|reasoning|action> <model-name> <api-key>',
  'model.key_set': '✓ API key set for {name}: {masked}',
  'model.unknown_subcmd': 'Unknown subcommand: "/model {sub}". Use: list, add, set, rm, key, fallback',
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
  'tier.reasoning': 'Reasoning',
  'tier.action': 'Action',

  // ── Slash Commands ──
  'cmd.unknown': 'Unknown command',
  'cmd.language_changed': '✓ Language switched to: {lang}',
  'cmd.language_usage': 'Usage: /language zh | en (no args = show selector)',
  'cmd.no_sessions': 'No session history.',
  'cmd.sessions_total': 'Total',
  'cmd.plan_usage': 'Usage: /plan <task description>',
  'cmd.no_api_key': '⚠ No API key configured. Set env var {env}.',
  'cmd.first_config': 'Welcome! First-time setup:\n/language  Switch UI language\n/model   Add model\n/help      Show all commands',
  'cmd.no_model_configured': '⚠ No model configured. Cannot execute tasks.',

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
};

export default en;
