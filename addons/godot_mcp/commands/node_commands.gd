@tool
class_name MCPNodeCommands
extends MCPBaseCommandProcessor

func process_command(client_id: int, command_type: String, params: Dictionary, command_id: String) -> bool:
	match command_type:
		"create_node":
			_create_node(client_id, params, command_id)
			return true
		"delete_node":
			_delete_node(client_id, params, command_id)
			return true
		"update_node_property":
			_update_node_property(client_id, params, command_id)
			return true
		"get_node_properties":
			_get_node_properties(client_id, params, command_id)
			return true
		"list_nodes":
			_list_nodes(client_id, params, command_id)
			return true
		"query_node":
			_query_node(client_id, params, command_id)
			return true
		"load_sprite":
			_load_sprite(client_id, params, command_id)
			return true
	return false  # Command not handled

func _create_node(client_id: int, params: Dictionary, command_id: String) -> void:
	var parent_path = params.get("parent_path", "/root")
	var node_type = params.get("node_type", "Node")
	var node_name = params.get("node_name", "NewNode")
	
	# Validation
	if not ClassDB.class_exists(node_type):
		return _send_error(client_id, "Invalid node type: %s" % node_type, command_id)
	
	# Get editor plugin and interfaces
	var plugin = Engine.get_meta("GodotMCPPlugin")
	if not plugin:
		return _send_error(client_id, "GodotMCPPlugin not found in Engine metadata", command_id)
	
	var editor_interface = plugin.get_editor_interface()
	var edited_scene_root = editor_interface.get_edited_scene_root()
	
	if not edited_scene_root:
		return _send_error(client_id, "No scene is currently being edited", command_id)
	
	# Get the parent node using the editor node helper
	var parent = _get_editor_node(parent_path)
	if not parent:
		return _send_error(client_id, "Parent node not found: %s" % parent_path, command_id)
		
	# Check if we should intercept via the Visual Diff UI (only in review_mode)
	var in_review_mode = _websocket_server and _websocket_server.get("review_mode") == true
	if in_review_mode and _websocket_server.get("diff_panel") != null:
		var diff_panel = _websocket_server.diff_panel
		var display_text = "[b]Proposed Node Creation:[/b]\n"
		display_text += "Action: Add node of type [color=yellow]" + node_type + "[/color] named [color=green]" + node_name + "[/color]\n"
		display_text += "Parent: [u]" + parent_path + "[/u]\n"
		
		if not diff_panel.proposal_accepted.is_connected(_on_create_node_accepted):
			diff_panel.proposal_accepted.connect(_on_create_node_accepted)
		if not diff_panel.proposal_rejected.is_connected(_on_create_node_rejected):
			diff_panel.proposal_rejected.connect(_on_create_node_rejected)
			
		set_meta("pending_create_node_" + command_id, {
			"client_id": client_id,
			"parent_path": parent_path,
			"node_type": node_type,
			"node_name": node_name,
			"parent": parent,
			"edited_scene_root": edited_scene_root
		})
		
		# Send immediate pending ack BEFORE showing the panel.
		# This guarantees the MCP client gets a response even if display_proposal fails.
		_send_success(client_id, {
			"status": "pending_review",
			"message": "Node creation pending user approval in Godot editor diff panel.",
			"node_type": node_type,
			"node_name": node_name,
			"parent_path": parent_path
		}, command_id)
		
		# Show the proposal in the editor UI (best-effort)
		diff_panel.display_proposal(command_id, display_text)
		return
		
	_execute_create_node(client_id, parent_path, node_type, node_name, parent, edited_scene_root, command_id)

func _on_create_node_accepted(proposal_id: String) -> void:
	if has_meta("pending_create_node_" + proposal_id):
		var args = get_meta("pending_create_node_" + proposal_id)
		remove_meta("pending_create_node_" + proposal_id)
		_execute_create_node(args["client_id"], args["parent_path"], args["node_type"], args["node_name"], args["parent"], args["edited_scene_root"], proposal_id)

func _on_create_node_rejected(proposal_id: String) -> void:
	if has_meta("pending_create_node_" + proposal_id):
		var args = get_meta("pending_create_node_" + proposal_id)
		remove_meta("pending_create_node_" + proposal_id)
		_send_error(args["client_id"], "User rejected the proposed node creation.", proposal_id)

