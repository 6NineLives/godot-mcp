@tool
class_name MCPVisualizerCommands
extends MCPBaseCommandProcessor

# ------------------------------------------------------------------------------
# Command Routing
# ------------------------------------------------------------------------------

func process_command(client_id: int, command_type: String, params: Dictionary, command_id: String) -> bool:
	match command_type:
		# Top-level MCP tool commands
		"map_project_scripts":
			var result = map_project(params)
			_send_success(client_id, result, command_id)
			return true
		"map_project_scenes":
			var result = map_scenes(params)
			_send_success(client_id, result, command_id)
			return true
		"get_scene_hierarchy":
			var result = _get_scene_hierarchy(params)
			_send_success(client_id, result, command_id)
			return true
		"open_script_in_editor":
			var result = _open_script_in_editor(params)
			_send_success(client_id, result, command_id)
			return true
		
		# Internal commands (forwarded by visualizer server with prefix)
		"visualizer._internal_create_script_file":
			var result = _internal_create_script_file(params)
			_send_success(client_id, result, command_id)
			return true
		"visualizer._internal_modify_variable":
			var result = _internal_modify_variable(params)
			_send_success(client_id, result, command_id)
			return true
		"visualizer._internal_modify_signal":
			var result = _internal_modify_signal(params)
			_send_success(client_id, result, command_id)
			return true
		"visualizer._internal_modify_function":
			var result = _internal_modify_function(params)
			_send_success(client_id, result, command_id)
			return true
		"visualizer._internal_modify_function_delete":
			var result = _internal_modify_function_delete(params)
			_send_success(client_id, result, command_id)
			return true
		"visualizer._internal_find_usages":
			var result = _internal_find_usages(params)
			_send_success(client_id, result, command_id)
			return true
		
			
	return false

# ------------------------------------------------------------------------------
# Project Mapping (Scripts)
# ------------------------------------------------------------------------------

func map_project(args: Dictionary) -> Dictionary:
	"""Crawl the entire project and build a structural map of all scripts."""
	var root_path: String = str(args.get("root", "res://"))
	var include_addons: bool = bool(args.get("include_addons", false))

	if not root_path.begins_with("res://"):
		root_path = "res://" + root_path

	# Collect all .gd files
	var script_paths: Array = []
	_collect_scripts(root_path, script_paths, include_addons)

	if script_paths.is_empty():
		return {"ok": false, "error": "No GDScript files found in " + root_path}

	# Parse each script
	var nodes: Array = []
	var class_map: Dictionary = {}  # class_name -> path

	for path in script_paths:
		var info: Dictionary = _parse_script(path)
		nodes.append(info)
		if info.get("class_name", "") != "":
			class_map[info["class_name"]] = path

	# Build edges
	var edges: Array = []
	for node in nodes:
		var from_path: String = node["path"]

		# extends relationship (resolve class_name to path)
		var extends_class: String = node.get("extends", "")
		if extends_class in class_map:
			edges.append({"from": from_path, "to": class_map[extends_class], "type": "extends"})

		# preload/load references
		for ref in node.get("preloads", []):
			if ref.ends_with(".gd"):
				edges.append({"from": from_path, "to": ref, "type": "preload"})

		# signal connections
		for conn in node.get("connections", []):
			var target: String = conn.get("target", "")
			if target in class_map:
				edges.append({"from": from_path, "to": class_map[target], "type": "signal", "signal_name": conn.get("signal", "")})

	return {
		"ok": true,
		"project_map": {
			"nodes": nodes,
			"edges": edges,
			"total_scripts": nodes.size(),
			"class_map": class_map 
		}
	}

func _collect_scripts(path: String, results: Array, include_addons: bool) -> void:
	"""Recursively collect all .gd files."""
	var dir := DirAccess.open(path)
	if dir == null:
		return

	dir.list_dir_begin()
	var name := dir.get_next()
	while name != "":
		if name.begins_with("."):
			name = dir.get_next()
			continue

		var full_path := path.path_join(name)

		if dir.current_is_dir():
			if name == "addons" and not include_addons:
				name = dir.get_next()
				continue
			_collect_scripts(full_path, results, include_addons)
		elif name.ends_with(".gd"):
			results.append(full_path)

		name = dir.get_next()
	dir.list_dir_end()

