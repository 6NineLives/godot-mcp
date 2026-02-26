@tool
class_name MCPSceneCommands
extends MCPBaseCommandProcessor

func process_command(client_id: int, command_type: String, params: Dictionary, command_id: String) -> bool:
	match command_type:
		"save_scene":
			_save_scene(client_id, params, command_id)
			return true
		"open_scene":
			_open_scene(client_id, params, command_id)
			return true
		"get_current_scene":
			_get_current_scene(client_id, params, command_id)
			return true
		"get_scene_structure":
			_get_scene_structure(client_id, params, command_id)
			return true
		"create_scene":
			_create_scene(client_id, params, command_id)
			return true
		"get_uid":
			_get_uid(client_id, params, command_id)
			return true
		"resave_scene":
			_resave_scene(client_id, params, command_id)
			return true
		"rename_node":
			_rename_node(client_id, params, command_id)
			return true
		"move_node":
			_move_node(client_id, params, command_id)
			return true
		"set_collision_shape":
			_set_collision_shape(client_id, params, command_id)
			return true
		"set_sprite_texture":
			_set_sprite_texture(client_id, params, command_id)
			return true
	return false  # Command not handled

func _save_scene(client_id: int, params: Dictionary, command_id: String) -> void:
	var path = params.get("path", "")
	
	# Get editor plugin and interfaces
	var plugin = Engine.get_meta("GodotMCPPlugin")
	if not plugin:
		return _send_error(client_id, "GodotMCPPlugin not found in Engine metadata", command_id)
	
	var editor_interface = plugin.get_editor_interface()
	var edited_scene_root = editor_interface.get_edited_scene_root()
	
	# If no path provided, use the current scene path
	if path.is_empty() and edited_scene_root:
		path = edited_scene_root.scene_file_path
	
	# Validation
	if path.is_empty():
		return _send_error(client_id, "Scene path cannot be empty", command_id)
	
	# Make sure we have an absolute path
	if not path.begins_with("res://"):
		path = "res://" + path
	
	if not path.ends_with(".tscn"):
		path += ".tscn"
	
	# Check if we have an edited scene
	if not edited_scene_root:
		return _send_error(client_id, "No scene is currently being edited", command_id)
	
	# Use the editor's built-in save mechanism, which properly captures all
	# property modifications including those made via the undo/redo system.
	# The manual PackedScene.pack() + ResourceSaver.save() approach bypasses
	# the editor's internal serialization and can lose property changes.
	var current_scene_path = edited_scene_root.scene_file_path
	
	if path == current_scene_path or current_scene_path.is_empty():
		# Save the current scene in-place using the editor API
		# If the scene has no path yet, set it first
		if current_scene_path.is_empty():
			edited_scene_root.scene_file_path = path
		var result = editor_interface.save_scene()
		if result != OK:
			# Fallback: try the manual approach
			print("[MCP] EditorInterface.save_scene() failed with code %d, trying manual save..." % result)
			result = _manual_save_scene(edited_scene_root, path)
			if result != OK:
				return _send_error(client_id, "Failed to save scene: %d" % result, command_id)
	else:
		# Save to a different path — use save_scene_as if available, else manual
		if editor_interface.has_method("save_scene_as"):
			editor_interface.save_scene_as(path)
		else:
			var result = _manual_save_scene(edited_scene_root, path)
			if result != OK:
				return _send_error(client_id, "Failed to save scene to %s: %d" % [path, result], command_id)
	
	_send_success(client_id, {
		"scene_path": path
	}, command_id)

# Fallback manual save (used when EditorInterface.save_scene() is not suitable)
func _manual_save_scene(scene_root: Node, path: String) -> int:
	var packed_scene = PackedScene.new()
	var result = packed_scene.pack(scene_root)
	if result != OK:
		return result
	return ResourceSaver.save(packed_scene, path)