func _execute_create_node(client_id: int, parent_path: String, node_type: String, node_name: String, parent: Node, edited_scene_root: Node, command_id: String) -> void:
	# Create the node
	var node
	if ClassDB.can_instantiate(node_type):
		node = ClassDB.instantiate(node_type)
	else:
		return _send_error(client_id, "Cannot instantiate node of type: %s" % node_type, command_id)
	
	if not node:
		return _send_error(client_id, "Failed to create node of type: %s" % node_type, command_id)
	
	# Set the node name
	node.name = node_name
	
	# Add the node to the parent
	parent.add_child(node)
	
	# Set owner for proper serialization
	node.owner = edited_scene_root
	
	# Mark the scene as modified
	_mark_scene_modified()
	
	_send_success(client_id, {
		"node_path": parent_path + "/" + node_name
	}, command_id)

func _delete_node(client_id: int, params: Dictionary, command_id: String) -> void:
	var node_path = params.get("node_path", "")
	
	# Validation
	if node_path.is_empty():
		return _send_error(client_id, "Node path cannot be empty", command_id)
	
	# Get editor plugin and interfaces
	var plugin = Engine.get_meta("GodotMCPPlugin")
	if not plugin:
		return _send_error(client_id, "GodotMCPPlugin not found in Engine metadata", command_id)
	
	var editor_interface = plugin.get_editor_interface()
	var edited_scene_root = editor_interface.get_edited_scene_root()
	
	if not edited_scene_root:
		return _send_error(client_id, "No scene is currently being edited", command_id)
	
	# Get the node using the editor node helper
	var node = _get_editor_node(node_path)
	if not node:
		return _send_error(client_id, "Node not found: %s" % node_path, command_id)
	
	# Cannot delete the root node
	if node == edited_scene_root:
		return _send_error(client_id, "Cannot delete the root node", command_id)
	
	# Get parent for operation
	var parent = node.get_parent()
	if not parent:
		return _send_error(client_id, "Node has no parent: %s" % node_path, command_id)
	
	# Remove the node
	parent.remove_child(node)
	node.queue_free()
	
	# Mark the scene as modified
	_mark_scene_modified()
	
	_send_success(client_id, {
		"deleted_node_path": node_path
	}, command_id)

func _update_node_property(client_id: int, params: Dictionary, command_id: String) -> void:
	var node_path = params.get("node_path", "")
	var property_name = params.get("property", "")
	var property_value = params.get("value")
	
	# Validation
	if node_path.is_empty():
		return _send_error(client_id, "Node path cannot be empty", command_id)
	
	if property_name.is_empty():
		return _send_error(client_id, "Property name cannot be empty", command_id)
	
	if property_value == null:
		return _send_error(client_id, "Property value cannot be null", command_id)
	
	# Get editor plugin and interfaces
	var plugin = Engine.get_meta("GodotMCPPlugin")
	if not plugin:
		return _send_error(client_id, "GodotMCPPlugin not found in Engine metadata", command_id)
	
	# Get the node using the editor node helper
	var node = _get_editor_node(node_path)
	if not node:
		return _send_error(client_id, "Node not found: %s" % node_path, command_id)
	
	# Check if the property exists
	if not property_name in node:
		return _send_error(client_id, "Property %s does not exist on node %s" % [property_name, node_path], command_id)
	
	# Parse property value for Godot types
	var parsed_value = _parse_property_value(property_value)
	
	# Convert value to match the expected property type (e.g. Dict → Vector2)
	parsed_value = _convert_value_to_property_type(node, property_name, parsed_value)
	
	print("[MCP] update_property: node=%s property=%s" % [node_path, property_name])
	print("[MCP]   raw value: %s (type: %s)" % [str(property_value), type_string(typeof(property_value))])
	print("[MCP]   parsed value: %s (type: %s)" % [str(parsed_value), type_string(typeof(parsed_value))])
	
	# Get current property value for undo
	var old_value = node.get(property_name)
	print("[MCP]   old value: %s (type: %s)" % [str(old_value), type_string(typeof(old_value))])
	
	# Always set the property directly first to ensure it's applied immediately.
	# This is the belt-and-suspenders approach — direct set guarantees the in-memory
	# node has the correct value, while undo/redo provides editor integration.
	node.set(property_name, parsed_value)
	
	# Also register with undo/redo system for editor integration
	var undo_redo = _get_undo_redo()
	if undo_redo:
		undo_redo.create_action("Update Property: " + property_name)
		undo_redo.add_do_property(node, property_name, parsed_value)
		undo_redo.add_undo_property(node, property_name, old_value)
		undo_redo.commit_action()
	
	# Verify the property was actually set by reading it back
	var verify_value = node.get(property_name)
	print("[MCP]   verified value: %s (type: %s)" % [str(verify_value), type_string(typeof(verify_value))])
	
	var property_set_ok = str(verify_value) == str(parsed_value)
	if not property_set_ok:
		print("[MCP]   WARNING: Property value mismatch after set!")
		print("[MCP]     expected: %s (%s)" % [str(parsed_value), type_string(typeof(parsed_value))])
		print("[MCP]     actual:   %s (%s)" % [str(verify_value), type_string(typeof(verify_value))])
	
	# Mark the scene as modified
	_mark_scene_modified()
	
	# Notify the editor that the property has changed so it updates the inspector
	node.notify_property_list_changed()
	
	_send_success(client_id, {
		"node_path": node_path,
		"property": property_name,
		"value": property_value,
		"parsed_value": str(parsed_value),
		"parsed_type": type_string(typeof(parsed_value)),
		"verified_value": str(verify_value),
		"verified_type": type_string(typeof(verify_value)),
		"property_set_ok": property_set_ok
	}, command_id)

