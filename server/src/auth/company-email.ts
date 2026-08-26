/**
 * Company email addresses.
 *
 * Sign in is by company address only. A personal address is refused when an
 * employee record is created and again when somebody tries to sign in, because
 * those are two different doors into the same building. NFR SEC 01.
 *
 * The accepted list is configuration, not code: it lives in
 * ALLOWED_EMAIL_DOMAINS so that adding a subsidiary's domain does not need a
 * release. Decided for Remat Holdings: `rematholdings.com`, and nothing else.
 *
 * Matching is exact. `hr.rematholdings.com` is not `rematholdings.com` and is
 * refused unless somebody adds it deliberately. Accepting subdomains would mean
 * anyone able to create one could mint themselves a valid company identity.
 */

export class NotACompanyEmail extends Error {
  constructor(email: string) {
    super(`${email} is not a company address. Sign in is by company email only.`);
    this.name = 'NotACompanyEmail';
  }
}

/**
 * Reads the accepted domains from configuration.
 *
 * Throws when the list is missing or empty rather than treating it as "no
 * restriction". An empty allow list must lock everybody out, never let everybody
 * in: the failure has to be loud and safe, not quiet and open.
 */
export function allowedDomains(env: NodeJS.ProcessEnv = process.env): string[] {
  const domains = parseDomains(env.ALLOWED_EMAIL_DOMAINS ?? '');

  if (domains.length === 0) {
    throw new Error(
      'ALLOWED_EMAIL_DOMAINS is empty. Sign in is restricted to company ' +
        'addresses, so there is no safe way to interpret an empty list. ' +
        'See .env.example.',
    );
  }

  return domains;
}

/** Splits and tidies the configured value. Tolerates spaces and stray commas. */
export function parseDomains(value: string): string[] {
  return value
    .split(',')
    .map((domain) => domain.trim().toLowerCase())
    .filter((domain) => domain.length > 0);
}

/**
 * Whether an address belongs to one of the accepted domains.
 *
 * Deliberately strict about the shape of the address. This is not a full
 * RFC 5322 validation and is not trying to be; it is the narrow question of
 * whether the part after the @ is a domain we accept, answered in a way that
 * cannot be talked into a yes.
 */
export function isCompanyEmail(email: string, domains: string[]): boolean {
  const domain = domainOf(email);
  return domain !== null && domains.includes(domain);
}

/** The same check, for the paths where refusing is the point. */
export function assertCompanyEmail(email: string, domains: string[]): void {
  if (!isCompanyEmail(email, domains)) {
    throw new NotACompanyEmail(email);
  }
}

/**
 * The domain part, lowercased, or null if the address is not one this system
 * will accept at all.
 */
function domainOf(email: string): string | null {
  const trimmed = email.trim();

  // Whitespace anywhere means either a typo or an attempt to smuggle something
  // past a later parser. Neither is a company address.
  if (trimmed.length === 0 || /\s/.test(trimmed)) {
    return null;
  }

  // Exactly one @. A quoted local part may legally contain more, but no member
  // of staff has one, and allowing them means deciding which @ is the real
  // separator, which is exactly the ambiguity worth refusing.
  const parts = trimmed.split('@');
  if (parts.length !== 2) {
    return null;
  }

  const [local, domain] = parts;
  if (local.length === 0 || domain.length === 0) {
    return null;
  }

  const normalised = domain.toLowerCase();

  // A trailing dot is a legal, fully qualified domain name and resolves to the
  // same host, so it would slip past a plain string comparison.
  if (normalised.endsWith('.') || normalised.startsWith('.') || normalised.includes('..')) {
    return null;
  }

  return normalised;
}
