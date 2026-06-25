/**
 * 中文翻译包
 */
const zh: Record<string, string> = {
  // ── 语言选择 ──
  'lang.select.title': '语言 / Language',
  'lang.select.prompt': '↑↓ 选择  Enter 确认',
  'lang.select.zh': '中文',
  'lang.select.en': 'English',

  // ── CLI ──
  'cli.description': 'Customize Agent v0.0.3 — 交互式 REPL',
  'cli.prompt_desc': '单次执行模式',
  'cli.plan_desc': 'Plan 模式：只读探索（须配合 -p）',
  'cli.mcp_server_desc': '启动 MCP Server (stdio JSON-RPC)',
  'cli.mcp_server_start': '[MCP Server] 启动 stdio JSON-RPC 2.0...',
  'cli.single_shot_header': '🚀 Customize Agent v0.0.3 [{provider}]',
  'cli.task_label': '任务',
  'cli.result_label': '📋 结果',

  // ── 欢迎 ──
  'welcome.ready': '✅ Ready.',
  'welcome.goodbye': '👋 Goodbye.',
  'welcome.title': 'Customize Agent',
  'welcome.provider_label': 'Provider',
  'welcome.start_hint': '输入任务开始',
  'welcome.usage_hints': '引用文件   / 命令   ↑↓ 历史',

  // ── 模式标签 ──
  'mode.agent': 'AGENT',
  'mode.plan': 'PLAN',

  // ── 帮助 ──
  'help.title': '命令',
  'help.plan': '制定执行计划（只读探索）',
  'help.clear': '重置当前会话',
  'help.sessions': '查看历史会话',
  'help.model': '模型管理',
  'help.language': '切换界面语言',
  'help.help': '显示帮助',
  'help.exit': '退出',
  'help.tips': '技巧',
  'help.file_tip': '引用文件并注入内容',
  'help.line_tip': '引用特定行范围',
  'help.key_tip': '浏览历史 / 下拉菜单',
  'help.tab_tip': '确认下拉选择',

  // ── 下拉菜单 ──
  'dropdown.files_header': '文件',
  'dropdown.commands_header': '命令',
  'dropdown.more': '… 还有 {count} 个',

  // ── 提示栏 ──
  'hint.tab_select': 'Tab 选择',
  'hint.arrow_navigate': '↑↓ 导航',
  'hint.enter_confirm': 'Enter 确认',
  'hint.esc_dismiss': 'Esc 关闭',
  'hint.separator': '  ·  ',

  // ── 工具名 ──
  'tool.search_symbol': '搜索代码符号',
  'tool.read_file': '读取文件',
  'tool.list_files': '列出目录',
  'tool.modify_file': '修改文件',
  'tool.write_file': '创建文件',
  'tool.execute_command': '执行终端命令',
  'tool.git_status': '查看 Git 状态',
  'tool.git_diff': '查看 Git 变更',
  'tool.git_commit': '提交 Git 变更',
  'tool.web_search': '搜索网络',
  'tool.lsp_definition': '跳转定义',
  'tool.lsp_references': '查找引用',
  'tool.lsp_diagnostics': '代码诊断',
  'tool.no_symbols': '未找到匹配 "{input}" 的符号。',
  'tool.validate_build': '请运行编译命令验证此修改。',

  // ── 审批 ──
  'approval.box_title': '⚠ 需要审批',
  'approval.allow': '允许执行？[y/N]',
  'approval.file_detail': '文件: {path}',
  'approval.command_detail': '命令: {cmd}',

  // ── 上下文 ──
  'context.compact_none': '上下文使用率正常，无需压缩。',
  'context.compacting': '上下文使用 {pct}%（{usedK}K / {limitK}K token），正在压缩…',
  'context.compacted': '压缩完成，释放约 {removedK}K token → 当前 {currentK}K token',
  'context.usage': '上下文',
  'context.session_cleared': '✓ 会话已重置。',

  // ── 流式输出 / 工具执行 ──
  'tool_call.success': '└ ✓',
  'tool_call.error': '└ ✗',
  'tool_call.truncated': '\n...[截断 {count} 字符]',
  'stream.thinking': '思考中…',

  // ── Diff 预览 ──
  'diff.more_lines': '… 还有 {count} 行',

  // ── 状态 ──
  'status.task_complete': '任务完成',
  'status.warning': '⚠',
  'status.error': '✗',
  'status.info': 'ℹ',

  // ── 文件引用 ──
  'file.not_found': '文件未找到',
  'file.reference': '参考文件',
  'file.binary': '[文件: {path}] ({size} KB, 二进制/大文件 — 请用 read_file 分段读取)',
  'file.inline': '[文件: {path}{lineRange}]\n{content}',
  'file.please_analyze': '请分析以下文件',

  // ── 记忆 ──
  'memory.feedback': '历史纠偏',
  'memory.user_preference': '用户偏好',
  'memory.project_knowledge': '项目知识',
  'memory.section_header': '--- 相关历史记忆 ---',
  'memory.section_footer': '--- 记忆结束 ---',

  // ── 模型管理 ──
  'model.add_usage': '用法: /model add <reader|reasoning|action> <provider> <model-name>',
  'model.invalid_tier': '无效层级: "{tier}"。可选: reader, reasoning, action',
  'model.added': '✓ 已添加 {name} ({provider}) 到 {tier}',
  'model.set_usage': '用法: /model set <reader|reasoning|action> <model-name>',
  'model.active_set': '✓ {tier} 激活模型设为: {name}',
  'model.rm_usage': '用法: /model rm <reader|reasoning|action> <model-name>',
  'model.removed': '✓ 已从 {tier} 移除 {name}',
  'model.key_usage': '用法: /model key <reader|reasoning|action> <model-name> <api-key>',
  'model.key_set': '✓ {name} API key 已设置: {masked}',
  'model.unknown_subcmd': '未知子命令: "/model {sub}"。可用: list, add, set, rm, key, fallback',
  'model.no_active': '(无)',
  'model.empty': '(空)',
  'model.commands_hint': '命令: /model add <层级> <提供商> <模型名>  |  set  |  rm  |  key  |  fallback',
  'model.fallback_label': '→ 回退:',
  'model.chain_separator': ' → ',

  // ── 会话历史 ──
  'session.date_label': '日期',
  'session.events_label': '事件',
  'session.task_label': '任务',

  // ── 模型层级标签 ──
  'tier.reader': 'Reader',
  'tier.reasoning': 'Reasoning',
  'tier.action': 'Action',

  // ── 斜杠命令 ──
  'cmd.unknown': '未知命令',
  'cmd.language_changed': '✓ 语言已切换为: {lang}',
  'cmd.language_usage': '用法: /language zh | en（无参数则弹出选择面板）',
  'cmd.no_sessions': '暂无历史会话。',
  'cmd.sessions_total': '总计',
  'cmd.plan_usage': '用法: /plan <任务描述>',
  'cmd.no_api_key': '⚠ 未设置 API Key。请设置环境变量 {env}。',
  'cmd.first_config': '欢迎使用！请先配置:\n/language  切换界面语言\n/model  添加模型\n/help      查看全部命令',
  'cmd.no_model_configured': '⚠ 未配置任何模型，无法执行任务。',

  // ── 执行器 ──
  'executor.security_policy_deny': '[安全策略禁止] {label}',
  'executor.user_cancelled': '[用户取消] {label}',
  'executor.missing_approval_handler': '[缺少审批处理器] {label}',
  'executor.truncated': '\n...[截断 {count} 字符]',
  'executor.exception': '[异常] {msg}',

  // ── Plan 模式 ──
  'plan.banner': 'Plan 模式',
  'plan.complete': '计划完成',

  // ── 通用 ──
  'common.truncation': '…',
  'common.error': '错误',
};

export default zh;
