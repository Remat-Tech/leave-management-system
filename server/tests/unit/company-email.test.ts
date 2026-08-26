import { describe, expect, it } from 'vitest';
import {
  allowedDomains,
  assertCompanyEmail,
  isCompanyEmail,
  NotACompanyEmail,
  parseDomains,
} from '../../src/auth/company-email.js';

/**
 * NFR SEC 01. Most of these are about the ways a domain check can be talked
 * into saying yes, because that is the failure that matters: letting an
 * outsider in is worse than turning a colleague away.
 */
const DOMAINS = ['rematholdings.com'];

describe('accepting company addresses', () => {
  it.each([
    'ama.mensah@rematholdings.com',
    'kwame.asante@rematholdings.com',
    'nana.owusu-ansah@rematholdings.com',
  ])('accepts %s', (email) => {
    expect(isCompanyEmail(email, DOMAINS)).toBe(true);
  });

  it('does not care about case', () => {
    expect(isCompanyEmail('Ama.Mensah@REMATHOLDINGS.COM', DOMAINS)).toBe(true);
  });

  it('tolerates surrounding whitespace, which forms and pasting introduce', () => {
    expect(isCompanyEmail('  ama.mensah@rematholdings.com  ', DOMAINS)).toBe(true);
  });

  it('accepts plus addressing, which is still the same mailbox', () => {
    expect(isCompanyEmail('ama.mensah+leave@rematholdings.com', DOMAINS)).toBe(true);
  });
});

describe('refusing everything else', () => {
  it.each([
    ['a personal address', 'ama.mensah@gmail.com'],
    ['a subdomain, which is a different domain', 'ama@hr.rematholdings.com'],
    ['a domain that merely ends the same way', 'attacker@notrematholdings.com'],
    ['the domain as a prefix of a longer one', 'attacker@rematholdings.com.evil.net'],
    ['the domain hidden in the local part', 'ama@rematholdings.com@evil.net'],
    ['a trailing dot, which resolves to the same host', 'ama@rematholdings.com.'],
    ['a leading dot', 'ama@.rematholdings.com'],
    ['a doubled dot', 'ama@rematholdings..com'],
    ['no domain at all', 'ama@'],
    ['no local part', '@rematholdings.com'],
    ['no @ at all', 'ama.rematholdings.com'],
    ['two @', 'ama@a@rematholdings.com'],
    ['an embedded space', 'ama mensah@rematholdings.com'],
    ['an embedded newline', 'ama@rematholdings.com\nevil@evil.net'],
    ['empty', ''],
    ['only whitespace', '   '],
  ])('refuses %s', (_label, email) => {
    expect(isCompanyEmail(email, DOMAINS)).toBe(false);
  });

  it('throws where refusing is the point', () => {
    expect(() => assertCompanyEmail('ama.mensah@gmail.com', DOMAINS)).toThrow(NotACompanyEmail);
  });

  it('says nothing where the address is fine', () => {
    expect(() => assertCompanyEmail('ama.mensah@rematholdings.com', DOMAINS)).not.toThrow();
  });
});

describe('reading the configured list', () => {
  it('takes the decided value from the environment', () => {
    const domains = allowedDomains({
      ALLOWED_EMAIL_DOMAINS: 'rematholdings.com',
    } as NodeJS.ProcessEnv);

    expect(domains).toEqual(['rematholdings.com']);
  });

  it('supports more than one domain, for a future subsidiary', () => {
    expect(parseDomains('rematholdings.com,remat.tech')).toEqual([
      'rematholdings.com',
      'remat.tech',
    ]);
  });

  it('forgives spacing and stray commas in the configured value', () => {
    expect(parseDomains(' Rematholdings.com , , REMAT.tech ')).toEqual([
      'rematholdings.com',
      'remat.tech',
    ]);
  });

  it.each([
    ['missing', {}],
    ['empty', { ALLOWED_EMAIL_DOMAINS: '' }],
    ['only separators', { ALLOWED_EMAIL_DOMAINS: ' , , ' }],
  ])('refuses to start when the list is %s', (_label, env) => {
    // An empty allow list must lock everybody out rather than let everybody in.
    // Failing closed is the whole point of the control.
    expect(() => allowedDomains(env as NodeJS.ProcessEnv)).toThrow(/ALLOWED_EMAIL_DOMAINS/);
  });

  it('never treats an empty list as no restriction', () => {
    // Guards the same property from the other direction: if allowedDomains were
    // ever softened to return [], nothing would match rather than everything.
    expect(isCompanyEmail('anyone@anywhere.example', [])).toBe(false);
  });
});
