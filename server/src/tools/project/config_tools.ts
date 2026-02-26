/**
 * Project configuration tools — manage project.godot settings, input maps,
 * autoloads, and plugins via direct file parsing (no WebSocket or Godot needed).
 *
 * Single consolidated tool: `manage_project_config`
 * Actions: update_settings | configure_input | setup_autoload | manage_plugins
 */

import { z } from 'zod';
import { readFileSync, writeFileSync, existsSync } from 'fs';
import { join } from 'path';
import { MCPTool } from '../../utils/types.js';
import { validatePath, isGodotProject, detectProjectPath } from '../../core/path-manager.js';
import { logDebug } from '../../utils/logger.js';

// ---------------------------------------------------------------------------
// project.godot INI parser / writer
// ---------------------------------------------------------------------------

interface IniSection {
    name: string;
    entries: Map<string, string>;
}

/** Parse a project.godot file into sections. */
function parseProjectGodot(content: string): IniSection[] {
    const sections: IniSection[] = [];
    let current: IniSection = { name: '', entries: new Map() };
    sections.push(current);

    for (const rawLine of content.split('\n')) {
        const line = rawLine.trim();

        // Skip empty lines and comments
        if (line === '' || line.startsWith(';')) continue;

        // Section header
        const sectionMatch = line.match(/^\[(.+?)\]$/);
        if (sectionMatch) {
            current = { name: sectionMatch[1], entries: new Map() };
            sections.push(current);
            continue;
        }

        // Key=value pair
        const eqIndex = line.indexOf('=');
        if (eqIndex > 0) {
            const key = line.slice(0, eqIndex).trim();
            const value = line.slice(eqIndex + 1).trim();
            current.entries.set(key, value);
        }
    }

    return sections;
}

/** Serialize sections back to project.godot format. */
function serializeProjectGodot(sections: IniSection[]): string {
    const lines: string[] = [];

    for (const section of sections) {
        if (section.name) {
            lines.push('');
            lines.push(`[${section.name}]`);
        }
        for (const [key, value] of section.entries) {
            lines.push(`${key}=${value}`);
        }
    }

    return lines.join('\n').trim() + '\n';
}

/** Get or create a section by name. */
function getOrCreateSection(sections: IniSection[], name: string): IniSection {
    let section = sections.find(s => s.name === name);
    if (!section) {
        section = { name, entries: new Map() };
        sections.push(section);
    }
    return section;
}

/** Validate and resolve a project path. */
function resolveProject(projectPath: string): { path: string; godotFile: string } {
    const resolved = detectProjectPath(projectPath);
    if (!validatePath(resolved)) throw new Error('Invalid project path');
    if (!isGodotProject(resolved)) throw new Error(`Not a Godot project: ${resolved}`);
    const godotFile = join(resolved, 'project.godot');
    if (!existsSync(godotFile)) throw new Error(`project.godot not found at ${resolved}`);
    return { path: resolved, godotFile };
}

// ---------------------------------------------------------------------------
// Action handlers
// ---------------------------------------------------------------------------

function handleUpdateSettings(
    sections: IniSection[],
    params: { section?: string; key?: string; value?: unknown },
): string {
    const { section: sectionName, key, value } = params;

    // Read mode — no key/value provided
    if (!key) {
        if (sectionName) {
            const section = sections.find(s => s.name === sectionName);
            if (!section) return `Section [${sectionName}] not found.`;
            const entries = Array.from(section.entries.entries())
                .map(([k, v]) => `  ${k} = ${v}`)
                .join('\n');
            return `[${sectionName}]\n${entries}`;
        }
        // List all sections
        return sections
            .filter(s => s.name)
            .map(s => `[${s.name}] (${s.entries.size} entries)`)
            .join('\n');
    }

    // Write mode
    if (value === undefined) throw new Error('value is required when setting a key');
    const section = getOrCreateSection(sections, sectionName || 'application');

    // Format value for Godot INI
    const formattedValue = typeof value === 'string' ? `"${value}"` : JSON.stringify(value);
    const oldValue = section.entries.get(key);
    section.entries.set(key, formattedValue);

    return oldValue
        ? `Updated [${section.name}] ${key}: ${oldValue} → ${formattedValue}`
        : `Added [${section.name}] ${key} = ${formattedValue}`;
}

