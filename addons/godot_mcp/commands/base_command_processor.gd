@tool
class_name MCPBaseCommandProcessor
extends Node

# Signal emitted when a command has completed processing
signal command_completed(client_id, command_type, result, command_id)

# Reference to the server - passed by the command handler
var _websocket_server = null

# Must be implemented by subclasses
func process_command(client_id: int, command_type: String, params: Dictionary, command_id: String) -> bool:
	push_error("BaseCommandProcessor.process_command called directly")
	return false

# Helper functions common to all command processors
func _send_success(client_id: int, result: Dictionary, command_id: String) -> void:
	var response = {
		"status": "success",
		"result": result
	}
	
	if not command_id.is_empty():
		response["commandId"] = command_id
	
	# Emit the signal for local processing (useful for testing)
	command_completed.emit(client_id, "success", result, command_id)
	
	# Send to websocket if available
	if _websocket_server:
		_websocket_server.send_response(client_id, response)

func _send_error(client_id: int, message: String, command_id: String) -> void:
	var response = {
		"status": "error",
		"message": message
	}
	
	if not command_id.is_empty():
		response["commandId"] = command_id
	
	# Emit the signal for local processing (useful for testing)
	var error_result = {"error": message}
	command_completed.emit(client_id, "error", error_result, command_id)
	
	# Send to websocket if available
	if _websocket_server:
		_websocket_server.send_response(client_id, response)
	print("Error: %s" % message)

# Common utility methods
func _get_editor_node(path: String) -> Node:
	var plugin = Engine.get_meta("GodotMCPPlugin")
	if not plugin:
		print("GodotMCPPlugin not found in Engine metadata")
		return null
		
	var editor_interface = plugin.get_editor_interface()
	var edited_scene_root = editor_interface.get_edited_scene_root()
	
	if not edited_scene_root:
		print("No edited scene found")
		return null
		
	# Handle explicit root references
	if path == "/root" or path == "" or path == ".":
		return edited_scene_root
	
	# Strip /root/ prefix if present
	var resolved_path = path
	if resolved_path.begins_with("/root/"):
		resolved_path = resolved_path.substr(6)  # Remove "/root/"
	elif resolved_path.begins_with("/"):
		resolved_path = resolved_path.substr(1)  # Remove leading "/"
	
	# If the path is empty after stripping, it's the root
	if resolved_path.is_empty():
		return edited_scene_root
	
	var root_name = edited_scene_root.name
	
	# If the path IS the root node's name, return the root
	if resolved_path == root_name:
		return edited_scene_root
	
	# If the path starts with the root node's name + "/", strip it and find the child
	# e.g. "dungeon_level/Enemies" → find "Enemies" under the root
	if resolved_path.begins_with(root_name + "/"):
		var child_path = resolved_path.substr(root_name.length() + 1)
		return edited_scene_root.get_node_or_null(child_path)
	
	# Otherwise, try to find as a direct child path
	# e.g. "Enemies" → find "Enemies" under the root
	return edited_scene_root.get_node_or_null(resolved_path)

# Helper function to mark a scene as modified
func _mark_scene_modified() -> void:
	var plugin = Engine.get_meta("GodotMCPPlugin")
	if not plugin:
		print("GodotMCPPlugin not found in Engine metadata")
		return
	
	var editor_interface = plugin.get_editor_interface()
	var edited_scene_root = editor_interface.get_edited_scene_root()
	
	if edited_scene_root:
		# This internally marks the scene as modified in the editor
		editor_interface.mark_scene_as_unsaved()

# Helper function to access the EditorUndoRedoManager
func _get_undo_redo():
	var plugin = Engine.get_meta("GodotMCPPlugin")
	if not plugin or not plugin.has_method("get_undo_redo"):
		print("Cannot access UndoRedo from plugin")
		return null
		
	return plugin.get_undo_redo()

