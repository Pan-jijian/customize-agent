import { useEffect } from 'react';
import { useRouter } from 'next/router';

export default function KnowledgeIndexPage() {
  const router = useRouter();
  useEffect(() => { router.replace('/knowledge/manage'); }, [router]);
  return null;
}