function handleConfigureInput(
    sections: IniSection[],
    params: { actionName?: string; inputEvents?: Array<{ type: string;[k: string]: unknown }>; remove?: boolean },
): string {
    const inputSection = getOrCreateSection(sections, 'input');
    const { actionName, inputEvents, remove } = params;

    // List mode
    if (!actionName) {
        const actions = Array.from(inputSection.entries.entries())
            .map(([k, v]) => `  ${k} = ${v}`)
            .join('\n');
        return actions ? `Input actions:\n${actions}` : 'No input actions configured.';
    }

    // Remove mode
    if (remove) {
        if (inputSection.entries.has(actionName)) {
            inputSection.entries.delete(actionName);
            return `Removed input action: ${actionName}`;
        }
        return `Input action "${actionName}" not found.`;
    }

    // Add/update mode
    if (!inputEvents || inputEvents.length === 0) {
        throw new Error('inputEvents required when adding an input action');
    }

    // Build Godot input event format
    const events = inputEvents.map(e => {
        if (e.type === 'key') {
            return `Object(InputEventKey,"keycode":${e.keycode || 0},"physical_keycode":${e.physical_keycode || 0})`;
        }
        if (e.type === 'mouse_button') {
            return `Object(InputEventMouseButton,"button_index":${e.button_index || 1})`;
        }
        if (e.type === 'joypad_button') {
            return `Object(InputEventJoypadButton,"button_index":${e.button_index || 0})`;
        }
        if (e.type === 'joypad_motion') {
            return `Object(InputEventJoypadMotion,"axis":${e.axis || 0},"axis_value":${e.axis_value || 1.0})`;
        }
        return `Object(InputEvent)`;
    });

    const value = `{"deadzone":${params.inputEvents?.[0]?.deadzone ?? 0.5},"events":[${events.join(', ')}]}`;
    inputSection.entries.set(actionName, value);

    return `Configured input action "${actionName}" with ${events.length} event(s)`;
}

function handleSetupAutoload(
    sections: IniSection[],
    params: { name?: string; path?: string; enabled?: boolean },
): string {
    const autoloadSection = getOrCreateSection(sections, 'autoload');
    const { name, path, enabled } = params;

    // List mode
    if (!name) {
        const autoloads = Array.from(autoloadSection.entries.entries())
            .map(([k, v]) => `  ${k} = ${v}`)
            .join('\n');
        return autoloads ? `Autoloads:\n${autoloads}` : 'No autoloads configured.';
    }

    // Remove mode
    if (enabled === false) {
        if (autoloadSection.entries.has(name)) {
            autoloadSection.entries.delete(name);
            return `Removed autoload: ${name}`;
        }
        return `Autoload "${name}" not found.`;
    }

    // Add/update mode
    if (!path) throw new Error('path is required to add an autoload (e.g. "res://singletons/game_state.gd")');
    const resPath = path.startsWith('res://') ? path : `res://${path}`;
    autoloadSection.entries.set(name, `"*${resPath}"`);

    return `Registered autoload: ${name} → ${resPath}`;
}

