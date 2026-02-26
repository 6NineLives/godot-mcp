/**
 * Documentation tools — search and retrieve Godot documentation.
 *
 * Single consolidated tool: `godot_docs`
 * Actions: search | get_file | get_class | get_best_practices | get_tree
 */

import { z } from 'zod';
import { MCPTool } from '../../utils/types.js';
import { DocsManager } from '../../utils/docs_manager.js';

// ---------------------------------------------------------------------------
// Best-practices knowledge base (curated guides by topic)
// ---------------------------------------------------------------------------

const BEST_PRACTICES: Record<string, string> = {
  physics: `# Best Practices: Physics

## Use the Right Body Type
- **StaticBody2D/3D** for immovable objects (walls, floors)
- **RigidBody2D/3D** for objects that respond to physics (crates, balls)
- **CharacterBody2D/3D** for player/NPC movement (use \`move_and_slide()\`)
- **Area2D/3D** for detection zones (pickups, triggers)

## Physics Process
- Always use \`_physics_process(delta)\` for physics code, not \`_process()\`
- The physics timestep is fixed (default 60 Hz), ensuring deterministic behavior

## Collision Layers
- Organize objects into layers: e.g. layer 1 = player, layer 2 = enemies, layer 3 = world
- Use masks to control what each body collides with
- Keep collision shapes as simple as possible for performance

## Example
\`\`\`gdscript
extends CharacterBody2D

var speed = 200.0

func _physics_process(delta):
    var input = Input.get_vector("left", "right", "up", "down")
    velocity = input * speed
    move_and_slide()
\`\`\`

## References
- https://docs.godotengine.org/en/stable/tutorials/physics/index.html`,

  signals: `# Best Practices: Signals

## Prefer Signals Over Direct Calls
- Signals decouple sender and receiver — the emitter doesn't need to know who listens
- Use signals for events: damage taken, item collected, state changed

## Naming Conventions
- Use past tense for signals: \`health_changed\`, \`item_collected\`, \`enemy_died\`
- Prefix with the subject when ambiguous: \`player_died\`, \`timer_finished\`

## Custom Signals
\`\`\`gdscript
signal health_changed(new_health: int)
signal died

func take_damage(amount: int):
    health -= amount
    health_changed.emit(health)
    if health <= 0:
        died.emit()
\`\`\`

## Connection Patterns
- Connect in \`_ready()\` for static connections
- Use \`connect()\` with \`CONNECT_ONE_SHOT\` for one-time events
- Disconnect signals when freeing nodes to avoid errors

## References
- https://docs.godotengine.org/en/stable/getting_started/step_by_step/signals.html`,

  gdscript: `# Best Practices: GDScript

## Type Hints
- Use static typing for better performance and error detection:
\`\`\`gdscript
var speed: float = 200.0
var player_name: String = "Hero"
func get_damage(base: int, multiplier: float) -> int:
    return int(base * multiplier)
\`\`\`

## Avoid Using \`get_node()\` in Loops
- Cache node references in \`_ready()\` using \`@onready\`:
\`\`\`gdscript
@onready var sprite: Sprite2D = $Sprite2D
@onready var anim: AnimationPlayer = $AnimationPlayer
\`\`\`

## Use Enums for States
\`\`\`gdscript
enum State { IDLE, RUNNING, JUMPING, FALLING }
var current_state: State = State.IDLE
\`\`\`

## Export Variables
- Use \`@export\` to expose variables in the editor:
\`\`\`gdscript
@export var speed: float = 200.0
@export var jump_height: float = 400.0
@export_range(0, 100) var health: int = 100
\`\`\`

## References
- https://docs.godotengine.org/en/stable/tutorials/scripting/gdscript/index.html`,

  scene_organization: `# Best Practices: Scene Organization

## Scene Composition
- Keep scenes small and focused — one scene per logical entity
- Use inheritance: create base scenes, extend them for variants
- Prefer composition over deep inheritance hierarchies

## Node Naming
- Use PascalCase for node names: \`PlayerCharacter\`, \`EnemySpawner\`
- Group related nodes: \`UI/HealthBar\`, \`Enemies/Goblin1\`

## Project Structure
\`\`\`
res://
├── scenes/          # .tscn files
├── scripts/         # .gd files
├── assets/
│   ├── sprites/
│   ├── audio/
│   └── fonts/
├── autoloads/       # Singleton scripts
└── resources/       # .tres files
\`\`\`

## Autoloads (Singletons)
- Use for global state: GameManager, AudioManager, SaveSystem
- Keep autoloads lean — avoid putting everything in one giant singleton
- Access via class name: \`GameManager.score += 10\`

## References
- https://docs.godotengine.org/en/stable/tutorials/best_practices/scene_organization.html`,

  animation: `# Best Practices: Animation

## AnimationPlayer
- Use AnimationPlayer for most animations — it can animate any property
- Keep animations in the scene they belong to
- Use descriptive names: \`idle\`, \`walk\`, \`attack_sword\`, \`death\`

## AnimationTree
- Use AnimationTree for complex state machines (blend between walk/run/idle)
- Set up StateMachine or BlendTree nodes for smooth transitions
- Connect to AnimationPlayer

## Tweens for Simple Animations
\`\`\`gdscript
func flash_red():
    var tween = create_tween()
    tween.tween_property($Sprite2D, "modulate", Color.RED, 0.1)
    tween.tween_property($Sprite2D, "modulate", Color.WHITE, 0.1)
\`\`\`

## Best Practices
- Use \`create_tween()\` (bound to node) instead of \`get_tree().create_tween()\`
- Chain tween calls for sequential animations
- Use \`.set_parallel()\` for concurrent property changes

## References
- https://docs.godotengine.org/en/stable/tutorials/animation/index.html`,

  ui: `# Best Practices: UI

## Use Control Nodes
- Build UI with Control-derived nodes (not Node2D)
- Use containers (VBoxContainer, HBoxContainer, GridContainer) for layout
- Avoid hard-coding positions — use anchors and margins

## Anchors and Margins
- Set anchors for responsive layouts that adapt to screen size
- Use "Full Rect" preset for full-screen containers
- Test at multiple resolutions

## Theme System
\`\`\`gdscript
# Apply a theme to a root Control node — all children inherit it
var theme = Theme.new()
theme.set_color("font_color", "Label", Color.WHITE)
theme.set_font_size("font_size", "Label", 16)
$UI.theme = theme
\`\`\`

## Separate UI from Game Logic
- Use signals to communicate between game and UI
- UI nodes should observe state, not modify it directly
- Keep UI scenes separate from gameplay scenes

## References
- https://docs.godotengine.org/en/stable/tutorials/ui/index.html`,

  input: `# Best Practices: Input Handling

## Use Input Map
- Define actions in Project Settings → Input Map
- Use action names, not raw key codes:
\`\`\`gdscript
# Good
if Input.is_action_just_pressed("jump"):
    jump()

# Bad
if Input.is_key_pressed(KEY_SPACE):
    jump()
\`\`\`

## Input Methods
- \`_input(event)\` — for one-shot events (menus, interactions)
- \`_unhandled_input(event)\` — for gameplay input (respects UI consumption)
- \`Input.get_vector()\` — for movement axes
- \`Input.is_action_just_pressed()\` — for discrete actions

## Consume Input
\`\`\`gdscript
func _unhandled_input(event):
    if event.is_action_pressed("interact"):
        interact()
        get_viewport().set_input_as_handled()
\`\`\`

## References
- https://docs.godotengine.org/en/stable/tutorials/inputs/index.html`,

  performance: `# Best Practices: Performance

## General Tips
- Use \`_physics_process()\` only for physics — use \`_process()\` for visuals
- Disable \`_process()\` on nodes that don't need it: \`set_process(false)\`
- Use Object Pooling for frequently created/destroyed objects (bullets, particles)

## Rendering
- Use visibility notifiers to disable off-screen processing
- Keep draw calls low — use AnimatedSprite2D batching
- Reduce overdraw — avoid stacking transparent sprites

## Static Typing
- Static typing in GDScript gives ~10-20% performance boost
- Always type function parameters and return values
\`\`\`gdscript
func calculate_damage(base: float, multiplier: float) -> float:
    return base * multiplier
\`\`\`

## Profiling
- Use the built-in profiler (Debugger → Profiler) to identify bottlenecks
- Monitor frame time, physics time, and idle time
- Use \`Engine.get_frames_per_second()\` for runtime FPS checks

## References
- https://docs.godotengine.org/en/stable/tutorials/performance/index.html`,
};

