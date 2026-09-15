import { createHash, randomBytes } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { LocalStorage } from '../../src/storage/local-storage.js';
import { SupabaseStorage } from '../../src/storage/supabase-storage.js';
import { createStorage, InvalidKey, ObjectNotFound } from '../../src/storage/index.js';

/**
 * These touch a temporary directory rather than a database or a network, so
 * they stay unit tests. The directory is created and removed per test.
 */
let root: string;
let storage: LocalStorage;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'lms-storage-'));
  storage = new LocalStorage(root);
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe('putting and getting a file back', () => {
  it('returns the same bytes that went in', async () => {
    const content = randomBytes(2048);

    const stored = await storage.put(content);

    expect(await storage.get(stored.key)).toEqual(content);
  });

  it('records the size and a checksum that matches the content', async () => {
    const content = Buffer.from('a medical certificate, as far as this test cares');

    const stored = await storage.put(content);

    expect(stored.size).toBe(content.byteLength);
    expect(stored.checksumSha256).toBe(createHash('sha256').update(content).digest('hex'));
  });

  it('gives identical uploads different keys', async () => {
    // Two people uploading the same document must not collide, and a key must
    // not reveal that the same file was uploaded twice.
    const content = Buffer.from('the same bytes both times');

    const first = await storage.put(content);
    const second = await storage.put(content);

    expect(first.key).not.toBe(second.key);
  });
});

describe('the key tells you nothing about where the file is', () => {
  it('is opaque: no path, no separators, no filename', async () => {
    const stored = await storage.put(Buffer.from('x'));

    expect(stored.key).toMatch(/^[0-9a-f]{64}$/);
    expect(stored.key).not.toContain('/');
    expect(stored.key).not.toContain('\\');
    expect(stored.key).not.toContain('.');
    expect(stored.key).not.toContain(root);
  });

  it('does not leak the storage root through what put returns', async () => {
    const stored = await storage.put(Buffer.from('x'));

    // The whole result, not just the key: nothing in it may hint at a location.
    expect(JSON.stringify(stored)).not.toContain(root);
    expect(Object.keys(stored).sort()).toEqual(['checksumSha256', 'key', 'size']);
  });
});

describe('deleting', () => {
  it('removes the object', async () => {
    const stored = await storage.put(Buffer.from('delete me'));

    await storage.delete(stored.key);

    await expect(storage.get(stored.key)).rejects.toThrow(ObjectNotFound);
  });

  it('does not complain about a file that is already gone', async () => {
    const stored = await storage.put(Buffer.from('delete me twice'));

    await storage.delete(stored.key);

    // The retention job of NFR SEC 06 reruns; it must not fail on its own work.
    await expect(storage.delete(stored.key)).resolves.toBeUndefined();
  });
});

describe('refusing keys it did not issue', () => {
  it('reports a missing object rather than returning nothing', async () => {
    const neverStored = randomBytes(32).toString('hex');

    await expect(storage.get(neverStored)).rejects.toThrow(ObjectNotFound);
  });

  it.each([
    ['traversal', '../../../../etc/passwd'],
    ['traversal, encoded as a key would be', '..%2F..%2Fetc%2Fpasswd'],
    ['absolute path', '/etc/passwd'],
    ['windows absolute path', 'C:\\Windows\\System32\\config\\SAM'],
    ['a real file under another name', 'not-a-key'],
    ['empty', ''],
    ['right characters, wrong length', 'abcdef'],
  ])('rejects %s', async (_label, key) => {
    // A key reaches this code from the database, so it is not beyond reach of
    // someone who can write there. It has to be checked, not trusted.
    await expect(storage.get(key)).rejects.toThrow(InvalidKey);
    await expect(storage.delete(key)).rejects.toThrow(InvalidKey);
  });

  it('cannot be talked into reading a file outside its root', async () => {
    const secret = join(root, '..', `outside-${randomBytes(4).toString('hex')}.txt`);
    await writeFile(secret, 'must not be readable through storage');

    try {
      // Every shape of key that could point at it is refused before any
      // filesystem call happens.
      await expect(storage.get(`../${secret}`)).rejects.toThrow(InvalidKey);
      await expect(storage.get(secret)).rejects.toThrow(InvalidKey);
    } finally {
      await rm(secret, { force: true });
    }
  });
});

/* ------------------------------------------------------------------ supabase */

interface Call {
  url: string;
  method: string;
}