func _open_scene(client_id: int, params: Dictionary, command_id: String) -> void:
	var path = params.get("path", "")
	
	# Validation
	if path.is_empty():
		return _send_error(client_id, "Scene path cannot be empty", command_id)
	
	# Make sure we have an absolute path
	if not path.begins_with("res://"):
		path = "res://" + path
	
	# Check if the file exists
	if not FileAccess.file_exists(path):
		return _send_error(client_id, "Scene file not found: %s" % path, command_id)
	
	# Since we can't directly open scenes in tool scripts,
	# we need to defer to the plugin which has access to EditorInterface
	var plugin = Engine.get_meta("GodotMCPPlugin") if Engine.has_meta("GodotMCPPlugin") else null
	
	if plugin and plugin.has_method("get_editor_interface"):
		var editor_interface = plugin.get_editor_interface()
		editor_interface.open_scene_from_path(path)
		_send_success(client_id, {
			"scene_path": path
		}, command_id)
	else:
		_send_error(client_id, "Cannot access EditorInterface. Please open the scene manually: %s" % path, command_id)

func _get_current_scene(client_id: int, _params: Dictionary, command_id: String) -> void:
	# Get editor plugin and interfaces
	var plugin = Engine.get_meta("GodotMCPPlugin")
	if not plugin:
		return _send_error(client_id, "GodotMCPPlugin not found in Engine metadata", command_id)
	
	var editor_interface = plugin.get_editor_interface()
	var edited_scene_root = editor_interface.get_edited_scene_root()
	
	if not edited_scene_root:
		print("No scene is currently being edited")
		# Instead of returning an error, return a valid response with empty/default values
		_send_success(client_id, {
			"scene_path": "None",
			"root_node_type": "None",
			"root_node_name": "None"
		}, command_id)
		return
	
	var scene_path = edited_scene_root.scene_file_path
	if scene_path.is_empty():
		scene_path = "Untitled"
	
	print("Current scene path: ", scene_path)
	print("Root node type: ", edited_scene_root.get_class())
	print("Root node name: ", edited_scene_root.name)
	
	_send_success(client_id, {
		"scene_path": scene_path,
		"root_node_type": edited_scene_root.get_class(),
		"root_node_name": edited_scene_root.name
	}, command_id)

func _get_scene_structure(client_id: int, params: Dictionary, command_id: String) -> void:
	var path = params.get("path", "")
	
	# Validation
	if path.is_empty():
		return _send_error(client_id, "Scene path cannot be empty", command_id)
	
	if not path.begins_with("res://"):
		path = "res://" + path
	
	if not FileAccess.file_exists(path):
		return _send_error(client_id, "Scene file not found: " + path, command_id)
	
	# Load the scene to analyze its structure
	var packed_scene = load(path)
	if not packed_scene:
		return _send_error(client_id, "Failed to load scene: " + path, command_id)
	
	# Create a temporary instance to analyze
	var scene_instance = packed_scene.instantiate()
	if not scene_instance:
		return _send_error(client_id, "Failed to instantiate scene: " + path, command_id)
	
	# Get the scene structure
	var structure = _get_node_structure(scene_instance)
	
	# Clean up the temporary instance
	scene_instance.queue_free()
	
	# Return the structure
	_send_success(client_id, {
		"path": path,
		"structure": structure
	}, command_id)

func _get_node_structure(node: Node) -> Dictionary:
	var structure = {
		"name": node.name,
		"type": node.get_class(),
		"path": node.get_path()
	}
	
	# Get script information
	var script = node.get_script()
	if script:
		structure["script"] = script.resource_path
	
	# Get important properties
	var properties = {}
	var property_list = node.get_property_list()
	
	for prop in property_list:
		var name = prop["name"]
		# Filter to include only the most useful properties
		if not name.begins_with("_") and name not in ["script", "children", "position", "rotation", "scale"]:
			continue
		
		# Skip properties that are default values
		if name == "position" and node.position == Vector2():
			continue
		if name == "rotation" and node.rotation == 0:
			continue
		if name == "scale" and node.scale == Vector2(1, 1):
			continue
		
		properties[name] = node.get(name)
	
	structure["properties"] = properties
	
	# Get children
	var children = []
	for child in node.get_children():
		children.append(_get_node_structure(child))
	
	structure["children"] = children
	
	return structure

