import { Resource } from 'fastmcp';
import { getGodotConnection } from '../utils/godot_connection.js';
import { logError } from '../utils/logger.js';

/**
 * Resource that provides a list of all scripts in the project
 */
export const scriptListResource: Resource = {
  uri: 'godot/scripts',
  name: 'Godot Script List',
  mimeType: 'application/json',
  async load() {
    const godot = getGodotConnection();

    try {
      const result = await godot.sendCommand('list_project_files', {
        extensions: ['.gd', '.cs'],
      });

      if (result && result.files) {
        return {
          text: JSON.stringify({
            scripts: result.files,
            count: result.files.length,
            gdscripts: result.files.filter((f: string) => f.endsWith('.gd')),
            csharp_scripts: result.files.filter((f: string) => f.endsWith('.cs')),
          }),
        };
      } else {
        return {
          text: JSON.stringify({
            scripts: [],
            count: 0,
            gdscripts: [],
            csharp_scripts: [],
          }),
        };
      }
    } catch (error) {
      logError(`Error fetching script list: ${(error as Error).message}`);
      throw error;
    }
  },
};
