/**
 * Project management tools (headless — no WebSocket required).
 *
 * Single consolidated tool: `manage_project`
 * Actions: launch_editor | run | stop | get_output | get_version | list | get_info
 *
 * These tools interact with Godot via the CLI or process spawning and do NOT
 * require the Godot editor addon to be running.
 */

import { z } from 'zod';
import { existsSync, readdirSync, readFileSync } from 'fs';
import { join, basename } from 'path';
import { MCPTool } from '../../utils/types.js';
import { detectGodotPath, validatePath, isGodotProject, detectProjectPath } from '../../core/path-manager.js';
import { getGodotVersion } from '../../core/godot-executor.js';
import { getProcessManager } from '../../core/process-manager.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function findProjects(directory: string, recursive: boolean): string[] {
    const projects: string[] = [];
    try {
        if (isGodotProject(directory)) projects.push(directory);
        if (recursive) {
            for (const entry of readdirSync(directory, { withFileTypes: true })) {
                if (entry.isDirectory() && !entry.name.startsWith('.')) {
                    projects.push(...findProjects(join(directory, entry.name), true));
                }
            }
        } else {
            for (const entry of readdirSync(directory, { withFileTypes: true })) {
                if (entry.isDirectory()) {
                    const sub = join(directory, entry.name);
                    if (isGodotProject(sub)) projects.push(sub);
                }
            }
        }
    } catch { /* ignore inaccessible */ }
    return projects;
}

function getProjectStructure(projectPath: string): Record<string, number> {
    const counts: Record<string, number> = {
        scenes: 0, scripts: 0, resources: 0, shaders: 0, images: 0, audio: 0, other: 0,
    };
    const extMap: Record<string, string> = {
        '.tscn': 'scenes', '.scn': 'scenes',
        '.gd': 'scripts', '.cs': 'scripts',
        '.tres': 'resources', '.res': 'resources',
        '.gdshader': 'shaders', '.shader': 'shaders',
        '.png': 'images', '.jpg': 'images', '.svg': 'images', '.webp': 'images',
        '.wav': 'audio', '.ogg': 'audio', '.mp3': 'audio',
    };

    function walk(dir: string) {
        try {
            for (const entry of readdirSync(dir, { withFileTypes: true })) {
                if (entry.name.startsWith('.') || entry.name === 'addons') continue;
                const full = join(dir, entry.name);
                if (entry.isDirectory()) walk(full);
                else {
                    const ext = entry.name.substring(entry.name.lastIndexOf('.')).toLowerCase();
                    counts[extMap[ext] ?? 'other']++;
                }
            }
        } catch { /* ignore */ }
    }
    walk(projectPath);
    return counts;
}

// ---------------------------------------------------------------------------
// Tool definition
// ---------------------------------------------------------------------------