function handleManagePlugins(
    sections: IniSection[],
    params: { pluginName?: string; enabled?: boolean },
): string {
    const pluginsSection = getOrCreateSection(sections, 'editor_plugins');
    const { pluginName, enabled } = params;

    // List mode
    if (!pluginName) {
        const enabledPlugins = pluginsSection.entries.get('enabled');
        if (!enabledPlugins) return 'No plugins enabled.';
        return `Enabled plugins: ${enabledPlugins}`;
    }

    // Get current enabled list
    const currentStr = pluginsSection.entries.get('enabled') || 'PackedStringArray()';
    const match = currentStr.match(/PackedStringArray\((.*)\)/);
    const currentPlugins = match && match[1]
        ? match[1].split(',').map(s => s.trim().replace(/"/g, ''))
        : [];

    const pluginPath = pluginName.includes('/') ? pluginName : `res://addons/${pluginName}/plugin.cfg`;
    const idx = currentPlugins.indexOf(pluginPath);

    if (enabled === false) {
        if (idx >= 0) {
            currentPlugins.splice(idx, 1);
            const newVal = `PackedStringArray(${currentPlugins.map(p => `"${p}"`).join(', ')})`;
            pluginsSection.entries.set('enabled', newVal);
            return `Disabled plugin: ${pluginPath}`;
        }
        return `Plugin "${pluginPath}" is not enabled.`;
    }

    // Enable
    if (idx < 0) {
        currentPlugins.push(pluginPath);
    }
    const newVal = `PackedStringArray(${currentPlugins.map(p => `"${p}"`).join(', ')})`;
    pluginsSection.entries.set('enabled', newVal);

    return idx < 0
        ? `Enabled plugin: ${pluginPath}`
        : `Plugin already enabled: ${pluginPath}`;
}

// ---------------------------------------------------------------------------
// Tool definition
// ---------------------------------------------------------------------------

export const configTools: MCPTool[] = [
    {
        name: 'manage_project_config',
        description:
            'Manage Godot project configuration (project.godot). ' +
            'Actions: "update_settings" to read/write project settings, ' +
            '"configure_input" to manage input actions, ' +
            '"setup_autoload" to register singletons, ' +
            '"manage_plugins" to enable/disable editor plugins. ' +
            'Call without optional params to list current values.',
        parameters: z.object({
            action: z
                .enum(['update_settings', 'configure_input', 'setup_autoload', 'manage_plugins'])
                .describe('Which configuration action to perform'),
            projectPath: z
                .string()
                .describe('Absolute path to the Godot project directory'),
            // update_settings
            section: z
                .string()
                .optional()
                .describe('For update_settings: INI section name (e.g. "application", "display")'),
            key: z
                .string()
                .optional()
                .describe('For update_settings: setting key (e.g. "config/name")'),
            value: z
                .any()
                .optional()
                .describe('For update_settings: new value for the setting'),
            // configure_input
            actionName: z
                .string()
                .optional()
                .describe('For configure_input: input action name (e.g. "move_left", "jump")'),
            inputEvents: z
                .array(
                    z.object({
                        type: z.enum(['key', 'mouse_button', 'joypad_button', 'joypad_motion']),
                        keycode: z.number().optional(),
                        physical_keycode: z.number().optional(),
                        button_index: z.number().optional(),
                        axis: z.number().optional(),
                        axis_value: z.number().optional(),
                        deadzone: z.number().optional(),
                    }),
                )
                .optional()
                .describe('For configure_input: array of input events to bind'),
            remove: z
                .boolean()
                .optional()
                .describe('For configure_input: set true to remove the action'),
            // setup_autoload
            name: z
                .string()
                .optional()
                .describe('For setup_autoload / manage_plugins: singleton name or plugin name'),
            path: z
                .string()
                .optional()
                .describe('For setup_autoload: script/scene path (e.g. "res://singletons/game.gd")'),
            enabled: z
                .boolean()
                .optional()
                .describe('For setup_autoload / manage_plugins: false to remove'),
            // manage_plugins
            pluginName: z
                .string()
                .optional()
                .describe('For manage_plugins: plugin name or path'),
        }),
        execute: async (params: Record<string, unknown>) => {
            const { action, projectPath } = params as { action: string; projectPath: string };
            const { godotFile } = resolveProject(projectPath);

            const content = readFileSync(godotFile, 'utf8');
            const sections = parseProjectGodot(content);
            let result: string;
            let needsWrite = false;

            switch (action) {
                case 'update_settings':
                    result = handleUpdateSettings(sections, params as any);
                    needsWrite = !!(params.key && params.value !== undefined);
                    break;
                case 'configure_input':
                    result = handleConfigureInput(sections, params as any);
                    needsWrite = !!(params.actionName);
                    break;
                case 'setup_autoload':
                    result = handleSetupAutoload(sections, params as any);
                    needsWrite = !!(params.name);
                    break;
                case 'manage_plugins':
                    result = handleManagePlugins(sections, params as any);
                    needsWrite = !!(params.pluginName);
                    break;
                default:
                    throw new Error(`Unknown action: ${action}`);
            }

            if (needsWrite) {
                const serialized = serializeProjectGodot(sections);
                writeFileSync(godotFile, serialized, 'utf8');
                logDebug(`Wrote updated project.godot to ${godotFile}`);
            }

            return result;
        },
    },
];
