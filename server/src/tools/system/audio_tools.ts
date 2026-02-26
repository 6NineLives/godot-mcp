/**
 * Audio tools — operations that interact with Godot's audio bus system.
 *
 * Single consolidated tool: `manage_audio`
 * Actions: get_buses | get_bus | set_bus_volume | set_bus_mute | play_stream | stop_stream
 *
 * Uses WebSocket to communicate with the Godot engine.
 */

import { z } from 'zod';
import { getGodotConnection } from '../../utils/godot_connection.js';
import { MCPTool, CommandResult } from '../../utils/types.js';

export const audioTools: MCPTool[] = [
    {
        name: 'manage_audio',
        description:
            'Manage audio operations within Godot. ' +
            'Actions: "get_buses" to list all audio buses and their current state, ' +
            '"get_bus" to get details for a specific bus by name or index, ' +
            '"set_bus_volume" to change bus volume (linear or db), ' +
            '"set_bus_mute" to mute/unmute a bus, ' +
            '"play_stream" to play an audio stream at a given node or globally, ' +
            '"stop_stream" to stop a currently playing audio stream. ' +
            'Use this to control game audio dynamically during testing or editing.',
        parameters: z.object({
            action: z
                .enum(['get_buses', 'get_bus', 'set_bus_volume', 'set_bus_mute', 'play_stream', 'stop_stream'])
                .describe('Which audio action to perform'),
            bus: z.union([z.string(), z.number()]).optional().describe(
                'Bus name (e.g., "Master", "Music") or index. Required for: get_bus, set_bus_volume, set_bus_mute.'
            ),
            volume: z.number().optional().describe(
                'Volume level. By default, linear volume (0.0 to 1.0+). Can also be db. Required for: set_bus_volume.'
            ),
            db: z.boolean().optional().describe(
                'If true, interprets volume as decibels (dB) instead of linear. Optional for: set_bus_volume.'
            ),
            mute: z.boolean().optional().describe(
                'Whether the bus should be muted. Required for: set_bus_mute.'
            ),
            stream_path: z.string().optional().describe(
                'Path to the audio stream resource (e.g., "res://sounds/jump.wav"). Required for: play_stream.'
            ),
            node_path: z.string().optional().describe(
                'Optional. The path of the AudioStreamPlayer to play/stop the stream on. ' +
                'If omitted for play_stream, it may play globally depending on implementation.'
            ),
        }),
        execute: async (params: Record<string, unknown>): Promise<string> => {
            const action = params.action as string;
            const godot = getGodotConnection();

            try {
                switch (action) {
                    case 'get_buses': {
                        const result = await godot.sendCommand<CommandResult>('get_audio_buses', {});
                        const buses = result.buses as Array<any>;
                        if (buses.length === 0) return 'No audio buses found.';

                        const busList = buses.map(bus =>
                            `- ${bus.name} (Index: ${bus.index}): Volume ${bus.volume_db.toFixed(2)} dB, Muted: ${bus.mute}`
                        ).join('\n');
                        return `Audio Buses:\n${busList}`;
                    }

                    case 'get_bus': {
                        if (params.bus === undefined) throw new Error('bus is required for action "get_bus"');
                        const result = await godot.sendCommand<CommandResult>('get_audio_bus', { bus: params.bus });
                        const bus = result.bus as any;
                        return `Bus "${bus.name}" (Index: ${bus.index}): Volume ${bus.volume_db.toFixed(2)} dB, Muted: ${bus.mute}`;
                    }

                    case 'set_bus_volume': {
                        if (params.bus === undefined) throw new Error('bus is required for action "set_bus_volume"');
                        if (params.volume === undefined) throw new Error('volume is required for action "set_bus_volume"');

                        const result = await godot.sendCommand<CommandResult>('set_audio_bus_volume', {
                            bus: params.bus,
                            volume: params.volume,
                            db: params.db ?? false
                        });
                        const bus = result.bus as any;
                        return `Set bus "${bus.name}" volume to ${bus.volume_db.toFixed(2)} dB`;
                    }

                    case 'set_bus_mute': {
                        if (params.bus === undefined) throw new Error('bus is required for action "set_bus_mute"');
                        if (params.mute === undefined) throw new Error('mute is required for action "set_bus_mute"');

                        const result = await godot.sendCommand<CommandResult>('set_audio_bus_mute', {
                            bus: params.bus,
                            mute: params.mute
                        });
                        const bus = result.bus as any;
                        return bus.mute ? `Muted bus "${bus.name}"` : `Unmuted bus "${bus.name}"`;
                    }

                    case 'play_stream': {
                        if (!params.stream_path) throw new Error('stream_path is required for action "play_stream"');

                        const result = await godot.sendCommand<CommandResult>('play_audio_stream', {
                            stream_path: params.stream_path,
                            node_path: params.node_path
                        });
                        return `Playing stream ${params.stream_path}` + (result.node_path ? ` on node ${result.node_path}` : ' globally');
                    }

                    case 'stop_stream': {
                        const result = await godot.sendCommand<CommandResult>('stop_audio_stream', {
                            node_path: params.node_path
                        });
                        if (params.node_path) {
                            return `Stopped audio stream on node ${params.node_path}`;
                        }
                        return `Stopped global audio stream.`;
                    }

                    default:
                        throw new Error(`Unknown action: ${action}`);
                }
            } catch (error) {
                if ((error as Error).message.startsWith('Unknown action:')) throw error;
                throw new Error(`Audio action "${action}" failed: ${(error as Error).message}`);
            }
        },
    },
];
