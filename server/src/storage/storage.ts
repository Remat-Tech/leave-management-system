/**
 * Attachment storage.
 *
 * Everything above this interface deals in opaque keys. Nothing outside it may
 * know whether a file sits on a disk, in a bucket, in which directory, or under
 * what name, because moving from a local directory to object storage in
 * production is meant to be a configuration change and nothing more.
 *
 * That is also a security property rather than only a tidiness one. A key
 * reveals nothing about where a file lives and cannot be guessed, so an
 * attachment is not addressable by anyone who has not been handed its key by
 * code that checked their authorisation first. NFR SEC 04.
 *
 * Metadata is not stored here. The attachment table already records the
 * original filename, content type, size and checksum, and that is where they
 * belong. This layer moves bytes.
 */

/** What `put` recorded. The caller persists these against the attachment row. */
export interface StoredObject {
  /**
   * Opaque handle. Treat it as meaningless: do not parse it, build a path from
   * it, or show it to a user. Its only use is passing back to `get` or
   * `delete`.
   */
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