func _create_scene(client_id: int, params: Dictionary, command_id: String) -> void:
	var path = params.get("path", "")
	var root_node_type = params.get("root_node_type", "Node")
	
	# Validation
	if path.is_empty():
		return _send_error(client_id, "Scene path cannot be empty", command_id)
	
	# Make sure we have an absolute path
	if not path.begins_with("res://"):
		path = "res://" + path
	
	# Ensure path ends with .tscn
	if not path.ends_with(".tscn"):
		path += ".tscn"
	
	# Create directory structure if it doesn't exist
	var dir_path = path.get_base_dir()
	if not DirAccess.dir_exists_absolute(dir_path):
		var dir = DirAccess.open("res://")
		if dir:
			dir.make_dir_recursive(dir_path.trim_prefix("res://"))
	
	# Check if file already exists
	if FileAccess.file_exists(path):
		return _send_error(client_id, "Scene file already exists: %s" % path, command_id)
	
	# Create the root node of the specified type
	var root_node = null
	
	match root_node_type:
		"Node":
			root_node = Node.new()
		"Node2D":
			root_node = Node2D.new()
		"Node3D", "Spatial":
			root_node = Node3D.new()
		"Control":
			root_node = Control.new()
		"CanvasLayer":
			root_node = CanvasLayer.new()
		"Panel":
			root_node = Panel.new()
		_:
			# Attempt to create a custom class if built-in type not recognized
			if ClassDB.class_exists(root_node_type):
				root_node = ClassDB.instantiate(root_node_type)
			else:
				return _send_error(client_id, "Invalid root node type: %s" % root_node_type, command_id)
	
	# Give the root node a name based on the file name
	var file_name = path.get_file().get_basename()
	root_node.name = file_name
	
	# Create a packed scene
	var packed_scene = PackedScene.new()
	var result = packed_scene.pack(root_node)
	if result != OK:
		root_node.free()
		return _send_error(client_id, "Failed to pack scene: %d" % result, command_id)
	
	# Save the packed scene to disk
	result = ResourceSaver.save(packed_scene, path)
	if result != OK:
		root_node.free()
		return _send_error(client_id, "Failed to save scene: %d" % result, command_id)
	
	# Clean up
	root_node.free()
	
	# Try to open the scene in the editor
	var plugin = Engine.get_meta("GodotMCPPlugin") if Engine.has_meta("GodotMCPPlugin") else null
	if plugin and plugin.has_method("get_editor_interface"):
		var editor_interface = plugin.get_editor_interface()
		editor_interface.open_scene_from_path(path)
	
	_send_success(client_id, {
		"scene_path": path,
		"root_node_type": root_node_type
	}, command_id)

func _get_uid(client_id: int, params: Dictionary, command_id: String) -> void:
	var path = params.get("path", "")
	
	if path.is_empty():
		return _send_error(client_id, "File path cannot be empty", command_id)
	
	if not path.begins_with("res://"):
		path = "res://" + path
	
	if not FileAccess.file_exists(path):
		return _send_error(client_id, "File not found: " + path, command_id)
	
	# Try to get UID using ResourceLoader
	var uid = ResourceLoader.get_resource_uid(path)
	
	# If UID is invalid (-1), check if .uid file exists manually as fallback
	if uid == -1:
		var uid_path = path + ".uid"
		if FileAccess.file_exists(uid_path):
			var f = FileAccess.open(uid_path, FileAccess.READ)
			if f:
				var content = f.get_as_text()
				if content.begins_with("uid://"):
					_send_success(client_id, {
						"path": path,
						"uid": content.strip_edges(),
						"method": "file_read"
					}, command_id)
					return
	
	# Convert numeric UID to string format (uid://...) if valid
	if uid != -1:
		var uid_string = ResourceUID.id_to_text(uid)
		_send_success(client_id, {
			"path": path,
			"uid": uid_string,
			"numeric_uid": uid,
			"method": "resource_loader"
		}, command_id)
	else:
		_send_error(client_id, "No UID found for file: " + path, command_id)

