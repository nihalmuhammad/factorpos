'use client';

// FactorPOS: the accountant's daily ZATCA review (roadmap phase 6). Reporting itself is
// automatic; this page shows each day's documents and their ZATCA verdicts, sends
// waiting ones by hand, and records that the day was reviewed.

import { useCallback, useEffect, useState } from 'react';
import { Loader2, RefreshCw, Send, ShieldCheck } from 'lucide-react';
import toast from 'react-hot-toast';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Ltr } from '@/components/layout/Ltr';
import { useZatcaText } from '@/components/settings/zatca-text';
import { useFormatCurrency } from '@/hooks/useFormatCurrency';
import { useFormatDate } from '@/hooks/useFormatDate';
import api from '@/lib/api';
import { useAuthStore } from '@/store/auth';

type Status = 'pending' | 'reported' | 'warning' | 'rejected' | 'review';

interface ReportingDocument {
  id: string;
  counter: number;
  type: 'simplified_invoice' | 'simplified_credit_note';
  number: string;
  issueTime: string;
  issuedAt: string;
  totalWithVatMinor: number;
  vatMinor: number;
  status: Status;
  attempts: number;
  nextAttemptAt: string | null;
  errors: string[];
  warnings: string[];
  lastError: string | null;
}

interface DayView {
  date: string;
  documents: ReportingDocument[];
  reviewed: { at: string; by: string } | null;
  summary: { waiting: number; nearLimit: number; overdue: number; rejected: number };
}

const STATUS_STYLE: Record<Status, string> = {
  pending: 'bg-amber-100 text-amber-900 dark:bg-amber-900/30 dark:text-amber-200',
  reported: 'bg-emerald-100 text-emerald-900 dark:bg-emerald-900/30 dark:text-emerald-200',
  warning: 'bg-yellow-100 text-yellow-900 dark:bg-yellow-900/30 dark:text-yellow-200',
  rejected: 'bg-red-100 text-red-900 dark:bg-red-900/30 dark:text-red-200',
  review: 'bg-red-100 text-red-900 dark:bg-red-900/30 dark:text-red-200',
};

function localToday(timeZone: string): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: timeZone || 'Asia/Riyadh',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date());
  return parts; // en-CA formats as YYYY-MM-DD
}

const utcDate = (sql: string) => new Date(sql.includes('T') ? sql : `${sql.replace(' ', 'T')}Z`);

