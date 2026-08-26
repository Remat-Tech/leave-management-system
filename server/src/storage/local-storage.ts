import { createHash, randomBytes } from 'node:crypto';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve, sep } from 'node:path';
import {
  InvalidKey,
  KEY_PATTERN,
  ObjectNotFound,
  type Storage,
  type StoredObject,
} from './storage.js';

/**
 * Stores attachments in a directory. For development and for tests.
 *
 * The directory must sit outside anything the web server serves. Files here are
 * medical certificates among other things, and a directory that is reachable by
 * URL makes every one of them public. NFR SEC 04, NFR SEC 06.
 */
export class LocalStorage implements Storage {
  readonly #root: string;

  constructor(root: string) {
    // Resolved once so that every later comparison is between absolute paths.
    this.#root = resolve(root);
  }

  async put(content: Buffer): Promise<StoredObject> {
    // 32 random bytes, not a hash of the content. Naming a file after its
    // contents would let anyone holding a copy of a document confirm it had
    // been uploaded, and would give two people who upload the same certificate
    // the same key.
    const key = randomBytes(32).toString('hex');
    const path = this.#pathFor(key);

    await mkdir(dirname(path), { recursive: true });
    // wx fails rather than overwrites. With 256 bits of randomness a collision
    // will not happen, but silently replacing an attachment is bad enough that
    // it is worth being told.
    await writeFile(path, content, { flag: 'wx' });

    return {
      key,
      size: content.byteLength,
      checksumSha256: createHash('sha256').update(content).digest('hex'),
    };
  }

  async get(key: string): Promise<Buffer> {
    try {
      return await readFile(this.#pathFor(key));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        throw new ObjectNotFound(key);
      }
      throw error;
    }
  }

  async delete(key: string): Promise<void> {
    // force ignores a missing file, which is the idempotence the interface
    // promises.
    await rm(this.#pathFor(key), { force: true });
  }

  /**
   * Maps a key to a path, and refuses anything this storage did not issue.
   *
   * The check matters because keys make a round trip through the database
   * before coming back here. A key of `../../../etc/passwd` would otherwise
   * resolve outside the root and turn attachment download into arbitrary file
   * read. Validating the shape is the cheap defence; the resolve check below is
   * the one that would still hold if the pattern were ever loosened.
   */
  #pathFor(key: string): string {
    if (!KEY_PATTERN.test(key)) {
      throw new InvalidKey();
    }

    // Two levels of fan out. A single directory holding every attachment gets
    // slow to list and unpleasant to work with once there are thousands.
    const path = resolve(join(this.#root, key.slice(0, 2), key.slice(2, 4), key));

    if (path !== this.#root && !path.startsWith(this.#root + sep)) {
      throw new InvalidKey();
    }

    return path;
  }
}
