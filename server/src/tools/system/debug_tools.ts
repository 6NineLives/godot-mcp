/**
 * Debug tools — running scenes, analyzing errors, and diagnosing issues.
 *
 * Single consolidated tool: `debug_project`
 * Actions: run_scene | get_error_context | get_debug_output | remote_tree_dump |
 *          toggle_debug_draw | list_missing_assets
 *
 * "list_missing_assets" absorbed from the old diagnostic_tools.ts.
 */

import { z } from 'zod';
import { join, extname } from 'path';
import { existsSync, readFileSync, readdirSync } from 'fs';
import { MCPTool } from '../../utils/types.js';
import {
    detectGodotPath,
    validatePath,
    isGodotProject,
    detectProjectPath,
} from '../../core/path-manager.js';
import { getProcessManager } from '../../core/process-manager.js';
import { logDebug, logInfo } from '../../utils/logger.js';
import {
    parseGodotOutput,
    getErrorSuggestions,
    extractClassNames,
} from '../../utils/error_parser.js';

// ---------------------------------------------------------------------------
// Helpers (for list_missing_assets)
// ---------------------------------------------------------------------------

function collectFiles(dir: string, extensions: Set<string>, result: string[] = []): string[] {
    let entries;
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return result; }
    for (const entry of entries) {
        const fullPath = join(dir, entry.name);
        if (entry.name.startsWith('.') || entry.name === 'addons' || entry.name === '.godot') continue;
        if (entry.isDirectory()) collectFiles(fullPath, extensions, result);
        else if (extensions.has(extname(entry.name).toLowerCase())) result.push(fullPath);
    }
    return result;
}

