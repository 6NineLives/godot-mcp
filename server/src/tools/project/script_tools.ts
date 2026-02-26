/**
 * Script tools — operations that manipulate GDScript files.
 *
 * Single consolidated tool: `manage_script`
 * Actions: create | edit | get | generate_template | validate |
 *          list_scripts | rename_file | delete_file | create_folder
 *
 * Uses WebSocket for create/edit/get, local generation for templates.
 */

import { z } from 'zod';
import { getGodotConnection } from '../../utils/godot_connection.js';
import { MCPTool, CommandResult } from '../../utils/types.js';

// ---------------------------------------------------------------------------
// Tool definition
// ---------------------------------------------------------------------------

export const scriptTools: MCPTool[] = [
  {
    name: 'manage_script',
    description:
      'Manage GDScript files in the Godot project. ' +
      'Actions: "create" to create a new script (optionally attach to a node), ' +
      '"edit" to update an existing script, "get" to read script contents, ' +
      '"generate_template" to generate a GDScript boilerplate template locally, ' +
      '"validate" to check a script for syntax errors, ' +
      '"list_scripts" to recursively find all .gd files in the project, ' +
      '"rename_file" to rename/move a file with optional reference updating, ' +
      '"delete_file" to delete a file with safety checks, ' +
      '"create_folder" to create a directory in the project.',
  parameters: z.object({
    action: z
      .enum(['create', 'edit', 'get', 'generate_template', 'validate', 'list_scripts', 'rename_file', 'delete_file', 'create_folder'])
      .describe('Which script action to perform'),
    script_path: z.string().optional().describe(
      'Path to the script file (e.g. "res://scripts/player.gd"). ' +
      'Required for: create, edit. Optional for: get (provide this or node_path).'
    ),
    content: z.string().optional().describe(
      'Content of the script. Required for: create, edit.'
    ),
    node_path: z.string().optional().describe(
      'Path to a node. For create: attach script to this node. For get: read script from this node.'
    ),
    // Template generation options
    class_name: z.string().optional().describe(
      'Optional class name for the script. Used for: generate_template.'
    ),
    extends_type: z.string().optional().describe(
      'Base class the script extends (e.g. "Node", "Node2D", "Control"). Default: "Node". Used for: generate_template.'
    ),
    include_ready: z.boolean().optional().describe(
      'Include _ready() function. Default: true. Used for: generate_template.'
    ),
    include_process: z.boolean().optional().describe(
      'Include _process() function. Default: false. Used for: generate_template.'
    ),
    include_input: z.boolean().optional().describe(
      'Include _input() function. Default: false. Used for: generate_template.'
    ),
    include_physics: z.boolean().optional().describe(
      'Include _physics_process() function. Default: false. Used for: generate_template.'
    ),
    target_path: z.string().optional().describe(
      'Original file path for rename/delete operations. Required for: rename_file, delete_file.'
    ),
    new_path: z.string().optional().describe(
      'New file path (destination). Required for: rename_file.'
    ),
    update_references: z.boolean().optional().describe(
      'If true, updates all res:// references to the old path across the project. Default: false. Used for: rename_file.'
    ),
    include_addons: z.boolean().optional().describe(
      'Include addons directory in listing. Default: false. Used for: list_scripts.'
    ),
    folder_path: z.string().optional().describe(
      'Path for the folder to create (e.g. "res://scenes/levels"). Required for: create_folder.'
    ),
  }),
  execute: async (params: Record<string, unknown>): Promise<string> => {
    const action = params.action as string;

    try {
      switch (action) {
        case 'create': {
          const script_path = params.script_path as string;
          const content = params.content as string;
          if (!script_path) throw new Error('script_path is required for action "create"');
          if (!content) throw new Error('content is required for action "create"');

          const godot = getGodotConnection();
          const node_path = params.node_path as string | undefined;

          const result = await godot.sendCommand<CommandResult>('create_script', {
            script_path, content, node_path,
          });

          const attachMessage = node_path ? ` and attached to node at ${node_path}` : '';
          return `Created script at ${result.script_path}${attachMessage}`;
        }

        case 'edit': {
          const script_path = params.script_path as string;
          const content = params.content as string;
          if (!script_path) throw new Error('script_path is required for action "edit"');
          if (!content) throw new Error('content is required for action "edit"');

          const godot = getGodotConnection();
          await godot.sendCommand('edit_script', { script_path, content });
          return `Updated script at ${script_path}`;
        }

        case 'get': {
          const script_path = params.script_path as string | undefined;
          const node_path = params.node_path as string | undefined;
          if (!script_path && !node_path) {
            throw new Error('Either script_path or node_path must be provided for action "get"');
          }

          const godot = getGodotConnection();
          const result = await godot.sendCommand<CommandResult>('get_script', {
            script_path, node_path,
          });
          return `Script at ${result.script_path}:\n\n\`\`\`gdscript\n${result.content}\n\`\`\``;
        }

        case 'generate_template': {
          const extends_type = (params.extends_type as string) ?? 'Node';
          const class_name = params.class_name as string | undefined;
          const include_ready = (params.include_ready as boolean) ?? true;
          const include_process = (params.include_process as boolean) ?? false;
          const include_input = (params.include_input as boolean) ?? false;
          const include_physics = (params.include_physics as boolean) ?? false;

          let template = '';
          if (class_name) {
            template += `class_name ${class_name}\n`;
          }
          template += `extends ${extends_type}\n\n`;

          if (include_ready) template += `func _ready():\n\tpass\n\n`;
          if (include_process) template += `func _process(delta):\n\tpass\n\n`;
          if (include_physics) template += `func _physics_process(delta):\n\tpass\n\n`;
          if (include_input) template += `func _input(event):\n\tpass\n\n`;

          template = template.trimEnd();
          return `Generated GDScript template:\n\n\`\`\`gdscript\n${template}\n\`\`\``;
        }

        case 'validate': {
          const script_path = params.script_path as string;
          if (!script_path) throw new Error('script_path is required for action "validate"');

          const godot = getGodotConnection();
          const result = await godot.sendCommand<CommandResult>('validate_script', { script_path });
          const validation = result as any;

          if (validation.valid) {
            return `✅ Script "${validation.script_path}" is valid — no errors found.`;
          }

          let response = `❌ Script "${validation.script_path}" has errors:\n\n`;
          for (const err of validation.errors) {
            const lineInfo = err.line > 0 ? ` (line ${err.line})` : '';
            response += `- [${err.type}]${lineInfo}: ${err.message}\n`;
          }
          return response;
        }

        case 'list_scripts': {
          const godot = getGodotConnection();
          const result = await godot.sendCommand<CommandResult>('list_scripts', {
            include_addons: (params.include_addons as boolean) ?? false,
          });
          const scripts = result.scripts as string[];
          let output = `Found ${result.count} scripts:\n\n`;
          for (const s of scripts) {
            output += `  ${s}\n`;
          }
          return output;
        }

        case 'rename_file': {
          const target_path = params.target_path as string;
          const new_path = params.new_path as string;
          if (!target_path) throw new Error('target_path is required for action "rename_file"');
          if (!new_path) throw new Error('new_path is required for action "rename_file"');

          const godot = getGodotConnection();
          const result = await godot.sendCommand<CommandResult>('rename_file', {
            target_path,
            new_path,
            update_references: (params.update_references as boolean) ?? false,
          });
          let msg = `Renamed ${result.old_path} → ${result.new_path}`;
          if ((result.references_updated as number) > 0) {
            msg += ` (updated ${result.references_updated} references)`;
          }
          return msg;
        }

        case 'delete_file': {
          const target_path = params.target_path as string;
          if (!target_path) throw new Error('target_path is required for action "delete_file"');

          const godot = getGodotConnection();
          const result = await godot.sendCommand<CommandResult>('delete_file', { target_path });
          return `Deleted ${result.deleted}`;
        }

        case 'create_folder': {
          const folder_path = params.folder_path as string;
          if (!folder_path) throw new Error('folder_path is required for action "create_folder"');

          const godot = getGodotConnection();
          const result = await godot.sendCommand<CommandResult>('create_folder', { folder_path });
          return result.already_existed
            ? `Folder already exists: ${result.folder_path}`
            : `Created folder: ${result.folder_path}`;
        }

        default:
          throw new Error(`Unknown action: ${action}`);
      }
    } catch (error) {
      if ((error as Error).message.startsWith('Unknown action:')) throw error;
      throw new Error(`Script action "${action}" failed: ${(error as Error).message}`);
    }
  },
  },
];