import { type ScanResult, ScannerUnavailable, type Scanner } from './scanner.js';

/**
 * A scanner that answers nothing. NFR SEC 07.
 *
 * What `SCANNER_DRIVER=off` builds: every upload is kept `PENDING` and satisfies no
 * documentation rule until something real has looked at it.
 */
export class UnavailableScanner implements Scanner {
  scan(): Promise<ScanResult> {
    return Promise.reject(new ScannerUnavailable('no scanner is configured'));
  }
}
