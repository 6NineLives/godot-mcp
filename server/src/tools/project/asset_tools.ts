/**
 * Asset tools — sprite loading, mesh library export, and UID management.
 *
 * Single consolidated tool: `manage_asset`
 * Actions: load_sprite | export_mesh_library | get_uid | update_uids
 *
 * UID actions (get_uid, update_uids) absorbed from the old uid_tools.ts.
 * All actions run headless via the Godot CLI.
 */

import { z } from 'zod';
import { MCPTool, CommandResult } from '../../utils/types.js';
import { detectGodotPath, validatePath, isGodotProject, detectProjectPath } from '../../core/path-manager.js';
import {
    executeOperation,
    getGodotVersion,
    isGodot44OrLater,
} from '../../core/godot-executor.js';

// ---------------------------------------------------------------------------
// Tool definition
// ---------------------------------------------------------------------------

export const assetTools: MCPTool[] = [
    {
        name: 'manage_asset',
        description:
            'Manage Godot assets (sprites, meshes, UIDs). ' +
            'Actions: "load_sprite" to load a texture into a sprite node, ' +
            '"export_mesh_library" to export a scene as a MeshLibrary .res, ' +
            '"get_uid" to get the UID for a file (Godot 4.4+), ' +
            '"update_uids" to re-save all resources to refresh UIDs (Godot 4.4+). ' +
            'All actions run headless via the Godot CLI.',
        parameters: z.object({
            action: z
                .enum(['load_sprite', 'export_mesh_library', 'get_uid', 'update_uids'])
                .describe('Which asset action to perform'),
            projectPath: z.string().optional().describe('Optional absolute path to the Godot project directory. If omitted, it will be auto-detected.'),
            scenePath: z.string().optional().describe(
                'Scene file path (relative to project). Required for: load_sprite, export_mesh_library.'
            ),
            nodePath: z.string().optional().describe(
                'Path to the target node (e.g. "root/Player/Sprite2D"). Required for: load_sprite.'
            ),
            texturePath: z.string().optional().describe(
                'Texture file path (relative to project). Required for: load_sprite.'
            ),
            outputPath: z.string().optional().describe(
                'Output path for the MeshLibrary .res file (relative to project). Required for: export_mesh_library.'
            ),
            filePath: z.string().optional().describe(
                'File path to get UID for (relative to project). Required for: get_uid.'
            ),
        }),
        execute: async (params: Record<string, unknown>): Promise<string> => {
            const action = params.action as string;
            const projectPath = params.projectPath as string | undefined;

            const resolvedPath = detectProjectPath(projectPath);
            if (!validatePath(resolvedPath)) throw new Error('Invalid project path');
            if (!isGodotProject(resolvedPath))
                throw new Error(`Not a Godot project: ${resolvedPath} (resolved from ${projectPath})`);

            const godotPath = await detectGodotPath();
            if (!godotPath) throw new Error('Godot executable not found. Set "godotPath" in godot-mcp.config.json, GODOT_PATH env var, or add Godot to PATH.');

            try {
                switch (action) {
                    // -----------------------------------------------------------
                    case 'load_sprite': {
                        const nodePath = params.nodePath as string;
                        const texturePath = params.texturePath as string;
                        if (!nodePath) throw new Error('nodePath is required for action "load_sprite"');
                        if (!texturePath) throw new Error('texturePath is required for action "load_sprite"');

                        // Use WebSocket (live editor) instead of headless CLI because
                        // headless mode cannot load image textures without .import metadata
                        const { getGodotConnection } = await import('../../utils/godot_connection.js');
                        const godot = getGodotConnection();

                        const result = await godot.sendCommand<CommandResult>('load_sprite', {
                            node_path: nodePath,
                            texture_path: texturePath,
                        });

                        return `✅ Sprite loaded: ${texturePath} → ${nodePath}`;
                    }

                    // -----------------------------------------------------------
                    case 'export_mesh_library': {
                        const scenePath = params.scenePath as string;
                        const outputPath = params.outputPath as string;
                        if (!scenePath) throw new Error('scenePath is required for action "export_mesh_library"');
                        if (!outputPath) throw new Error('outputPath is required for action "export_mesh_library"');

                        const { stdout, stderr } = await executeOperation(
                            'export_mesh_library', { scenePath, outputPath }, resolvedPath, godotPath,
                        );
                        if (stderr && stderr.includes('Failed to')) throw new Error(`Failed to export mesh library: ${stderr}`);
                        return `MeshLibrary exported: ${scenePath} → ${outputPath}\n\nOutput: ${stdout}`;
                    }

                    // -----------------------------------------------------------
                    case 'get_uid': {
                        const filePath = params.filePath as string;
                        if (!filePath) throw new Error('filePath is required for action "get_uid"');

                        const version = await getGodotVersion(godotPath);
                        if (!isGodot44OrLater(version)) {
                            throw new Error(`get_uid requires Godot 4.4+. Detected version: ${version}.`);
                        }

                        const { stdout, stderr } = await executeOperation('get_uid', { filePath }, resolvedPath, godotPath);
                        if (stderr && stderr.includes('Failed to')) throw new Error(`Failed to get UID: ${stderr}`);
                        return `UID for ${filePath}: ${stdout.trim()}`;
                    }

                    // -----------------------------------------------------------
                    case 'update_uids': {
                        const version = await getGodotVersion(godotPath);
                        if (!isGodot44OrLater(version)) {
                            throw new Error(`update_uids requires Godot 4.4+. Detected version: ${version}.`);
                        }

                        const { stdout, stderr } = await executeOperation('resave_resources', {}, resolvedPath, godotPath);
                        if (stderr && stderr.includes('Failed to')) throw new Error(`Failed to update project UIDs: ${stderr}`);
                        return `Project UIDs updated successfully.\n\nOutput: ${stdout}`;
                    }

                    default:
                        throw new Error(`Unknown action: ${action}`);
                }
            } catch (error) {
                if ((error as Error).message.startsWith('Unknown action:')) throw error;
                throw new Error(`Asset action "${action}" failed: ${(error as Error).message}`);
            }
        },
    },
];
