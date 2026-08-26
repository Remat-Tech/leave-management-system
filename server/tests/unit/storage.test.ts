import { createHash, randomBytes } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { LocalStorage } from '../../src/storage/local-storage.js';
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
});
