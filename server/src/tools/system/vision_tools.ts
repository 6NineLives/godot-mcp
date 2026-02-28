/**
 * Vision tools — capturing screenshots and viewport snapshots.
 *
 * Single consolidated tool: `capture_vision`
 * Actions: editor_viewport | game_screenshot | scene_preview | headless_screenshot
 *
 * "headless_screenshot" absorbed from the old diagnostic_tools.ts.
 */

import { z } from 'zod';
import { join, extname } from 'path';
import { existsSync, writeFileSync, unlinkSync } from 'fs';
import { promisify } from 'util';
import { execFile } from 'child_process';
import { getGodotConnection } from '../../utils/godot_connection.js';
import { MCPTool, CommandResult } from '../../utils/types.js';
import { getGameBridge } from '../../core/game_bridge.js';
import {
  detectGodotPath,
  validatePath,
  isGodotProject,
  detectProjectPath,
} from '../../core/path-manager.js';
import { logInfo, logWarn } from '../../utils/logger.js';

const execFileAsync = promisify(execFile);

// ---------------------------------------------------------------------------
// Tool definition
// ---------------------------------------------------------------------------

export const visionTools: MCPTool[] = [
  {
    name: 'capture_vision',
    description:
      'Capture screenshots and viewport snapshots from Godot. ' +
      'Actions: "editor_viewport" to snapshot the editor viewport (requires addon), ' +
      '"game_screenshot" to screenshot the running game (requires addon), ' +
      '"scene_preview" to capture a scene preview/thumbnail (requires addon), ' +
      '"headless_screenshot" to render a scene via headless Godot and save a PNG (no addon needed), ' +
      '"game_bridge" to capture a screenshot from the running game via the E2E bridge.',
  parameters: z.object({
    action: z
      .enum(['editor_viewport', 'game_screenshot', 'scene_preview', 'headless_screenshot', 'game_bridge'])
      .describe('Which capture action to perform'),
    scenePath: z.string().optional().describe(
      'Path to the scene file (e.g. "res://scenes/main.tscn"). ' +
      'Required for: scene_preview, headless_screenshot.'
    ),
    delay_ms: z.number().optional().describe(
      'Delay in ms before capturing (default: 0). Used for: game_screenshot.'
    ),
    // headless_screenshot specific
    projectPath: z.string().optional().describe(
      'Absolute path to the Godot project directory. Required for: headless_screenshot.'
    ),
    outputPath: z.string().optional().describe(
      'Where to save the screenshot (absolute path). Required for: headless_screenshot.'
    ),
    waitFrames: z.number().optional().describe(
      'Frames to wait before capturing (default: 10). Used for: headless_screenshot.'
    ),
  }),
  execute: async (params: Record<string, unknown>): Promise<string> => {
    const action = params.action as string;

    try {
      switch (action) {
        // -----------------------------------------------------------
        case 'editor_viewport': {
          const godot = getGodotConnection();
          const result = await godot.sendCommand<CommandResult>('capture_viewport', {});
          return `Snapshot saved to: ${result.absolute_path}`;
        }

        // -----------------------------------------------------------
        case 'game_screenshot': {
          const delay_ms = params.delay_ms as number | undefined;
          if (delay_ms && delay_ms > 0) {
            await new Promise(resolve => setTimeout(resolve, delay_ms));
          }
          const godot = getGodotConnection();
          try {
            const result = await godot.sendCommand<CommandResult>('capture_game_screenshot', {});
            if (result.absolute_path) {
              return JSON.stringify({ status: 'success', screenshotPath: result.absolute_path, message: 'Game screenshot captured successfully' }, null, 2);
            }
            const fallback = await godot.sendCommand<CommandResult>('capture_viewport', {});
            return JSON.stringify({ status: 'fallback', screenshotPath: fallback.absolute_path, message: 'Used editor viewport capture as fallback' }, null, 2);
          } catch (error) {
            throw new Error(`Failed to capture game screenshot: ${(error as Error).message}`);
          }
        }

        // -----------------------------------------------------------
        case 'scene_preview': {
          const scenePath = params.scenePath as string;
          if (!scenePath) throw new Error('scenePath is required for action "scene_preview"');

          const godot = getGodotConnection();
          const result = await godot.sendCommand<CommandResult>('capture_scene_preview', { scene_path: scenePath });
          return JSON.stringify({ status: 'success', scenePath, previewPath: result.absolute_path, message: `Scene preview captured for: ${scenePath}` }, null, 2);
        }

        // -----------------------------------------------------------
        case 'headless_screenshot': {
          const projectPath = params.projectPath as string;
          const scenePath = params.scenePath as string;
          const outputPath = params.outputPath as string;
          if (!projectPath) throw new Error('projectPath is required for action "headless_screenshot"');
          if (!scenePath) throw new Error('scenePath is required for action "headless_screenshot"');
          if (!outputPath) throw new Error('outputPath is required for action "headless_screenshot"');

          const resolvedPath = detectProjectPath(projectPath);
          if (!validatePath(resolvedPath)) throw new Error('Invalid project path');
          if (!isGodotProject(resolvedPath)) throw new Error(`Not a Godot project: ${resolvedPath}`);

          const godotPath = await detectGodotPath();
          if (!godotPath) throw new Error('Godot executable not found. Set "godotPath" in godot-mcp.config.json, GODOT_PATH env var, or add Godot to PATH.');

          const frames = (params.waitFrames as number) ?? 10;
          logInfo(`capture_vision/headless: ${scenePath} → ${outputPath} (wait ${frames} frames)`);

          const normalizedScene = scenePath.startsWith('res://') ? scenePath : `res://${scenePath}`;
          const escapedOutputPath = outputPath.replace(/\\/g, '/');

          // NOTE: We do NOT use --headless because the dummy renderer cannot
          // produce viewport textures. Instead we launch a real Godot instance
          // with the GL Compatibility renderer and a small window, capture the
          // rendered frame, then quit.
          const captureScript = `extends SceneTree

var _frames_waited := 0
var _max_frames := ${frames}
var _scene_loaded := false

func _init():
\tvar scene = load("${normalizedScene}")
\tif scene:
\t\tvar instance = scene.instantiate()
\t\troot.add_child(instance)
\t\t_scene_loaded = true
\t\tprint("[SCREENSHOT] Scene loaded: ${normalizedScene}")
\telse:
\t\tprint("[SCREENSHOT] ERROR: Failed to load scene: ${normalizedScene}")
\t\tquit(1)

func _process(_delta):
\tif not _scene_loaded:
\t\treturn
\t_frames_waited += 1
\tif _frames_waited >= _max_frames:
\t\tvar viewport = root.get_viewport()
\t\tif not viewport:
\t\t\tprint("[SCREENSHOT] ERROR: No viewport available")
\t\t\tquit(1)
\t\t\treturn
\t\tvar texture = viewport.get_texture()
\t\tif not texture:
\t\t\tprint("[SCREENSHOT] ERROR: Viewport texture is null — the renderer may not support offscreen capture")
\t\t\tquit(1)
\t\t\treturn
\t\tvar image = texture.get_image()
\t\tif not image:
\t\t\tprint("[SCREENSHOT] ERROR: Failed to get image from viewport texture")
\t\t\tquit(1)
\t\t\treturn
\t\tvar err = image.save_png("${escapedOutputPath}")
\t\tif err == OK:
\t\t\tprint("[SCREENSHOT] Saved to: ${escapedOutputPath}")
\t\t\tprint("[SCREENSHOT] Size: " + str(image.get_width()) + "x" + str(image.get_height()))
\t\telse:
\t\t\tprint("[SCREENSHOT] ERROR: Failed to save screenshot, error code: " + str(err))
\t\tquit(0)
`;

          const tmpScriptPath = join(resolvedPath, '_mcp_capture_screenshot.gd');

          try {
            writeFileSync(tmpScriptPath, captureScript, 'utf8');

            // Use gl_compatibility renderer (NOT --headless, which uses a dummy
            // renderer that cannot produce viewport textures).
            const args = [
              '--rendering-method', 'gl_compatibility',
              '--path', resolvedPath,
              '--script', 'res://_mcp_capture_screenshot.gd',
            ];
            let stdout = '';
            let stderr = '';

            try {
              const result = await execFileAsync(godotPath, args, { timeout: 30000, cwd: resolvedPath });
              stdout = result.stdout;
              stderr = result.stderr;
            } catch (error: unknown) {
              if (error instanceof Error && 'stdout' in error && 'stderr' in error) {
                const execError = error as Error & { stdout: string; stderr: string };
                stdout = execError.stdout;
                stderr = execError.stderr;
              } else {
                throw error;
              }
            }

            const screenshotExists = existsSync(outputPath);
            let width: number | null = null;
            let height: number | null = null;
            const sizeMatch = stdout.match(/\[SCREENSHOT\] Size: (\d+)x(\d+)/);
            if (sizeMatch) { width = parseInt(sizeMatch[1], 10); height = parseInt(sizeMatch[2], 10); }

            const report = {
              success: screenshotExists,
              outputPath: screenshotExists ? outputPath : null,
              scene: scenePath,
              size: width && height ? { width, height } : null,
              message: screenshotExists
                ? `✅ Screenshot saved to ${outputPath}`
                : `❌ Failed to capture screenshot. Check the scene path and Godot output.`,
              godotOutput: (stdout + '\n' + stderr).split('\n').filter(l => l.trim()).slice(-20),
            };

            logInfo(`capture_vision/headless: ${report.message}`);
            return JSON.stringify(report, null, 2);
          } finally {
            try { if (existsSync(tmpScriptPath)) unlinkSync(tmpScriptPath); }
            catch { logWarn(`Failed to clean up temp script: ${tmpScriptPath}`); }
          }
        }

        // -----------------------------------------------------------
        case 'game_bridge': {
          const bridge = getGameBridge();
          if (!bridge.isConnected()) {
            throw new Error('Not connected to game bridge. Use manage_game_bridge action "connect" first.');
          }

          const outputPath = params.outputPath as string;
          const result = await bridge.sendCommand('take_screenshot', {
            output_path: outputPath || '',
          });

          if (result.base64_png) {
            return JSON.stringify({
              success: true,
              base64_png: result.base64_png,
              size: result.size,
              message: '✅ Game screenshot captured (base64)',
            }, null, 2);
          }

          return JSON.stringify({
            success: true,
            outputPath: result.path,
            size: result.size,
            message: `✅ Game screenshot saved to ${result.path}`,
          }, null, 2);
        }

        default:
          throw new Error(`Unknown action: ${action}`);
      }
    } catch (error) {
      if ((error as Error).message.startsWith('Unknown action:')) throw error;
      throw new Error(`Vision action "${action}" failed: ${(error as Error).message}`);
    }
  },
  },
];