func _get_node_properties(client_id: int, params: Dictionary, command_id: String) -> void:
	var node_path = params.get("node_path", "")
	
	# Validation
	if node_path.is_empty():
		return _send_error(client_id, "Node path cannot be empty", command_id)
	
	# Get the node using the editor node helper
	var node = _get_editor_node(node_path)
	if not node:
		return _send_error(client_id, "Node not found: %s" % node_path, command_id)
	
	# Get all properties
	var properties = {}
	var property_list = node.get_property_list()
	
	for prop in property_list:
		var name = prop["name"]
		if not name.begins_with("_"):  # Skip internal properties
			properties[name] = node.get(name)
	
	_send_success(client_id, {
		"node_path": node_path,
		"properties": properties
	}, command_id)

func _list_nodes(client_id: int, params: Dictionary, command_id: String) -> void:
	var parent_path = params.get("parent_path", "/root")
	
	# Get the parent node using the editor node helper
	var parent = _get_editor_node(parent_path)
	if not parent:
		return _send_error(client_id, "Parent node not found: %s" % parent_path, command_id)
	
	# Get children
	var children = []
	for child in parent.get_children():
		children.append({
			"name": child.name,
			"type": child.get_class(),
			"path": str(child.get_path()).replace(str(parent.get_path()), parent_path)
		})
	
	_send_success(client_id, {
		"parent_path": parent_path,
		"children": children
	}, command_id)