func _resave_scene(client_id: int, params: Dictionary, command_id: String) -> void:
	var path = params.get("path", "")
	
	if path.is_empty():
		return _send_error(client_id, "Scene path cannot be empty", command_id)
	
	if not path.begins_with("res://"):
		path = "res://" + path
	
	if not FileAccess.file_exists(path):
		return _send_error(client_id, "Scene file not found: " + path, command_id)
	
	# Load the scene
	var packed_scene = load(path)
	if not packed_scene:
		return _send_error(client_id, "Failed to load scene: " + path, command_id)
	
	# Save it back
	var result = ResourceSaver.save(packed_scene, path)
	if result != OK:
		return _send_error(client_id, "Failed to resave scene: %d" % result, command_id)
	
	# Get the new UID
	var uid = ResourceLoader.get_resource_uid(path)
	var uid_string = ""
	if uid != -1:
		uid_string = ResourceUID.id_to_text(uid)
	
	_send_success(client_id, {
		"path": path,
		"uid": uid_string,
		"status": "resaved"
	}, command_id)

# =============================================================================
# rename_node — Renames a node in the currently edited scene
# =============================================================================
func _rename_node(client_id: int, params: Dictionary, command_id: String) -> void:
	var node_path = params.get("node_path", "")
	var new_name = params.get("new_name", "")

	if node_path.is_empty():
		return _send_error(client_id, "node_path is required", command_id)
	if new_name.is_empty():
		return _send_error(client_id, "new_name is required", command_id)

	var plugin = Engine.get_meta("GodotMCPPlugin")
	if not plugin:
		return _send_error(client_id, "GodotMCPPlugin not found in Engine metadata", command_id)

	var editor_interface = plugin.get_editor_interface()
	var edited_scene_root = editor_interface.get_edited_scene_root()
	if not edited_scene_root:
		return _send_error(client_id, "No scene is currently being edited", command_id)

	# Find the target node
	var node = edited_scene_root.get_node_or_null(node_path)
	if not node:
		return _send_error(client_id, "Node not found: %s" % node_path, command_id)

	var old_name = node.name

	# Use undo/redo if available
	var undo_redo = _get_undo_redo()
	if undo_redo:
		undo_redo.create_action("Rename Node: %s -> %s" % [old_name, new_name])
		undo_redo.add_do_property(node, "name", new_name)
		undo_redo.add_undo_property(node, "name", old_name)
		undo_redo.commit_action()
	else:
		node.name = new_name

	_mark_scene_modified()

	_send_success(client_id, {
		"old_name": old_name,
		"new_name": str(node.name),
		"node_path": str(node.get_path())
	}, command_id)

