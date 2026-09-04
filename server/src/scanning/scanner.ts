/** Virus scanning for attachments. NFR SEC 07. */

/** What a scanner may say. There is no "probably". */
export type ScanVerdict = 'CLEAN' | 'INFECTED';

export interface ScanResult {
  verdict: ScanVerdict;
  /** What it found, on the one verdict that has something to name. */
  signature: string | null;
  /** Which scanner answered, for the record. */
  scannedBy: string;
}

/** The scanner could not be reached. The file is kept unscanned, never assumed clean. */
export class ScannerUnavailable extends Error {
  constructor(scannedBy: string, cause?: unknown) {
    super(`${scannedBy} could not scan this file.`);
    this.name = 'ScannerUnavailable';
    this.cause = cause;
  }
}

export interface Scanner {
  /** Throws {@link ScannerUnavailable} rather than guessing. */
  scan(content: Buffer): Promise<ScanResult>;
}
