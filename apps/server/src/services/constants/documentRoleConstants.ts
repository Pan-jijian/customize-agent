/** 合法提示词执行类型集合，用于替代连续 if/或判断。 */
export const PROMPT_EXECUTION_TYPES = new Set(['fact_extraction', 'chapter_generation', 'llm_review', 'validation', 'formatting', 'reference']);

/** 合法文件处理类型集合，用于替代连续 if/或判断。 */
export const FILE_PROCESSING_TYPES = new Set(['rule', 'table', 'drawing', 'specification', 'reference']);

/** 文档角色和配置 ID 的最大长度。 */
export const DOCUMENT_ROLE_ID_MAX_LENGTH = 80;
