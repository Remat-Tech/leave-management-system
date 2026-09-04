import type { ScanResult, Scanner } from './scanner.js';

/**
 * The EICAR test string, which every real scanner also flags. NFR SEC 07.
 *
 * Split so that this file is not itself detected on disk.
 */
const EICAR = 'X5O!P%@AP[4\\PZX54(P^)7CC)7}$' + 'EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*';

/**
 * Development's scanner: flags EICAR and calls everything else clean.
 *
 * It is not antivirus. It exists so the upload path can be exercised end to end without a
 * daemon, and production must point `SCANNER_DRIVER` at something real.
 */
export class SignatureScanner implements Scanner {
  readonly #name = 'the built-in test signature scanner';

  scan(content: Buffer): Promise<ScanResult> {
    const infected = content.includes(EICAR, 0, 'latin1');

    return Promise.resolve({
      verdict: infected ? 'INFECTED' : 'CLEAN',
      signature: infected ? 'EICAR-Test-File' : null,
      scannedBy: this.#name,
    });
  }
}
