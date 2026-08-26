import { LocalStorage } from './local-storage.js';
import type { Storage } from './storage.js';

export { InvalidKey, ObjectNotFound } from './storage.js';
export type { Storage, StoredObject } from './storage.js';

/**
 * Builds the storage the environment asks for.
 *
 * This function is the only place that knows which implementation is in use.
 * Everything else takes a {@link Storage} and cannot tell the difference, which
 * is what makes production a matter of STORAGE_DRIVER rather than of code.
 *
 * An object storage driver will join it here when Phase 4 needs one. Adding it
 * should touch this file and one new class, and nothing else.
 */
export function createStorage(env: NodeJS.ProcessEnv = process.env): Storage {
  const driver = env.STORAGE_DRIVER ?? 'local';

  switch (driver) {
    case 'local': {
      const path = env.STORAGE_LOCAL_PATH;
      if (!path) {
        throw new Error('STORAGE_LOCAL_PATH is not set. See .env.example.');
      }
      return new LocalStorage(path);
    }

    default:
      throw new Error(
        `Unknown STORAGE_DRIVER "${driver}". The only driver implemented is "local".`,
      );
  }
}
