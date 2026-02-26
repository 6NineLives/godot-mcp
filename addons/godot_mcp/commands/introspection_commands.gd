@tool
class_name MCPIntrospectionCommands
extends MCPBaseCommandProcessor

func process_command(client_id: int, command_type: String, params: Dictionary, command_id: String) -> bool:
	match command_type:
		"get_input_map":
			_get_input_map(client_id, params, command_id)
			return true
		"get_collision_layers":
			_get_collision_layers(client_id, params, command_id)
			return true
		"get_node_type_properties":
			_get_node_type_properties(client_id, params, command_id)
			return true
		"get_console_log":
			_get_console_log(client_id, params, command_id)
			return true
		"get_errors":
			_get_errors(client_id, params, command_id)
			return true
		"clear_console_log":
			_clear_console_log(client_id, params, command_id)
			return true
		"open_in_editor":
			_open_in_editor(client_id, params, command_id)
			return true
	return false  # Command not handled

# =============================================================================
# get_input_map — Returns all InputMap actions and their event bindings
# =============================================================================
func _get_input_map(client_id: int, _params: Dictionary, command_id: String) -> void:
	var actions: Array = []

	for action_name in InputMap.get_actions():
		# Skip built-in UI actions unless specifically requested
		if str(action_name).begins_with("ui_"):
			continue

		var events: Array = []
		for event in InputMap.action_get_events(action_name):
			var event_info: Dictionary = {"type": event.get_class()}

			if event is InputEventKey:
				event_info["key"] = OS.get_keycode_string(event.keycode) if event.keycode != 0 else OS.get_keycode_string(event.physical_keycode)
				event_info["shift"] = event.shift_pressed
				event_info["ctrl"] = event.ctrl_pressed
				event_info["alt"] = event.alt_pressed
			elif event is InputEventMouseButton:
				event_info["button_index"] = event.button_index
			elif event is InputEventJoypadButton:
				event_info["button_index"] = event.button_index
			elif event is InputEventJoypadMotion:
				event_info["axis"] = event.axis
				event_info["axis_value"] = event.axis_value

			events.append(event_info)

		actions.append({
			"name": str(action_name),
			"deadzone": InputMap.action_get_deadzone(action_name),
			"events": events
		})

	_send_success(client_id, {
		"actions": actions,
		"count": actions.size()
	}, command_id)

# =============================================================================
# get_collision_layers — Returns named collision layer info from ProjectSettings
# =============================================================================
func _get_collision_layers(client_id: int, _params: Dictionary, command_id: String) -> void:
	var layers_2d: Array = []
	var layers_3d: Array = []

	# Read 2D physics layer names (up to 32 layers)
	for i in range(1, 33):
		var setting_path = "layer_names/2d_physics/layer_%d" % i
		var layer_name = ""
		if ProjectSettings.has_setting(setting_path):
			layer_name = str(ProjectSettings.get_setting(setting_path))
		layers_2d.append({
			"layer": i,
			"name": layer_name if not layer_name.is_empty() else "Layer %d" % i,
			"has_custom_name": not layer_name.is_empty()
		})

	# Read 3D physics layer names (up to 32 layers)
	for i in range(1, 33):
		var setting_path = "layer_names/3d_physics/layer_%d" % i
		var layer_name = ""
		if ProjectSettings.has_setting(setting_path):
			layer_name = str(ProjectSettings.get_setting(setting_path))
		layers_3d.append({
			"layer": i,
			"name": layer_name if not layer_name.is_empty() else "Layer %d" % i,
			"has_custom_name": not layer_name.is_empty()
		})

	_send_success(client_id, {
		"physics_2d": layers_2d,
		"physics_3d": layers_3d
	}, command_id)

# =============================================================================
# get_node_type_properties — ClassDB-based property discovery for any node type
# =============================================================================
func _get_node_type_properties(client_id: int, params: Dictionary, command_id: String) -> void:
	var node_type = params.get("node_type", "")
	if node_type.is_empty():
		return _send_error(client_id, "node_type is required (e.g. 'CharacterBody2D')", command_id)

	if not ClassDB.class_exists(node_type):
		return _send_error(client_id, "Class does not exist: %s" % node_type, command_id)

	# Get property list from ClassDB
	var property_list = ClassDB.class_get_property_list(node_type, true)  # true = no inheritance
	var properties: Array = []

	for prop in property_list:
		var prop_name = prop.get("name", "")
		if prop_name.is_empty() or prop_name.begins_with("_"):
			continue

		properties.append({
			"name": prop_name,
			"type": _type_to_string(prop.get("type", 0)),
			"type_id": prop.get("type", 0),
			"hint": prop.get("hint", 0),
			"hint_string": prop.get("hint_string", ""),
			"usage": prop.get("usage", 0)
		})

	# Get inheritance chain
	var inheritance: Array = []
	var current_class = node_type
	while not current_class.is_empty():
		inheritance.append(current_class)
		current_class = ClassDB.get_parent_class(current_class)

	# Get method list
	var methods: Array = []
	var method_list = ClassDB.class_get_method_list(node_type, true)
	for method in method_list:
		var method_name = method.get("name", "")
		if method_name.is_empty() or method_name.begins_with("_"):
			continue
		methods.append(method_name)

	# Get signal list
	var signals: Array = []
	var signal_list = ClassDB.class_get_signal_list(node_type, true)
	for sig in signal_list:
		signals.append(sig.get("name", ""))

	_send_success(client_id, {
		"class_name": node_type,
		"inheritance": inheritance,
		"properties": properties,
		"methods": methods,
		"signals": signals,
		"property_count": properties.size(),
		"method_count": methods.size(),
		"signal_count": signals.size()
	}, command_id)

