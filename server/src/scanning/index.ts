import { SignatureScanner } from './signature-scanner.js';
import { UnavailableScanner } from './unavailable-scanner.js';
import type { Scanner } from './scanner.js';

export { ScannerUnavailable } from './scanner.js';
export type { ScanResult, Scanner, ScanVerdict } from './scanner.js';

/** Builds the scanner the environment asks for. NFR SEC 07. */
export function createScanner(env: NodeJS.ProcessEnv = process.env): Scanner {
  const driver = env.SCANNER_DRIVER ?? 'signature';

  switch (driver) {
    case 'signature':
      return new SignatureScanner();

    case 'off':
      return new UnavailableScanner();

    default:
      throw new Error(
        `Unknown SCANNER_DRIVER "${driver}". The drivers implemented are "signature" and "off".`,
      );
  }
}
