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

/** A lifetime in seconds, refused rather than coerced. Blank means the driver's own. */
function seconds(value: string | undefined): number | undefined {
  if (!value) {
    return undefined;
  }

  const parsed = Number(value);

  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 3600) {
    throw new Error(
      `STORAGE_SIGNED_URL_TTL_SECONDS is ${value}, which is not a whole number of seconds ` +
        'between 1 and 3600. See .env.example.',
    );
  }

  return parsed;
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
        signedUrlSeconds: seconds(env.STORAGE_SIGNED_URL_TTL_SECONDS),
      });

    default:
      throw new Error(
        `Unknown STORAGE_DRIVER "${driver}". The drivers implemented are "local" and "supabase".`,
      );
  }
}
