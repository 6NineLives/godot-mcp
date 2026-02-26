import { Resource } from 'fastmcp';
import { getGodotConnection } from '../utils/godot_connection.js';
import { logError } from '../utils/logger.js';

/**
 * Resource that provides a list of all scenes in the project
 */
export const sceneListResource: Resource = {
  uri: 'godot/scenes',
  name: 'Godot Scene List',
  mimeType: 'application/json',
  async load() {
    const godot = getGodotConnection();

    try {
      const result = await godot.sendCommand('list_project_files', {
        extensions: ['.tscn', '.scn'],
      });

      if (result && result.files) {
        return {
          text: JSON.stringify({
            scenes: result.files,
            count: result.files.length,
          }),
        };
      } else {
        return {
          text: JSON.stringify({ scenes: [], count: 0 }),
        };
      }
    } catch (error) {
      logError(`Error fetching scene list: ${(error as Error).message}`);
      throw error;
    }
  },
};

/**
 * Resource that provides detailed information about the current scene
 */
export const sceneStructureResource: Resource = {
  uri: 'godot/scene/current',
  name: 'Godot Scene Structure',
  mimeType: 'application/json',
  async load() {
    const godot = getGodotConnection();

    try {
      const result = await godot.sendCommand('get_current_scene_structure', {});
      return { text: JSON.stringify(result) };
    } catch (error) {
      logError(`Error fetching scene structure: ${(error as Error).message}`);
      throw error;
    }
  },
};
