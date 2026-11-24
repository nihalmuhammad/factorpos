'use client';

// FactorPOS: ZATCA e-invoicing settings — seller details, onboarding this till with a
// FATOORA OTP, and switching simulation invoices on (roadmap phase 5).

import { useCallback, useEffect, useState } from 'react';
import { CheckCircle2, Circle, FileBadge, Loader2, XCircle } from 'lucide-react';
import toast from 'react-hot-toast';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Ltr } from '@/components/layout/Ltr';
import { useFormatDate } from '@/hooks/useFormatDate';
import api from '@/lib/api';
import { useZatcaText } from './zatca-text';

const SELLER_FIELDS = [
  { key: 'crn', numeric: true, maxLength: 10 },
  { key: 'street' },
  { key: 'building_number', numeric: true, maxLength: 4 },
  { key: 'district' },
  { key: 'city' },
  { key: 'postal_code', numeric: true, maxLength: 5 },
  { key: 'branch_name' },
  { key: 'industry' },
] as const;

const ERROR_CODES = [
  'zatca_otp_required',
  'zatca_otp_invalid',
  'zatca_not_onboarded',
  'zatca_secure_storage_unavailable',
  'zatca_onboarding_busy',
] as const;
type ErrorCode = (typeof ERROR_CODES)[number];

type SellerKey = (typeof SELLER_FIELDS)[number]['key'];
type OnboardingStatus =
  | 'not_started'
  | 'started'
  | 'compliance_issued'
  | 'checks_passed'
  | 'active';

interface Check {
  document: 'invoice' | 'credit_note' | 'debit_note';
  passed: boolean;
  errors: string[];
  warnings: string[];
}

interface ZatcaOverview {
  environment: string;
  seller: Record<SellerKey, string> & { name: string; vat_number: string };
  seller_check: { complete: boolean; problem: string | null };
  vat_check?: { ok: boolean; problem: string | null };
  onboarding: {
    status: OnboardingStatus;
    egsUuid: string | null;
    checks: Check[];
    lastError: string | null;
    updatedAt: string | null;
  };
  certificate: {
    egsUuid: string | null;
    expiresAt: string | null;
    createdAt: string;
    onboarded: boolean;
  } | null;
}

const STEP_ORDER: OnboardingStatus[] = ['started', 'compliance_issued', 'checks_passed', 'active'];

function StepIcon({ done, failed }: { done: boolean; failed?: boolean }) {
  if (failed) return <XCircle size={16} className="text-destructive shrink-0" />;
  if (done) return <CheckCircle2 size={16} className="text-emerald-600 shrink-0" />;
  return <Circle size={16} className="text-muted-foreground shrink-0" />;
}

