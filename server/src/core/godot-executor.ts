/**
 * Headless GDScript operation executor.
 *
 * Runs `godot --headless --script godot_operations.gd <operation> <params>`
 * using `execFile` (not `exec`) to prevent command injection.
 */

import { promisify } from 'util';
import { execFile } from 'child_process';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

import {
    convertCamelToSnakeCase,
    type OperationParams,
} from './parameter-normalizer.js';
import { normalizePath } from './path-manager.js';
import { logDebug } from '../utils/logger.js';
import { GODOT_DEBUG_MODE } from '../config/config.js';

const execFileAsync = promisify(execFile);

// ---------------------------------------------------------------------------
// Script path resolution
// ---------------------------------------------------------------------------

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

/** Resolve the bundled godot_operations.gd script path. */
export function getOperationsScriptPath(): string {
    return join(__dirname, '..', 'scripts', 'godot_operations.gd');
}

// ---------------------------------------------------------------------------
// Version helpers
// ---------------------------------------------------------------------------

/** Retrieve the Godot version string (e.g. "4.4.1.stable"). */
export async function getGodotVersion(godotPath: string): Promise<string> {
    const { stdout } = await execFileAsync(godotPath, ['--version']);
    return stdout.trim();
}

/** Check whether a version string represents Godot 4.4+. */
export function isGodot44OrLater(version: string): boolean {
    const match = version.match(/^(\d+)\.(\d+)/);
    if (!match) return false;
    const major = parseInt(match[1], 10);
    const minor = parseInt(match[2], 10);
    return major > 4 || (major === 4 && minor >= 4);
}

// ---------------------------------------------------------------------------
// Core executor
// ---------------------------------------------------------------------------

/**
 * Execute a named operation via the Godot operations GDScript.
 *
 * @param operation  Operation name (e.g. 'create_scene', 'add_node')
 * @param params     Parameters in camelCase — they will be auto-converted
 *                   to snake_case before being sent to the GDScript.
 * @param projectPath  Absolute path to the Godot project directory.
 * @param godotPath    Absolute path to the Godot executable.
 * @returns stdout and stderr produced by the operation.
 */
export async function executeOperation(
    operation: string,
    params: OperationParams,
    projectPath: string,
    godotPath: string,
): Promise<{ stdout: string; stderr: string }> {
    logDebug(`Executing operation: ${operation} in project: ${projectPath}`);
    logDebug(`Original params: ${JSON.stringify(params)}`);

    const normalizedProjectPath = normalizePath(projectPath);
    const snakeCaseParams = convertCamelToSnakeCase(params);
    logDebug(`Converted snake_case params: ${JSON.stringify(snakeCaseParams)}`);

    const paramsJson = JSON.stringify(snakeCaseParams);
    const scriptPath = getOperationsScriptPath();

    // Build the argument list for execFile (no shell interpolation)
    const args: string[] = [
        '--headless',
        '--path',
        normalizedProjectPath,
        '--script',
        scriptPath,
        operation,
        paramsJson,
    ];

    if (GODOT_DEBUG_MODE) {
        args.push('--debug-godot');
    }

    logDebug(`execFile: ${godotPath} ${args.join(' ')}`);

    try {
        const { stdout, stderr } = await execFileAsync(godotPath, args);
        return { stdout, stderr };
    } catch (error: unknown) {
        // execFile rejects on non-zero exit but still populates stdout/stderr
        if (
            error instanceof Error &&
            'stdout' in error &&
            'stderr' in error
        ) {
            const execError = error as Error & { stdout: string; stderr: string };
            return { stdout: execError.stdout, stderr: execError.stderr };
        }
        throw error;
    }
}