# =============================================================================
# move_node — Reparents a node to a new parent in the scene tree
# =============================================================================
func _move_node(client_id: int, params: Dictionary, command_id: String) -> void:
	var node_path = params.get("node_path", "")
	var new_parent_path = params.get("new_parent_path", "")
	var sibling_index: int = int(params.get("sibling_index", -1))

	if node_path.is_empty():
		return _send_error(client_id, "node_path is required", command_id)
	if new_parent_path.is_empty():
		return _send_error(client_id, "new_parent_path is required", command_id)

	var plugin = Engine.get_meta("GodotMCPPlugin")
	if not plugin:
		return _send_error(client_id, "GodotMCPPlugin not found in Engine metadata", command_id)

	var editor_interface = plugin.get_editor_interface()
	var edited_scene_root = editor_interface.get_edited_scene_root()
	if not edited_scene_root:
		return _send_error(client_id, "No scene is currently being edited", command_id)

	# Find the node to move
	var node = edited_scene_root.get_node_or_null(node_path)
	if not node:
		return _send_error(client_id, "Node not found: %s" % node_path, command_id)

	# Cannot move the root node
	if node == edited_scene_root:
		return _send_error(client_id, "Cannot move the root node", command_id)

	# Find the new parent
	var new_parent: Node
	if new_parent_path == "." or new_parent_path.is_empty():
		new_parent = edited_scene_root
	else:
		new_parent = edited_scene_root.get_node_or_null(new_parent_path)
	if not new_parent:
		return _send_error(client_id, "New parent not found: %s" % new_parent_path, command_id)

	# Cannot reparent onto itself or a descendant
	if new_parent == node or new_parent.is_ancestor_of(node) == false and node.is_ancestor_of(new_parent):
		return _send_error(client_id, "Cannot move a node into its own descendant", command_id)

	var old_parent = node.get_parent()
	var node_name = node.name

	# Reparent the node
	old_parent.remove_child(node)
	new_parent.add_child(node)
	node.owner = edited_scene_root

	# Set sibling position if specified
	if sibling_index >= 0 and sibling_index < new_parent.get_child_count():
		new_parent.move_child(node, sibling_index)

	# Ensure all descendants keep their owner
	_set_owner_recursive(node, edited_scene_root)

	_mark_scene_modified()

	_send_success(client_id, {
		"node_name": node_name,
		"old_parent": str(old_parent.get_path()),
		"new_parent": str(new_parent.get_path()),
		"new_path": str(node.get_path())
	}, command_id)

func _set_owner_recursive(node: Node, owner: Node) -> void:
	for child in node.get_children():
		child.owner = owner
		_set_owner_recursive(child, owner)

# =============================================================================
# set_collision_shape — Creates and assigns a shape resource to a CollisionShape node
# =============================================================================
func _set_collision_shape(client_id: int, params: Dictionary, command_id: String) -> void:
	var node_path = params.get("node_path", "")
	var shape_type = params.get("shape_type", "")
	var shape_params: Dictionary = params.get("shape_params", {})

	if node_path.is_empty():
		return _send_error(client_id, "node_path is required", command_id)
	if shape_type.is_empty():
		return _send_error(client_id, "shape_type is required (e.g. CircleShape2D, RectangleShape2D, BoxShape3D)", command_id)

	var plugin = Engine.get_meta("GodotMCPPlugin")
	if not plugin:
		return _send_error(client_id, "GodotMCPPlugin not found in Engine metadata", command_id)

	var editor_interface = plugin.get_editor_interface()
	var edited_scene_root = editor_interface.get_edited_scene_root()
	if not edited_scene_root:
		return _send_error(client_id, "No scene is currently being edited", command_id)

	var node = edited_scene_root.get_node_or_null(node_path)
	if not node:
		return _send_error(client_id, "Node not found: %s" % node_path, command_id)

	# Verify the node is a CollisionShape2D or CollisionShape3D
	if not (node is CollisionShape2D or node is CollisionShape3D):
		return _send_error(client_id, "Node must be a CollisionShape2D or CollisionShape3D, got: %s" % node.get_class(), command_id)

	# Create the shape resource
	if not ClassDB.class_exists(shape_type):
		return _send_error(client_id, "Unknown shape type: %s" % shape_type, command_id)

	var shape = ClassDB.instantiate(shape_type)
	if not shape:
		return _send_error(client_id, "Failed to create shape: %s" % shape_type, command_id)

	# Set shape parameters
	if shape_type == "CircleShape2D" or shape_type == "SphereShape3D":
		if shape_params.has("radius"):
			shape.radius = float(shape_params["radius"])
	elif shape_type == "RectangleShape2D":
		if shape_params.has("size"):
			var s = shape_params["size"]
			shape.size = Vector2(float(s.get("x", 64)), float(s.get("y", 64)))
	elif shape_type == "CapsuleShape2D" or shape_type == "CapsuleShape3D":
		if shape_params.has("radius"):
			shape.radius = float(shape_params["radius"])
		if shape_params.has("height"):
			shape.height = float(shape_params["height"])
	elif shape_type == "BoxShape3D":
		if shape_params.has("size"):
			var s = shape_params["size"]
			shape.size = Vector3(float(s.get("x", 1)), float(s.get("y", 1)), float(s.get("z", 1)))
	# For other shapes, try to set params generically
	else:
		for key in shape_params:
			if shape.has_method("set"):
				shape.set(key, shape_params[key])

	# Assign the shape to the node
	node.shape = shape
	_mark_scene_modified()

	_send_success(client_id, {
		"node_path": node_path,
		"shape_type": shape_type,
		"message": "Collision shape %s assigned to %s" % [shape_type, node_path]
	}, command_id)

