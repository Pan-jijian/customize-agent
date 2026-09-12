---
"@customize-agent/knowledge": minor
"@customize-agent/server": minor
---

OCR 分栏重排与表格 KV 行结构修复批次：

  - **knowledge/extraction**：新增 OCR 页多栏版面检测与分栏重排（走廊检测 → 表格保护（切割线两侧表格状内容带 ≥4 即拒绝）→ 判据门控 → 按栏重组 + 重排前后字符多重集校验）：修复扫描图纸 PDF 多栏页 OCR 文本全页交错、正文不可读（如舒城信号灯图纸 p80、装配式图纸 p2/p6）；单栏页与表格页幂等回退不误伤
  - **knowledge/extraction**：OCR 页节（## PDF 第 N 页（OCR））内的识别行不再做 Markdown 标题化（数字开头短行不再加 ##）：修复 OCR 碎片行被误判为二级标题后独占一级节、页标记 section_title 被抢占的问题，OCR 页的 section_title 稳定归属「PDF 第 N 页（OCR）」
  - **knowledge/extraction**：DOCX 表格智能表头检测（与 xlsx/CSV 路径同源，多级表头拼接 + 标题行降级注释）：修复首行非表头时列名沦为上一行数据内容、KV 声明行沿用错误列名的问题；KV 声明行单元格内换行折叠（Excel Alt+Enter/Word 折行不再拆断「R#C# 列名: 值」行结构）
  - **knowledge/chunking**：表格 KV 声明行优先按行拆分（防多 sheet 工作簿 KV 结构被空白分隔符拆碎，向量检索可按列名召回参数）；无数据行表格块整块保留（修复 docx 表头回退块整块丢失）；重叠块对齐行边界（修复重叠块行首残缺）
  - **knowledge/cleaning**：KV 声明行页眉页脚误判保护（多 sheet 重复条目不再整行删除）；投标文件格式模板段闭合判定（未闭合不删，宁多勿丢，修复缺段落边界时收集链扩展到文件尾的连带删除）
  - **server**：知识库导出移除文件数与文本总量上限；工作流模式支持对 failed/aborted/生成中记录导出已有正文（MD/HTML/DOCX/PDF）；移除导出门禁风险提示
