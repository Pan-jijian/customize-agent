'use client';

import { useEffect, useState, useCallback } from 'react';
import { getKbStats, getKbFiles, getKbFeatures, reindexKb, type KbStats, type KbFileItem, type KbFeatures } from '@/lib/api';

/** 获取知识库统计信息的 Hook（文件数、块数、向量状态等） */
export function useKbStats() {
  const [stats, setStats] = useState<KbStats | null>(null);
  const [loading, setLoading] = useState(false);
  const load = useCallback(async () => {
    setLoading(true);
    try { setStats(await getKbStats()); } catch { /* */ }
    finally { setLoading(false); }
  }, []);
  useEffect(() => { void load(); }, [load]);
  return { stats, loading, reload: load };
}

/** 获取知识库文件列表的 Hook，支持按分类筛选 */
export function useKbFiles(category?: string) {
  const [files, setFiles] = useState<KbFileItem[]>([]);
  const [loading, setLoading] = useState(false);
  const load = useCallback(async () => {
    setLoading(true);
    try { const r = await getKbFiles({ category: category || undefined, limit: 200 }); setFiles(r.files || []); } catch { /* */ }
    finally { setLoading(false); }
  }, [category]);
  useEffect(() => { void load(); }, [load]);
  return { files, loading, reload: load };
}

/** 获取知识库特性信息的 Hook（向量存储、嵌入、提取器等） */
export function useKbFeatures() {
  const [features, setFeatures] = useState<KbFeatures | null>(null);
  useEffect(() => { getKbFeatures().then(setFeatures).catch(() => {}); }, []);
  return features;
}

/** 知识库重新索引 Hook，返回 reindex 触发函数和加载状态 */
export function useReindex() {
  const [reindexing, setReindexing] = useState(false);
  const reindex = useCallback(async () => {
    setReindexing(true);
    try { await reindexKb(); return true; } catch { return false; }
    finally { setReindexing(false); }
  }, []);
  return { reindexing, reindex };
}
