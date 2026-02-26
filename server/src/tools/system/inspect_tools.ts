/**
 * Inspect tools — deep project introspection via the Godot editor.
 *
 * Single consolidated tool: `inspect_project`
 * Actions: get_input_map | get_collision_layers | get_node_type_properties |
 *          get_console_log | get_errors | clear_console | open_in_editor
 *
 * Uses WebSocket for live editor access.
 */

import { z } from 'zod';
import { getGodotConnection } from '../../utils/godot_connection.js';
import { MCPTool, CommandResult } from '../../utils/types.js';

// ---------------------------------------------------------------------------
// Tool definition
// ---------------------------------------------------------------------------

export const inspectTools: MCPTool[] = [
    {
        name: 'inspect_project',
        description:
            'Deep project introspection through the Godot editor. ' +
            'Actions: "get_input_map" to list all input actions and their keybindings, ' +
            '"get_collision_layers" to get physics layer names (2D and 3D), ' +
            '"get_node_type_properties" to discover all properties/methods/signals of a node type via ClassDB, ' +
            '"get_console_log" to read the editor Output panel, ' +
            '"get_errors" to filter console output for errors and warnings, ' +
            '"clear_console" to clear the editor Output panel, ' +
            '"open_in_editor" to open a file (scene, script, resource) in the Godot editor.',
        parameters: z.object({
            action: z
                .enum([
                    'get_input_map',
                    'get_collision_layers',
                    'get_node_type_properties',
                    'get_console_log',
                    'get_errors',
                    'clear_console',
                    'open_in_editor',
                ])
                .describe('Which inspection action to perform'),
            node_type: z.string().optional().describe(
                'Godot class name to inspect (e.g. "CharacterBody2D", "Sprite2D"). ' +
                'Required for: get_node_type_properties.'
            ),
            max_lines: z.number().optional().describe(
                'Maximum number of log lines to return (default: 100). Used for: get_console_log.'
            ),
            max_errors: z.number().optional().describe(
                'Maximum number of errors to return (default: 50). Used for: get_errors.'
            ),
            include_warnings: z.boolean().optional().describe(
                'Include warnings in addition to errors (default: true). Used for: get_errors.'
            ),
            file_path: z.string().optional().describe(
                'Path to the file to open (e.g. "res://scripts/player.gd"). Required for: open_in_editor.'
            ),
            line_number: z.number().optional().describe(
                'Line number to jump to when opening a script. Used for: open_in_editor.'
            ),
        }),
        execute: async (params: Record<string, unknown>): Promise<string> => {
            const action = params.action as string;
            const godot = getGodotConnection();

            try {
                switch (action) {
                    case 'get_input_map': {
                        const result = await godot.sendCommand<CommandResult>('get_input_map', {});
                        const actions = result.actions as Array<{
                            name: string;
                            deadzone: number;
                            events: Array<Record<string, unknown>>;
                        }>;

                        let output = `Input Map (${result.count} actions):\n\n`;
                        for (const a of actions) {
                            const eventDescs = a.events.map((e: Record<string, unknown>) => {
                                if (e.key) return `Key: ${e.key}`;
                                if (e.type === 'InputEventMouseButton') return `Mouse: button ${e.button_index}`;
                                if (e.type === 'InputEventJoypadButton') return `Joypad: button ${e.button_index}`;
                                if (e.type === 'InputEventJoypadMotion') return `Joypad axis: ${e.axis}`;
                                return String(e.type);
                            });
                            output += `  ${a.name}: ${eventDescs.join(', ') || '(no events)'}\n`;
                        }
                        return output;
                    }

                    case 'get_collision_layers': {
                        const result = await godot.sendCommand<CommandResult>('get_collision_layers', {});
                        let output = 'Collision Layers:\n\n2D Physics:\n';
                        const layers2d = result.physics_2d as Array<{ layer: number; name: string; has_custom_name: boolean }>;
                        for (const l of layers2d) {
                            if (l.has_custom_name) {
                                output += `  Layer ${l.layer}: ${l.name}\n`;
                            }
                        }
                        if (!layers2d.some((l: { has_custom_name: boolean }) => l.has_custom_name)) {
                            output += '  (no custom names set)\n';
                        }

                        output += '\n3D Physics:\n';
                        const layers3d = result.physics_3d as Array<{ layer: number; name: string; has_custom_name: boolean }>;
                        for (const l of layers3d) {
                            if (l.has_custom_name) {
                                output += `  Layer ${l.layer}: ${l.name}\n`;
                            }
                        }
                        if (!layers3d.some((l: { has_custom_name: boolean }) => l.has_custom_name)) {
                            output += '  (no custom names set)\n';
                        }
                        return output;
                    }

                    case 'get_node_type_properties': {
                        const node_type = params.node_type as string;
                        if (!node_type) throw new Error('node_type is required for action "get_node_type_properties"');

                        const result = await godot.sendCommand<CommandResult>('get_node_type_properties', { node_type });
                        const inheritance = (result.inheritance as string[]).join(' → ');
                        let output = `Class: ${result.class_name}\nInheritance: ${inheritance}\n`;
                        output += `Properties: ${result.property_count} | Methods: ${result.method_count} | Signals: ${result.signal_count}\n\n`;

                        output += 'Properties:\n';
                        const props = result.properties as Array<{ name: string; type: string; hint_string: string }>;
                        for (const p of props) {
                            output += `  ${p.name}: ${p.type}${p.hint_string ? ` (${p.hint_string})` : ''}\n`;
                        }

                        output += '\nSignals:\n';
                        const signals = result.signals as string[];
                        for (const s of signals) {
                            output += `  ${s}\n`;
                        }
                        return output;
                    }

                    case 'get_console_log': {
                        const result = await godot.sendCommand<CommandResult>('get_console_log', {
                            max_lines: (params.max_lines as number) ?? 100,
                        });
                        const lines = result.lines as string[];
                        if (lines.length === 0) {
                            return result.message ? String(result.message) : 'Console log is empty.';
                        }
                        return `Console Output (${result.returned_lines} of ${result.total_lines} lines):\n\n${lines.join('\n')}`;
                    }

                    case 'get_errors': {
                        const result = await godot.sendCommand<CommandResult>('get_errors', {
                            max_errors: (params.max_errors as number) ?? 50,
                            include_warnings: (params.include_warnings as boolean) ?? true,
                        });

                        const errors = result.errors as Array<{ raw: string; file?: string; line?: number }>;
                        const warnings = result.warnings as Array<{ raw: string; file?: string; line?: number }>;

                        let output = `Errors: ${result.error_count} | Warnings: ${result.warning_count}\n\n`;

                        if (errors.length > 0) {
                            output += 'ERRORS:\n';
                            for (const e of errors) {
                                output += `  ${e.raw}`;
                                if (e.file) output += ` [${e.file}:${e.line ?? '?'}]`;
                                output += '\n';
                            }
                        }

                        if (warnings.length > 0) {
                            output += '\nWARNINGS:\n';
                            for (const w of warnings) {
                                output += `  ${w.raw}`;
                                if (w.file) output += ` [${w.file}:${w.line ?? '?'}]`;
                                output += '\n';
                            }
                        }

                        if (errors.length === 0 && warnings.length === 0) {
                            output += 'No errors or warnings found.';
                        }
                        return output;
                    }

                    case 'clear_console': {
                        const result = await godot.sendCommand<CommandResult>('clear_console_log', {});
                        return String(result.message);
                    }

                    case 'open_in_editor': {
                        const file_path = params.file_path as string;
                        if (!file_path) throw new Error('file_path is required for action "open_in_editor"');

                        const result = await godot.sendCommand<CommandResult>('open_in_editor', {
                            file_path,
                            line_number: (params.line_number as number) ?? -1,
                        });
                        return `Opened ${result.file_path} as ${result.opened_as}`;
                    }

                    default:
                        throw new Error(`Unknown action: ${action}`);
                }
            } catch (error) {
                if ((error as Error).message.startsWith('Unknown action:')) throw error;
                throw new Error(`Inspect action "${action}" failed: ${(error as Error).message}`);
            }
        },
    },
];
