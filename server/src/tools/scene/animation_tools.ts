/**
 * Animation tools — manage AnimationPlayers, keyframes, and AnimationTrees.
 *
 * Single consolidated tool: `manage_animation`
 * Actions: create_player | add_keyframes | setup_tree
 *
 * Uses WebSocket for live editor manipulation.
 */

import { z } from 'zod';
import { getGodotConnection } from '../../utils/godot_connection.js';
import { MCPTool, CommandResult } from '../../utils/types.js';
import { logInfo } from '../../utils/logger.js';

// ---------------------------------------------------------------------------
// Tool definition
// ---------------------------------------------------------------------------

export const animationTools: MCPTool[] = [
    {
        name: 'manage_animation',
        description:
            'Manage animations in a Godot scene. ' +
            'Actions: "create_player" to add an AnimationPlayer with a named animation, ' +
            '"add_keyframes" to insert keyframes into existing animations, ' +
            '"setup_tree" to configure an AnimationTree for blending. ' +
            'Requires the Godot editor addon to be running.',
        parameters: z.object({
            action: z
                .enum(['create_player', 'add_keyframes', 'setup_tree'])
                .describe('Which animation action to perform'),

            // For create_player
            parent_path: z
                .string()
                .optional()
                .describe('Parent node path (for create_player / setup_tree)'),
            node_name: z
                .string()
                .optional()
                .describe('Name for the new AnimationPlayer/Tree node'),
            animation_name: z
                .string()
                .optional()
                .describe('Name of the animation to create (for create_player)'),
            animation_length: z
                .number()
                .optional()
                .describe('Duration of the animation in seconds (default: 1.0)'),
            loop_mode: z
                .enum(['none', 'linear', 'pingpong'])
                .optional()
                .describe('Loop mode: "none", "linear", or "pingpong" (default: "none")'),

            // For add_keyframes
            animation_player_path: z
                .string()
                .optional()
                .describe('Path to the AnimationPlayer node (for add_keyframes)'),
            track_path: z
                .string()
                .optional()
                .describe(
                    'Node property path for the track (for add_keyframes). ' +
                    'E.g. "Sprite2D:position", "Player:modulate".',
                ),
            track_type: z
                .enum(['value', 'method', 'bezier', 'audio', 'animation'])
                .optional()
                .describe('Type of animation track (default: "value")'),
            keyframes: z
                .array(
                    z.object({
                        time: z.number().describe('Time position in seconds'),
                        value: z.any().describe('Value at this keyframe'),
                        transition: z.number().optional().describe('Easing transition (-1 to 1)'),
                    }),
                )
                .optional()
                .describe('Array of keyframes to insert (for add_keyframes)'),

            // For setup_tree
            animation_player_node: z
                .string()
                .optional()
                .describe(
                    'Path to the AnimationPlayer this tree references (for setup_tree)',
                ),
            tree_root_type: z
                .enum([
                    'state_machine',
                    'blend_tree',
                    'blend_space_1d',
                    'blend_space_2d',
                ])
                .optional()
                .describe('Root node type for the AnimationTree (for setup_tree)'),
        }),
        execute: async (params: Record<string, unknown>) => {
            const godot = getGodotConnection();
            const action = params.action as string;

            logInfo(`manage_animation: action=${action}`);

            try {
                switch (action) {
                    case 'create_player': {
                        if (!params.parent_path) throw new Error('parent_path is required');
                        const nodeName = (params.node_name as string) || 'AnimationPlayer';
                        const animName = (params.animation_name as string) || 'default';
                        const length = (params.animation_length as number) ?? 1.0;

                        // Create AnimationPlayer node
                        await godot.sendCommand<CommandResult>('create_node', {
                            parent_path: params.parent_path,
                            node_type: 'AnimationPlayer',
                            node_name: nodeName,
                        });

                        // Create an animation via the WebSocket command
                        const playerPath = `${params.parent_path}/${nodeName}`;
                        await godot.sendCommand<CommandResult>('create_animation', {
                            animation_player_path: playerPath,
                            animation_name: animName,
                            length,
                            loop_mode: params.loop_mode || 'none',
                        });

                        return (
                            `✅ Created AnimationPlayer "${nodeName}" under ${params.parent_path} ` +
                            `with animation "${animName}" (${length}s, loop: ${params.loop_mode || 'none'})`
                        );
                    }

                    case 'add_keyframes': {
                        if (!params.animation_player_path)
                            throw new Error('animation_player_path is required');
                        if (!params.animation_name)
                            throw new Error('animation_name is required');
                        if (!params.track_path) throw new Error('track_path is required');
                        if (!params.keyframes || !Array.isArray(params.keyframes))
                            throw new Error('keyframes array is required');

                        const keyframes = params.keyframes as Array<{
                            time: number;
                            value: unknown;
                            transition?: number;
                        }>;

                        const result = await godot.sendCommand<CommandResult>('add_keyframes', {
                            animation_player_path: params.animation_player_path,
                            animation_name: params.animation_name,
                            track_path: params.track_path,
                            track_type: params.track_type || 'value',
                            keyframes,
                        });

                        return (
                            `✅ Added ${keyframes.length} keyframe(s) to ` +
                            `"${params.animation_name}" on track "${params.track_path}"`
                        );
                    }

                    case 'setup_tree': {
                        if (!params.parent_path) throw new Error('parent_path is required');
                        const nodeName = (params.node_name as string) || 'AnimationTree';

                        // Create AnimationTree node
                        await godot.sendCommand<CommandResult>('create_node', {
                            parent_path: params.parent_path,
                            node_type: 'AnimationTree',
                            node_name: nodeName,
                        });

                        const treePath = `${params.parent_path}/${nodeName}`;

                        // Link to AnimationPlayer if specified
                        if (params.animation_player_node) {
                            await godot.sendCommand<CommandResult>('update_node_property', {
                                node_path: treePath,
                                property: 'anim_player',
                                value: params.animation_player_node,
                            });
                        }

                        // Configure root type if specified
                        if (params.tree_root_type) {
                            const rootTypeMap: Record<string, string> = {
                                state_machine: 'AnimationNodeStateMachine',
                                blend_tree: 'AnimationNodeBlendTree',
                                blend_space_1d: 'AnimationNodeBlendSpace1D',
                                blend_space_2d: 'AnimationNodeBlendSpace2D',
                            };
                            const rootType =
                                rootTypeMap[params.tree_root_type as string] ||
                                (params.tree_root_type as string);

                            await godot.sendCommand<CommandResult>('setup_animation_tree', {
                                tree_path: treePath,
                                root_type: rootType,
                            });
                        }

                        return (
                            `✅ Created AnimationTree "${nodeName}" under ${params.parent_path}` +
                            (params.tree_root_type
                                ? ` with root type: ${params.tree_root_type}`
                                : '') +
                            (params.animation_player_node
                                ? ` linked to ${params.animation_player_node}`
                                : '')
                        );
                    }

                    default:
                        throw new Error(`Unknown animation action: ${action}`);
                }
            } catch (error) {
                throw new Error(`manage_animation (${action}): ${(error as Error).message}`);
            }
        },
    },
];