func _parse_script(path: String) -> Dictionary:
	"""Parse a GDScript file and extract its structure."""
	var file := FileAccess.open(path, FileAccess.READ)
	if file == null:
		return {"path": path, "error": "Cannot open file"}

	var content: String = file.get_as_text()
	file.close()

	var lines: PackedStringArray = content.split("\n")
	var line_count: int = lines.size()

	var description := ""
	var extends_class := ""
	var class_name_str := ""
	var variables: Array = []
	var functions: Array = []
	var signals_list: Array = []
	var preloads: Array = []
	var connections: Array = []

	# Regex patterns
	var re_desc := RegEx.new()
	re_desc.compile("^##\\s*@desc:\\s*(.+)")

	var re_extends := RegEx.new()
	re_extends.compile("^extends\\s+(\\w+)")

	var re_class_name := RegEx.new()
	re_class_name.compile("^class_name\\s+(\\w+)")

	# Match: @export var name: Type = value  OR  var name: Type  OR  var name = value
	var re_var := RegEx.new()
	re_var.compile("^(@export(?:\\([^)]*\\))?\\s+)?(@onready\\s+)?var\\s+(\\w+)\\s*(?::\\s*(\\w+))?(?:\\s*=\\s*(.+))?")

	# Match: func name(params) -> ReturnType:
	var re_func := RegEx.new()
	re_func.compile("^func\\s+(\\w+)\\s*\\(([^)]*)\\)\\s*(?:->\\s*(\\w+))?")

	# Match: signal name(params)
	var re_signal := RegEx.new()
	re_signal.compile("^signal\\s+(\\w+)(?:\\(([^)]*)\\))?")

	var re_preload := RegEx.new()
	re_preload.compile("(?:preload|load)\\s*\\(\\s*\"(res://[^\"]+)\"\\s*\\)")

	var re_connect_obj := RegEx.new()
	re_connect_obj.compile("(\\w+)\\.(\\w+)\\.connect\\s*\\(")
	
	var re_connect_direct := RegEx.new()
	re_connect_direct.compile("^\\s*(\\w+)\\.connect\\s*\\(")
	
	var var_type_map: Dictionary = {}
	var func_starts: Array = [] 

	for i in range(line_count):
		var line: String = lines[i]
		var stripped: String = line.strip_edges()

		if i < 15 and description.is_empty():
			var m := re_desc.search(stripped)
			if m:
				description = m.get_string(1)
				continue

		if extends_class.is_empty():
			var m := re_extends.search(stripped)
			if m:
				extends_class = m.get_string(1)
				continue

		if class_name_str.is_empty():
			var m := re_class_name.search(stripped)
			if m:
				class_name_str = m.get_string(1)
				continue

		if not line.begins_with("\t") and not line.begins_with(" "):
			var m_var := re_var.search(stripped)
			if m_var:
				var exported: bool = m_var.get_string(1).strip_edges() != ""
				var onready: bool = m_var.get_string(2).strip_edges() != ""
				var var_name: String = m_var.get_string(3)
				var var_type: String = m_var.get_string(4).strip_edges()
				var default_val: String = m_var.get_string(5).strip_edges()

				if var_type.is_empty() and not default_val.is_empty():
					var_type = _infer_type(default_val)
				
				if not var_type.is_empty():
					var_type_map[var_name] = var_type

				variables.append({
					"name": var_name,
					"type": var_type,
					"exported": exported,
					"onready": onready,
					"default": default_val
				})

		var m_func := re_func.search(stripped)
		if m_func:
			var func_name: String = m_func.get_string(1)
			var return_type: String = m_func.get_string(3).strip_edges()
			func_starts.append({"line_idx": i, "name": func_name})
			functions.append({
				"name": func_name,
				"params": m_func.get_string(2).strip_edges(),
				"return_type": return_type,
				"line": i + 1,
				"body": ""
			})

		var m_sig := re_signal.search(stripped)
		if m_sig:
			signals_list.append({
				"name": m_sig.get_string(1),
				"params": m_sig.get_string(2).strip_edges() if m_sig.get_string(2) else ""
			})

		var m_preload := re_preload.search(stripped)
		if m_preload:
			preloads.append(m_preload.get_string(1))

		var m_conn_obj := re_connect_obj.search(stripped)
		if m_conn_obj:
			var obj_name: String = m_conn_obj.get_string(1)
			var signal_name: String = m_conn_obj.get_string(2)
			var target_type: String = var_type_map.get(obj_name, "")
			connections.append({
				"object": obj_name,
				"signal": signal_name,
				"target": target_type,
				"line": i + 1
			})
		else:
			var m_conn_direct := re_connect_direct.search(stripped)
			if m_conn_direct:
				connections.append({
					"signal": m_conn_direct.get_string(1),
					"target": extends_class,
					"line": i + 1
				})

	for fi in range(func_starts.size()):
		var start_idx: int = func_starts[fi]["line_idx"]
		var end_idx: int
		if fi + 1 < func_starts.size():
			end_idx = func_starts[fi + 1]["line_idx"]
		else:
			end_idx = line_count

		while end_idx > start_idx + 1 and lines[end_idx - 1].strip_edges().is_empty():
			end_idx -= 1

		for check_idx in range(start_idx + 1, end_idx):
			var check_line: String = lines[check_idx]
			if not check_line.is_empty() and not check_line.begins_with("\t") and not check_line.begins_with(" ") and not check_line.begins_with("#"):
				end_idx = check_idx
				break

		var body_lines: PackedStringArray = PackedStringArray()
		for li in range(start_idx, end_idx):
			body_lines.append(lines[li])

		var body: String = "\n".join(body_lines)
		if body.length() > 3000:
			body = body.substr(0, 3000) + "\n# ... (truncated)"

		functions[fi]["body"] = body
		functions[fi]["body_lines"] = end_idx - start_idx

	var folder: String = path.get_base_dir()
	var filename: String = path.get_file()

	return {
		"path": path,
		"filename": filename,
		"folder": folder,
		"class_name": class_name_str,
		"extends": extends_class,
		"description": description,
		"line_count": line_count,
		"variables": variables,
		"functions": functions,
		"signals": signals_list,
		"preloads": preloads,
		"connections": connections
	}

