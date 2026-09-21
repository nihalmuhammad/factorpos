import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  formatCurrencyForTenant,
  formatDateForTenant,
  formatNumberForTenant,
  getCountryByCode,
} from '../main/countries';
import { FACTORPOS_DEFAULTS } from '../shared/factorpos-defaults';

const ARABIC_INDIC_DIGITS = /[\u0660-\u0669\u06f0-\u06f9]/;

test('IR country profile properties', () => {
  const ir = getCountryByCode('IR');
  assert.ok(ir, 'IR country profile should exist');
  assert.equal(ir.code, 'IR');
  assert.equal(ir.locale, 'fa-IR');
  assert.equal(ir.currency, 'IRR');
  assert.equal(ir.timezone, 'Asia/Tehran');
  assert.equal(ir.dialCode, '+98');
  assert.equal(ir.taxIdLabel, 'Economic Code');
  assert.equal(ir.taxName, 'VAT');
  assert.equal(ir.taxIdFormat, undefined, 'No tax ID format should be enforced for IR');
});

test('SA country profile offers locale and Western digits', () => {
  const sa = getCountryByCode('SA');
  assert.ok(sa, 'SA country profile should exist');
  assert.equal(sa.currency, 'SAR');
  assert.equal(sa.timezone, 'Asia/Riyadh');
  assert.deepEqual(sa.localeOptions?.digits, ['locale', 'latin']);
});

test('FactorPOS onboarding defaults are Saudi, English, and Latin-digit based', () => {
  assert.deepEqual(FACTORPOS_DEFAULTS, {
    country: 'SA',
    currency: 'SAR',
    timezone: 'Asia/Riyadh',
    language: 'en',
    numberDigits: 'latin',
  });
});

test('Saudi tenant values render with Western digits when using FactorPOS defaults', () => {
  const preferences = { digits: FACTORPOS_DEFAULTS.numberDigits };
  const amount = formatCurrencyForTenant(1234.5, 'SA', 'SAR', preferences);
  const quantity = formatNumberForTenant(9876.5, 'SA', preferences);
  const date = formatDateForTenant(
    new Date('2026-09-20T12:30:00Z'),
    'SA',
    FACTORPOS_DEFAULTS.timezone,
    preferences,
    { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' },
  );

  for (const [label, value] of Object.entries({ amount, quantity, date })) {
    assert.match(value, /[0-9]/, `${label} should contain Western digits: ${value}`);
    assert.doesNotMatch(value, ARABIC_INDIC_DIGITS, `${label} should not contain Arabic-Indic digits: ${value}`);
  }
});