export default function ZatcaReviewPage() {
  const zt = useZatcaText();
  const formatCurrency = useFormatCurrency();
  const { formatDateTime } = useFormatDate();
  const tenant = useAuthStore((s) => s.currentTenant);
  const [date, setDate] = useState(() => localToday(tenant?.timezone || ''));
  const [view, setView] = useState<DayView | null>(null);
  const [environment, setEnvironment] = useState<string | null>(null);
  const [busy, setBusy] = useState<'load' | 'send' | 'review' | null>('load');

  const errorText = (err: unknown) =>
    (err as { response?: { data?: { error?: string } } })?.response?.data?.error ||
    zt('review.genericError');

  const load = useCallback(async (day: string) => {
    setBusy('load');
    try {
      const [res, overview] = await Promise.all([
        api.get('/zatca/reporting/day', { params: { date: day } }),
        api.get('/zatca').catch(() => null),
      ]);
      setView(res.data);
      if (overview) setEnvironment(overview.data.environment);
    } catch (err) {
      toast.error(errorText(err));
    } finally {
      setBusy(null);
    }
    // errorText only reads translations; reloading on its identity is unnecessary.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    void load(date);
  }, [date, load]);

  const send = async (documentIds?: string[]) => {
    setBusy('send');
    try {
      const res = await api.post('/zatca/reporting/send', { date, document_ids: documentIds });
      setView(res.data);
      toast.success(zt('review.sent'));
    } catch (err) {
      toast.error(errorText(err));
    } finally {
      setBusy(null);
    }
  };

  const markReviewed = async () => {
    setBusy('review');
    try {
      const res = await api.post('/zatca/reporting/review', { date });
      setView(res.data);
      toast.success(zt('review.reviewedToast'));
    } catch (err) {
      toast.error(errorText(err));
    } finally {
      setBusy(null);
    }
  };

  const documents = view?.documents ?? [];
  const waiting = documents.filter((doc) => doc.status === 'pending');
  const sign = (doc: ReportingDocument) => (doc.type === 'simplified_credit_note' ? -1 : 1);
  const dayTotal = documents.reduce((sum, doc) => sum + sign(doc) * doc.totalWithVatMinor, 0);
  const dayVat = documents.reduce((sum, doc) => sum + sign(doc) * doc.vatMinor, 0);

  return (
    <div className="mx-auto max-w-6xl space-y-4">
      <div>
        <h1 className="text-xl font-semibold">{zt('review.title')}</h1>
        <p className="text-sm text-muted-foreground">{zt('review.description')}</p>
      </div>

      {environment === 'disabled' && (
        <div className="rounded-md border bg-muted/40 p-3 text-sm">{zt('review.notEnabled')}</div>
      )}

      <Card>
        <CardContent className="flex flex-wrap items-end gap-3 py-4">
          <div className="space-y-1">
            <Label htmlFor="zatca-day">{zt('review.date')}</Label>
            <Input
              id="zatca-day"
              type="date"
              className="w-44"
              value={date}
              max={localToday(tenant?.timezone || '')}
              onChange={(e) => e.target.value && setDate(e.target.value)}
            />
          </div>
          <Button variant="outline" onClick={() => setDate(localToday(tenant?.timezone || ''))}>
            {zt('review.today')}
          </Button>
          <Button variant="outline" onClick={() => void load(date)} disabled={busy !== null}>
            <RefreshCw className="size-4" />
          </Button>
          <div className="flex-1" />
          <Button onClick={() => void send()} disabled={busy !== null || waiting.length === 0}>
            {busy === 'send' ? (
              <Loader2 className="size-4 animate-spin" />
            ) : (
              <Send className="size-4" />
            )}
            {zt('review.sendWaiting')} ({waiting.length})
          </Button>
          <Button
            variant="outline"
            onClick={() => void markReviewed()}
            disabled={busy !== null || documents.length === 0}
          >
            {busy === 'review' ? (
              <Loader2 className="size-4 animate-spin" />
            ) : (
              <ShieldCheck className="size-4" />
            )}
            {zt('review.markReviewed')}
          </Button>
        </CardContent>
      </Card>

      {view?.reviewed && (
        <div className="text-sm text-emerald-700 dark:text-emerald-400">
          {zt('review.reviewed', {
            by: view.reviewed.by,
            at: formatDateTime(utcDate(view.reviewed.at)),
          })}
        </div>
      )}

      <Card>
        <CardContent className="py-4">
          {busy === 'load' && !view ? (
            <p className="text-sm text-muted-foreground">{zt('review.loading')}</p>
          ) : documents.length === 0 ? (
            <p className="text-sm text-muted-foreground">{zt('review.empty')}</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="text-xs text-muted-foreground">
                  <tr className="border-b text-start">
                    <th className="py-2 pe-3 text-start">{zt('review.counter')}</th>
                    <th className="py-2 pe-3 text-start">{zt('review.number')}</th>
                    <th className="py-2 pe-3 text-start">{zt('review.type')}</th>
                    <th className="py-2 pe-3 text-start">{zt('review.time')}</th>
                    <th className="py-2 pe-3 text-end">{zt('review.total')}</th>
                    <th className="py-2 pe-3 text-end">{zt('review.vat')}</th>
                    <th className="py-2 pe-3 text-start">{zt('review.status')}</th>
                    <th className="py-2" />
                  </tr>
                </thead>
                <tbody>
                  {documents.map((doc) => (
                    <tr key={doc.id} className="border-b align-top last:border-0">
                      <td className="py-2 pe-3 tabular-nums">{doc.counter}</td>
                      <td className="py-2 pe-3">
                        <Ltr>{doc.number}</Ltr>
                      </td>
                      <td className="py-2 pe-3">
                        {doc.type === 'simplified_credit_note'
                          ? zt('review.creditNote')
                          : zt('review.invoice')}
                      </td>
                      <td className="py-2 pe-3 tabular-nums">
                        <Ltr>{doc.issueTime}</Ltr>
                      </td>
                      <td className="py-2 pe-3 text-end tabular-nums">
                        {formatCurrency((sign(doc) * doc.totalWithVatMinor) / 100)}
                      </td>
                      <td className="py-2 pe-3 text-end tabular-nums">
                        {formatCurrency((sign(doc) * doc.vatMinor) / 100)}
                      </td>
                      <td className="py-2 pe-3">
                        <span className={`rounded px-2 py-0.5 text-xs ${STATUS_STYLE[doc.status]}`}>
                          {zt(`review.statuses.${doc.status}`)}
                        </span>
                        {[...doc.errors, ...doc.warnings].length > 0 && (
                          <Ltr as="ul" className="mt-1 space-y-0.5 text-xs text-muted-foreground">
                            {[...doc.errors, ...doc.warnings].map((message) => (
                              <li key={message}>{message}</li>
                            ))}
                          </Ltr>
                        )}
                        {doc.status === 'pending' && doc.attempts > 0 && (
                          <div className="mt-1 text-xs text-muted-foreground">
                            {zt('review.attempts', {
                              count: doc.attempts,
                              at: doc.nextAttemptAt
                                ? formatDateTime(utcDate(doc.nextAttemptAt))
                                : '—',
                            })}
                            {doc.lastError && (
                              <Ltr as="div" className="break-words">
                                {doc.lastError}
                              </Ltr>
                            )}
                          </div>
                        )}
                      </td>
                      <td className="py-2 text-end">
                        {doc.status !== 'reported' && doc.status !== 'warning' && (
                          <Button
                            size="sm"
                            variant="outline"
                            disabled={busy !== null}
                            onClick={() => void send([doc.id])}
                          >
                            {zt('review.resend')}
                          </Button>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <div className="mt-3 text-sm">
                <span className="font-medium">{zt('review.totals')}: </span>
                {zt('review.totalsLine', {
                  count: documents.length,
                  total: formatCurrency(dayTotal / 100),
                  vat: formatCurrency(dayVat / 100),
                })}
              </div>
            </div>
          )}
        </CardContent>
      </Card>

      <p className="text-xs text-muted-foreground">{zt('review.correctionHint')}</p>
    </div>
  );
}