func _query_node(client_id: int, params: Dictionary, command_id: String) -> void:
	var node_path = params.get("node_path", "")
	
	# Validation
	if node_path.is_empty():
		return _send_error(client_id, "Node path cannot be empty", command_id)
	
	# Get the node using the editor node helper
	var node = _get_editor_node(node_path)
	if not node:
		return _send_error(client_id, "Node not found: %s" % node_path, command_id)
	
	# Build comprehensive node info
	var node_info = {
		"name": node.name,
		"type": node.get_class(),
		"path": str(node.get_path()),
		"children": [],
		"properties": {},
		"signals": [],
		"methods": [],
		"script": ""
	}
	
	# Get children (1-level deep)
	for child in node.get_children():
		node_info["children"].append({
			"name": child.name,
			"type": child.get_class()
		})
	
	# Get type-specific properties
	var property_names: Array[String] = ["visible", "process_mode"]
	
	if node is Node2D:
		property_names.append_array(["position", "rotation", "scale", "global_position", "z_index"])
	elif node is Node3D:
		property_names.append_array(["position", "rotation", "scale", "global_position", "transform"])
	elif node is Control:
		property_names.append_array(["position", "size", "anchor_left", "anchor_top", "anchor_right", "anchor_bottom"])
	
	if node is Sprite2D or node is Sprite3D:
		property_names.append_array(["texture", "centered", "offset", "flip_h", "flip_v"])
	if node is RigidBody2D or node is RigidBody3D:
		property_names.append_array(["mass", "gravity_scale", "linear_velocity", "angular_velocity"])
	if node is CharacterBody2D or node is CharacterBody3D:
		property_names.append_array(["velocity", "motion_mode"])
	
	# Read property values with safe serialization
	for prop_name in property_names:
		if prop_name in node:
			var value = node.get(prop_name)
			if value is Vector2:
				node_info["properties"][prop_name] = {"x": value.x, "y": value.y}
			elif value is Vector3:
				node_info["properties"][prop_name] = {"x": value.x, "y": value.y, "z": value.z}
			elif value is Color:
				node_info["properties"][prop_name] = {"r": value.r, "g": value.g, "b": value.b, "a": value.a}
			elif value is Transform2D:
				node_info["properties"][prop_name] = {
					"origin": {"x": value.origin.x, "y": value.origin.y},
					"rotation": value.get_rotation(),
					"scale": {"x": value.get_scale().x, "y": value.get_scale().y}
				}
			elif value is Transform3D:
				node_info["properties"][prop_name] = {
					"origin": {"x": value.origin.x, "y": value.origin.y, "z": value.origin.z}
				}
			elif value is Resource:
				node_info["properties"][prop_name] = value.resource_path if value.resource_path != "" else "<embedded>"
			elif value == null:
				node_info["properties"][prop_name] = null
			else:
				node_info["properties"][prop_name] = value
	
	# Get signals
	var signal_list = node.get_signal_list()
	for sig in signal_list:
		var sig_data = {"name": sig.name, "parameters": []}
		if sig.has("args"):
			for arg in sig.args:
				sig_data["parameters"].append({"name": arg.name, "type": arg.type})
		node_info["signals"].append(sig_data)
	
	# Get non-internal methods
	var method_list = node.get_method_list()
	for method in method_list:
		var method_name = method.name
		if not method_name.begins_with("_") and not method_name in ["get", "set", "get_class", "is_class"]:
			var method_data = {"name": method_name, "parameters": []}
			if method.has("args"):
				for arg in method.args:
					method_data["parameters"].append({"name": arg.name, "type": arg.type})
			node_info["methods"].append(method_data)
	
	# Check for attached script
	if node.get_script():
		var script = node.get_script()
		node_info["script"] = script.resource_path if script.resource_path != "" else "<embedded>"
	
	_send_success(client_id, node_info, command_id)


func _load_sprite(client_id: int, params: Dictionary, command_id: String) -> void:
	var node_path = params.get("node_path", "")
	var texture_path = params.get("texture_path", "")
	
	# Validation
	if node_path.is_empty():
		return _send_error(client_id, "node_path cannot be empty", command_id)
	if texture_path.is_empty():
		return _send_error(client_id, "texture_path cannot be empty", command_id)
	
	# Ensure res:// prefix
	if not texture_path.begins_with("res://"):
		texture_path = "res://" + texture_path
	
	# Get the sprite node from the edited scene
	var node = _get_editor_node(node_path)
	if not node:
		return _send_error(client_id, "Node not found: %s" % node_path, command_id)
	
	# Verify the node is a sprite-compatible type
	if not (node is Sprite2D or node is Sprite3D or node is TextureRect):
		return _send_error(client_id, "Node '%s' is not a sprite-compatible type (is %s). Expected Sprite2D, Sprite3D, or TextureRect." % [node_path, node.get_class()], command_id)
	
	# Check if the texture file exists
	if not ResourceLoader.exists(texture_path):
		return _send_error(client_id, "Texture file not found: %s. Make sure the file exists in the project and Godot has imported it (check the FileSystem dock)." % texture_path, command_id)
	
	# Load the texture via the editor (which has imported resources available)
	var texture = load(texture_path)
	if not texture:
		return _send_error(client_id, "Failed to load texture: %s. The file exists but could not be loaded as a texture." % texture_path, command_id)
	
	if not texture is Texture2D:
		return _send_error(client_id, "Resource at '%s' is not a Texture2D (is %s)" % [texture_path, texture.get_class()], command_id)
	
	# Set the texture
	node.texture = texture
	
	# Mark scene as modified
	_mark_scene_modified()
	
	_send_success(client_id, {
		"node_path": node_path,
		"texture_path": texture_path,
		"node_type": node.get_class()
	}, command_id)