export function ZatcaSettingsCard({ canManage = false }: { canManage?: boolean }) {
  const zt = useZatcaText();
  const { formatDate } = useFormatDate();
  const [data, setData] = useState<ZatcaOverview | null>(null);
  const [form, setForm] = useState<Record<SellerKey, string> | null>(null);
  const [otp, setOtp] = useState('');
  const [busy, setBusy] = useState<'seller' | 'onboarding' | 'environment' | null>(null);

  const apply = useCallback((next: ZatcaOverview) => {
    setData(next);
    setForm(
      Object.fromEntries(SELLER_FIELDS.map(({ key }) => [key, next.seller[key] ?? ''])) as Record<
        SellerKey,
        string
      >,
    );
  }, []);

  useEffect(() => {
    api
      .get('/zatca')
      .then((res) => apply(res.data))
      .catch((err) => console.warn('[ZATCA] load failed:', (err as Error)?.message || err));
  }, [apply]);

  // Known refusals are localized; ZATCA's own messages are shown as ZATCA sent them.
  const errorText = (err: unknown) => {
    const body = (err as { response?: { data?: { error?: string; code?: string } } })?.response
      ?.data;
    const code = body?.code as ErrorCode | undefined;
    if (code && (ERROR_CODES as readonly string[]).includes(code)) return zt(`errors.${code}`);
    return body?.error || zt('genericError');
  };

  const saveSeller = async () => {
    if (!form) return;
    setBusy('seller');
    try {
      const res = await api.put('/zatca/seller', form);
      apply(res.data);
      toast.success(zt('sellerSaved'));
    } catch (err) {
      toast.error(errorText(err));
    } finally {
      setBusy(null);
    }
  };

  const onboard = async () => {
    setBusy('onboarding');
    try {
      const res = await api.post('/zatca/onboarding', otp ? { otp } : {});
      apply(res.data);
      setOtp('');
      toast.success(zt('onboardingDone'));
    } catch (err) {
      toast.error(errorText(err));
      api
        .get('/zatca')
        .then((res) => apply(res.data))
        .catch(() => undefined);
    } finally {
      setBusy(null);
    }
  };

  const setEnvironment = async (environment: 'disabled' | 'simulation') => {
    setBusy('environment');
    try {
      const res = await api.put('/zatca/environment', { environment });
      apply(res.data);
      toast.success(environment === 'simulation' ? zt('issuingOn') : zt('issuingOff'));
    } catch (err) {
      toast.error(errorText(err));
    } finally {
      setBusy(null);
    }
  };

  if (!data || !form) {
    return (
      <Card data-setting-section="zatca-e-invoicing">
        <CardContent className="py-6 text-sm text-muted-foreground">{zt('loading')}</CardContent>
      </Card>
    );
  }

  const status = data.onboarding.status;
  const reached = (step: OnboardingStatus) =>
    STEP_ORDER.indexOf(status) >= STEP_ORDER.indexOf(step);
  const needsOtp = status === 'not_started' || status === 'started' || status === 'active';
  const checkFailed = data.onboarding.checks.some((c) => !c.passed);
  const issuing = data.environment === 'simulation';
  const dirty = SELLER_FIELDS.some(({ key }) => (form[key] ?? '') !== (data.seller[key] ?? ''));

  return (
    <Card data-setting-section="zatca-e-invoicing">
      <CardContent className="space-y-6 py-6">
        <div className="flex items-start gap-2">
          <FileBadge size={20} className="text-brand mt-0.5" />
          <div>
            <h2 className="font-semibold text-foreground">{zt('title')}</h2>
            <p className="text-xs text-muted-foreground mt-0.5">{zt('description')}</p>
          </div>
        </div>

        {/* Seller details */}
        <section className="space-y-3">
          <h3 className="text-sm font-medium">{zt('sellerTitle')}</h3>
          <div className="grid gap-3 sm:grid-cols-2 text-sm">
            <div>
              <div className="text-xs text-muted-foreground">{zt('sellerName')}</div>
              <div>{data.seller.name || '—'}</div>
            </div>
            <div>
              <div className="text-xs text-muted-foreground">{zt('vatNumber')}</div>
              <Ltr>{data.seller.vat_number || '—'}</Ltr>
            </div>
          </div>
          <p className="text-xs text-muted-foreground">{zt('sellerNameHint')}</p>
          <div className="grid gap-3 sm:grid-cols-2">
            {SELLER_FIELDS.map((field) => {
              const id = `zatca-${field.key}`;
              const numeric = 'numeric' in field && field.numeric;
              return (
                <div key={field.key} className="space-y-1">
                  <Label htmlFor={id}>{zt(`fields.${field.key}`)}</Label>
                  <Input
                    id={id}
                    value={form[field.key]}
                    disabled={!canManage || busy !== null}
                    inputMode={numeric ? 'numeric' : undefined}
                    dir={numeric ? 'ltr' : undefined}
                    maxLength={'maxLength' in field ? field.maxLength : 200}
                    onChange={(e) => setForm({ ...form, [field.key]: e.target.value })}
                  />
                </div>
              );
            })}
          </div>
          {!data.seller_check.complete && data.seller_check.problem && (
            <p className="text-xs text-amber-700 dark:text-amber-400">
              {data.seller_check.problem}
            </p>
          )}
          <Button onClick={saveSeller} disabled={!canManage || !dirty || busy !== null}>
            {busy === 'seller' ? <Loader2 className="size-4 animate-spin" /> : null}
            {zt('saveSeller')}
          </Button>
        </section>

        {/* Onboarding */}
        <section className="space-y-3 border-t pt-5">
          <div>
            <h3 className="text-sm font-medium">{zt('onboardingTitle')}</h3>
            <p className="text-xs text-muted-foreground mt-0.5">{zt('onboardingDescription')}</p>
          </div>
          <ol className="space-y-2 text-sm">
            <li className="flex items-center gap-2">
              <StepIcon done={reached('compliance_issued')} />
              {zt('stepCompliance')}
            </li>
            <li className="flex items-start gap-2">
              <StepIcon
                done={reached('checks_passed')}
                failed={status === 'compliance_issued' && checkFailed}
              />
              <div>
                {zt('stepChecks')}
                {data.onboarding.checks.length > 0 && (
                  <ul className="mt-1 space-y-0.5 text-xs text-muted-foreground">
                    {data.onboarding.checks.map((check) => (
                      <li key={check.document}>
                        {zt(`documents.${check.document}`)}:{' '}
                        {check.passed ? zt('passed') : zt('failed')}
                        {check.warnings.length > 0
                          ? ` (${check.warnings.length === 1 ? zt('warningsOne') : zt('warningsMany', { count: check.warnings.length })})`
                          : ''}
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            </li>
            <li className="flex items-center gap-2">
              <StepIcon done={reached('active')} />
              {zt('stepCertificate')}
            </li>
          </ol>

          {data.certificate?.onboarded && (
            <div className="rounded-md border bg-muted/40 p-3 text-xs space-y-1">
              <div>
                {zt('certificateExpires')}:{' '}
                {data.certificate.expiresAt ? formatDate(data.certificate.expiresAt) : '—'}
              </div>
              <div>
                {zt('tillId')}: <Ltr>{data.certificate.egsUuid}</Ltr>
              </div>
            </div>
          )}

          {data.onboarding.lastError && (
            <div className="rounded-md border border-destructive/40 bg-destructive/5 p-3 text-xs">
              <div className="font-medium text-destructive">{zt('lastError')}</div>
              <Ltr as="div" className="mt-1 break-words">
                {data.onboarding.lastError}
              </Ltr>
            </div>
          )}

          <div className="flex flex-wrap items-end gap-3">
            {needsOtp && (
              <div className="space-y-1">
                <Label htmlFor="zatca-otp">{zt('otp')}</Label>
                <Input
                  id="zatca-otp"
                  className="w-36"
                  dir="ltr"
                  inputMode="numeric"
                  autoComplete="one-time-code"
                  maxLength={6}
                  value={otp}
                  disabled={!canManage || busy !== null}
                  onChange={(e) => setOtp(e.target.value.replace(/\D/g, ''))}
                />
              </div>
            )}
            <Button
              onClick={onboard}
              disabled={
                !canManage ||
                busy !== null ||
                !data.seller_check.complete ||
                (needsOtp && otp.length !== 6)
              }
            >
              {busy === 'onboarding' ? <Loader2 className="size-4 animate-spin" /> : null}
              {status === 'active'
                ? zt('renew')
                : status === 'not_started'
                  ? zt('onboard')
                  : zt('resume')}
            </Button>
          </div>
          <p className="text-xs text-muted-foreground">{zt('otpHint')}</p>
        </section>

        {/* Issuance switch */}
        <section className="space-y-3 border-t pt-5">
          <div>
            <h3 className="text-sm font-medium">{zt('issuingTitle')}</h3>
            <p className="text-xs text-muted-foreground mt-0.5">
              {issuing ? zt('issuingOnDescription') : zt('issuingOffDescription')}
            </p>
          </div>
          <Button
            variant={issuing ? 'outline' : 'default'}
            onClick={() => setEnvironment(issuing ? 'disabled' : 'simulation')}
            disabled={
              !canManage ||
              busy !== null ||
              (!issuing && (status !== 'active' || data.vat_check?.ok === false))
            }
          >
            {busy === 'environment' ? <Loader2 className="size-4 animate-spin" /> : null}
            {issuing ? zt('switchOff') : zt('switchOn')}
          </Button>
          {!issuing && data.vat_check?.ok === false && (
            <p className="text-xs text-amber-700 dark:text-amber-400">{zt('vatRequired')}</p>
          )}
          <p className="text-xs text-muted-foreground">{zt('productionNote')}</p>
        </section>
      </CardContent>
    </Card>
  );
}
