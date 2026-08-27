/**
 * Passwords, hashed.
 *
 * The first factor of NFR SEC 01. The second is the emailed code of LMS 110,
 * which is why this file is careful to be one half of a door rather than the
 * whole of one: nothing here decides that somebody may sign in, only whether the
 * password they typed is the password that was set.
 *
 * `scrypt`, from `node:crypto`, and no dependency. Not because a dependency
 * would be wrong — bcrypt and argon2 are both fine — but because the two that
 * are commonly reached for are native modules, and a native module has to be
 * built for the platform of every machine, every container and every continuous
 * integration runner that touches this repository. scrypt is a memory hard
 * function designed for exactly this, it is in the standard library of the
 * runtime the README pins, and it is what the Node documentation points at for
 * storing passwords.
 *
 * Three properties are what make this safe, and all three are easy to lose:
 *
 *   Every password gets its own salt, so two colleagues who chose the same
 *   password do not have the same hash, and a table of precomputed hashes is
 *   worth nothing against this column.
 *
 *   The comparison is timing safe. A `===` on two hashes returns as soon as it
 *   finds a differing byte, and the time it took is a measurement of how much of
 *   the guess was right, which is a way of guessing a hash one byte at a time.
 *
 *   The cost parameters are stored in the hash rather than only in this file.
 *   Raising them later has to leave every existing password verifiable, and it
 *   only does if each hash says what it was made with. See {@link hashPassword}.
 */

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

/**
 * The cost of hashing one password, and therefore the cost of testing one guess.
 *
 * N is the work factor and the only one worth turning up. 2^15 puts a single
 * hash at roughly a tenth of a second on the hardware this will run on, which
 * nobody signing in notices and which makes an offline attack against a stolen
 * copy of this column expensive per guess rather than free.
 *
 * r and p are the block size and parallelisation, at the values the scrypt paper
 * and the Node documentation use. They are here to be recorded in the hash, not
 * to be tuned.
 *
 * Memory follows from N and r: 128 * N * r is 16MB, which is over the 32MB
 * default `maxmem` allows for once the internal buffers are counted, so maxmem is
 * set explicitly. Leaving it default is how raising N one notch turns every sign
 * in into an error rather than a slower success.
 */
const COST: ScryptCost = { N: 32_768, r: 8, p: 1, maxmem: 128 * 32_768 * 8 * 2 };

/** 16 bytes, which is the salt length the Node documentation uses. */
const SALT_BYTES = 16;

/** 32 bytes of derived key. Longer buys nothing; shorter is a smaller haystack. */
const KEY_BYTES = 32;

/**
 * The only algorithm this file has ever written. A second one arriving is what
 * the field exists for; see {@link verifyPassword}.
 */
const SCRYPT = 'scrypt';

/**
 * A password nobody set, hashed once, so that verifying against an account with
 * no password costs what verifying against an account with one costs.
 *
 * Built lazily and kept, because building it costs a real hash and it is the
 * same value every time.
 */
let decoy: string | undefined;

/**
 * Hashes a password for storage.
 *
 * The result is self describing: algorithm, cost, salt, key, separated by `$`.
 * That is deliberate and it is the thing that makes this changeable. When the
 * cost is raised — and it should be, every few years — the hashes already in the
 * column still carry the cost they were made with, so they keep verifying, and
 * each one can be quietly rewritten at the next successful sign in, which is the
 * only moment the plain password is in hand. A file level constant instead of a
 * stored one makes every existing password fail on the day somebody raises it.
 *
 * Encoded base64url so that nothing in the string needs escaping wherever it
 * travels, and so `$` is unambiguously the separator.
 *
 * The caller is expected to have checked that the password is one this system
 * accepts; {@link assertUsablePassword} in ./sign-in.ts is that check. This
 * function will hash anything, including the empty string, because refusing is a
 * rule about people and this file is about bytes.
 */
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