func _infer_type(default_val: String) -> String:
	if default_val == "true" or default_val == "false":
		return "bool"
	if default_val.is_valid_int():
		return "int"
	if default_val.is_valid_float():
		return "float"
	if default_val.begins_with("\"") or default_val.begins_with("'"):
		return "String"
	if default_val.begins_with("Vector2"):
		return "Vector2"
	if default_val.begins_with("Vector3"):
		return "Vector3"
	if default_val.begins_with("Color"):
		return "Color"
	if default_val.begins_with("["):
		return "Array"
	if default_val.begins_with("{"):
		return "Dictionary"
	if default_val == "null":
		return "Variant"
	if default_val.ends_with(".new()"):
		return default_val.replace(".new()", "")
	return ""

# ------------------------------------------------------------------------------
# Project Mapping (Scenes)
# ------------------------------------------------------------------------------

func map_scenes(args: Dictionary) -> Dictionary:
	var root_path: String = str(args.get("root", "res://"))
	var include_addons: bool = bool(args.get("include_addons", false))

	if not root_path.begins_with("res://"):
		root_path = "res://" + root_path

	var scene_paths: Array = []
	_collect_scenes(root_path, scene_paths, include_addons)

	if scene_paths.is_empty():
		return {"ok": true, "scene_map": {"scenes": [], "total_scenes": 0}}

	var scenes: Array = []
	for path in scene_paths:
		var info: Dictionary = _parse_scene(path)
		scenes.append(info)

	var edges: Array = []
	for scene in scenes:
		var from_path: String = scene["path"]
		for instance in scene.get("instances", []):
			edges.append({"from": from_path, "to": instance, "type": "instance"})

	return {
		"ok": true,
		"scene_map": {
			"scenes": scenes,
			"edges": edges,
			"total_scenes": scenes.size()
		}
	}

func _collect_scenes(path: String, results: Array, include_addons: bool) -> void:
	var dir := DirAccess.open(path)
	if dir == null:
		return

	dir.list_dir_begin()
	var name := dir.get_next()
	while name != "":
		if name.begins_with("."):
			name = dir.get_next()
			continue

		var full_path := path.path_join(name)

		if dir.current_is_dir():
			if name == "addons" and not include_addons:
				name = dir.get_next()
				continue
			_collect_scenes(full_path, results, include_addons)
		elif name.ends_with(".tscn"):
			results.append(full_path)

		name = dir.get_next()
	dir.list_dir_end()

