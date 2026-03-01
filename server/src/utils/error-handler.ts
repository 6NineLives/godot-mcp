/**
 * Standardized error and success response utilities.
 *
 * Every tool handler should return responses through these helpers so that
 * the AI assistant sees a consistent format — including actionable
 * "possible solutions" when things go wrong.
 */

import { logError, logDebug } from './logger.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ToolResponseContent {
    type: 'text' | 'image';
    text?: string;
    data?: string;
    mimeType?: string;
}

export interface ToolResponse {
    content: ToolResponseContent[];
    isError?: true;
}

// ---------------------------------------------------------------------------
// Responses
// ---------------------------------------------------------------------------

/**
 * Create a standardised error response with optional possible solutions.
 *
 * @example
 * return createErrorResponse('Scene not found', [
 *   'Ensure the scene path is relative to the project root',
 *   'Use list_scenes to find available scenes',
 * ]);
 */
export function createErrorResponse(
    message: string,
    possibleSolutions: string[] = [],
): ToolResponse {
    logError(`Error response: ${message}`);
    if (possibleSolutions.length > 0) {
        logDebug(`Possible solutions: ${possibleSolutions.join(', ')}`);
    }

    const response: ToolResponse = {
        content: [{ type: 'text', text: message }],
        isError: true,
    };

    if (possibleSolutions.length > 0) {
        response.content.push({
            type: 'text',
            text: 'Possible solutions:\n- ' + possibleSolutions.join('\n- '),
        });
    }

    return response;
}

/** Create a plain-text success response. */
export function createSuccessResponse(text: string): ToolResponse {
    return { content: [{ type: 'text', text }] };
}

/** Create a JSON-formatted success response. */
export function createJsonResponse(data: unknown): ToolResponse {
    return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
}