// ---------------------------------------------------------------------------
// Tool definition
// ---------------------------------------------------------------------------

export const docTools: MCPTool[] = [
  {
    name: 'godot_docs',
    description:
      'Search and retrieve Godot documentation. ' +
      'Actions: "search" to find files matching a query, ' +
      '"get_file" to read a specific documentation file, ' +
      '"get_class" to get class reference documentation, ' +
      '"get_best_practices" to get curated best-practice guides for a topic.',
    parameters: z.object({
      action: z
        .enum(['search', 'get_file', 'get_class', 'get_best_practices', 'get_tree'])
        .describe('Which documentation action to perform'),
      query: z
        .string()
        .optional()
        .describe('Search query (for search). E.g. "Node2D", "signal"'),
      path: z
        .string()
        .optional()
        .describe('Path to the file relative to docs root (for get_file). E.g. "classes/class_node.rst"'),
      class_name: z
        .string()
        .optional()
        .describe('Name of the class (for get_class). E.g. "Node", "Sprite2D"'),
      tree_path: z
        .string()
        .optional()
        .describe('Relative path for getting doc folder tree. Leave empty for root. E.g "tutorials/2d"'),
      topic: z
        .string()
        .optional()
        .describe(
          'Topic for best practices (for get_best_practices). ' +
          'Available: "physics", "signals", "gdscript", "scene_organization", ' +
          '"animation", "ui", "input", "performance"'
        ),
    }),
    execute: async (params: Record<string, unknown>) => {
      const action = params.action as string;
      const docsManager = DocsManager.getInstance();

      try {
        switch (action) {
          case 'search': {
            const query = params.query as string;
            if (!query) throw new Error('query is required for action "search"');
            const results = await docsManager.searchFiles(query);
            if (results.length === 0) return 'No results found.';
            return `Found ${results.length} files:\n${results.join('\n')}`;
          }

          case 'get_file': {
            const path = params.path as string;
            if (!path) throw new Error('path is required for action "get_file"');
            return await docsManager.getFileContent(path);
          }

          case 'get_class': {
            const className = params.class_name as string;
            if (!className) throw new Error('class_name is required for action "get_class"');
            return await docsManager.getClassReference(className);
          }

          case 'get_best_practices': {
            const topic = (params.topic as string ?? '').toLowerCase().replace(/[\s-]+/g, '_');
            if (!topic) throw new Error('topic is required for action "get_best_practices"');

            const practices = BEST_PRACTICES[topic];
            if (!practices) {
              const available = Object.keys(BEST_PRACTICES).join(', ');
              return `No best practices found for topic: "${topic}"\n\nAvailable topics: ${available}`;
            }
            return practices;
          }

          case 'get_tree': {
            const treePath = (params.tree_path as string) || '';
            const tree = await docsManager.getTree(treePath);
            if (tree.length === 0) return `No files/directories found in ${treePath || 'root'}.`;
            return `Contents of ${treePath || 'documentation root'}:\n- ` + tree.join('\n- ');
          }

          default:
            throw new Error(`Unknown action: ${action}`);
        }
      } catch (error) {
        throw new Error(`Documentation action "${action}" failed: ${(error as Error).message}`);
      }
    },
  },
];