func _parse_scene(path: String) -> Dictionary:
	var file := FileAccess.open(path, FileAccess.READ)
	if file == null:
		return {"path": path, "error": "Cannot open file"}

	var content: String = file.get_as_text()
	file.close()

	var scene_name: String = path.get_file().replace(".tscn", "")
	var root_type: String = ""
	var nodes: Array = []
	var instances: Array = []
	var scripts: Array = []

	var lines: PackedStringArray = content.split("\n")
	
	var re_ext_resource := RegEx.new()
	re_ext_resource.compile('\\[ext_resource.*path="([^"]+)".*type="([^"]+)"')
	
	var re_node := RegEx.new()
	re_node.compile('\\[node name="([^"]+)".*type="([^"]+)"')
	
	var re_node_instance := RegEx.new()
	re_node_instance.compile('\\[node name="([^"]+)".*instance=ExtResource\\("([^"]+)"\\)')
	
	for line in lines:
		var m_ext := re_ext_resource.search(line)
		if m_ext:
			var res_path: String = m_ext.get_string(1)
			var res_type: String = m_ext.get_string(2)
			if res_type == "PackedScene":
				instances.append(res_path)
			elif res_type == "Script":
				scripts.append(res_path)
			continue

		var m_node := re_node.search(line)
		if m_node:
			var node_name: String = m_node.get_string(1)
			var node_type: String = m_node.get_string(2)
			if root_type.is_empty():
				root_type = node_type
			nodes.append({"name": node_name, "type": node_type})
			continue

		var m_inst := re_node_instance.search(line)
		if m_inst:
			var node_name: String = m_inst.get_string(1)
			nodes.append({"name": node_name, "type": "Instance"})

	return {
		"path": path,
		"name": scene_name,
		"root_type": root_type,
		"nodes": nodes,
		"instances": instances,
		"scripts": scripts,
		"node_count": nodes.size()
	}

# ------------------------------------------------------------------------------
# Scene Hierarchy (for visualizer expandScene)
# ------------------------------------------------------------------------------

func _get_scene_hierarchy(args: Dictionary) -> Dictionary:
	"""Get the full node hierarchy of a single scene file for the visualizer."""
	var scene_path: String = args.get("scene_path", "")
	if scene_path.is_empty():
		return {"ok": false, "error": "Missing scene_path parameter"}
	
	if not FileAccess.file_exists(scene_path):
		return {"ok": false, "error": "Scene file not found: " + scene_path}
	
	var file := FileAccess.open(scene_path, FileAccess.READ)
	if file == null:
		return {"ok": false, "error": "Cannot open scene file: " + scene_path}
	
	var content: String = file.get_as_text()
	file.close()
	
	var lines: PackedStringArray = content.split("\n")
	var hierarchy: Array = []
	
	# Parse [node] entries with parent info
	var re_node := RegEx.new()
	re_node.compile('\\[node name="([^"]+)"\\s+type="([^"]+)"(?:\\s+parent="([^"]*)")?')
	
	var re_node_root := RegEx.new()
	re_node_root.compile('\\[node name="([^"]+)"\\s+type="([^"]+)"\\]')
	
	for line in lines:
		var m := re_node.search(line)
		if m:
			var node_name: String = m.get_string(1)
			var node_type: String = m.get_string(2)
			var parent_path: String = m.get_string(3) if m.get_string(3) != "" else ""
			
			# Build the full node path
			var node_path: String
			if parent_path.is_empty():
				# This is a root node (no parent attribute) or parent="."
				node_path = "."
			elif parent_path == ".":
				node_path = node_name
			else:
				node_path = parent_path + "/" + node_name
			
			hierarchy.append({
				"name": node_name,
				"type": node_type,
				"path": node_path,
				"parent": parent_path
			})
	
	return {
		"ok": true,
		"hierarchy": hierarchy,
		"scene_path": scene_path
	}

# ------------------------------------------------------------------------------
# Open Script in Editor
# ------------------------------------------------------------------------------

