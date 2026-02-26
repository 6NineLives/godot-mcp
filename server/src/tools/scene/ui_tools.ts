/**
 * UI tools — create and configure Godot UI elements, themes, layouts, and menus.
 *
 * Single consolidated tool: `manage_ui`
 * Actions: create_element | apply_theme | setup_layout | create_menu
 *
 * Uses WebSocket for live editor manipulation.
 */

import { z } from 'zod';
import { getGodotConnection } from '../../utils/godot_connection.js';
import { MCPTool, CommandResult } from '../../utils/types.js';
import { logInfo } from '../../utils/logger.js';

// ---------------------------------------------------------------------------
// Tool definition
// ---------------------------------------------------------------------------

export const uiTools: MCPTool[] = [
    {
        name: 'manage_ui',
        description:
            'Create and configure UI elements in a Godot scene. ' +
            'Actions: "create_element" to add a UI control node, ' +
            '"apply_theme" to set theme overrides (colors, fonts, styles), ' +
            '"setup_layout" to configure container layouts (VBox, HBox, Grid, etc.), ' +
            '"create_menu" to build menu bar or popup menu structures. ' +
            'Requires the Godot editor addon to be running.',
        parameters: z.object({
            action: z
                .enum(['create_element', 'apply_theme', 'setup_layout', 'create_menu'])
                .describe('Which UI action to perform'),

            // Common
            parent_path: z
                .string()
                .optional()
                .describe('Parent node path for new elements'),
            node_name: z
                .string()
                .optional()
                .describe('Name for the new UI node'),
            node_path: z
                .string()
                .optional()
                .describe('Path to existing node (for apply_theme)'),

            // For create_element
            element_type: z
                .enum([
                    'button',
                    'label',
                    'line_edit',
                    'text_edit',
                    'rich_text_label',
                    'check_box',
                    'check_button',
                    'option_button',
                    'spin_box',
                    'h_slider',
                    'v_slider',
                    'progress_bar',
                    'texture_rect',
                    'texture_button',
                    'color_rect',
                    'panel',
                    'scroll_container',
                    'tab_container',
                    'tab_bar',
                    'split_container',
                    'tree',
                    'item_list',
                    'file_dialog',
                    'color_picker',
                    'color_picker_button',
                ])
                .optional()
                .describe('Type of UI element to create (for create_element)'),
            text: z
                .string()
                .optional()
                .describe('Text content for the element (Button, Label, etc.)'),
            size: z
                .object({
                    x: z.number(),
                    y: z.number(),
                })
                .optional()
                .describe('Custom minimum size for the element'),
            anchors_preset: z
                .enum([
                    'top_left',
                    'top_right',
                    'bottom_left',
                    'bottom_right',
                    'center',
                    'center_left',
                    'center_right',
                    'center_top',
                    'center_bottom',
                    'full_rect',
                    'wide_top',
                    'wide_bottom',
                    'wide_left',
                    'wide_right',
                ])
                .optional()
                .describe('Anchor preset for positioning'),

            // For apply_theme
            theme_overrides: z
                .record(z.any())
                .optional()
                .describe(
                    'Theme override properties. Keys use Godot theme format: ' +
                    '"colors/font_color", "font_sizes/font_size", etc.',
                ),

            // For setup_layout
            container_type: z
                .enum([
                    'v_box',
                    'h_box',
                    'grid',
                    'margin',
                    'center',
                    'flow',
                    'aspect_ratio',
                    'panel',
                    'scroll',
                    'tab',
                    'split_h',
                    'split_v',
                ])
                .optional()
                .describe('Type of container to create (for setup_layout)'),
            separation: z
                .number()
                .optional()
                .describe('Spacing between children in pixels (for VBox/HBox/Grid)'),
            columns: z
                .number()
                .optional()
                .describe('Number of columns (for Grid container)'),
            margin: z
                .object({
                    left: z.number().optional(),
                    right: z.number().optional(),
                    top: z.number().optional(),
                    bottom: z.number().optional(),
                })
                .optional()
                .describe('Margin values in pixels (for Margin container)'),

            // For create_menu
            menu_type: z
                .enum(['menu_bar', 'popup_menu', 'menu_button'])
                .optional()
                .describe('Type of menu to create (for create_menu)'),
            menu_items: z
                .array(
                    z.object({
                        label: z.string().describe('Menu item text'),
                        id: z.number().optional().describe('Unique item ID'),
                        shortcut: z.string().optional().describe('Keyboard shortcut text'),
                        separator: z.boolean().optional().describe('If true, add as separator'),
                        submenu: z
                            .array(
                                z.object({
                                    label: z.string(),
                                    id: z.number().optional(),
                                }),
                            )
                            .optional()
                            .describe('Nested submenu items'),
                    }),
                )
                .optional()
                .describe('Array of menu items (for create_menu)'),
        }),
        execute: async (params: Record<string, unknown>) => {
            const godot = getGodotConnection();
            const action = params.action as string;

            logInfo(`manage_ui: action=${action}`);

            try {
                switch (action) {
                    case 'create_element': {
                        const elementType = params.element_type as string;
                        if (!elementType) throw new Error('element_type is required');
                        if (!params.parent_path) throw new Error('parent_path is required');

                        // Map friendly names to Godot class names
                        const typeMap: Record<string, string> = {
                            button: 'Button',
                            label: 'Label',
                            line_edit: 'LineEdit',
                            text_edit: 'TextEdit',
                            rich_text_label: 'RichTextLabel',
                            check_box: 'CheckBox',
                            check_button: 'CheckButton',
                            option_button: 'OptionButton',
                            spin_box: 'SpinBox',
                            h_slider: 'HSlider',
                            v_slider: 'VSlider',
                            progress_bar: 'ProgressBar',
                            texture_rect: 'TextureRect',
                            texture_button: 'TextureButton',
                            color_rect: 'ColorRect',
                            panel: 'Panel',
                            scroll_container: 'ScrollContainer',
                            tab_container: 'TabContainer',
                            tab_bar: 'TabBar',
                            split_container: 'HSplitContainer',
                            tree: 'Tree',
                            item_list: 'ItemList',
                            file_dialog: 'FileDialog',
                            color_picker: 'ColorPicker',
                            color_picker_button: 'ColorPickerButton',
                        };

                        const godotType = typeMap[elementType] || elementType;
                        const nodeName = (params.node_name as string) || godotType;

                        await godot.sendCommand<CommandResult>('create_node', {
                            parent_path: params.parent_path,
                            node_type: godotType,
                            node_name: nodeName,
                        });

                        const nodePath = `${params.parent_path}/${nodeName}`;

                        // Set text if applicable
                        if (params.text) {
                            const textProp = ['RichTextLabel'].includes(godotType)
                                ? 'bbcode_text'
                                : 'text';
                            await godot.sendCommand<CommandResult>('update_node_property', {
                                node_path: nodePath,
                                property: textProp,
                                value: params.text,
                            });
                        }

                        // Set custom minimum size if specified
                        if (params.size) {
                            await godot.sendCommand<CommandResult>('update_node_property', {
                                node_path: nodePath,
                                property: 'custom_minimum_size',
                                value: params.size,
                            });
                        }

                        return `✅ Created ${godotType} "${nodeName}" under ${params.parent_path}`;
                    }

                    case 'apply_theme': {
                        const targetPath = (params.node_path || params.parent_path) as string;
                        if (!targetPath) throw new Error('node_path is required for apply_theme');
                        if (!params.theme_overrides)
                            throw new Error('theme_overrides is required');

                        const overrides = params.theme_overrides as Record<string, unknown>;
                        const results: string[] = [];

                        for (const [key, value] of Object.entries(overrides)) {
                            // Theme overrides use a specific property naming:
                            // "theme_override_colors/font_color", "theme_override_font_sizes/font_size", etc.
                            const propName = key.startsWith('theme_override_')
                                ? key
                                : `theme_override_${key}`;

                            await godot.sendCommand<CommandResult>('update_node_property', {
                                node_path: targetPath,
                                property: propName,
                                value,
                            });
                            results.push(`${propName}=${JSON.stringify(value)}`);
                        }

                        return `✅ Applied ${results.length} theme override(s) to ${targetPath}:\n${results.join('\n')}`;
                    }

                    case 'setup_layout': {
                        const containerType = params.container_type as string;
                        if (!containerType) throw new Error('container_type is required');
                        if (!params.parent_path) throw new Error('parent_path is required');

                        const typeMap: Record<string, string> = {
                            v_box: 'VBoxContainer',
                            h_box: 'HBoxContainer',
                            grid: 'GridContainer',
                            margin: 'MarginContainer',
                            center: 'CenterContainer',
                            flow: 'FlowContainer',
                            aspect_ratio: 'AspectRatioContainer',
                            panel: 'PanelContainer',
                            scroll: 'ScrollContainer',
                            tab: 'TabContainer',
                            split_h: 'HSplitContainer',
                            split_v: 'VSplitContainer',
                        };

                        const godotType = typeMap[containerType] || containerType;
                        const nodeName = (params.node_name as string) || godotType;

                        await godot.sendCommand<CommandResult>('create_node', {
                            parent_path: params.parent_path,
                            node_type: godotType,
                            node_name: nodeName,
                        });

                        const containerPath = `${params.parent_path}/${nodeName}`;
                        const configDetails: string[] = [];

                        // Configure separation for box/grid containers
                        if (
                            params.separation !== undefined &&
                            ['VBoxContainer', 'HBoxContainer', 'GridContainer'].includes(godotType)
                        ) {
                            await godot.sendCommand<CommandResult>('update_node_property', {
                                node_path: containerPath,
                                property: 'theme_override_constants/separation',
                                value: params.separation,
                            });
                            configDetails.push(`separation=${params.separation}px`);
                        }

                        // Configure columns for grid
                        if (params.columns !== undefined && godotType === 'GridContainer') {
                            await godot.sendCommand<CommandResult>('update_node_property', {
                                node_path: containerPath,
                                property: 'columns',
                                value: params.columns,
                            });
                            configDetails.push(`columns=${params.columns}`);
                        }

                        // Configure margin
                        if (params.margin && godotType === 'MarginContainer') {
                            const marginObj = params.margin as Record<string, number>;
                            for (const [side, val] of Object.entries(marginObj)) {
                                if (val !== undefined) {
                                    await godot.sendCommand<CommandResult>('update_node_property', {
                                        node_path: containerPath,
                                        property: `theme_override_constants/margin_${side}`,
                                        value: val,
                                    });
                                    configDetails.push(`margin_${side}=${val}px`);
                                }
                            }
                        }

                        const config =
                            configDetails.length > 0
                                ? ` (${configDetails.join(', ')})`
                                : '';

                        return `✅ Created ${godotType} "${nodeName}" under ${params.parent_path}${config}`;
                    }

                    case 'create_menu': {
                        const menuType = params.menu_type as string;
                        if (!menuType) throw new Error('menu_type is required');
                        if (!params.parent_path) throw new Error('parent_path is required');

                        const typeMap: Record<string, string> = {
                            menu_bar: 'MenuBar',
                            popup_menu: 'PopupMenu',
                            menu_button: 'MenuButton',
                        };

                        const godotType = typeMap[menuType] || menuType;
                        const nodeName = (params.node_name as string) || godotType;

                        await godot.sendCommand<CommandResult>('create_node', {
                            parent_path: params.parent_path,
                            node_type: godotType,
                            node_name: nodeName,
                        });

                        // Add menu items if specified
                        const items = (params.menu_items as Array<{
                            label: string;
                            id?: number;
                            separator?: boolean;
                        }>) || [];

                        if (items.length > 0) {
                            const menuPath = `${params.parent_path}/${nodeName}`;
                            await godot.sendCommand<CommandResult>('configure_menu', {
                                menu_path: menuPath,
                                items: items.map((item, idx) => ({
                                    label: item.label,
                                    id: item.id ?? idx,
                                    separator: item.separator ?? false,
                                })),
                            });
                        }

                        return (
                            `✅ Created ${godotType} "${nodeName}" under ${params.parent_path}` +
                            (items.length > 0 ? ` with ${items.length} item(s)` : '')
                        );
                    }

                    default:
                        throw new Error(`Unknown UI action: ${action}`);
                }
            } catch (error) {
                throw new Error(`manage_ui (${action}): ${(error as Error).message}`);
            }
        },
    },
];
