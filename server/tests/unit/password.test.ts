import { randomBytes, scryptSync } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { hashPassword, needsRehash, verifyPassword } from '../../src/features/sign-in/password.js';

/**
 * NFR SEC 01, the storage half.
 *
 * These are slow by design: a hash that verifies in a microsecond is a hash an
 * attacker tests a billion of. The suite keeps the number of them small for that
 * reason, and each one that is here is guarding a property that is easy to lose
 * in a refactor and invisible when it is lost.
 */
const PASSWORD = 'correct horse battery staple';

describe('hashing a password', () => {
  it('never stores the password', async () => {
    const hash = await hashPassword(PASSWORD);

    expect(hash).not.toContain(PASSWORD);
    expect(hash).not.toContain('correct');
  });

  it('gives the same password a different hash every time', async () => {
    // Per password salt. Without it, two colleagues who chose the same password
    // have the same hash, and one stolen hash is two accounts.
    const [first, second] = await Promise.all([hashPassword(PASSWORD), hashPassword(PASSWORD)]);

    expect(first).not.toBe(second);
    await expect(verifyPassword(PASSWORD, first)).resolves.toBe(true);
    await expect(verifyPassword(PASSWORD, second)).resolves.toBe(true);
  });

  it('records the cost it used, so a later change can leave old hashes working', async () => {
    const hash = await hashPassword(PASSWORD);

    expect(hash).toMatch(/^scrypt\$N=\d+,r=\d+,p=\d+\$[\w-]+\$[\w-]+$/);
  });

  it('fits the column, which holds 255 characters', async () => {
    expect((await hashPassword(PASSWORD)).length).toBeLessThanOrEqual(255);
  });
});

describe('verifying a password', () => {
  it('accepts the password that was set', async () => {
    await expect(verifyPassword(PASSWORD, await hashPassword(PASSWORD))).resolves.toBe(true);
  });

  it.each([
    ['a different password', 'incorrect horse battery staple'],
    ['the right password with a character missing', 'correct horse battery stapl'],
    ['the right password in different case', 'Correct Horse Battery Staple'],
    ['an empty string', ''],
  ])('refuses %s', async (_label, attempt) => {
    await expect(verifyPassword(attempt, await hashPassword(PASSWORD))).resolves.toBe(false);
  });

  it('refuses everything when no password has been set', async () => {
    // The column is nullable and a provisioned account starts that way. Null is
    // "nobody can sign in", never "anybody can".
    await expect(verifyPassword(PASSWORD, null)).resolves.toBe(false);
    await expect(verifyPassword('', null)).resolves.toBe(false);
  });

  it.each([
    ['an empty hash', ''],
    ['something that is not a hash', 'not-a-hash'],
    ['an algorithm this file does not know', 'bcrypt$N=1,r=1,p=1$c2FsdA$aGFzaA'],
    ['a hash with a piece missing', 'scrypt$N=32768,r=8,p=1$c2FsdA'],
    ['a hash with no key', 'scrypt$N=32768,r=8,p=1$c2FsdA$'],
    ['a hash with no salt', 'scrypt$N=32768,r=8,p=1$$aGFzaA'],
    ['a cost that is not a number', 'scrypt$N=eight,r=8,p=1$c2FsdA$aGFzaA'],
    ['a cost of zero', 'scrypt$N=0,r=8,p=1$c2FsdA$aGFzaA'],
  ])('answers no rather than throwing for %s', async (_label, stored) => {
    // A throw in the sign in path is a stack trace with a password in one of its
    // frames. Every unreadable value is a refusal.
    await expect(verifyPassword(PASSWORD, stored)).resolves.toBe(false);
  });

  it('accepts a passphrase whose accents are encoded the other way', async () => {
    // 'é' has two encodings and which one arrives depends on the keyboard. They
    // are one character to the person typing and different bytes to scrypt.
    const composed = 'ekléktikos passphrase'.normalize('NFC');
    const decomposed = composed.normalize('NFD');

    expect(composed).not.toBe(decomposed);
    await expect(verifyPassword(decomposed, await hashPassword(composed))).resolves.toBe(true);
  });
});

describe('raising the cost later', () => {
  it('leaves a hash made at the current cost alone', async () => {
    expect(needsRehash(await hashPassword(PASSWORD))).toBe(false);
  });

  it.each([
    ['a lower work factor', 'scrypt$N=16384,r=8,p=1$c2FsdA$aGFzaA'],
    ['a different block size', 'scrypt$N=32768,r=4,p=1$c2FsdA$aGFzaA'],
    ['a shorter key', `scrypt$N=32768,r=8,p=1$c2FsdA$${'a'.repeat(20)}`],
    ['no password at all', null],
    ['something unreadable', 'not-a-hash'],
  ])('asks for a rewrite of %s', (_label, stored) => {
    expect(needsRehash(stored)).toBe(true);
  });

  it('still verifies a hash made with an older cost', async () => {
    /* The reason the parameters are stored rather than assumed. This hash was
       made with N=16384 and has to keep working on the day the constant says
       32768, or raising it locks the whole company out at once.

       Built here rather than pasted, so it is a real scrypt output and not a
       string that happens to look like one. */
    const older = hashAt(PASSWORD, 16_384);

    expect(older).toContain('N=16384');
    await expect(verifyPassword(PASSWORD, older)).resolves.toBe(true);
    await expect(verifyPassword('something else', older)).resolves.toBe(false);
    expect(needsRehash(older)).toBe(true);
  });
});

/** A hash in the stored format, at a work factor the application no longer uses. */
function hashAt(password: string, N: number): string {
  const salt = randomBytes(16);
  const key = scryptSync(password.normalize('NFC'), salt, 32, {
    N,
    r: 8,
    p: 1,
    maxmem: 128 * N * 8 * 2,
  });

  return `scrypt$N=${N},r=8,p=1$${salt.toString('base64url')}$${key.toString('base64url')}`;
}