func _open_script_in_editor(args: Dictionary) -> Dictionary:
	"""Open a script file in the Godot editor."""
	var script_path: String = args.get("path", "")
	if script_path.is_empty():
		return {"ok": false, "error": "Missing path parameter"}
	
	if not FileAccess.file_exists(script_path):
		return {"ok": false, "error": "Script file not found: " + script_path}
	
	var script := load(script_path)
	if script == null:
		return {"ok": false, "error": "Cannot load script: " + script_path}
	
	# Open in the editor
	EditorInterface.edit_script(script)
	
	# Optionally go to a specific line
	var line: int = int(args.get("line", 0))
	if line > 0:
		var script_editor := EditorInterface.get_script_editor()
		if script_editor:
			var editor := script_editor.get_current_editor()
			if editor:
				var code_edit := editor.get_base_editor()
				if code_edit is CodeEdit:
					code_edit.set_caret_line(line - 1)
					code_edit.center_viewport_to_caret()
	
	return {"ok": true, "path": script_path}

# ------------------------------------------------------------------------------
# Internal Modifications
# ------------------------------------------------------------------------------

func _internal_create_script_file(args: Dictionary) -> Dictionary:
	var script_path: String = args.get("path", "")
	var extends_type: String = args.get("extends", "Node")
	var class_name_str: String = args.get("class_name", "")
	
	if script_path.is_empty():
		return {"ok": false, "error": "No path provided"}
	
	if not script_path.begins_with("res://"):
		script_path = "res://" + script_path
	
	if not script_path.ends_with(".gd"):
		script_path += ".gd"
	
	if FileAccess.file_exists(script_path):
		return {"ok": false, "error": "File already exists: " + script_path}
	
	var dir_path: String = script_path.get_base_dir()
	if not DirAccess.dir_exists_absolute(dir_path):
		var err := DirAccess.make_dir_recursive_absolute(dir_path)
		if err != OK:
			return {"ok": false, "error": "Failed to create directory"}
	
	var content := ""
	if not class_name_str.is_empty():
		content += "class_name " + class_name_str + "\n"
	content += "extends " + extends_type + "\n"
	content += "\n\n"
	content += "func _ready() -> void:\n"
	content += "\tpass\n"
	
	var file := FileAccess.open(script_path, FileAccess.WRITE)
	if file == null:
		return {"ok": false, "error": "Cannot create file: " + script_path}
	
	file.store_string(content)
	file.close()
	
	return {"ok": true, "path": script_path}

func _internal_modify_variable(args: Dictionary) -> Dictionary:
	var script_path: String = args.get("path", "")
	var action: String = args.get("action", "")
	var old_name: String = args.get("old_name", "")
	var new_name: String = args.get("name", "")
	var var_type: String = args.get("type", "")
	var default_val: String = args.get("default", "")
	var exported: bool = args.get("exported", false)
	var onready: bool = args.get("onready", false)
	
	if script_path.is_empty():
		return {"ok": false, "error": "No script path provided"}
	
	var file := FileAccess.open(script_path, FileAccess.READ)
	if file == null:
		return {"ok": false, "error": "Cannot open file: " + script_path}
	
	var content: String = file.get_as_text()
	file.close()
	
	var lines: Array = Array(content.split("\n"))
	var modified := false
	
	if action == "delete":
		var pattern := RegEx.new()
		pattern.compile("^(@export(?:\\([^)]*\\))?\\s+)?(?:@onready\\s+)?var\\s+" + old_name + "\\s*(?::|=|$)")
		for i in range(lines.size() - 1, -1, -1):
			if pattern.search(lines[i].strip_edges()):
				lines.remove_at(i)
				modified = true
				break
	
	elif action == "update":
		var pattern := RegEx.new()
		pattern.compile("^(@export(?:\\([^)]*\\))?\\s+)?(@onready\\s+)?var\\s+" + old_name + "\\s*(?::\\s*\\w+)?(?:\\s*=\\s*.+)?$")
		for i in range(lines.size()):
			var m := pattern.search(lines[i].strip_edges())
			if m:
				var new_line := _build_var_line(new_name, var_type, default_val, exported, onready)
				lines[i] = new_line
				modified = true
				break
	
	elif action == "add":
		var insert_pos := _find_var_insert_position(lines, exported)
		var new_line := _build_var_line(new_name, var_type, default_val, exported, false)
		lines.insert(insert_pos, new_line)
		modified = true
	
	if modified:
		var new_content := "\n".join(PackedStringArray(lines))
		var write_file := FileAccess.open(script_path, FileAccess.WRITE)
		if write_file == null:
			return {"ok": false, "error": "Cannot write to file: " + script_path}
		write_file.store_string(new_content)
		write_file.close()
		return {"ok": true, "action": action, "variable": new_name}
	
	return {"ok": false, "error": "Variable not found: " + old_name}