function extractResPaths(content: string): string[] {
    const matches = content.match(/res:\/\/[^\s"'\])\},]+/g) ?? [];
    return matches.map(m => m.replace(/[;:\s]+$/, ''));
}

// ---------------------------------------------------------------------------
// Tool definition
// ---------------------------------------------------------------------------

export const debugTools: MCPTool[] = [
    {
        name: 'debug_project',
        description:
            'Debug and diagnose a Godot project. ' +
            'Actions: "run_scene" to run a scene and get structured error output, ' +
            '"get_error_context" to analyze an error message with suggestions, ' +
            '"get_debug_output" to retrieve live stdout/stderr from a running project, ' +
            '"remote_tree_dump" to dump the live scene tree via WebSocket, ' +
            '"toggle_debug_draw" to toggle visual debug draw modes, ' +
            '"list_missing_assets" to scan for broken res:// references.',
        parameters: z.object({
            action: z
                .enum(['run_scene', 'get_error_context', 'get_debug_output', 'remote_tree_dump', 'toggle_debug_draw', 'list_missing_assets'])
                .describe('Which debug action to perform'),
            projectPath: z.string().optional().describe(
                'Absolute path to the Godot project directory. Required for: run_scene, list_missing_assets.'
            ),
            scenePath: z.string().optional().describe(
                'Scene to run (e.g. "scenes/main.tscn"). Required for: run_scene.'
            ),
            timeoutMs: z.number().optional().describe(
                'Max wait for scene run (ms, default: 15000). Used for: run_scene.'
            ),
            debug: z.boolean().optional().describe(
                'Run with verbose debug flags (default: true). Used for: run_scene.'
            ),
            errorMessage: z.string().optional().describe(
                'Error message to analyze. Required for: get_error_context.'
            ),
            script: z.string().optional().describe(
                'Script where error occurred. Used for: get_error_context.'
            ),
            line: z.number().optional().describe(
                'Line number of error. Used for: get_error_context.'
            ),
            lastN: z.number().optional().describe(
                'Number of recent output lines (default: 50). Used for: get_debug_output.'
            ),
            rootPath: z.string().optional().describe(
                'Root node path for tree dump (default: "/root"). Used for: remote_tree_dump.'
            ),
            maxDepth: z.number().optional().describe(
                'Max depth for tree dump (-1 = unlimited). Used for: remote_tree_dump.'
            ),
            includeProperties: z.boolean().optional().describe(
                'Include node properties in tree dump. Used for: remote_tree_dump.'
            ),
            filterType: z.string().optional().describe(
                'Only include nodes of this type. Used for: remote_tree_dump.'
            ),
            mode: z.string().optional().describe(
                'Debug draw mode (e.g. "wireframe", "overdraw", "disabled"). Required for: toggle_debug_draw.'
            ),
            checkTypes: z.array(z.string()).optional().describe(
                'File extensions to scan (default: [".tscn",".tres",".gd"]). Used for: list_missing_assets.'
            ),
        }),
        execute: async (params: Record<string, unknown>): Promise<string> => {
            const action = params.action as string;

            try {
                switch (action) {
                    // -----------------------------------------------------------
                    case 'run_scene': {
                        const projectPath = params.projectPath as string;
                        const scenePath = params.scenePath as string;
                        if (!projectPath) throw new Error('projectPath is required for action "run_scene"');
                        if (!scenePath) throw new Error('scenePath is required for action "run_scene"');

                        const resolvedPath = detectProjectPath(projectPath);
                        if (!validatePath(resolvedPath)) throw new Error('Invalid project path');
                        if (!isGodotProject(resolvedPath)) throw new Error(`Not a Godot project: ${resolvedPath}`);

                        const godotPath = await detectGodotPath();
                        if (!godotPath) throw new Error('Godot executable not found. Set "godotPath" in godot-mcp.config.json, GODOT_PATH env var, or add Godot to PATH.');

                        const pm = getProcessManager();
                        const timeout = (params.timeoutMs as number) ?? 15000;
                        logInfo(`debug_project/run_scene: ${scenePath} (timeout: ${timeout}ms)`);

                        const runResult = await pm.runProject(resolvedPath, godotPath, scenePath);
                        const startTime = Date.now();
                        while (pm.isRunning() && Date.now() - startTime < timeout) {
                            await new Promise(resolve => setTimeout(resolve, 500));
                        }

                        const timedOut = pm.isRunning();
                        if (timedOut) pm.stopProject();

                        const debugOutput = pm.getDebugOutput();
                        const output = debugOutput?.output ?? runResult.output;
                        const errors = debugOutput?.errors ?? runResult.errors;
                        const { parsedErrors, parsedWarnings } = parseGodotOutput(output, errors);

                        const success = parsedErrors.length === 0 && !timedOut;
                        const report = {
                            scene: scenePath, success, timedOut,
                            summary: success
                                ? '✅ Scene ran successfully with no errors.'
                                : timedOut
                                    ? `⏱️ Scene timed out after ${timeout}ms. ${parsedErrors.length} error(s), ${parsedWarnings.length} warning(s).`
                                    : `❌ Scene exited with ${parsedErrors.length} error(s) and ${parsedWarnings.length} warning(s).`,
                            errors: parsedErrors, warnings: parsedWarnings,
                            consoleOutput: output.slice(-50),
                            nextSteps: parsedErrors.length > 0
                                ? ['Use debug_project with action "get_error_context" for detailed solutions', 'Use validate_scene to check the scene file', 'Use get_project_diagnostics to check all scripts']
                                : [],
                        };
                        logInfo(`debug_project/run_scene: ${report.summary}`);
                        return JSON.stringify(report, null, 2);
                    }

                    // -----------------------------------------------------------
                    case 'get_error_context': {
                        const errorMessage = params.errorMessage as string;
                        if (!errorMessage) throw new Error('errorMessage is required for action "get_error_context"');

                        logDebug(`debug_project/get_error_context: analyzing "${errorMessage}"`);

                        let errorType = 'runtime';
                        const lowerMsg = errorMessage.toLowerCase();
                        if (lowerMsg.includes('parse') || lowerMsg.includes('syntax') || lowerMsg.includes('unexpected')) errorType = 'script/parse';
                        else if (lowerMsg.includes('shader')) errorType = 'shader';
                        else if (lowerMsg.includes('engine') || lowerMsg.includes('internal')) errorType = 'engine';
                        else if (lowerMsg.includes('null') || lowerMsg.includes('invalid')) errorType = 'runtime/null_reference';
                        else if (lowerMsg.includes('type')) errorType = 'runtime/type';

                        const suggestions = getErrorSuggestions(errorMessage);
                        const classNames = extractClassNames(errorMessage);
                        const docLinks = classNames.slice(0, 5).map(cls => ({
                            className: cls,
                            url: `https://docs.godotengine.org/en/stable/classes/class_${cls.toLowerCase()}.html`,
                        }));

                        return JSON.stringify({
                            errorType, message: errorMessage,
                            location: params.script ? { script: params.script, line: params.line ?? null } : null,
                            suggestions: suggestions.length > 0 ? suggestions : ['Check the Godot documentation', 'Search the Godot Q&A forums', 'Verify the script and scene are saved before running'],
                            relatedDocs: docLinks,
                        }, null, 2);
                    }

                    // -----------------------------------------------------------
                    case 'get_debug_output': {
                        const pm = getProcessManager();
                        const debugOutput = pm.getDebugOutput();
                        if (!debugOutput) {
                            return JSON.stringify({ status: 'no_session', message: 'No running or recently-run project found.' });
                        }

                        const limit = (params.lastN as number) ?? 50;
                        const { parsedErrors, parsedWarnings } = parseGodotOutput(debugOutput.output, debugOutput.errors);
                        return JSON.stringify({
                            status: pm.isRunning() ? 'running' : 'stopped',
                            totalOutputLines: debugOutput.output.length,
                            totalErrorLines: debugOutput.errors.length,
                            errors: parsedErrors, warnings: parsedWarnings,
                            recentOutput: debugOutput.output.slice(-limit),
                            recentErrors: debugOutput.errors.slice(-Math.min(limit, 20)),
                        }, null, 2);
                    }

                    // -----------------------------------------------------------
                    case 'remote_tree_dump': {
                        const { getGodotConnection } = await import('../../utils/godot_connection.js');
                        const godot = getGodotConnection();

                        const rootP = (params.rootPath as string) ?? '/root';
                        logInfo(`debug_project/remote_tree_dump: root=${rootP}`);

                        const result = await godot.sendCommand<{
                            tree: Array<{ name: string; type: string; path: string; children_count: number; properties?: Record<string, unknown>; signals?: string[] }>;
                        }>('get_tree_dump', {
                            root_path: rootP,
                            max_depth: (params.maxDepth as number) ?? -1,
                            include_properties: (params.includeProperties as boolean) ?? false,
                            filter_type: (params.filterType as string) ?? '',
                        });

                        if (!result.tree || result.tree.length === 0) {
                            return JSON.stringify({ status: 'empty', message: `No nodes found at ${rootP}` });
                        }

                        const treeLines = result.tree.map(n => {
                            const depth = (n.path.match(/\//g) || []).length - 1;
                            const prefix = '  '.repeat(Math.max(0, depth));
                            let line = `${prefix}${n.name} (${n.type}) [${n.path}]`;
                            if (n.children_count > 0) line += ` — ${n.children_count} children`;
                            return line;
                        });

                        return JSON.stringify({
                            rootPath: rootP,
                            totalNodes: result.tree.length,
                            filterApplied: params.filterType ?? null,
                            tree: treeLines.join('\n'),
                            rawNodes: params.includeProperties ? result.tree : undefined,
                        }, null, 2);
                    }

                    // -----------------------------------------------------------
                    case 'toggle_debug_draw': {
                        const mode = params.mode as string;
                        if (!mode) throw new Error('mode is required for action "toggle_debug_draw"');

                        const { getGodotConnection } = await import('../../utils/godot_connection.js');
                        const godot = getGodotConnection();
                        logInfo(`debug_project/toggle_debug_draw: mode="${mode}"`);

                        await godot.sendCommand('set_debug_draw', { mode });
                        return mode === 'disabled'
                            ? '✅ Debug drawing disabled.'
                            : `✅ Debug draw mode set to "${mode}". Open the viewport to see the effect.`;
                    }

                    // -----------------------------------------------------------
                    case 'list_missing_assets': {
                        const projectPath = params.projectPath as string;
                        if (!projectPath) throw new Error('projectPath is required for action "list_missing_assets"');

                        const resolvedPath = detectProjectPath(projectPath);
                        if (!validatePath(resolvedPath)) throw new Error('Invalid project path');
                        if (!isGodotProject(resolvedPath)) throw new Error(`Not a Godot project: ${resolvedPath}`);

                        logInfo(`debug_project/list_missing_assets: scanning ${resolvedPath}`);
                        const extensions = new Set<string>((params.checkTypes as string[]) ?? ['.tscn', '.tres', '.gd']);
                        const files = collectFiles(resolvedPath, extensions);

                        interface MissingAssetInfo { resPath: string; referencedBy: string[]; suggestedFixes: string[] }
                        const missingMap = new Map<string, MissingAssetInfo>();
                        let totalReferences = 0;

                        for (const filePath of files) {
                            let content: string;
                            try { content = readFileSync(filePath, 'utf8'); } catch { continue; }
                            const resPaths = extractResPaths(content);
                            totalReferences += resPaths.length;

                            for (const resPath of resPaths) {
                                const relativePath = resPath.replace(/^res:\/\//, '');
                                const absolutePath = join(resolvedPath, relativePath);
                                if (!existsSync(absolutePath)) {
                                    const relFile = filePath.replace(resolvedPath, '').replace(/\\/g, '/').replace(/^\//, '');
                                    if (missingMap.has(resPath)) {
                                        const existing = missingMap.get(resPath)!;
                                        if (!existing.referencedBy.includes(relFile)) existing.referencedBy.push(relFile);
                                    } else {
                                        const fixes: string[] = [];
                                        const ext = extname(relativePath).toLowerCase();
                                        if (['.png', '.jpg', '.svg'].includes(ext)) { fixes.push(`Add the missing image: ${relativePath}`, 'Check if the asset was renamed or moved'); }
                                        else if (ext === '.tscn') { fixes.push(`Create or restore the missing scene: ${relativePath}`, 'Update the reference path'); }
                                        else if (ext === '.gd') { fixes.push(`Create or restore the missing script: ${relativePath}`); }
                                        else if (ext === '.tres') { fixes.push(`Create or restore the missing resource: ${relativePath}`); }
                                        else { fixes.push(`Add the missing file: ${relativePath}`); }
                                        fixes.push('Remove the reference if no longer needed');
                                        missingMap.set(resPath, { resPath, referencedBy: [relFile], suggestedFixes: fixes });
                                    }
                                }
                            }
                        }

                        const missingAssets = Array.from(missingMap.values());
                        const report = {
                            status: missingAssets.length === 0 ? 'clean' : 'missing_assets_found',
                            summary: missingAssets.length === 0
                                ? `✅ All ${totalReferences} asset references are valid.`
                                : `⚠️ Found ${missingAssets.length} missing asset(s) across ${files.length} scanned files.`,
                            scannedFiles: files.length, totalReferences, missingAssets,
                        };
                        logInfo(`debug_project/list_missing_assets: ${report.summary}`);
                        return JSON.stringify(report, null, 2);
                    }

                    default:
                        throw new Error(`Unknown action: ${action}`);
                }
            } catch (error) {
                if ((error as Error).message.startsWith('Unknown action:')) throw error;
                throw new Error(`Debug action "${action}" failed: ${(error as Error).message}`);
            }
        },
    },
];
