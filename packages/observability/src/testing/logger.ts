import { createLogger } from '../logger.js';
import type { Logger } from '../logger.js';

/** A real logger that never writes anything — for a test that needs one to satisfy a signature. */
export function silentLogger(): Logger {
  return createLogger('test').child({}, { level: 'silent' });
}