func _build_var_line(name: String, type: String, default_val: String, exported: bool, onready: bool) -> String:
	var line := ""
	if exported:
		line += "@export "
	if onready:
		line += "@onready "
	line += "var " + name
	if not type.is_empty():
		line += ": " + type
	if not default_val.is_empty():
		line += " = " + default_val
	return line

func _find_var_insert_position(lines: Array, exported: bool) -> int:
	var last_var_idx := -1
	var class_def_idx := -1
	
	for i in range(lines.size()):
		var line = lines[i].strip_edges()
		if line.begins_with("class_name") or line.begins_with("extends"):
			class_def_idx = i
		elif line.begins_with("var ") or line.begins_with("@export") or line.begins_with("@onready"):
			last_var_idx = i
		elif line.begins_with("func ") and last_var_idx != -1:
			return i # Before first function
			
	if last_var_idx != -1:
		return last_var_idx + 1
	if class_def_idx != -1:
		return class_def_idx + 2
	return 0

func _internal_modify_signal(args: Dictionary) -> Dictionary:
	var script_path: String = args.get("path", "")
	var action: String = args.get("action", "")
	var old_name: String = args.get("old_name", "")
	var new_name: String = args.get("name", "")
	var params: String = args.get("params", "")
	
	if script_path.is_empty():
		return {"ok": false, "error": "No script path provided"}
	
	var file := FileAccess.open(script_path, FileAccess.READ)
	if file == null:
		return {"ok": false, "error": "Cannot open file: " + script_path}
	
	var content: String = file.get_as_text()
	file.close()
	
	var lines: Array = Array(content.split("\n"))
	var modified := false
	
	if action == "delete":
		var pattern := RegEx.new()
		pattern.compile("^signal\\s+" + old_name + "(?:\\s*\\(|$)")
		for i in range(lines.size() - 1, -1, -1):
			if pattern.search(lines[i].strip_edges()):
				lines.remove_at(i)
				modified = true
				break
	
	elif action == "update":
		var pattern := RegEx.new()
		pattern.compile("^signal\\s+" + old_name + "(?:\\s*\\([^)]*\\))?$")
		for i in range(lines.size()):
			if pattern.search(lines[i].strip_edges()):
				var new_line := "signal " + new_name
				if not params.is_empty():
					new_line += "(" + params + ")"
				lines[i] = new_line
				modified = true
				break
	
	elif action == "add":
		var insert_pos := _find_signal_insert_position(lines)
		var new_line := "signal " + new_name
		if not params.is_empty():
			new_line += "(" + params + ")"
		lines.insert(insert_pos, new_line)
		modified = true
	
	if modified:
		var new_content := "\n".join(PackedStringArray(lines))
		var write_file := FileAccess.open(script_path, FileAccess.WRITE)
		if write_file == null:
			return {"ok": false, "error": "Cannot write to file: " + script_path}
		write_file.store_string(new_content)
		write_file.close()
		return {"ok": true, "action": action, "signal": new_name}
	
	return {"ok": false, "error": "Signal not found: " + old_name}

func _find_signal_insert_position(lines: Array) -> int:
	var last_sig_idx := -1
	var class_def_idx := -1
	
	for i in range(lines.size()):
		var line = lines[i].strip_edges()
		if line.begins_with("class_name") or line.begins_with("extends"):
			class_def_idx = i
		elif line.begins_with("signal "):
			last_sig_idx = i
			
	if last_sig_idx != -1:
		return last_sig_idx + 1
	if class_def_idx != -1:
		return class_def_idx + 2
	return 0

