---
"@customize-agent/knowledge": patch
---

修复 CAD 图纸解析乱码残留：GBK 编码标注被 Latin-1 误读的多种形态过滤（纯扩展拉丁短行、GBK 误读标点混入 ASCII、分数符号误读），语义节点图层/块名补全可读性过滤，$AUDIT_BAD 内部审计标记剔除，U+FFFF 非字符全局清理；图纸无字符数据时不再入库。
