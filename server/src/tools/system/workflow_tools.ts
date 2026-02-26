/**
 * End-to-end workflow tools for automated testing and verification.
 *
 * Bridges the GDAI MCP gap: AI can run → capture errors → analyze → verify
 * in a single orchestrated flow instead of requiring manual tool chaining.
 */

import { z } from 'zod';
import { promisify } from 'util';
import { execFile } from 'child_process';
import { MCPTool } from '../../utils/types.js';
import { detectGodotPath, validatePath, isGodotProject, detectProjectPath } from '../../core/path-manager.js';
import { getProcessManager } from '../../core/process-manager.js';
import { logDebug, logInfo } from '../../utils/logger.js';
import { parseGodotOutput, getErrorSuggestions } from '../../utils/error_parser.js';

const GODOT_NOT_FOUND_MSG =
    'Godot executable not found. Either:\n' +
    '1. Set "godotPath" in godot-mcp.config.json\n' +
    '2. Set GODOT_PATH environment variable\n' +
    '3. Add Godot to your system PATH';

const execFileAsync = promisify(execFile);

// ---------------------------------------------------------------------------
// Tool definitions
// ---------------------------------------------------------------------------

export const workflowTools: MCPTool[] = [
    {
        name: 'run_and_verify',
        description:
            'Run a Godot project, wait for output, analyze errors, and return a structured ' +
            'verification report — all in one call. This is the end-to-end test loop: ' +
            'launch → capture output → parse errors/warnings → stop → report. ' +
            'Use this to verify changes work after editing scripts or scenes.',
        parameters: z.object({
            projectPath: z.string().describe('Absolute path to the Godot project directory'),
            scene: z.string().optional().describe(
                'Optional: specific scene to run (e.g. "res://scenes/main.tscn")'
            ),
            waitMs: z.number().optional().describe(
                'How long to wait (ms) for the game to produce output before stopping. ' +
                'Default: 8000 (8 seconds). Increase for slower-starting projects.'
            ),
            keepRunning: z.boolean().optional().describe(
                'If true, leave the project running after capturing output (default: false — stops automatically)'
            ),
        }),
        execute: async ({ projectPath, scene, waitMs, keepRunning }) => {
            const resolvedPath = detectProjectPath(projectPath);
            if (!validatePath(resolvedPath)) throw new Error('Invalid project path');
            if (!isGodotProject(resolvedPath)) throw new Error(`Not a Godot project: ${resolvedPath} (resolved from ${projectPath})`);

            const godotPath = await detectGodotPath();
            if (!godotPath) throw new Error(GODOT_NOT_FOUND_MSG);

            const pm = getProcessManager();
            const duration = waitMs ?? 8000;

            logInfo(`run_and_verify: starting project at ${resolvedPath} (wait: ${duration}ms)`);

            // Step 1: Launch the project
            const runResult = await pm.runProject(resolvedPath, godotPath, scene);

            // Step 2: Wait for output with early termination on errors
            const startTime = Date.now();
            let earlyExit = false;
            while (Date.now() - startTime < duration) {
                await new Promise(resolve => setTimeout(resolve, 500));
                const snapshot = pm.getDebugOutput();
                if (snapshot?.errors && snapshot.errors.length > 0) {
                    // Errors detected — give a little more time for context to accumulate
                    logDebug('Errors detected early, waiting 1.5s for context...');
                    await new Promise(resolve => setTimeout(resolve, 1500));
                    earlyExit = true;
                    break;
                }
            }

            // Step 3: Capture current output (snapshot to avoid race conditions)
            const debugOutput = pm.getDebugOutput();
            const output = [...(debugOutput?.output ?? runResult.output)];
            const errors = [...(debugOutput?.errors ?? runResult.errors)];

            // Step 4: Parse errors and warnings
            const { parsedErrors, parsedWarnings } = parseGodotOutput(output, errors);

            // Step 5: Optionally stop the project
            let finalOutput = output;
            let finalErrors = errors;
            if (!keepRunning) {
                const stopResult = pm.stopProject();
                if (stopResult) {
                    finalOutput = stopResult.output;
                    finalErrors = stopResult.errors;
                    // Re-parse with final output
                    const final = parseGodotOutput(finalOutput, finalErrors);
                    // Merge any new errors from shutdown
                    for (const err of final.parsedErrors) {
                        if (!parsedErrors.some(e => e.message === err.message)) {
                            parsedErrors.push(err);
                        }
                    }
                }
            }

            // Step 6: Enrich errors with suggestions
            const errorSuggestions = parsedErrors
                .map(e => ({ error: e.message, suggestions: getErrorSuggestions(e.message) }))
                .filter(s => s.suggestions.length > 0);

            // Step 7: Build the verification report
            const status = parsedErrors.length === 0 ? 'pass' : 'fail';
            const elapsed = Date.now() - startTime;

            const report = {
                status,
                summary: status === 'pass'
                    ? `✅ Project ran for ${elapsed}ms with no errors detected.`
                    : `❌ Found ${parsedErrors.length} error(s) and ${parsedWarnings.length} warning(s)${earlyExit ? ' (detected early)' : ''}.`,
                running: keepRunning ?? false,
                errors: parsedErrors,
                ...(errorSuggestions.length > 0 ? { errorSuggestions } : {}),
                warnings: parsedWarnings,
                rawOutput: finalOutput.slice(-30),   // Last 30 lines
                rawErrors: finalErrors.slice(-15),    // Last 15 error lines
            };

            logInfo(`run_and_verify: ${report.summary}`);
            return JSON.stringify(report, null, 2);
        },
    },

    {
        name: 'get_project_diagnostics',
        description:
            'Validate all scripts in a Godot project without running it. ' +
            'Uses Godot\'s --check-only mode to detect parse errors, type errors, ' +
            'and warnings. Faster than run_and_verify for catching syntax issues.',
        parameters: z.object({
            projectPath: z.string().describe('Absolute path to the Godot project directory'),
        }),
        execute: async ({ projectPath }) => {
            const resolvedPath = detectProjectPath(projectPath);
            if (!validatePath(resolvedPath)) throw new Error('Invalid project path');
            if (!isGodotProject(resolvedPath)) throw new Error(`Not a Godot project: ${resolvedPath} (resolved from ${projectPath})`);

            const godotPath = await detectGodotPath();
            if (!godotPath) throw new Error(GODOT_NOT_FOUND_MSG);

            logDebug(`get_project_diagnostics: checking ${resolvedPath}`);

            const args = ['--headless', '--check-only', '--path', resolvedPath];

            let stdout = '';
            let stderr = '';

            try {
                const result = await execFileAsync(godotPath, args, { timeout: 30000 });
                stdout = result.stdout;
                stderr = result.stderr;
            } catch (error: unknown) {
                if (
                    error instanceof Error &&
                    'stdout' in error &&
                    'stderr' in error
                ) {
                    const execError = error as Error & { stdout: string; stderr: string };
                    stdout = execError.stdout;
                    stderr = execError.stderr;
                } else {
                    throw error;
                }
            }

            const allOutput = (stdout + '\n' + stderr).split('\n').filter(l => l.trim());
            const { parsedErrors, parsedWarnings } = parseGodotOutput(allOutput, []);

            const status = parsedErrors.length === 0 ? 'clean' : 'issues_found';

            const report = {
                status,
                summary: status === 'clean'
                    ? '✅ All scripts pass validation — no parse errors or type issues detected.'
                    : `⚠️ Found ${parsedErrors.length} error(s) and ${parsedWarnings.length} warning(s) in project scripts.`,
                errors: parsedErrors,
                warnings: parsedWarnings,
                rawOutput: allOutput.slice(-30),
            };

            return JSON.stringify(report, null, 2);
        },
    },
];
