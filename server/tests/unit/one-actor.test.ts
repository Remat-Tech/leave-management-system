import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * An actor is derived, never accepted. NFR SEC 02. LMS 112, LMS 401.
 *
 * The sibling of ./one-writer.test.ts, and it exists for the same reason: this is a claim
 * about code that does not exist, so the only way to check it is to read the source.
 *
 * The claim is the one `SignedIn.actor` makes in as many words — "a route layer must
 * derive its own from whatever it uses to identify a request rather than taking one over
 * the wire — the whole point of this object is that it is the *answer* to 'who is this',
 * never the evidence for it."
 *
 * ## What this is actually protecting against
 *
 * Not somebody posting `{"actor": {"roles": ["HR_ADMIN"]}}` and it working. That would be
 * a spectacular bug and it would be found in an afternoon.
 *
 * The realistic version is an honest convenience. A second route needs to know whether to
 * show an approvals link, so it reads roles from the request body the client helpfully
 * sends; or a background job wants to reuse a handler, so it mints `theSystem()` inside
 * the route layer to call it with. Neither arrives as a security bug. The first arrives
 * as a screen that renders slightly wrong, and the second as a route that quietly holds
 * every role — which is exactly what `theSystem()`'s own note warns about when it says
 * `grep -rn theSystem server/src` should stay short.
 *
 * So the rule is not "be careful in routes", it is **one derivation, in one file**.
 *
 * ## Read from the source, with the comments taken out
 *
 * The same technique ./one-writer.test.ts and ./migrations.test.ts use, and for the same
 * reason: these files are mostly prose and every one of them discusses the thing being
 * searched for at length. This file included — which is why it lives outside `src`.
 */

const SOURCE = join(process.cwd(), 'server', 'src');

/* Normalised to forward slashes as they are read, for the reason ./one-writer.test.ts
   gives: `readdirSync` hands back the platform separator, so an exemption list written
   with forward slashes silently matches nothing on Windows — and the test then fails on a
   developer's machine while passing in continuous integration. */
const sources = readdirSync(SOURCE, { recursive: true, encoding: 'utf8' })
  .filter((file) => file.endsWith('.ts'))
  .map((file) => ({
    file: file.replaceAll('\\', '/'),
    code: readFileSync(join(SOURCE, file), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, ' ')
      .replace(/\/\/[^\n]*/g, ' '),
  }));

/**
 * The two files that may mint an actor for a person, and what each is for.
 *
 * `auth/actor.ts` declares `signedInAs`. `features/sign-in/sign-in.service.ts` calls it at the
 * moment somebody finishes proving who they are, which is the only moment that fact is
 * established. `http/identify.ts` calls it once per request from a verified cookie plus
 * a fresh read of the roles, which is the route layer deriving its own exactly as it was
 * told to.
 */
const MAY_MINT = ['auth/actor.ts', 'features/sign-in/sign-in.service.ts', 'http/identify.ts'];

describe('an actor is derived, never accepted', () => {
  it('there is source to read', () => {
    expect(sources.length).toBeGreaterThan(20);
  });

  it('and only the sign in door and the route layer mint one', () => {
    const minting = sources.filter(
      ({ file, code }) => !MAY_MINT.includes(file) && /signedInAs\s*\(/.test(code),
    );

    expect(minting.map(({ file }) => file)).toEqual([]);
  });

  /**
   * And no route mints the actor that holds every role.
   *
   * `theSystem()` is a back door with a name on it — a job, a migration, a seed, a test
   * fixture — and every one of those runs unattended. A request has a person behind it by
   * definition, so a route reaching for it is a route that has stopped asking who is
   * asking. This is the check that keeps `grep -rn theSystem server/src` short in the one
   * folder where the answer must be nothing at all.
   */
  it('and nothing in the route layer reaches for the system actor', () => {
    const reaching = sources.filter(
      ({ file, code }) => file.startsWith('routes/') && /theSystem\s*\(/.test(code),
    );

    expect(reaching.map(({ file }) => file)).toEqual([]);
  });

  /**
   * And the route layer takes nothing about identity off the request.
   *
   * Deliberately a search for the *fields*, rather than for a body being read at all —
   * `features/sign-in/session.routes.ts` reads an email and a password out of one, which is the whole job
   * of a sign in route. What must never be read is anything the server is supposed to
   * decide: who this is, what they hold, and whether they are a manager.
   */
  it('and reads no identity off a request body or header', () => {
    const suspect =
      /req(uest)?\.(body|query|params|headers)[^;\n]*\b(actor|roles?|isManager|employeeId)\b/;

    const reading = sources.filter(
      ({ file, code }) => file.startsWith('routes/') && suspect.test(code),
    );

    expect(reading.map(({ file }) => file)).toEqual([]);
  });

  /**
   * And every route that reads a record goes through the one derivation.
   *
   * A weaker check than the ones above and worth having anyway: it fails on the change
   * that would quietly undo the mounting order, which is somebody adding a router to
   * `http/app.ts` in front of `identify` while chasing a 401 in development.
   *
   * Every reading router is named rather than only the first, because the failure this
   * guards against is a *new* one going in the wrong place — and a test that watched one
   * router would go on passing while the next was mounted in front of the line.
   */
  it('and the application mounts the derivation before anything that reads a record', () => {
    const app = sources.find(({ file }) => file === 'http/app.ts');

    expect(app).toBeDefined();

    const code = app?.code ?? '';
    const theLine = code.indexOf('identify(');

    expect(theLine).toBeGreaterThan(-1);

    for (const router of ['balanceRoutes(', 'requestRoutes(']) {
      expect(code.indexOf(router)).toBeGreaterThan(-1);
      expect(theLine).toBeLessThan(code.indexOf(router));
    }
  });
});
