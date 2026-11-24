'use client';

// FactorPOS: a bar across the dashboard when ZATCA documents are close to (or past) the
// 24-hour reporting limit, or were rejected (roadmap phase 6). Hidden when all is well.

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { AlertTriangle } from 'lucide-react';
import api from '@/lib/api';
import { tenantCan } from '@/lib/permissions';
import { useAuthStore } from '@/store/auth';
import { useZatcaText } from './zatca-text';
import { useEdition } from '@/hooks/useEdition';

const POLL_MS = 5 * 60_000;

interface Summary {
  nearLimit: number;
  overdue: number;
  rejected: number;
}

export function ZatcaReportingAlert() {
  const zt = useZatcaText();
  const tenant = useAuthStore((s) => s.currentTenant);
  const { zatca } = useEdition();
  const enabled = zatca && tenantCan(tenant, 'reports.view');
  const [summary, setSummary] = useState<Summary | null>(null);

  useEffect(() => {
    if (!enabled) return;
    let active = true;
    const load = () =>
      api
        .get('/zatca/reporting')
        .then((res) => active && setSummary(res.data))
        .catch(() => undefined);
    void load();
    const timer = window.setInterval(load, POLL_MS);
    return () => {
      active = false;
      window.clearInterval(timer);
    };
  }, [enabled]);

  if (!enabled || !summary) return null;
  const lines = [
    summary.overdue > 0 && zt('alert.overdue', { count: summary.overdue }),
    summary.nearLimit > 0 && zt('alert.nearLimit', { count: summary.nearLimit }),
    summary.rejected > 0 && zt('alert.rejected', { count: summary.rejected }),
  ].filter(Boolean) as string[];
  if (lines.length === 0) return null;
  const severe = summary.overdue > 0 || summary.rejected > 0;

  return (
    <div
      role="alert"
      className={`flex flex-wrap items-center gap-2 border-b px-4 py-2 text-sm shrink-0 ${
        severe
          ? 'bg-red-50 text-red-900 dark:bg-red-950/40 dark:text-red-200'
          : 'bg-amber-50 text-amber-900 dark:bg-amber-950/40 dark:text-amber-200'
      }`}
    >
      <AlertTriangle className="size-4 shrink-0" />
      <span className="flex-1">{lines.join(' ')}</span>
      <Link href="/zatca" className="font-medium underline">
        {zt('alert.open')}
      </Link>
    </div>
  );
}