# Helper function to parse property values from string/dict to proper Godot types
func _parse_property_value(value):
	# Handle Dictionary → Godot type conversion (from JSON deserialization)
	if typeof(value) == TYPE_DICTIONARY:
		var dict = value as Dictionary
		# Vector2: {"x": ..., "y": ...}
		if dict.size() == 2 and dict.has("x") and dict.has("y"):
			return Vector2(float(dict["x"]), float(dict["y"]))
		# Vector3: {"x": ..., "y": ..., "z": ...}
		if dict.size() == 3 and dict.has("x") and dict.has("y") and dict.has("z"):
			return Vector3(float(dict["x"]), float(dict["y"]), float(dict["z"]))
		# Vector4: {"x": ..., "y": ..., "z": ..., "w": ...}
		if dict.size() == 4 and dict.has("x") and dict.has("y") and dict.has("z") and dict.has("w"):
			return Vector4(float(dict["x"]), float(dict["y"]), float(dict["z"]), float(dict["w"]))
		# Color: {"r": ..., "g": ..., "b": ...} or {"r": ..., "g": ..., "b": ..., "a": ...}
		if dict.has("r") and dict.has("g") and dict.has("b"):
			var a = float(dict.get("a", 1.0))
			return Color(float(dict["r"]), float(dict["g"]), float(dict["b"]), a)
		# Rect2: {"position": {"x": ..., "y": ...}, "size": {"x": ..., "y": ...}}
		if dict.has("position") and dict.has("size") and typeof(dict["position"]) == TYPE_DICTIONARY and typeof(dict["size"]) == TYPE_DICTIONARY:
			var pos = dict["position"]
			var sz = dict["size"]
			if pos.has("x") and pos.has("y") and sz.has("x") and sz.has("y"):
				return Rect2(Vector2(float(pos["x"]), float(pos["y"])), Vector2(float(sz["x"]), float(sz["y"])))
		# Return as-is for unrecognized dict shapes
		return value
	
	# Handle Array → Godot packed array types
	if typeof(value) == TYPE_ARRAY:
		var arr = value as Array
		if arr.size() > 0:
			# Array of dicts with x/y → could be PackedVector2Array
			if typeof(arr[0]) == TYPE_DICTIONARY and arr[0].has("x") and arr[0].has("y"):
				if arr[0].has("z"):
					var packed := PackedVector3Array()
					for item in arr:
						packed.append(Vector3(float(item["x"]), float(item["y"]), float(item["z"])))
					return packed
				else:
					var packed := PackedVector2Array()
					for item in arr:
						packed.append(Vector2(float(item["x"]), float(item["y"])))
					return packed
			# Array of dicts with r/g/b → PackedColorArray
			if typeof(arr[0]) == TYPE_DICTIONARY and arr[0].has("r") and arr[0].has("g") and arr[0].has("b"):
				var packed := PackedColorArray()
				for item in arr:
					packed.append(Color(float(item["r"]), float(item["g"]), float(item["b"]), float(item.get("a", 1.0))))
				return packed
		return value
	
	# Handle string-encoded Godot types (e.g. "Vector2(100, 200)")
	if typeof(value) == TYPE_STRING and (
		value.begins_with("Vector") or 
		value.begins_with("Transform") or 
		value.begins_with("Rect") or 
		value.begins_with("Color") or
		value.begins_with("Quat") or
		value.begins_with("Basis") or
		value.begins_with("Plane") or
		value.begins_with("AABB") or
		value.begins_with("Projection") or
		value.begins_with("Callable") or
		value.begins_with("Signal") or
		value.begins_with("PackedVector") or
		value.begins_with("PackedString") or
		value.begins_with("PackedFloat") or
		value.begins_with("PackedInt") or
		value.begins_with("PackedColor") or
		value.begins_with("PackedByteArray") or
		value.begins_with("Dictionary") or
		value.begins_with("Array")
	):
		var expression = Expression.new()
		var error = expression.parse(value, [])
		
		if error == OK:
			var result = expression.execute([], null, true)
			if not expression.has_execute_failed():
				print("Successfully parsed %s as %s" % [value, result])
				return result
			else:
				print("Failed to execute expression for: %s" % value)
		else:
			print("Failed to parse expression: %s (Error: %d)" % [value, error])
	
	# Otherwise, return value as is
	return value

# Helper to convert a value to match the expected property type on a node.
# Uses property introspection to look up the Variant.Type the node expects.
func _convert_value_to_property_type(node: Node, property_name: String, value):
	# Look up the expected type from the node's property list
	var expected_type := -1
	for prop in node.get_property_list():
		if prop["name"] == property_name:
			expected_type = prop["type"]
			break
	
	if expected_type == -1:
		# Property not found in list; return as-is
		return value
	
	var current_type := typeof(value)
	
	# If it already matches, return as-is
	if current_type == expected_type:
		return value
	
	# Convert based on expected type
	match expected_type:
		TYPE_VECTOR2:
			if current_type == TYPE_DICTIONARY:
				return Vector2(float(value.get("x", 0)), float(value.get("y", 0)))
			if current_type == TYPE_ARRAY and value.size() >= 2:
				return Vector2(float(value[0]), float(value[1]))
		TYPE_VECTOR2I:
			if current_type == TYPE_DICTIONARY:
				return Vector2i(int(value.get("x", 0)), int(value.get("y", 0)))
			if current_type == TYPE_ARRAY and value.size() >= 2:
				return Vector2i(int(value[0]), int(value[1]))
		TYPE_VECTOR3:
			if current_type == TYPE_DICTIONARY:
				return Vector3(float(value.get("x", 0)), float(value.get("y", 0)), float(value.get("z", 0)))
			if current_type == TYPE_ARRAY and value.size() >= 3:
				return Vector3(float(value[0]), float(value[1]), float(value[2]))
		TYPE_VECTOR3I:
			if current_type == TYPE_DICTIONARY:
				return Vector3i(int(value.get("x", 0)), int(value.get("y", 0)), int(value.get("z", 0)))
			if current_type == TYPE_ARRAY and value.size() >= 3:
				return Vector3i(int(value[0]), int(value[1]), int(value[2]))
		TYPE_VECTOR4:
			if current_type == TYPE_DICTIONARY:
				return Vector4(float(value.get("x", 0)), float(value.get("y", 0)), float(value.get("z", 0)), float(value.get("w", 0)))
		TYPE_COLOR:
			if current_type == TYPE_DICTIONARY:
				return Color(float(value.get("r", 0)), float(value.get("g", 0)), float(value.get("b", 0)), float(value.get("a", 1.0)))
			if current_type == TYPE_STRING:
				return Color(value)
		TYPE_RECT2:
			if current_type == TYPE_DICTIONARY:
				var pos = value.get("position", {"x": 0, "y": 0})
				var sz = value.get("size", {"x": 0, "y": 0})
				return Rect2(Vector2(float(pos.get("x", 0)), float(pos.get("y", 0))), Vector2(float(sz.get("x", 0)), float(sz.get("y", 0))))
		TYPE_FLOAT:
			return float(value)
		TYPE_INT:
			return int(value)
		TYPE_BOOL:
			if current_type == TYPE_STRING:
				return value.to_lower() == "true" or value == "1"
			return bool(value)
		TYPE_STRING:
			return str(value)
	
	# Fallback: return as-is
	return value
