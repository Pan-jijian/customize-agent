'use client';

import { useEffect, useState, useCallback } from 'react';
import { getKbStats, getKbFiles, getKbFeatures, reindexKb, type KbStats, type KbFileItem, type KbFeatures } from '@/lib/api';

export function useKbStats() {
  const [stats, setStats] = useState<KbStats | null>(null);
  const [loading, setLoading] = useState(true);
  const load = useCallback(async () => {
    setLoading(true);
    try { setStats(await getKbStats()); } catch { /* */ }
    finally { setLoading(false); }
  }, []);
  useEffect(() => { void load(); }, [load]);
  return { stats, loading, reload: load };
}

export function useKbFiles(category?: string) {
  const [files, setFiles] = useState<KbFileItem[]>([]);
  const [loading, setLoading] = useState(true);
  const load = useCallback(async () => {
    setLoading(true);
    try { const r = await getKbFiles({ category: category || undefined, limit: 200 }); setFiles(r.files || []); } catch { /* */ }
    finally { setLoading(false); }
  }, [category]);
  useEffect(() => { void load(); }, [load]);
  return { files, loading, reload: load };
}

export function useKbFeatures() {
  const [features, setFeatures] = useState<KbFeatures | null>(null);
  useEffect(() => { getKbFeatures().then(setFeatures).catch(() => {}); }, []);
  return features;
}

export function useReindex() {
  const [reindexing, setReindexing] = useState(false);
  const reindex = useCallback(async () => {
    setReindexing(true);
    try { await reindexKb(); return true; } catch { return false; }
    finally { setReindexing(false); }
  }, []);
  return { reindexing, reindex };
}
