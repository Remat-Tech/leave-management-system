import { createHash, randomBytes } from 'node:crypto';
import {
  InvalidKey,
  KEY_PATTERN,
  ObjectNotFound,
  type Storage,
  type StoredObject,
} from '../../src/storage/storage.js';

/**
 * `Storage` in a Map. NFR SEC 04.
 *
 * Same contract as `LocalStorage` — issued keys, refused ones, idempotent delete — with
 * nothing on a disk to clean up. ../unit/storage.test.ts is what proves the real driver.
 */
export class InMemoryStorage implements Storage {
  readonly #objects = new Map<string, Buffer>();

  /** What has been written and not deleted, for a test that asserts on the bytes. */
  get size(): number {
    return this.#objects.size;
  }

  has(key: string): boolean {
    return this.#objects.has(key);
  }

  /** Empties it between tests, the way `TRUNCATE` empties the tables. */
  reset(): void {
    this.#objects.clear();
  }

  put(content: Buffer): Promise<StoredObject> {
    const key = randomBytes(32).toString('hex');

    this.#objects.set(key, Buffer.from(content));

    return Promise.resolve({
      key,
      size: content.byteLength,
      checksumSha256: createHash('sha256').update(content).digest('hex'),
    });
  }

  get(key: string): Promise<Buffer> {
    const content = this.#objects.get(this.#checked(key));

    return content === undefined
      ? Promise.reject(new ObjectNotFound(key))
      : Promise.resolve(content);
  }

  delete(key: string): Promise<void> {
    this.#objects.delete(this.#checked(key));

    return Promise.resolve();
  }

  #checked(key: string): string {
    if (!KEY_PATTERN.test(key)) {
      throw new InvalidKey();
    }

    return key;
  }
}