# =============================================================================
# set_sprite_texture — Assigns a texture to a Sprite2D/3D/TextureRect node
# =============================================================================
func _set_sprite_texture(client_id: int, params: Dictionary, command_id: String) -> void:
	var node_path = params.get("node_path", "")
	var texture_type = params.get("texture_type", "ImageTexture")
	var texture_params: Dictionary = params.get("texture_params", {})

	if node_path.is_empty():
		return _send_error(client_id, "node_path is required", command_id)

	var plugin = Engine.get_meta("GodotMCPPlugin")
	if not plugin:
		return _send_error(client_id, "GodotMCPPlugin not found in Engine metadata", command_id)

	var editor_interface = plugin.get_editor_interface()
	var edited_scene_root = editor_interface.get_edited_scene_root()
	if not edited_scene_root:
		return _send_error(client_id, "No scene is currently being edited", command_id)

	var node = edited_scene_root.get_node_or_null(node_path)
	if not node:
		return _send_error(client_id, "Node not found: %s" % node_path, command_id)

	# Verify the node can accept a texture
	if not (node is Sprite2D or node is Sprite3D or node is TextureRect):
		return _send_error(client_id, "Node must be Sprite2D, Sprite3D, or TextureRect, got: %s" % node.get_class(), command_id)

	var texture = null

	match texture_type:
		"ImageTexture":
			var image_path = str(texture_params.get("path", ""))
			if image_path.is_empty():
				return _send_error(client_id, "texture_params.path is required for ImageTexture", command_id)
			if not image_path.begins_with("res://"):
				image_path = "res://" + image_path
			texture = load(image_path)
			if not texture:
				return _send_error(client_id, "Failed to load texture: %s" % image_path, command_id)

		"PlaceholderTexture2D":
			texture = PlaceholderTexture2D.new()
			if texture_params.has("size"):
				var s = texture_params["size"]
				texture.size = Vector2(float(s.get("x", 64)), float(s.get("y", 64)))

		"GradientTexture2D":
			texture = GradientTexture2D.new()
			var gradient = Gradient.new()
			texture.gradient = gradient
			if texture_params.has("width"):
				texture.width = int(texture_params["width"])
			if texture_params.has("height"):
				texture.height = int(texture_params["height"])

		"NoiseTexture2D":
			texture = NoiseTexture2D.new()
			texture.noise = FastNoiseLite.new()
			if texture_params.has("width"):
				texture.width = int(texture_params["width"])
			if texture_params.has("height"):
				texture.height = int(texture_params["height"])

		_:
			return _send_error(client_id, "Unknown texture_type: %s. Supported: ImageTexture, PlaceholderTexture2D, GradientTexture2D, NoiseTexture2D" % texture_type, command_id)

	# Assign the texture
	node.texture = texture
	_mark_scene_modified()

	_send_success(client_id, {
		"node_path": node_path,
		"texture_type": texture_type,
		"message": "%s texture assigned to %s" % [texture_type, node_path]
	}, command_id)
