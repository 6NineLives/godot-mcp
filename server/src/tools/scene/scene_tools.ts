/**
 * Scene tools — operations that manipulate Godot scenes.
 *
 * Single consolidated tool: `manage_scene`
 * Actions: create | save | open | get_current | get_info | create_resource |
 *          rename_node | move_node | set_collision_shape | set_sprite_texture
 *
 * Uses WebSocket for live editor manipulation.
 */

import { z } from 'zod';
import { getGodotConnection } from '../../utils/godot_connection.js';
import { MCPTool, CommandResult } from '../../utils/types.js';

// ---------------------------------------------------------------------------
// Tool definition
// ---------------------------------------------------------------------------

export const sceneTools: MCPTool[] = [
  {
    name: 'manage_scene',
    description:
      'Manage Godot scenes and resources. ' +
      'Actions: "create" to create a new scene, "save" to save the current scene, ' +
      '"open" to open a scene in the editor, "get_current" to get info about the open scene, ' +
      '"get_info" to get project info, "create_resource" to create a new resource file, ' +
      '"rename_node" to rename a node in the current scene, ' +
      '"move_node" to reparent a node within the scene tree, ' +
      '"set_collision_shape" to assign a shape resource to a CollisionShape2D/3D, ' +
      '"set_sprite_texture" to assign a texture to a Sprite2D/3D/TextureRect.',
    parameters: z.object({
      action: z
        .enum(['create', 'save', 'open', 'get_current', 'get_info', 'create_resource', 'rename_node', 'move_node', 'set_collision_shape', 'set_sprite_texture'])
        .describe('Which scene action to perform'),
      path: z.string().optional().describe(
        'Path for the scene or resource. E.g. "res://scenes/main.tscn". ' +
        'Required for: create, open. Optional for: save (uses current scene path if omitted).'
      ),
      root_node_type: z.string().optional().describe(
        'Type of root node for new scene (e.g. "Node2D", "Node3D", "Control"). Default: "Node". Used for: create.'
      ),
      resource_type: z.string().optional().describe(
        'Type of resource to create (e.g. "ImageTexture", "StyleBoxFlat"). Required for: create_resource.'
      ),
      resource_path: z.string().optional().describe(
        'Path where the resource will be saved. Required for: create_resource.'
      ),
      properties: z.record(z.any()).optional().describe(
        'Dictionary of property values to set on a resource. Used for: create_resource.'
      ),
      node_path: z.string().optional().describe(
        'Path to the node within the scene (e.g. "Player/Sprite2D"). ' +
        'Required for: rename_node, move_node, set_collision_shape, set_sprite_texture.'
      ),
      new_name: z.string().optional().describe(
        'New name for the node. Required for: rename_node.'
      ),
      new_parent_path: z.string().optional().describe(
        'Path to the new parent node. Required for: move_node.'
      ),
      sibling_index: z.number().optional().describe(
        'Child index position in the new parent (-1 for last). Used for: move_node.'
      ),
      shape_type: z.string().optional().describe(
        'Shape class name (e.g. "CircleShape2D", "RectangleShape2D", "BoxShape3D", "CapsuleShape2D"). ' +
        'Required for: set_collision_shape.'
      ),
      shape_params: z.record(z.any()).optional().describe(
        'Shape configuration (e.g. {"radius": 32} for CircleShape2D, {"size": {"x": 64, "y": 32}} for RectangleShape2D). ' +
        'Used for: set_collision_shape.'
      ),
      texture_type: z.string().optional().describe(
        'Texture class: "ImageTexture", "PlaceholderTexture2D", "GradientTexture2D", or "NoiseTexture2D". ' +
        'Default: "ImageTexture". Used for: set_sprite_texture.'
      ),
      texture_params: z.record(z.any()).optional().describe(
        'Texture configuration (e.g. {"path": "res://icon.svg"} for ImageTexture, {"size": {"x": 64, "y": 64}} for Placeholder). ' +
        'Used for: set_sprite_texture.'
      ),
    }),
    execute: async (params: Record<string, unknown>): Promise<string> => {
      const action = params.action as string;
      const godot = getGodotConnection();

      try {
        switch (action) {
          case 'create': {
            const path = params.path as string;
            if (!path) throw new Error('path is required for action "create"');
            const root_node_type = (params.root_node_type as string) ?? 'Node';

            const result = await godot.sendCommand<CommandResult>('create_scene', { path, root_node_type });
            return `Created new scene at ${result.scene_path} with root node type ${result.root_node_type}`;
          }

          case 'save': {
            const path = params.path as string | undefined;
            const result = await godot.sendCommand<CommandResult>('save_scene', { path });
            return `Saved scene to ${result.scene_path}`;
          }

          case 'open': {
            const path = params.path as string;
            if (!path) throw new Error('path is required for action "open"');

            const result = await godot.sendCommand<CommandResult>('open_scene', { path });
            return `Opened scene at ${result.scene_path}`;
          }

          case 'get_current': {
            const result = await godot.sendCommand<CommandResult>('get_current_scene', {});
            return `Current scene: ${result.scene_path}\nRoot node: ${result.root_node_name} (${result.root_node_type})`;
          }

          case 'get_info': {
            const result = await godot.sendCommand<CommandResult>('get_project_info', {});
            const godotVersion = `${result.godot_version.major}.${result.godot_version.minor}.${result.godot_version.patch}`;

            let output = `Project Name: ${result.project_name}\n`;
            output += `Project Version: ${result.project_version}\n`;
            output += `Project Path: ${result.project_path}\n`;
            output += `Godot Version: ${godotVersion}\n`;
            output += result.current_scene
              ? `Current Scene: ${result.current_scene}`
              : 'No scene is currently open';
            return output;
          }

          case 'create_resource': {
            const resource_type = params.resource_type as string;
            const resource_path = params.resource_path as string;
            if (!resource_type) throw new Error('resource_type is required for action "create_resource"');
            if (!resource_path) throw new Error('resource_path is required for action "create_resource"');

            const result = await godot.sendCommand<CommandResult>('create_resource', {
              resource_type,
              resource_path,
              properties: (params.properties as Record<string, unknown>) ?? {},
            });
            return `Created ${resource_type} resource at ${result.resource_path}`;
          }

          case 'rename_node': {
            const node_path = params.node_path as string;
            const new_name = params.new_name as string;
            if (!node_path) throw new Error('node_path is required for action "rename_node"');
            if (!new_name) throw new Error('new_name is required for action "rename_node"');

            const result = await godot.sendCommand<CommandResult>('rename_node', { node_path, new_name });
            return `Renamed node "${result.old_name}" to "${result.new_name}" (path: ${result.node_path})`;
          }

          case 'move_node': {
            const node_path = params.node_path as string;
            const new_parent_path = params.new_parent_path as string;
            if (!node_path) throw new Error('node_path is required for action "move_node"');
            if (!new_parent_path) throw new Error('new_parent_path is required for action "move_node"');

            const result = await godot.sendCommand<CommandResult>('move_node', {
              node_path,
              new_parent_path,
              sibling_index: (params.sibling_index as number) ?? -1,
            });
            return `Moved node "${result.node_name}" from ${result.old_parent} to ${result.new_parent} (new path: ${result.new_path})`;
          }

          case 'set_collision_shape': {
            const node_path = params.node_path as string;
            const shape_type = params.shape_type as string;
            if (!node_path) throw new Error('node_path is required for action "set_collision_shape"');
            if (!shape_type) throw new Error('shape_type is required for action "set_collision_shape"');

            const result = await godot.sendCommand<CommandResult>('set_collision_shape', {
              node_path,
              shape_type,
              shape_params: (params.shape_params as Record<string, unknown>) ?? {},
            });
            return result.message as string;
          }

          case 'set_sprite_texture': {
            const node_path = params.node_path as string;
            if (!node_path) throw new Error('node_path is required for action "set_sprite_texture"');

            const result = await godot.sendCommand<CommandResult>('set_sprite_texture', {
              node_path,
              texture_type: (params.texture_type as string) ?? 'ImageTexture',
              texture_params: (params.texture_params as Record<string, unknown>) ?? {},
            });
            return result.message as string;
          }

          default:
            throw new Error(`Unknown action: ${action}`);
        }
      } catch (error) {
        if ((error as Error).message.startsWith('Unknown action:')) throw error;
        throw new Error(`Scene action "${action}" failed: ${(error as Error).message}`);
      }
    },
  },
];