/**
 * Game scene tools — live scene tree inspection/control of a running game.
 *
 * Single consolidated tool: `game_scene`
 * Actions: get_tree | find_nodes | get_properties | set_property | call_method | reset | load
 */

import { z } from 'zod';
import { MCPTool } from '../../utils/types.js';
import { getGameBridge } from '../../core/game_bridge.js';
import { loadConfig } from '../../config/config.js';

export const gameSceneTools: MCPTool[] = [
    {
        name: 'game_scene',
        description:
            'Inspect and control the scene tree of a running Godot game (via the game bridge). ' +
            'Actions: "get_tree" dumps the scene tree, "find_nodes" searches by name/class/group, ' +
            '"get_properties" reads node properties, "set_property" sets a property, ' +
            '"call_method" calls a method (requires allowUnsafeGameCommands), ' +
            '"reset" reloads the current scene, "load" loads a different scene.',
        parameters: z.object({
            action: z
                .enum(['get_tree', 'find_nodes', 'get_properties', 'set_property', 'call_method', 'reset', 'load'])
                .describe('Which scene action to perform'),
            nodePath: z.string().optional().describe(
                'Path to the target node (e.g. "/root/Main/Player"). ' +
                'Required for: get_properties, set_property, call_method.'
            ),
            maxDepth: z.number().optional().describe(
                'Maximum tree depth for get_tree (default: 10).'
            ),
            pattern: z.string().optional().describe(
                'Name pattern to search for. Used for: find_nodes.'
            ),
            type: z.string().optional().describe(
                'Class name filter (e.g. "Sprite2D"). Used for: find_nodes.'
            ),
            group: z.string().optional().describe(
                'Group name to search. Used for: find_nodes.'
            ),
            property: z.string().optional().describe(
                'Property name. Required for: set_property.'
            ),
            value: z.any().optional().describe(
                'Property value to set. Required for: set_property.'
            ),
            filter: z.array(z.string()).optional().describe(
                'List of property names to return (default: all editor properties). Used for: get_properties.'
            ),
            method: z.string().optional().describe(
                'Method name to call. Required for: call_method.'
            ),
            args: z.array(z.any()).optional().describe(
                'Arguments for method call. Used for: call_method.'
            ),
            scenePath: z.string().optional().describe(
                'Scene path to load (e.g. "res://scenes/level2.tscn"). Required for: load.'
            ),
        }),
        execute: async (params: Record<string, unknown>): Promise<string> => {
            const action = params.action as string;
            const bridge = getGameBridge();
            const config = loadConfig();

            if (!bridge.isConnected()) {
                throw new Error('Not connected to game bridge. Use manage_game_bridge action "connect" first.');
            }

            try {
                switch (action) {
                    case 'get_tree': {
                        const result = await bridge.sendCommand('get_tree', {
                            max_depth: (params.maxDepth as number) ?? 10,
                        });
                        return JSON.stringify(result, null, 2);
                    }

                    case 'find_nodes': {
                        const result = await bridge.sendCommand('find_nodes', {
                            pattern: (params.pattern as string) || '',
                            type: (params.type as string) || '',
                            group: (params.group as string) || '',
                        });
                        return JSON.stringify(result, null, 2);
                    }

                    case 'get_properties': {
                        const nodePath = params.nodePath as string;
                        if (!nodePath) throw new Error('nodePath is required for action "get_properties"');

                        const result = await bridge.sendCommand('get_node_properties', {
                            node_path: nodePath,
                            filter: (params.filter as string[]) || [],
                        });
                        return JSON.stringify(result, null, 2);
                    }

                    case 'set_property': {
                        const nodePath = params.nodePath as string;
                        const property = params.property as string;
                        if (!nodePath) throw new Error('nodePath is required for action "set_property"');
                        if (!property) throw new Error('property is required for action "set_property"');

                        const result = await bridge.sendCommand('set_node_property', {
                            node_path: nodePath,
                            property,
                            value: params.value,
                        });
                        return JSON.stringify(result, null, 2);
                    }

                    case 'call_method': {
                        if (!config.allowUnsafeGameCommands) {
                            throw new Error(
                                'call_method requires "allowUnsafeGameCommands": true in godot-mcp.config.json'
                            );
                        }

                        const nodePath = params.nodePath as string;
                        const method = params.method as string;
                        if (!nodePath) throw new Error('nodePath is required for action "call_method"');
                        if (!method) throw new Error('method is required for action "call_method"');

                        const result = await bridge.sendCommand('call_method', {
                            node_path: nodePath,
                            method,
                            args: (params.args as any[]) || [],
                        });
                        return JSON.stringify(result, null, 2);
                    }

                    case 'reset': {
                        const result = await bridge.sendCommand('reset_scene', {});
                        return `✅ Scene reloaded: ${result.reloaded}`;
                    }

                    case 'load': {
                        const scenePath = params.scenePath as string;
                        if (!scenePath) throw new Error('scenePath is required for action "load"');

                        const result = await bridge.sendCommand('load_scene', {
                            scene_path: scenePath,
                        });
                        return `✅ Scene loaded: ${result.loaded}`;
                    }

                    default:
                        throw new Error(`Unknown action: ${action}`);
                }
            } catch (error) {
                if ((error as Error).message.startsWith('Unknown action:')) throw error;
                throw new Error(`Game scene action "${action}" failed: ${(error as Error).message}`);
            }
        },
    },
];
