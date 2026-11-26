import { ValidationError } from './errors.js';

/**
 * Money is always an integer number of minor units (cents for USD, santim
 * for ETB, whole yen for JPY). Never use floats: 0.1 + 0.2 !== 0.3.
 */

/** Digits after the decimal point for a currency: USD 2, JPY 0, KWD 3. */
export function minorUnitDigits(currency: string): number {
  return new Intl.NumberFormat('en', { style: 'currency', currency }).resolvedOptions().maximumFractionDigits ?? 2;
}

export function assertMinorUnits(value: unknown, field = 'amount'): asserts value is number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value)) {
    throw new ValidationError(`${field} must be an integer number of minor units (e.g. cents)`, { field, value });
  }
}

/** "12.34" USD -> 1234. Parses the string by hand so no float is ever involved. */
export function toMinorUnits(decimal: string, currency: string): number {
  const digits = minorUnitDigits(currency);
  const match = /^(-)?(\d+)(?:\.(\d+))?$/.exec(decimal.trim());
  if (!match) throw new ValidationError(`"${decimal}" is not a decimal amount`);
  const [, sign, whole = '0', frac = ''] = match;
  if (frac.length > digits) throw new ValidationError(`${currency} allows at most ${digits} decimal places, got "${decimal}"`);
  const minor = Number(whole + frac.padEnd(digits, '0'));
  if (!Number.isSafeInteger(minor)) throw new ValidationError(`"${decimal}" is too large`);
  return sign ? -minor : minor;
}

/** 1234 USD -> "$12.34". Uses integer maths, then formats. */
export function formatMoney(minor: number, currency: string): string {
  const digits = minorUnitDigits(currency);
  const sign = minor < 0 ? '-' : '';
  const abs = Math.abs(minor).toString().padStart(digits + 1, '0');
  const whole = abs.slice(0, abs.length - digits) || '0';
  const frac = digits ? '.' + abs.slice(abs.length - digits) : '';
  return `${sign}${Number(whole).toLocaleString('en')}${frac} ${currency}`;
}
