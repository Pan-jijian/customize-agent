/** 上下文重要程度，用于记忆召回排序和展示分层。 */
export type Importance = 'high' | 'medium' | 'low';

/** 从记忆库读取并标准化后的上下文条目。 */
export interface ContextEntry {
  id: string;
  title: string;
  content: string;
  type: string;
  importance: Importance;
  tags: string[];
  source: string;
  created_at: number;
  updated_at: number;
}
