/** 记忆类型对应的中文展示标签。 */
export const CONTEXT_TYPE_LABELS: Record<string, string> = {
  project_fact: '项目知识',
  user_preference: '用户偏好',
  feedback: '历史纠偏',
  pattern: '解决方案',
};

/** 记忆检索时最多参与 SQL 匹配的关键词数量，防止 LIKE 条件无限膨胀。 */
export const MAX_CONTEXT_QUERY_TERMS = 8;

/** 记忆检索时参与匹配的最短关键词长度。 */
export const MIN_CONTEXT_QUERY_TERM_LENGTH = 2;
