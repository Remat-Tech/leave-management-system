/** Passwords, hashed. NFR SEC 01, LMS 110. */

import { randomBytes, scrypt as scryptCallback, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';

/** What one hash costs to compute, which is what one guess costs to test. */
interface ScryptCost {
  N: number;
  r: number;
  p: number;
  maxmem: number;
}

const scrypt = promisify(scryptCallback) as (
  password: string | Buffer,
  salt: string | Buffer,
  keylen: number,
  options: ScryptCost,
) => Promise<Buffer>;

/** The cost of hashing one password, and therefore the cost of testing one guess. */
const COST: ScryptCost = { N: 32_768, r: 8, p: 1, maxmem: 128 * 32_768 * 8 * 2 };

/** 16 bytes, which is the salt length the Node documentation uses. */
const SALT_BYTES = 16;

/** 32 bytes of derived key. */
const KEY_BYTES = 32;

/** The only algorithm this file has ever written. */
const SCRYPT = 'scrypt';

/**
 * A password nobody set, hashed once, so that verifying against an account with no password costs what verifying against an account with one costs.
 */
let decoy: string | undefined;

/** Hashes a password for storage. */
export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(SALT_BYTES);
  const key = await scrypt(normalise(password), salt, KEY_BYTES, COST);

  return [
    SCRYPT,
    `N=${COST.N},r=${COST.r},p=${COST.p}`,
    salt.toString('base64url'),
    key.toString('base64url'),
  ].join('$');
}

/**
 * Whether a password matches a stored hash.
 *
 * `stored` is nullable because the column is: an account that exists but has no
 * password yet is the ordinary state of a login between being provisioned and
 * being used. That case answers false, and it answers it after doing the same
 * work a real verification would do. Returning early would make "no password
 * set" measurably faster than "wrong password", which tells whoever is measuring
 * which accounts are half provisioned — the ones worth attacking.
 *
 * The same is true of a hash this file cannot read: a corrupted value, or one
 * written by an algorithm added later and then removed. Both are false, both
 * cost the same, and neither throws. A throw here would be a stack trace in the
 * sign in path holding a password in one of its frames.
 */
export async function verifyPassword(password: string, stored: string | null): Promise<boolean> {
  const parsed = parse(stored ?? (await theDecoy()));

  if (parsed === undefined) {
    // Unreadable. Do the work anyway, then say no.
    await scrypt(normalise(password), randomBytes(SALT_BYTES), KEY_BYTES, COST);
    return false;
  }

  // Both buffers are the same length by construction — the derived one is asked
  // for at the length of the stored one — which is what timingSafeEqual requires.
  const key = await scrypt(normalise(password), parsed.salt, parsed.key.length, parsed.cost);
  const matched = timingSafeEqual(key, parsed.key);

  /* The decoy's password is 32 random bytes, so a match against it is not a
     thing that happens. Saying so anyway costs nothing and means an account with
     no password cannot become a signed in one through any later edit of this
     function. */
  return matched && stored !== null;
}

/**
 * Whether a stored hash was made with the current cost.
 *
 * The sign in path calls this after a successful verification and rewrites the
 * hash when it says no, which is how a raised cost reaches passwords that were
 * set before it was raised. Nobody has to be asked to change their password and
 * nothing has to be migrated: the rewrite happens at the one moment the plain
 * password is legitimately in memory.
 */
export function needsRehash(stored: string | null): boolean {
  const parsed = parse(stored);

  return (
    parsed === undefined ||
    parsed.cost.N !== COST.N ||
    parsed.cost.r !== COST.r ||
    parsed.cost.p !== COST.p ||
    parsed.key.length !== KEY_BYTES
  );
}

/**
 * Unicode normalisation, so that a password typed on one keyboard verifies when
 * it is typed on another.
 *
 * `é` has two encodings — one code point, or `e` followed by a combining accent
 * — and which one a browser sends depends on the platform and the input method.
 * They are the same character to the person typing it and different bytes to
 * scrypt. NFC folds them together. This matters for Ghanaian names and for
 * anybody whose passphrase is in a language with accents, and it is invisible
 * until somebody changes laptop and can no longer sign in.
 *
 * NFC rather than NFKC: NFKC also folds characters that merely look similar,
 * which would quietly make two genuinely different passwords the same one.
 */
function normalise(password: string): string {
  return password.normalize('NFC');
}

interface ParsedHash {
  cost: ScryptCost;
  salt: Buffer;
  key: Buffer;
}

/**
 * Reads a stored hash back into its parts, or undefined if it is not one.
 *
 * Total, and deliberately so. Everything this parses came out of a database
 * column that several things can write, so "this is not a hash I recognise" is a
 * value to return rather than an exception to raise in the middle of a sign in.
 */
function parse(stored: string | null): ParsedHash | undefined {
  if (stored === null) {
    return undefined;
  }

  const parts = stored.split('$');
  if (parts.length !== 4 || parts[0] !== SCRYPT) {
    return undefined;
  }

  const [, parameters, salt, key] = parts;

  const cost = { ...COST };
  for (const parameter of parameters.split(',')) {
    const [name, value] = parameter.split('=');
    const parsed = Number(value);

    if (!Number.isInteger(parsed) || parsed <= 0) {
      return undefined;
    }
    if (name === 'N') cost.N = parsed;
    else if (name === 'r') cost.r = parsed;
    else if (name === 'p') cost.p = parsed;
    else return undefined;
  }

  /* Memory is derived from the parameters that were read rather than taken from
     the current constant, so a hash made when the cost was lower still verifies
     and one made when it was higher does not fail for want of headroom. */
  cost.maxmem = 128 * cost.N * cost.r * 2;

  const saltBytes = Buffer.from(salt, 'base64url');
  const keyBytes = Buffer.from(key, 'base64url');

  /* base64url decoding never fails; it discards what it cannot read. Empty
     buffers are what that looks like, and a zero length key would make
     timingSafeEqual compare nothing and agree. */
  if (saltBytes.length === 0 || keyBytes.length === 0) {
    return undefined;
  }

  return { cost, salt: saltBytes, key: keyBytes };
}

async function theDecoy(): Promise<string> {
  decoy ??= await hashPassword(randomBytes(32).toString('base64url'));
  return decoy;
}
