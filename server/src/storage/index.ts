import { LocalStorage } from './local-storage.js';
import type { Storage } from './storage.js';

export { InvalidKey, ObjectNotFound } from './storage.js';
export type { Storage, StoredObject } from './storage.js';

/** Builds the storage the environment asks for. */
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