func _type_to_string(type_id: int) -> String:
	match type_id:
		TYPE_NIL: return "nil"
		TYPE_BOOL: return "bool"
		TYPE_INT: return "int"
		TYPE_FLOAT: return "float"
		TYPE_STRING: return "String"
		TYPE_VECTOR2: return "Vector2"
		TYPE_VECTOR2I: return "Vector2i"
		TYPE_RECT2: return "Rect2"
		TYPE_VECTOR3: return "Vector3"
		TYPE_VECTOR3I: return "Vector3i"
		TYPE_TRANSFORM2D: return "Transform2D"
		TYPE_VECTOR4: return "Vector4"
		TYPE_PLANE: return "Plane"
		TYPE_QUATERNION: return "Quaternion"
		TYPE_AABB: return "AABB"
		TYPE_BASIS: return "Basis"
		TYPE_TRANSFORM3D: return "Transform3D"
		TYPE_PROJECTION: return "Projection"
		TYPE_COLOR: return "Color"
		TYPE_STRING_NAME: return "StringName"
		TYPE_NODE_PATH: return "NodePath"
		TYPE_RID: return "RID"
		TYPE_OBJECT: return "Object"
		TYPE_CALLABLE: return "Callable"
		TYPE_SIGNAL: return "Signal"
		TYPE_DICTIONARY: return "Dictionary"
		TYPE_ARRAY: return "Array"
		TYPE_PACKED_BYTE_ARRAY: return "PackedByteArray"
		TYPE_PACKED_INT32_ARRAY: return "PackedInt32Array"
		TYPE_PACKED_INT64_ARRAY: return "PackedInt64Array"
		TYPE_PACKED_FLOAT32_ARRAY: return "PackedFloat32Array"
		TYPE_PACKED_FLOAT64_ARRAY: return "PackedFloat64Array"
		TYPE_PACKED_STRING_ARRAY: return "PackedStringArray"
		TYPE_PACKED_VECTOR2_ARRAY: return "PackedVector2Array"
		TYPE_PACKED_VECTOR3_ARRAY: return "PackedVector3Array"
		TYPE_PACKED_COLOR_ARRAY: return "PackedColorArray"
		_: return "type_%d" % type_id

# =============================================================================
# get_console_log — Reads the editor's Output panel contents
# =============================================================================
func _get_console_log(client_id: int, params: Dictionary, command_id: String) -> void:
	var max_lines: int = int(params.get("max_lines", 100))

	var plugin = Engine.get_meta("GodotMCPPlugin")
	if not plugin:
		return _send_error(client_id, "GodotMCPPlugin not found in Engine metadata", command_id)

	var editor_interface = plugin.get_editor_interface()
	var base_control = editor_interface.get_base_control()

	# Try to find the EditorLog's RichTextLabel
	var log_text = _find_editor_log(base_control)
	if log_text.is_empty():
		# Fallback: return a message indicating we couldn't find the log
		_send_success(client_id, {
			"lines": [],
			"message": "Could not locate the editor Output panel. Use print() statements and check the Output in Godot.",
			"count": 0
		}, command_id)
		return

	# Split into lines and return the most recent ones
	var lines = log_text.split("\n")
	var start_index = max(0, lines.size() - max_lines)
	var result_lines: Array = []
	for i in range(start_index, lines.size()):
		if not lines[i].strip_edges().is_empty():
			result_lines.append(lines[i])

	_send_success(client_id, {
		"lines": result_lines,
		"total_lines": lines.size(),
		"returned_lines": result_lines.size()
	}, command_id)

func _find_editor_log(node: Node) -> String:
	# Traverse the editor's node tree to find the Output panel's RichTextLabel
	if node is RichTextLabel:
		var parent = node.get_parent()
		if parent and (parent.get_class() == "EditorLog" or str(parent.name).to_lower().contains("log")):
			return node.get_parsed_text()

	for child in node.get_children():
		var result = _find_editor_log(child)
		if not result.is_empty():
			return result

	return ""