/** The driver against a stubbed fetch, so this stays a unit test. */
function supabaseStorage(respond: (call: Call) => Response) {
  const calls: Call[] = [];

  const stub: typeof globalThis.fetch = (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const call = { url, method: init?.method ?? 'GET' };
    calls.push(call);
    return Promise.resolve(respond(call));
  };

  const storage = new SupabaseStorage({
    url: 'https://a-project.supabase.co',
    serviceRoleKey: 'a-service-role-key-for-a-test',
    bucket: 'attachments',
    fetch: stub,
  });

  return { storage, calls };
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const missing = () =>
  json({ statusCode: '404', error: 'not_found', message: 'Object not found' }, 404);

describe('an address the bytes may be fetched from directly', () => {
  it('is not offered by a directory, which has none', async () => {
    const stored = await storage.put(Buffer.from('relayed, not linked'));

    // The caller then reads the bytes and sends them on, as it always did.
    expect(await storage.linkTo(stored.key)).toBeUndefined();
  });

  it('is refused for a key the storage did not issue, as every other path is', async () => {
    await expect(storage.linkTo('../../../../etc/passwd')).rejects.toThrow(InvalidKey);
  });

  it('is signed, expiring and names one object where the driver can mint one', async () => {
    const signed =
      'https://a-project.supabase.co/storage/v1/object/sign/attachments/ab/cd/x?token=y';
    const { storage: supabase, calls } = supabaseStorage((call) =>
      call.method === 'POST' && call.url.includes('/object/sign/')
        ? json({ signedURL: new URL(signed).pathname + new URL(signed).search })
        : json({ Key: 'stored' }),
    );

    const stored = await supabase.put(Buffer.from('x'));
    const url = await supabase.linkTo(stored.key);

    const path = `${stored.key.slice(0, 2)}/${stored.key.slice(2, 4)}/${stored.key}`;
    expect(calls[1].url).toContain(`/object/sign/attachments/${path}`);
    expect(url).toContain('token=');
  });
});

describe('the supabase driver', () => {
  it('writes into the bucket at a path the key decides', async () => {
    const { storage, calls } = supabaseStorage(() => json({ Key: 'stored' }));
    const content = Buffer.from('a medical certificate, as far as this test cares');

    const stored = await storage.put(content);

    expect(stored.size).toBe(content.byteLength);
    expect(stored.checksumSha256).toBe(createHash('sha256').update(content).digest('hex'));
    expect(stored.key).toMatch(/^[0-9a-f]{64}$/);
    // Fanned out, inside the bucket, and named by the key alone.
    const path = `${stored.key.slice(0, 2)}/${stored.key.slice(2, 4)}/${stored.key}`;
    expect(calls[0].url).toContain(`/object/attachments/${path}`);
    expect(calls[0].method).toBe('POST');
  });

  it('reads the same bytes back', async () => {
    const content = randomBytes(512);
    const { storage } = supabaseStorage((call) =>
      call.method === 'POST' ? json({ Key: 'stored' }) : new Response(content),
    );

    const stored = await storage.put(content);

    expect(await storage.get(stored.key)).toEqual(content);
  });

  it('reports a missing object rather than returning nothing', async () => {
    const { storage } = supabaseStorage(() => missing());

    await expect(storage.get(randomBytes(32).toString('hex'))).rejects.toThrow(ObjectNotFound);
  });

  it('does not complain about deleting what is already gone', async () => {
    const { storage } = supabaseStorage(() => missing());

    // The retention job of NFR SEC 06 reruns over its own work.
    await expect(storage.delete(randomBytes(32).toString('hex'))).resolves.toBeUndefined();
  });

  it('says so when storage itself fails', async () => {
    const { storage } = supabaseStorage(() => json({ message: 'service unavailable' }, 503));

    await expect(storage.get(randomBytes(32).toString('hex'))).rejects.toThrow(/Could not read/);
  });

  it.each([
    ['traversal', '../../../../etc/passwd'],
    ['a path of its own', 'attachments/somebody-elses-file'],
    ['empty', ''],
    ['right characters, wrong length', 'abcdef'],
  ])('refuses %s before it reaches the network', async (_label, key) => {
    const { storage, calls } = supabaseStorage(() => json({}));

    await expect(storage.get(key)).rejects.toThrow(InvalidKey);
    await expect(storage.delete(key)).rejects.toThrow(InvalidKey);
    expect(calls).toEqual([]);
  });
});

describe('choosing an implementation by configuration', () => {
  it('builds local storage when the driver says local', async () => {
    const storageFromEnv = createStorage({
      STORAGE_DRIVER: 'local',
      STORAGE_LOCAL_PATH: root,
    } as NodeJS.ProcessEnv);

    const stored = await storageFromEnv.put(Buffer.from('configured, not constructed'));

    expect(await storageFromEnv.get(stored.key)).toEqual(
      Buffer.from('configured, not constructed'),
    );
  });

  it('refuses a driver it has no implementation for', () => {
    expect(() =>
      createStorage({ STORAGE_DRIVER: 's3', STORAGE_LOCAL_PATH: root } as NodeJS.ProcessEnv),
    ).toThrow(/Unknown STORAGE_DRIVER/);
  });

  it('will not start without somewhere to put things', () => {
    expect(() => createStorage({ STORAGE_DRIVER: 'local' } as NodeJS.ProcessEnv)).toThrow(
      /STORAGE_LOCAL_PATH/,
    );
  });

  it('builds supabase storage when the driver says supabase', () => {
    const storageFromEnv = createStorage({
      STORAGE_DRIVER: 'supabase',
      SUPABASE_URL: 'https://a-project.supabase.co',
      SUPABASE_SERVICE_ROLE_KEY: 'a-service-role-key-for-a-test',
      SUPABASE_BUCKET: 'attachments',
    } as NodeJS.ProcessEnv);

    expect(storageFromEnv).toBeInstanceOf(SupabaseStorage);
  });

  it.each(['SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY', 'SUPABASE_BUCKET'])(
    'will not start without %s',
    (missingKey) => {
      const env = {
        STORAGE_DRIVER: 'supabase',
        SUPABASE_URL: 'https://a-project.supabase.co',
        SUPABASE_SERVICE_ROLE_KEY: 'a-service-role-key-for-a-test',
        SUPABASE_BUCKET: 'attachments',
      } as NodeJS.ProcessEnv;
      delete env[missingKey];

      expect(() => createStorage(env)).toThrow(new RegExp(missingKey));
    },
  );
});
