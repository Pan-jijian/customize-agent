/** 记忆类型对应的中文展示标签。 */
export const CONTEXT_TYPE_LABELS: Record<string, string> = {
  user_preference: '用户偏好',
  feedback: '历史纠偏',
  pattern: '解决方案',
};


/** 记忆检索时参与匹配的最短关键词长度。 */
export const MIN_CONTEXT_QUERY_TERM_LENGTH = 2;
