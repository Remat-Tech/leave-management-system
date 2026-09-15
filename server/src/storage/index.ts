import { LocalStorage } from './local-storage.js';
import { SupabaseStorage } from './supabase-storage.js';
import type { Storage } from './storage.js';

export { InvalidKey, ObjectNotFound } from './storage.js';
export type { Storage, StoredObject } from './storage.js';

/** A setting the chosen driver cannot run without. */
function required(env: NodeJS.ProcessEnv, key: string): string {
  const value = env[key];
  if (!value) {
    throw new Error(`${key} is not set. See .env.example.`);
  }
  return value;
}

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

    case 'supabase':
      return new SupabaseStorage({
        url: required(env, 'SUPABASE_URL'),
        serviceRoleKey: required(env, 'SUPABASE_SERVICE_ROLE_KEY'),
        bucket: required(env, 'SUPABASE_BUCKET'),
      });

    default:
      throw new Error(
        `Unknown STORAGE_DRIVER "${driver}". The drivers implemented are "local" and "supabase".`,
      );
  }
}
