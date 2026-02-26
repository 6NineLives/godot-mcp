/**
 * Node tools — operations that manipulate nodes in the Godot scene tree.
 *
 * Single consolidated tool: `manage_node`
 * Actions: create | delete | update_property | get_properties | list | duplicate | query | add_particles
 *
 * Uses WebSocket for live editor manipulation.
 */

import { z } from 'zod';
import { getGodotConnection } from '../../utils/godot_connection.js';
import { MCPTool, CommandResult } from '../../utils/types.js';

// ---------------------------------------------------------------------------
// Tool definition
// ---------------------------------------------------------------------------

export const nodeTools: MCPTool[] = [
  {
    name: 'manage_node',
    description:
      'Manage nodes in the Godot scene tree. ' +
      'Actions: "create" to add a new node, "delete" to remove a node, ' +
      '"update_property" to change a property, "get_properties" to inspect a node, ' +
      '"list" to list child nodes, "duplicate" to clone a node, ' +
      '"query" to get detailed node info (type, children, signals, methods, script), ' +
      '"add_particles" to create a particle system with configured properties. ' +
      'IMPORTANT: Use "/root" to reference the scene root. Call with action "get_properties" ' +
      'to discover available properties before updating.',
    parameters: z.object({
      action: z
        .enum(['create', 'delete', 'update_property', 'get_properties', 'list', 'duplicate', 'query', 'add_particles'])
        .describe('Which node action to perform'),
      node_path: z.string().optional().describe(
        'Path to the target node. Examples: "/root" for scene root, "Player", "Enemies/Golem1". ' +
        'Required for: delete, update_property, get_properties, duplicate.'
      ),
      parent_path: z.string().optional().describe(
        'Path to the parent node. Required for: create, list. ' +
        'Use "/root" for the scene root.'
      ),
      node_type: z.string().optional().describe(
        'Type of node to create (e.g. "Node2D", "Sprite2D", "Label"). Required for: create.'
      ),
      node_name: z.string().optional().describe(
        'Name for the new node. Required for: create.'
      ),
      property: z.string().optional().describe(
        'Name of the property to update (e.g. "position", "text", "modulate"). Required for: update_property.'
      ),
      value: z.any().optional().describe(
        'New value for the property. Required for: update_property.'
      ),
      new_name: z.string().optional().describe(
        'Optional name for the duplicate. Defaults to "OriginalName_copy". Used for: duplicate.'
      ),
      particle_type: z.string().optional().describe(
        'Type of particle system: "GPUParticles2D" or "GPUParticles3D". Required for: add_particles.'
      ),
      particle_properties: z.object({
        amount: z.number().optional().describe('Number of particles (default: 8)'),
        lifetime: z.number().optional().describe('Lifetime in seconds (default: 1.0)'),
        one_shot: z.boolean().optional().describe('Emit once then stop (default: false)'),
        preprocess: z.number().optional().describe('Seconds to pre-simulate (default: 0)'),
        speed_scale: z.number().optional().describe('Speed multiplier (default: 1.0)'),
        explosiveness: z.number().optional().describe('0=steady stream, 1=all at once (default: 0)'),
        randomness: z.number().optional().describe('Randomness ratio (default: 0)'),
      }).optional().describe('Particle-specific properties. Used for: add_particles.'),
    }),
    execute: async (params: Record<string, unknown>): Promise<string> => {
      const action = params.action as string;
      const godot = getGodotConnection();

      try {
        switch (action) {
          case 'create': {
            const parent_path = params.parent_path as string;
            const node_type = params.node_type as string;
            const node_name = params.node_name as string;
            if (!parent_path) throw new Error('parent_path is required for action "create"');
            if (!node_type) throw new Error('node_type is required for action "create"');
            if (!node_name) throw new Error('node_name is required for action "create"');

            const result = await godot.sendCommand<CommandResult>('create_node', {
              parent_path, node_type, node_name,
            });
            return `Created ${node_type} node named "${node_name}" at ${result.node_path}`;
          }

          case 'delete': {
            const node_path = params.node_path as string;
            if (!node_path) throw new Error('node_path is required for action "delete"');

            await godot.sendCommand('delete_node', { node_path });
            return `Deleted node at ${node_path}`;
          }

          case 'update_property': {
            const node_path = params.node_path as string;
            const property = params.property as string;
            const value = params.value;
            if (!node_path) throw new Error('node_path is required for action "update_property"');
            if (!property) throw new Error('property is required for action "update_property"');

            await godot.sendCommand<CommandResult>('update_node_property', {
              node_path, property, value,
            });
            return `Updated property "${property}" of node at ${node_path} to ${JSON.stringify(value)}`;
          }

          case 'get_properties': {
            const node_path = params.node_path as string;
            if (!node_path) throw new Error('node_path is required for action "get_properties"');

            const result = await godot.sendCommand<CommandResult>('get_node_properties', { node_path });
            const formattedProperties = Object.entries(result.properties)
              .map(([key, value]) => `${key}: ${JSON.stringify(value)}`)
              .join('\n');
            return `Properties of node at ${node_path}:\n\n${formattedProperties}`;
          }

          case 'list': {
            const parent_path = params.parent_path as string;
            if (!parent_path) throw new Error('parent_path is required for action "list"');

            const result = await godot.sendCommand<CommandResult>('list_nodes', { parent_path });
            if (result.children.length === 0) {
              return `No child nodes found under ${parent_path}`;
            }
            const formattedChildren = result.children
              .map((child: any) => `${child.name} (${child.type}) - ${child.path}`)
              .join('\n');
            return `Children of node at ${parent_path}:\n\n${formattedChildren}`;
          }

          case 'duplicate': {
            const node_path = params.node_path as string;
            if (!node_path) throw new Error('node_path is required for action "duplicate"');

            const result = await godot.sendCommand<CommandResult>('duplicate_node', {
              node_path,
              new_name: (params.new_name as string) ?? undefined,
            });
            return `Duplicated node at ${node_path} → ${result.new_node_path ?? 'copy created'}`;
          }

          case 'query': {
            const node_path = params.node_path as string;
            if (!node_path) throw new Error('node_path is required for action "query"');

            const result = await godot.sendCommand<CommandResult>('query_node', { node_path });
            const info = result as any;

            let response = `## Node: ${info.name} (${info.type})\nPath: ${info.path}\n`;

            if (info.script) {
              response += `Script: ${info.script}\n`;
            }

            if (Object.keys(info.properties).length > 0) {
              response += `\n### Properties\n`;
              for (const [key, value] of Object.entries(info.properties)) {
                response += `- ${key}: ${JSON.stringify(value)}\n`;
              }
            }

            if (info.children.length > 0) {
              response += `\n### Children (${info.children.length})\n`;
              for (const child of info.children) {
                response += `- ${child.name} (${child.type})\n`;
              }
            }

            if (info.signals.length > 0) {
              response += `\n### Signals (${info.signals.length})\n`;
              for (const sig of info.signals) {
                const params_str = sig.parameters?.map((p: any) => p.name).join(', ') ?? '';
                response += `- ${sig.name}(${params_str})\n`;
              }
            }

            if (info.methods.length > 0) {
              response += `\n### Methods (${info.methods.length})\n`;
              for (const method of info.methods.slice(0, 30)) {
                const params_str = method.parameters?.map((p: any) => p.name).join(', ') ?? '';
                response += `- ${method.name}(${params_str})\n`;
              }
              if (info.methods.length > 30) {
                response += `- ... and ${info.methods.length - 30} more\n`;
              }
            }

            return response;
          }

          case 'add_particles': {
            const parent_path = params.parent_path as string;
            const node_name = params.node_name as string;
            const particle_type = params.particle_type as string;
            if (!parent_path) throw new Error('parent_path is required for action "add_particles"');
            if (!node_name) throw new Error('node_name is required for action "add_particles"');
            if (!particle_type) throw new Error('particle_type is required for action "add_particles"');
            if (particle_type !== 'GPUParticles2D' && particle_type !== 'GPUParticles3D') {
              throw new Error('particle_type must be "GPUParticles2D" or "GPUParticles3D"');
            }

            // Create the particle node
            const createResult = await godot.sendCommand<CommandResult>('create_node', {
              parent_path, node_type: particle_type, node_name,
            });
            const particlePath = createResult.node_path as string;

            // Apply particle-specific properties
            const props = (params.particle_properties ?? {}) as Record<string, unknown>;
            const propsToSet: Array<[string, unknown]> = [];
            if (props.amount !== undefined) propsToSet.push(['amount', props.amount]);
            if (props.lifetime !== undefined) propsToSet.push(['lifetime', props.lifetime]);
            if (props.one_shot !== undefined) propsToSet.push(['one_shot', props.one_shot]);
            if (props.preprocess !== undefined) propsToSet.push(['preprocess', props.preprocess]);
            if (props.speed_scale !== undefined) propsToSet.push(['speed_scale', props.speed_scale]);
            if (props.explosiveness !== undefined) propsToSet.push(['explosiveness_ratio', props.explosiveness]);
            if (props.randomness !== undefined) propsToSet.push(['randomness_ratio', props.randomness]);

            for (const [property, value] of propsToSet) {
              await godot.sendCommand<CommandResult>('update_node_property', {
                node_path: particlePath, property, value,
              });
            }

            const setProps = propsToSet.map(([k]) => k).join(', ');
            return `Created ${particle_type} "${node_name}" at ${particlePath}` +
              (setProps ? ` with properties: ${setProps}` : '');
          }

          default:
            throw new Error(`Unknown action: ${action}`);
        }
      } catch (error) {
        if ((error as Error).message.startsWith('Unknown action:')) throw error;
        throw new Error(`Node action "${action}" failed: ${(error as Error).message}`);
      }
    },
  },
];