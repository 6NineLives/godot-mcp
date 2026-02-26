/**
 * Bidirectional parameter name normalization.
 *
 * MCP clients may send parameters in either snake_case or camelCase.
 * The Godot operations GDScript expects snake_case.  Our TypeScript code
 * uses camelCase internally.  This module handles both directions.
 */

import {
    PARAMETER_MAPPINGS,
    REVERSE_PARAMETER_MAPPINGS,
} from '../config/config.js';

export type OperationParams = Record<string, unknown>;

// ---------------------------------------------------------------------------
// snake_case → camelCase (incoming from MCP client → internal TS)
// ---------------------------------------------------------------------------

/**
 * Normalise parameter keys to camelCase.
 * Keys that exist in PARAMETER_MAPPINGS are mapped directly;
 * all other keys are left as-is.
 */
export function normalizeParameters(params: OperationParams): OperationParams {
    if (!params || typeof params !== 'object') return params;

    const result: OperationParams = {};

    for (const key of Object.keys(params)) {
        let normalizedKey = key;

        // Map known snake_case → camelCase
        if (key.includes('_') && PARAMETER_MAPPINGS[key]) {
            normalizedKey = PARAMETER_MAPPINGS[key];
        }

        // Recurse into nested objects (but not arrays)
        const value = params[key];
        if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
            result[normalizedKey] = normalizeParameters(value as OperationParams);
        } else {
            result[normalizedKey] = value;
        }
    }

    return result;
}

// ---------------------------------------------------------------------------
// camelCase → snake_case (internal TS → GDScript operations)
// ---------------------------------------------------------------------------

/**
 * Convert camelCase parameter keys to snake_case for the Godot operations
 * script.  Known mappings from REVERSE_PARAMETER_MAPPINGS are preferred;
 * otherwise a generic regex conversion is applied.
 */
export function convertCamelToSnakeCase(params: OperationParams): OperationParams {
    const result: OperationParams = {};

    for (const key of Object.keys(params)) {
        const snakeKey =
            REVERSE_PARAMETER_MAPPINGS[key] ??
            key.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`);

        const value = params[key];
        if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
            result[snakeKey] = convertCamelToSnakeCase(value as OperationParams);
        } else {
            result[snakeKey] = value;
        }
    }

    return result;
}

// ---------------------------------------------------------------------------
// Path normalization helpers used by the BaseToolHandler
// ---------------------------------------------------------------------------

/**
 * Normalise all common path-typed arguments in a params object
 * (e.g. resolve Windows back-slashes to forward-slashes for Godot).
 */
export function normalizeHandlerPaths(args: OperationParams): OperationParams {
    const pathKeys = [
        'projectPath',
        'scenePath',
        'texturePath',
        'outputPath',
        'filePath',
        'nodePath',
        'newPath',
        'directory',
    ];

    const result = { ...args };

    for (const key of pathKeys) {
        if (typeof result[key] === 'string') {
            // Godot always uses forward slashes internally
            result[key] = (result[key] as string).replace(/\\/g, '/');
        }
    }

    return result;
}