# =============================================================================
# get_errors — Filters console output for errors and warnings
# =============================================================================
func _get_errors(client_id: int, params: Dictionary, command_id: String) -> void:
	var max_errors: int = int(params.get("max_errors", 50))
	var include_warnings: bool = bool(params.get("include_warnings", true))

	var plugin = Engine.get_meta("GodotMCPPlugin")
	if not plugin:
		return _send_error(client_id, "GodotMCPPlugin not found in Engine metadata", command_id)

	var editor_interface = plugin.get_editor_interface()
	var base_control = editor_interface.get_base_control()

	var log_text = _find_editor_log(base_control)
	if log_text.is_empty():
		_send_success(client_id, {
			"errors": [],
			"warnings": [],
			"message": "Could not locate the editor Output panel."
		}, command_id)
		return

	var lines = log_text.split("\n")
	var errors: Array = []
	var warnings: Array = []

	for line in lines:
		var stripped = line.strip_edges()
		if stripped.is_empty():
			continue

		# Detect errors
		if stripped.begins_with("ERROR") or stripped.contains("ERROR:") or stripped.contains("error:"):
			errors.append(_parse_error_line(stripped))
		elif include_warnings and (stripped.begins_with("WARNING") or stripped.contains("WARNING:") or stripped.contains("warning:")):
			warnings.append(_parse_error_line(stripped))

	# Limit output
	if errors.size() > max_errors:
		errors = errors.slice(errors.size() - max_errors, errors.size())
	if warnings.size() > max_errors:
		warnings = warnings.slice(warnings.size() - max_errors, warnings.size())

	_send_success(client_id, {
		"errors": errors,
		"warnings": warnings,
		"error_count": errors.size(),
		"warning_count": warnings.size()
	}, command_id)

func _parse_error_line(line: String) -> Dictionary:
	var result: Dictionary = {"raw": line}

	# Try to extract file and line number patterns like "res://path/file.gd:42"
	var regex = RegEx.new()
	regex.compile("(res://[\\w/\\-\\.]+):(\\d+)")
	var match = regex.search(line)
	if match:
		result["file"] = match.get_string(1)
		result["line"] = int(match.get_string(2))

	return result

# =============================================================================
# clear_console_log — Clears the editor Output panel
# =============================================================================
func _clear_console_log(client_id: int, _params: Dictionary, command_id: String) -> void:
	var plugin = Engine.get_meta("GodotMCPPlugin")
	if not plugin:
		return _send_error(client_id, "GodotMCPPlugin not found in Engine metadata", command_id)

	var editor_interface = plugin.get_editor_interface()
	var base_control = editor_interface.get_base_control()

	# Try to find and clear the EditorLog
	var cleared = _find_and_clear_log(base_control)

	_send_success(client_id, {
		"cleared": cleared,
		"message": "Console log cleared" if cleared else "Could not locate the editor Output panel to clear"
	}, command_id)

func _find_and_clear_log(node: Node) -> bool:
	if node is RichTextLabel:
		var parent = node.get_parent()
		if parent and (parent.get_class() == "EditorLog" or str(parent.name).to_lower().contains("log")):
			node.clear()
			return true

	for child in node.get_children():
		if _find_and_clear_log(child):
			return true

	return false

# =============================================================================
# open_in_editor — Opens a file in the Godot editor
# =============================================================================
func _open_in_editor(client_id: int, params: Dictionary, command_id: String) -> void:
	var file_path = params.get("file_path", "")
	var line_number: int = int(params.get("line_number", -1))

	if file_path.is_empty():
		return _send_error(client_id, "file_path is required", command_id)

	if not file_path.begins_with("res://"):
		file_path = "res://" + file_path

	if not FileAccess.file_exists(file_path):
		return _send_error(client_id, "File not found: %s" % file_path, command_id)

	var plugin = Engine.get_meta("GodotMCPPlugin")
	if not plugin:
		return _send_error(client_id, "GodotMCPPlugin not found in Engine metadata", command_id)

	var editor_interface = plugin.get_editor_interface()

	# Handle based on file type
	if file_path.ends_with(".tscn") or file_path.ends_with(".scn"):
		editor_interface.open_scene_from_path(file_path)
		_send_success(client_id, {
			"file_path": file_path,
			"opened_as": "scene"
		}, command_id)
	elif file_path.ends_with(".gd"):
		var script = load(file_path)
		if script:
			editor_interface.edit_resource(script)
			if line_number >= 0:
				# Try to go to line via script editor
				var script_editor = editor_interface.get_script_editor()
				if script_editor:
					script_editor.goto_line(line_number)
			_send_success(client_id, {
				"file_path": file_path,
				"opened_as": "script",
				"line": line_number if line_number >= 0 else "start"
			}, command_id)
		else:
			_send_error(client_id, "Failed to load script: %s" % file_path, command_id)
	else:
		# Try to open as a generic resource
		var resource = load(file_path)
		if resource:
			editor_interface.edit_resource(resource)
			_send_success(client_id, {
				"file_path": file_path,
				"opened_as": "resource"
			}, command_id)
		else:
			_send_error(client_id, "Could not open file: %s" % file_path, command_id)
