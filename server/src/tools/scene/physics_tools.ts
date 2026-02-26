/**
 * Physics tools — manage physics bodies, collision layers, and areas.
 *
 * Single consolidated tool: `manage_physics`
 * Actions: add_body | configure | setup_layers | create_area
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

export const physicsTools: MCPTool[] = [
    {
        name: 'manage_physics',
        description:
            'Manage physics bodies, collision shapes, layers, and areas in a Godot scene. ' +
            'Actions: "add_body" to create a physics body with collision shape, ' +
            '"configure" to set physics properties (mass, friction, bounce, gravity_scale), ' +
            '"setup_layers" to configure collision layers and masks, ' +
            '"create_area" to create Area2D/3D nodes for overlap detection. ' +
            'Requires the Godot editor addon to be running.',
        parameters: z.object({
            action: z
                .enum(['add_body', 'configure', 'setup_layers', 'create_area'])
                .describe('Which physics action to perform'),

            // Common
            node_path: z
                .string()
                .optional()
                .describe(
                    'Path to existing node (for configure/setup_layers). ' +
                    'E.g. "Player", "Enemies/Golem".',
                ),

            // For add_body
            body_type: z
                .enum([
                    'character_body_2d',
                    'character_body_3d',
                    'rigid_body_2d',
                    'rigid_body_3d',
                    'static_body_2d',
                    'static_body_3d',
                    'animatable_body_2d',
                    'animatable_body_3d',
                ])
                .optional()
                .describe('Type of physics body to create (for add_body)'),
            collision_shape: z
                .enum([
                    'rectangle',
                    'circle',
                    'capsule',
                    'box',
                    'sphere',
                    'cylinder',
                    'convex_polygon',
                    'concave_polygon',
                    'world_boundary',
                    'segment',
                ])
                .optional()
                .describe('Collision shape to attach (for add_body)'),
            parent_path: z
                .string()
                .optional()
                .describe(
                    'Parent node path where the body should be added (for add_body / create_area)',
                ),
            node_name: z
                .string()
                .optional()
                .describe('Name for the new node (for add_body / create_area)'),

            // For configure
            mass: z
                .number()
                .optional()
                .describe('Mass of the body in kg (for configure, RigidBody only)'),
            friction: z
                .number()
                .optional()
                .describe('Friction coefficient 0.0–1.0 (for configure)'),
            bounce: z
                .number()
                .optional()
                .describe('Bounce/restitution 0.0–1.0 (for configure)'),
            gravity_scale: z
                .number()
                .optional()
                .describe('Gravity multiplier (for configure, RigidBody only)'),
            linear_damp: z
                .number()
                .optional()
                .describe('Linear damping (for configure, RigidBody only)'),
            angular_damp: z
                .number()
                .optional()
                .describe('Angular damping (for configure, RigidBody only)'),

            // For setup_layers
            collision_layer: z
                .number()
                .optional()
                .describe(
                    'Collision layer bitmask (for setup_layers). Layers this object IS on.',
                ),
            collision_mask: z
                .number()
                .optional()
                .describe(
                    'Collision mask bitmask (for setup_layers). Layers this object SCANS.',
                ),

            // For create_area
            area_type: z
                .enum(['area_2d', 'area_3d'])
                .optional()
                .describe('Type of area to create (for create_area)'),
            monitoring: z
                .boolean()
                .optional()
                .describe('Whether the area detects bodies/areas entering (default: true)'),
            monitorable: z
                .boolean()
                .optional()
                .describe('Whether other areas can detect this area (default: true)'),
        }),
        execute: async (params: Record<string, unknown>) => {
            const godot = getGodotConnection();
            const action = params.action as string;

            logInfo(`manage_physics: action=${action}`);

            try {
                switch (action) {
                    case 'add_body': {
                        const bodyType = params.body_type as string;
                        if (!bodyType) throw new Error('body_type is required for add_body');
                        if (!params.parent_path) throw new Error('parent_path is required for add_body');

                        // Map friendly names to Godot class names
                        const typeMap: Record<string, string> = {
                            character_body_2d: 'CharacterBody2D',
                            character_body_3d: 'CharacterBody3D',
                            rigid_body_2d: 'RigidBody2D',
                            rigid_body_3d: 'RigidBody3D',
                            static_body_2d: 'StaticBody2D',
                            static_body_3d: 'StaticBody3D',
                            animatable_body_2d: 'AnimatableBody2D',
                            animatable_body_3d: 'AnimatableBody3D',
                        };

                        const godotType = typeMap[bodyType] || bodyType;
                        const nodeName = (params.node_name as string) || godotType;

                        // Create the body node
                        const bodyResult = await godot.sendCommand<CommandResult>('create_node', {
                            parent_path: params.parent_path,
                            node_type: godotType,
                            node_name: nodeName,
                        });

                        // Optionally add collision shape
                        let shapeMsg = '';
                        if (params.collision_shape) {
                            const is3D = bodyType.includes('3d');
                            const shapeMap: Record<string, string> = {
                                rectangle: 'RectangleShape2D',
                                circle: 'CircleShape2D',
                                capsule: is3D ? 'CapsuleShape3D' : 'CapsuleShape2D',
                                box: 'BoxShape3D',
                                sphere: 'SphereShape3D',
                                cylinder: 'CylinderShape3D',
                                world_boundary: is3D ? 'WorldBoundaryShape3D' : 'WorldBoundaryShape2D',
                                segment: 'SegmentShape2D',
                                convex_polygon: is3D ? 'ConvexPolygonShape3D' : 'ConvexPolygonShape2D',
                                concave_polygon: is3D ? 'ConcavePolygonShape3D' : 'ConcavePolygonShape2D',
                            };

                            const shapeType = is3D ? 'CollisionShape3D' : 'CollisionShape2D';
                            const bodyPath = `${params.parent_path}/${nodeName}`;

                            await godot.sendCommand<CommandResult>('create_node', {
                                parent_path: bodyPath,
                                node_type: shapeType,
                                node_name: 'CollisionShape',
                            });
                            shapeMsg = ` with ${shapeType} (${params.collision_shape})`;
                        }

                        return `✅ Created ${godotType} "${nodeName}" under ${params.parent_path}${shapeMsg}`;
                    }

                    case 'configure': {
                        if (!params.node_path) throw new Error('node_path is required for configure');

                        const props: Record<string, unknown> = {};
                        if (params.mass !== undefined) props['mass'] = params.mass;
                        if (params.friction !== undefined) props['friction'] = params.friction;
                        if (params.bounce !== undefined) props['bounce'] = params.bounce;
                        if (params.gravity_scale !== undefined) props['gravity_scale'] = params.gravity_scale;
                        if (params.linear_damp !== undefined) props['linear_damp'] = params.linear_damp;
                        if (params.angular_damp !== undefined) props['angular_damp'] = params.angular_damp;

                        if (Object.keys(props).length === 0) {
                            // Read mode - get current physics properties
                            const result = await godot.sendCommand<CommandResult>('get_node_properties', {
                                node_path: params.node_path,
                            });
                            return JSON.stringify(result, null, 2);
                        }

                        // Set properties
                        const results: string[] = [];
                        for (const [prop, val] of Object.entries(props)) {
                            await godot.sendCommand<CommandResult>('update_node_property', {
                                node_path: params.node_path,
                                property: prop,
                                value: val,
                            });
                            results.push(`${prop}=${val}`);
                        }

                        return `✅ Configured physics on ${params.node_path}: ${results.join(', ')}`;
                    }

                    case 'setup_layers': {
                        if (!params.node_path) throw new Error('node_path is required for setup_layers');

                        const updates: string[] = [];
                        if (params.collision_layer !== undefined) {
                            await godot.sendCommand<CommandResult>('update_node_property', {
                                node_path: params.node_path,
                                property: 'collision_layer',
                                value: params.collision_layer,
                            });
                            updates.push(`layer=${params.collision_layer}`);
                        }
                        if (params.collision_mask !== undefined) {
                            await godot.sendCommand<CommandResult>('update_node_property', {
                                node_path: params.node_path,
                                property: 'collision_mask',
                                value: params.collision_mask,
                            });
                            updates.push(`mask=${params.collision_mask}`);
                        }

                        if (updates.length === 0) {
                            throw new Error('At least one of collision_layer or collision_mask is required');
                        }

                        return `✅ Updated collision layers on ${params.node_path}: ${updates.join(', ')}`;
                    }

                    case 'create_area': {
                        const areaType = params.area_type as string;
                        if (!areaType) throw new Error('area_type is required for create_area');
                        if (!params.parent_path) throw new Error('parent_path is required for create_area');

                        const typeMap: Record<string, string> = {
                            area_2d: 'Area2D',
                            area_3d: 'Area3D',
                        };

                        const godotType = typeMap[areaType] || areaType;
                        const nodeName = (params.node_name as string) || godotType;

                        await godot.sendCommand<CommandResult>('create_node', {
                            parent_path: params.parent_path,
                            node_type: godotType,
                            node_name: nodeName,
                        });

                        // Configure monitoring/monitorable if specified
                        const areaPath = `${params.parent_path}/${nodeName}`;
                        if (params.monitoring !== undefined) {
                            await godot.sendCommand<CommandResult>('update_node_property', {
                                node_path: areaPath,
                                property: 'monitoring',
                                value: params.monitoring,
                            });
                        }
                        if (params.monitorable !== undefined) {
                            await godot.sendCommand<CommandResult>('update_node_property', {
                                node_path: areaPath,
                                property: 'monitorable',
                                value: params.monitorable,
                            });
                        }

                        // Add a collision shape child
                        const is3D = areaType === 'area_3d';
                        const shapeNodeType = is3D ? 'CollisionShape3D' : 'CollisionShape2D';
                        await godot.sendCommand<CommandResult>('create_node', {
                            parent_path: areaPath,
                            node_type: shapeNodeType,
                            node_name: 'CollisionShape',
                        });

                        return `✅ Created ${godotType} "${nodeName}" under ${params.parent_path} with ${shapeNodeType}`;
                    }

                    default:
                        throw new Error(`Unknown physics action: ${action}`);
                }
            } catch (error) {
                throw new Error(`manage_physics (${action}): ${(error as Error).message}`);
            }
        },
    },
];
