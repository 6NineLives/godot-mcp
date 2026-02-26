import { Resource } from 'fastmcp';
import { getGodotConnection } from '../utils/godot_connection.js';
import { logError } from '../utils/logger.js';

/**
 * Resource that provides information about the current state of the Godot editor
 */
export const editorStateResource: Resource = {
  uri: 'godot/editor/state',
  name: 'Godot Editor State',
  mimeType: 'application/json',
  async load() {
    const godot = getGodotConnection();

    try {
      const result = await godot.sendCommand('get_editor_state');
      return { text: JSON.stringify(result) };
    } catch (error) {
      logError(`Error fetching editor state: ${(error as Error).message}`);
      throw error;
    }
  },
};

/**
 * Resource that provides information about the currently selected node
 */
export const selectedNodeResource: Resource = {
  uri: 'godot/editor/selected_node',
  name: 'Godot Selected Node',
  mimeType: 'application/json',
  async load() {
    const godot = getGodotConnection();

    try {
      const result = await godot.sendCommand('get_selected_node');
      return { text: JSON.stringify(result) };
    } catch (error) {
      logError(`Error fetching selected node: ${(error as Error).message}`);
      throw error;
    }
  },
};

/**
 * Resource that provides information about the currently edited script
 */
export const currentScriptResource: Resource = {
  uri: 'godot/editor/current_script',
  name: 'Current Script in Editor',
  mimeType: 'text/plain',
  async load() {
    const godot = getGodotConnection();

    try {
      const result = await godot.sendCommand('get_current_script');

      if (result && result.script_found && result.content) {
        return {
          text: result.content,
          metadata: {
            path: result.script_path,
            language: result.script_path.endsWith('.gd')
              ? 'gdscript'
              : result.script_path.endsWith('.cs')
                ? 'csharp'
                : 'unknown',
          },
        };
      } else {
        return {
          text: '',
          metadata: {
            error: 'No script currently being edited',
            script_found: false,
          },
        };
      }
    } catch (error) {
      logError(`Error fetching current script: ${(error as Error).message}`);
      throw error;
    }
  },
};