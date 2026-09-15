import { createHash, randomBytes } from 'node:crypto';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import {
  InvalidKey,
  KEY_PATTERN,
  ObjectNotFound,
  type Storage,
  type StoredObject,
} from './storage.js';

export interface SupabaseStorageOptions {
  url: string;
  /** Service role. Never leaves the server. */
  serviceRoleKey: string;
  bucket: string;
  /** How long a direct link lives. NFR SEC 04. */
  signedUrlSeconds?: number;
  /** For tests. */
  fetch?: typeof globalThis.fetch;
}

/** Stores attachments in a Supabase bucket. NFR SEC 04, NFR SEC 06. */
export class SupabaseStorage implements Storage {
  readonly #client: SupabaseClient;
  readonly #bucket: string;
  readonly #signedUrlSeconds: number;

  constructor({ url, serviceRoleKey, bucket, signedUrlSeconds, fetch }: SupabaseStorageOptions) {
    this.#signedUrlSeconds = signedUrlSeconds ?? 300;
    this.#client = createClient(url, serviceRoleKey, {
      // A server with no user to keep signed in.
      auth: { persistSession: false, autoRefreshToken: false },
      ...(fetch ? { global: { fetch } } : {}),
    });
    this.#bucket = bucket;
  }

  async put(content: Buffer): Promise<StoredObject> {
    // 32 random bytes, as the local driver. Not a hash of the content: naming a
    // file after its bytes would let anyone holding a copy confirm it was
    // uploaded, and would collide for two people uploading the same certificate.
    const key = randomBytes(32).toString('hex');

    const { error } = await this.#objects().upload(this.#pathFor(key), content, {
      // The real type is on the attachment row. Storage says nothing, so a
      // bucket served directly could never render one of these inline.
      contentType: 'application/octet-stream',
      // Refuse rather than overwrite, as the local driver's wx flag does.
      upsert: false,
    });

    if (error) {
      throw new Error(`Could not store the attachment: ${error.message}`, { cause: error });
    }

    return {
      key,
      size: content.byteLength,
      checksumSha256: createHash('sha256').update(content).digest('hex'),
    };
  }

  async get(key: string): Promise<Buffer> {
    const { data, error } = await this.#objects().download(this.#pathFor(key));

    if (error) {
      if (isMissing(error)) throw new ObjectNotFound(key);
      throw new Error(`Could not read the attachment: ${error.message}`, { cause: error });
    }

    return Buffer.from(await data.arrayBuffer());
  }

  /**
   * A signed URL straight to the object, good for {@link SupabaseStorageOptions.signedUrlSeconds}.
   *
   * What it saves is a whole transfer of the file: without it every certificate is pulled into
   * the application and sent on again, so a reader waits for the same bytes twice. The URL
   * carries its own signature, expires, and names nothing but this object.
   */
  async linkTo(key: string): Promise<string | undefined> {
    const { data, error } = await this.#objects().createSignedUrl(
      this.#pathFor(key),
      this.#signedUrlSeconds,
    );

    if (error) {
      if (isMissing(error)) throw new ObjectNotFound(key);
      throw new Error(`Could not mint a link to the attachment: ${error.message}`, {
        cause: error,
      });
    }

    return data.signedUrl;
  }

  async delete(key: string): Promise<void> {
    const { error } = await this.#objects().remove([this.#pathFor(key)]);

    // A missing object is the idempotence the interface promises: the NFR SEC 06
    // retention job reruns over its own work.
    if (error && !isMissing(error)) {
      throw new Error(`Could not delete the attachment: ${error.message}`, { cause: error });
    }
  }

  #objects() {
    return this.#client.storage.from(this.#bucket);
  }

  /** Maps a key to an object path, and refuses anything this storage did not issue. */
  #pathFor(key: string): string {
    // A key reaches here from the database, so it is checked rather than trusted.
    if (!KEY_PATTERN.test(key)) {
      throw new InvalidKey();
    }

    // Two levels of fan out, as the local driver has.
    return `${key.slice(0, 2)}/${key.slice(2, 4)}/${key}`;
  }
}

/** Supabase reports a missing object by status on some paths and by message on others. */
function isMissing(error: unknown): boolean {
  const { status, statusCode, message } = error as {
    status?: number;
    statusCode?: string;
    message?: string;
  };

  return status === 404 || statusCode === '404' || /not.?found/i.test(message ?? '');
}