export const projectTools: MCPTool[] = [
    {
        name: 'manage_project',
        description:
            'Manage Godot projects (headless, no addon required). ' +
            'Actions: "launch_editor" to open the Godot editor, ' +
            '"run" to run a project in debug mode, "stop" to stop a running project, ' +
            '"get_output" to get stdout/stderr from the running project, ' +
            '"get_version" to get the installed Godot version, ' +
            '"list" to find Godot projects in a directory, ' +
            '"get_info" to get project metadata and file structure.',
        parameters: z.object({
            action: z
                .enum(['launch_editor', 'run', 'stop', 'get_output', 'get_version', 'list', 'get_info'])
                .describe('Which project action to perform'),
            projectPath: z.string().optional().describe(
                'Optional absolute path to the Godot project directory. If omitted, it will be auto-detected.'
            ),
            scene: z.string().optional().describe(
                'Specific scene to run (relative to project). Used for: run.'
            ),
            directory: z.string().optional().describe(
                'Directory to search for projects. Required for: list.'
            ),
            recursive: z.boolean().optional().describe(
                'Search recursively for projects. Used for: list.'
            ),
        }),
        execute: async (params: Record<string, unknown>): Promise<string> => {
            const action = params.action as string;

            try {
                switch (action) {
                    // -----------------------------------------------------------
                    case 'launch_editor': {
                        const projectPath = params.projectPath as string | undefined;

                        // If already connected to a Godot editor via WebSocket, don't launch a second instance.
                        // Two editors competing for port 9080 causes both to malfunction.
                        const { getGodotConnection } = await import('../../utils/godot_connection.js');
                        const existingConn = getGodotConnection();
                        if (existingConn.isConnected()) {
                            return 'Godot editor is already running and connected (WebSocket active on port 9080). ' +
                                'Use the existing editor instance instead of launching a new one.';
                        }

                        const resolvedPath = detectProjectPath(projectPath);
                        if (!validatePath(resolvedPath)) throw new Error('Invalid project path');
                        if (!isGodotProject(resolvedPath)) throw new Error(`Not a Godot project: ${resolvedPath}`);

                        const godotPath = await detectGodotPath();
                        if (!godotPath) throw new Error('Godot executable not found. Set "godotPath" in godot-mcp.config.json, GODOT_PATH env var, or add Godot to PATH.');

                        const pm = getProcessManager();
                        await pm.launchEditor(resolvedPath, godotPath);
                        return `Godot editor launched for project: ${resolvedPath}`;
                    }


                    // -----------------------------------------------------------
                    case 'run': {
                        const projectPath = params.projectPath as string | undefined;

                        const resolvedPath = detectProjectPath(projectPath);
                        if (!validatePath(resolvedPath)) throw new Error('Invalid project path');
                        if (!isGodotProject(resolvedPath)) throw new Error(`Not a Godot project: ${resolvedPath}`);

                        const godotPath = await detectGodotPath();
                        if (!godotPath) throw new Error('Godot executable not found. Set "godotPath" in godot-mcp.config.json, GODOT_PATH env var, or add Godot to PATH.');

                        const pm = getProcessManager();
                        const result = await pm.runProject(resolvedPath, godotPath, params.scene as string | undefined);
                        return JSON.stringify({
                            status: 'running',
                            initialOutput: result.output.slice(-20),
                            initialErrors: result.errors.slice(-10),
                        }, null, 2);
                    }

                    // -----------------------------------------------------------
                    case 'stop': {
                        const pm = getProcessManager();
                        const result = pm.stopProject();
                        if (!result) return 'No project is currently running.';
                        return JSON.stringify({
                            status: 'stopped',
                            finalOutput: result.output.slice(-30),
                            finalErrors: result.errors.slice(-10),
                        }, null, 2);
                    }

                    // -----------------------------------------------------------
                    case 'get_output': {
                        const pm = getProcessManager();
                        const result = pm.getDebugOutput();
                        if (!result) return 'No project output available. Run a project first.';
                        return JSON.stringify({
                            running: pm.isRunning(),
                            output: result.output.slice(-50),
                            errors: result.errors.slice(-20),
                        }, null, 2);
                    }

                    // -----------------------------------------------------------
                    case 'get_version': {
                        const godotPath = await detectGodotPath();
                        if (!godotPath) throw new Error('Godot executable not found. Set "godotPath" in godot-mcp.config.json, GODOT_PATH env var, or add Godot to PATH.');
                        const version = await getGodotVersion(godotPath);
                        return `Godot version: ${version}`;
                    }

                    // -----------------------------------------------------------
                    case 'list': {
                        const directory = params.directory as string;
                        if (!directory) throw new Error('directory is required for action "list"');
                        if (!validatePath(directory)) throw new Error('Invalid directory path');
                        if (!existsSync(directory)) throw new Error(`Directory does not exist: ${directory}`);

                        const projects = findProjects(directory, (params.recursive as boolean) ?? false);
                        if (projects.length === 0) return `No Godot projects found in ${directory}`;
                        return JSON.stringify({
                            count: projects.length,
                            projects: projects.map(p => ({ path: p, name: basename(p) })),
                        }, null, 2);
                    }

                    // -----------------------------------------------------------
                    case 'get_info': {
                        const projectPath = params.projectPath as string | undefined;

                        const resolvedPath = detectProjectPath(projectPath);
                        if (!validatePath(resolvedPath)) throw new Error('Invalid project path');
                        if (!isGodotProject(resolvedPath)) throw new Error(`Not a Godot project: ${resolvedPath}`);

                        let projectName = basename(resolvedPath);
                        try {
                            const content = readFileSync(join(resolvedPath, 'project.godot'), 'utf8');
                            const nameMatch = content.match(/config\/name="([^"]+)"/);
                            if (nameMatch) projectName = nameMatch[1];
                        } catch { /* use directory name */ }

                        const structure = getProjectStructure(resolvedPath);
                        return JSON.stringify({ name: projectName, path: resolvedPath, fileStructure: structure }, null, 2);
                    }

                    default:
                        throw new Error(`Unknown action: ${action}`);
                }
            } catch (error) {
                if ((error as Error).message.startsWith('Unknown action:')) throw error;
                throw new Error(`Project action "${action}" failed: ${(error as Error).message}`);
            }
        },
    },
];

/** Read-only tools from this module (for ToolRegistry metadata). */
export const PROJECT_READONLY_TOOLS = [
    'manage_project', // get_output, stop, get_version, list, get_info actions are read-only
];

/** Write tools from this module. */
export const PROJECT_WRITE_TOOLS = [
    'manage_project', // launch_editor, run actions are write
];