func _internal_modify_function(args: Dictionary) -> Dictionary:
	var script_path: String = args.get("path", "")
	var func_name: String = args.get("name", "")
	var new_body: String = args.get("body", "")
	
	if script_path.is_empty() or func_name.is_empty():
		return {"ok": false, "error": "Missing path or function name"}
	
	var file := FileAccess.open(script_path, FileAccess.READ)
	if file == null:
		return {"ok": false, "error": "Cannot open file: " + script_path}
	
	var content: String = file.get_as_text()
	file.close()
	
	var lines: Array = Array(content.split("\n"))
	
	var re_func := RegEx.new()
	re_func.compile("^func\\s+" + func_name + "\\s*\\(")
	
	var func_start := -1
	var func_end := -1
	
	for i in range(lines.size()):
		if func_start == -1:
			if re_func.search(lines[i].strip_edges()):
				func_start = i
		elif func_start != -1:
			var stripped: String = lines[i].strip_edges()
			if not stripped.is_empty() and not lines[i].begins_with("\t") and not lines[i].begins_with(" ") and not stripped.begins_with("#"):
				func_end = i
				break
	
	if func_start == -1:
		return {"ok": false, "error": "Function not found: " + func_name}
	
	if func_end == -1:
		func_end = lines.size()
	
	while func_end > func_start + 1 and lines[func_end - 1].strip_edges().is_empty():
		func_end -= 1
	
	var new_lines := Array(new_body.split("\n"))
	
	for i in range(func_end - 1, func_start - 1, -1):
		lines.remove_at(i)
	
	for i in range(new_lines.size()):
		lines.insert(func_start + i, new_lines[i])
	
	var new_content := "\n".join(PackedStringArray(lines))
	var write_file := FileAccess.open(script_path, FileAccess.WRITE)
	if write_file == null:
		return {"ok": false, "error": "Cannot write to file: " + script_path}
	write_file.store_string(new_content)
	write_file.close()
	
	return {"ok": true, "function": func_name}

func _internal_modify_function_delete(args: Dictionary) -> Dictionary:
	var script_path: String = args.get("path", "")
	var func_name: String = args.get("name", "")
	
	if script_path.is_empty() or func_name.is_empty():
		return {"ok": false, "error": "Missing path or function name"}
	
	var file := FileAccess.open(script_path, FileAccess.READ)
	if file == null:
		return {"ok": false, "error": "Cannot open file: " + script_path}
	
	var content: String = file.get_as_text()
	file.close()
	
	var lines: Array = Array(content.split("\n"))
	
	var re_func := RegEx.new()
	re_func.compile("^func\\s+" + func_name + "\\s*\\(")
	
	var func_start := -1
	var func_end := -1
	
	for i in range(lines.size()):
		if func_start == -1:
			if re_func.search(lines[i].strip_edges()):
				func_start = i
		elif func_start != -1:
			var stripped: String = lines[i].strip_edges()
			if not stripped.is_empty() and not lines[i].begins_with("\t") and not lines[i].begins_with(" ") and not stripped.begins_with("#"):
				func_end = i
				break
	
	if func_start == -1:
		return {"ok": false, "error": "Function not found: " + func_name}
	
	if func_end == -1:
		func_end = lines.size()
	
	while func_end > func_start + 1 and lines[func_end - 1].strip_edges().is_empty():
		func_end -= 1
	
	for i in range(func_end - 1, func_start - 1, -1):
		lines.remove_at(i)
	
	var new_content := "\n".join(PackedStringArray(lines))
	var write_file := FileAccess.open(script_path, FileAccess.WRITE)
	if write_file == null:
		return {"ok": false, "error": "Cannot write to file: " + script_path}
	write_file.store_string(new_content)
	write_file.close()
	
	return {"ok": true, "deleted": func_name}

func _internal_find_usages(args: Dictionary) -> Dictionary:
	# Simplified implementation for now, just searching text
	var query: String = args.get("query", "")
	var root_path: String = "res://"
	
	if query.is_empty():
		return {"ok": false, "error": "No query provided"}
		
	var file_paths: Array = []
	_collect_scripts(root_path, file_paths, false)
	
	var usages: Array = []
	
	for path in file_paths:
		var file := FileAccess.open(path, FileAccess.READ)
		if file:
			var content := file.get_as_text()
			var lines := content.split("\n")
			for i in range(lines.size()):
				if lines[i].contains(query):
					usages.append({
						"path": path,
						"line": i + 1,
						"content": lines[i].strip_edges()
					})
	
	return {"ok": true, "usages": usages}
