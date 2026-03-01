/**
 * Shared Godot error/warning parser and error context enrichment.
 *
 * Used by workflow_tools, debug_tools, and any other tool that needs to
 * interpret Godot's stdout/stderr output.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ParsedError {
    type: 'error' | 'warning' | 'script_error' | 'shader_error';
    message: string;
    file?: string;
    line?: number;
    function?: string;
}

// ---------------------------------------------------------------------------
// Godot output parser
// ---------------------------------------------------------------------------

/**
 * Parse Godot stdout/stderr lines for structured errors and warnings.
 *
 * Recognises:
 *   - `SCRIPT ERROR: <msg> at: <file>:<line>`
 *   - `ERROR: <msg> at: <file>:<line> in <func>`
 *   - `WARNING: <msg> at: <file>:<line>`
 *   - `SHADER ERROR: <msg>`
 *   - Parser errors: `res://path:line - message`
 */
export function parseGodotOutput(
    output: string[],
    errors: string[],
): { parsedErrors: ParsedError[]; parsedWarnings: ParsedError[] } {
    const parsedErrors: ParsedError[] = [];
    const parsedWarnings: ParsedError[] = [];

    const allLines = [...output, ...errors];

    for (const line of allLines) {
        // SCRIPT ERROR: ...
        const scriptErrorMatch = line.match(
            /SCRIPT ERROR:\s*(.+?)(?:\s+at:\s+(.+?):(\d+))?$/i,
        );
        if (scriptErrorMatch) {
            parsedErrors.push({
                type: 'script_error',
                message: scriptErrorMatch[1].trim(),
                file: scriptErrorMatch[2],
                line: scriptErrorMatch[3]
                    ? parseInt(scriptErrorMatch[3], 10)
                    : undefined,
            });
            continue;
        }

        // ERROR: ... at: file:line in function
        const errorMatch = line.match(
            /ERROR:\s*(.+?)(?:\s+at:\s+(.+?):(\d+)\s+in\s+(.+))?$/i,
        );
        if (errorMatch && !line.includes('WARNING')) {
            parsedErrors.push({
                type: 'error',
                message: errorMatch[1].trim(),
                file: errorMatch[2],
                line: errorMatch[3]
                    ? parseInt(errorMatch[3], 10)
                    : undefined,
                function: errorMatch[4],
            });
            continue;
        }

        // WARNING: ...
        const warningMatch = line.match(
            /WARNING:\s*(.+?)(?:\s+at:\s+(.+?):(\d+))?$/i,
        );
        if (warningMatch) {
            parsedWarnings.push({
                type: 'warning',
                message: warningMatch[1].trim(),
                file: warningMatch[2],
                line: warningMatch[3]
                    ? parseInt(warningMatch[3], 10)
                    : undefined,
            });
            continue;
        }

        // Shader error
        const shaderMatch = line.match(/SHADER ERROR:\s*(.+)/i);
        if (shaderMatch) {
            parsedErrors.push({
                type: 'shader_error',
                message: shaderMatch[1].trim(),
            });
            continue;
        }

        // Parser errors: res://path:line - message
        const parserMatch = line.match(
            /^(res:\/\/[^:]+):(\d+)\s*-\s*(.+)$/,
        );
        if (parserMatch) {
            parsedErrors.push({
                type: 'script_error',
                message: parserMatch[3].trim(),
                file: parserMatch[1],
                line: parseInt(parserMatch[2], 10),
            });
            continue;
        }
    }

    return { parsedErrors, parsedWarnings };
}

// ---------------------------------------------------------------------------
// Common error patterns → suggested solutions
// ---------------------------------------------------------------------------

interface ErrorPattern {
    /** Substring to search for (case-insensitive). */
    pattern: string;
    /** Suggested solutions for this error type. */
    solutions: string[];
}

export const COMMON_ERROR_PATTERNS: ErrorPattern[] = [
    {
        pattern: 'null',
        solutions: [
            'Check if the node or resource exists before accessing it',
            'Use `if node:` or `if is_instance_valid(node):` to guard against null',
            'Ensure the node path is correct and the node is in the scene tree',
        ],
    },
    {
        pattern: 'invalid call',
        solutions: [
            'Verify the method exists on the object',
            'Check the method signature and parameter count/types',
            'Ensure the object is of the expected type (use `is` or type casting)',
        ],
    },
    {
        pattern: 'invalid get index',
        solutions: [
            'Check that the property or key exists on the object or dictionary',
            'Use `has()` to verify keys before accessing',
            'Ensure the variable is the correct type (not null or wrong type)',
        ],
    },
    {
        pattern: 'parse error',
        solutions: [
            'Check for syntax errors (missing colons, brackets, parentheses)',
            'Verify proper indentation — GDScript is indentation-sensitive',
            'Make sure all function/class definitions end with a colon',
        ],
    },
    {
        pattern: 'type mismatch',
        solutions: [
            'Check the types of variables and parameters',
            'Use explicit type casting: `var x: int = int(value)`',
            'Verify the return type of functions matches the expected type',
        ],
    },
    {
        pattern: 'not found',
        solutions: [
            'Check if the file or resource path is correct',
            'Verify the resource exists in the project directory',
            'Use `res://` prefix for resource paths',
            'Check for typos in the path or filename',
        ],
    },
    {
        pattern: 'already in use',
        solutions: [
            'The resource or node name is already taken — use a different name',
            'Check for duplicate node names in the scene tree',
        ],
    },
    {
        pattern: 'cycl',
        solutions: [
            'Break the circular dependency by using `@onready` or deferred calls',
            'Re-structure the scene hierarchy to avoid circular references',
        ],
    },
    {
        pattern: 'out of range',
        solutions: [
            'Check array/string bounds before accessing indices',
            'Use `array.size()` to verify the index is within range',
            'Remember arrays/strings are 0-indexed in GDScript',
        ],
    },
    {
        pattern: 'cannot convert',
        solutions: [
            'Use explicit type conversion functions (int(), float(), str())',
            'Check if the value is null or an unexpected type before converting',
        ],
    },
];

/**
 * Given an error message, return matching suggestions from COMMON_ERROR_PATTERNS.
 */
export function getErrorSuggestions(errorMessage: string): string[] {
    const lower = errorMessage.toLowerCase();
    const suggestions: string[] = [];

    for (const { pattern, solutions } of COMMON_ERROR_PATTERNS) {
        if (lower.includes(pattern)) {
            suggestions.push(...solutions);
        }
    }

    return suggestions;
}

/**
 * Extract Godot class names mentioned in an error message.
 * Looks for PascalCase identifiers optionally ending in 2D/3D.
 */
export function extractClassNames(errorMessage: string): string[] {
    const matches = errorMessage.match(/\b([A-Z][a-zA-Z0-9]*(?:2D|3D)?)\b/g);
    if (!matches) return [];
    // Deduplicate
    return [...new Set(matches)];
}
