/** Attachment storage. NFR SEC 04. */

/** What `put` recorded. */
export interface StoredObject {
  /** Opaque handle. */
  key: string;
  size: number;
  /** Lets a later read prove the bytes are the ones that were written. */
  checksumSha256: string;
}

export class ObjectNotFound extends Error {
  constructor(key: string) {
    // The key is not secret to whoever already holds it, but there is no reason
    // to repeat storage detail in an error that may be logged.
    super(`No stored object for key ${key.slice(0, 8)}…`);
    this.name = 'ObjectNotFound';
  }
}

export class InvalidKey extends Error {
  constructor() {
    super('Not a key this storage issued.');
    this.name = 'InvalidKey';
  }
}

export interface Storage {
  /**
   * Writes bytes and issues a key for them. The key is generated here, not
   * supplied by the caller, so that no part of the application decides where
   * anything is kept or can arrange for two attachments to collide.
   */
  put(content: Buffer): Promise<StoredObject>;

  /** Throws {@link ObjectNotFound} if the key has no object. */
  get(key: string): Promise<Buffer>;

  /**
   * Removes the object. Succeeds whether or not it was there, so the retention
   * job of NFR SEC 06 can run repeatedly without special casing a file somebody
   * already removed.
   */
  delete(key: string): Promise<void>;
}

/**
 * Attachments are capped at MAX_UPLOAD_MB, currently 10, so whole buffers are
 * simpler than streams and cost little. If that cap ever rises to the point
 * where holding a file in memory matters, this is the signature to revisit.
 */
export const KEY_PATTERN = /^[0-9a-f]{64}$/;
