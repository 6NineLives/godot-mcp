/**
 * Structured logging utilities.
 *
 * All output goes to stderr because MCP uses stdout for JSON-RPC transport.
 * Debug messages are gated behind the DEBUG environment variable.
 */

import { DEBUG_MODE } from '../config/config.js';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

/** Log a debug message (only when DEBUG=true). */
export function logDebug(message: string): void {
    if (DEBUG_MODE) {
        console.error(`[DEBUG] ${message}`);
    }
}

/** Log an informational message. */
export function logInfo(message: string): void {
    console.error(`[INFO] ${message}`);
}

/** Log a warning message. */
export function logWarn(message: string): void {
    console.error(`[WARN] ${message}`);
}

/** Log an error message. */
export function logError(message: string): void {
    console.error(`[ERROR] ${message}`);
}

/** Generic log function that dispatches by level. */
export function log(level: LogLevel, message: string): void {
    switch (level) {
        case 'debug':
            logDebug(message);
            break;
        case 'info':
            logInfo(message);
            break;
        case 'warn':
            logWarn(message);
            break;
        case 'error':
            logError(message);
            break;
    }
}
