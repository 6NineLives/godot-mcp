@tool
class_name MCPScriptCommands
extends MCPBaseCommandProcessor

func process_command(client_id: int, command_type: String, params: Dictionary, command_id: String) -> bool:
	match command_type:
		"create_script":
			_create_script(client_id, params, command_id)
			return true
		"edit_script":
			_edit_script(client_id, params, command_id)
			return true
		"get_script":
			_get_script(client_id, params, command_id)
			return true
		"get_script_metadata":
			_get_script_metadata(client_id, params, command_id)
			return true
		"get_current_script":
			_get_current_script(client_id, params, command_id)
			return true
		"create_script_template":
			_create_script_template(client_id, params, command_id)
			return true
		"validate_script":
			_validate_script(client_id, params, command_id)
			return true
		"list_scripts":
			_list_scripts(client_id, params, command_id)
			return true
		"rename_file":
			_rename_file(client_id, params, command_id)
			return true
		"delete_file":
			_delete_file(client_id, params, command_id)
			return true
		"create_folder":
			_create_folder(client_id, params, command_id)
			return true
	return false  # Command not handled

func _create_script(client_id: int, params: Dictionary, command_id: String) -> void:
	var script_path = params.get("script_path", "")
	var content = params.get("content", "")
	var node_path = params.get("node_path", "")
	
	# Validation
	if script_path.is_empty():
		return _send_error(client_id, "Script path cannot be empty", command_id)
	
	# Make sure we have an absolute path
	if not script_path.begins_with("res://"):
		script_path = "res://" + script_path
	
	if not script_path.ends_with(".gd"):
		script_path += ".gd"
	
	# Get editor plugin and interfaces
	var plugin = Engine.get_meta("GodotMCPPlugin")
	if not plugin:
		return _send_error(client_id, "GodotMCPPlugin not found in Engine metadata", command_id)
	
	var editor_interface = plugin.get_editor_interface()
	var script_editor = editor_interface.get_script_editor()
	
	# Create the directory if it doesn't exist
	var dir = script_path.get_base_dir()
	if not DirAccess.dir_exists_absolute(dir):
		var err = DirAccess.make_dir_recursive_absolute(dir)
		if err != OK:
			return _send_error(client_id, "Failed to create directory: %s (Error code: %d)" % [dir, err], command_id)
	
	# Create the script file
	var file = FileAccess.open(script_path, FileAccess.WRITE)
	if file == null:
		return _send_error(client_id, "Failed to create script file: %s" % script_path, command_id)
	
	file.store_string(content)
	file = null  # Close the file
	
	# Refresh the filesystem
	editor_interface.get_resource_filesystem().scan()
	
	# Attach the script to a node if specified
	if not node_path.is_empty():
		var node = _get_editor_node(node_path)
		if not node:
			return _send_error(client_id, "Node not found: %s" % node_path, command_id)
		
		# Wait for script to be recognized in the filesystem
		await get_tree().create_timer(0.5).timeout
		
		var script = load(script_path)
		if not script:
			return _send_error(client_id, "Failed to load script: %s" % script_path, command_id)
		
		# Use undo/redo for script assignment
		var undo_redo = _get_undo_redo()
		if not undo_redo:
			# Fallback method if we can't get undo/redo
			node.set_script(script)
			_mark_scene_modified()
		else:
			# Use undo/redo for proper editor integration
			undo_redo.create_action("Assign Script")
			undo_redo.add_do_method(node, "set_script", script)
			undo_redo.add_undo_method(node, "set_script", node.get_script())
			undo_redo.commit_action()
		
		# Mark the scene as modified
		_mark_scene_modified()
	
	# Open the script in the editor
	var script_resource = load(script_path)
	if script_resource:
		editor_interface.edit_script(script_resource)
	
	_send_success(client_id, {
		"script_path": script_path,
		"node_path": node_path
	}, command_id)

func _edit_script(client_id: int, params: Dictionary, command_id: String) -> void:
	var script_path = params.get("script_path", "")
	var content = params.get("content", "")
	
	# Validation
	if script_path.is_empty():
		return _send_error(client_id, "Script path cannot be empty", command_id)
	
	if content.is_empty():
		return _send_error(client_id, "Content cannot be empty", command_id)
	
	# Make sure we have an absolute path
	if not script_path.begins_with("res://"):
		script_path = "res://" + script_path
	
	# Check if the file exists
	if not FileAccess.file_exists(script_path):
		return _send_error(client_id, "Script file not found: %s" % script_path, command_id)
	
	# Check if we should intercept via the Visual Diff UI (only when review_mode is on)
	var in_review_mode = _websocket_server and _websocket_server.get("review_mode") == true
	if in_review_mode and _websocket_server.get("diff_panel") != null:
		var diff_panel = _websocket_server.diff_panel
		var display_text = "[b]Proposed Modification to:[/b] " + script_path + "\n\n"
		display_text += "[code]" + content + "[/code]"
		
		if not diff_panel.proposal_accepted.is_connected(_on_edit_proposal_accepted):
			diff_panel.proposal_accepted.connect(_on_edit_proposal_accepted)
		if not diff_panel.proposal_rejected.is_connected(_on_edit_proposal_rejected):
			diff_panel.proposal_rejected.connect(_on_edit_proposal_rejected)
		
		set_meta("pending_edit_" + command_id, {
			"client_id": client_id,
			"script_path": script_path,
			"content": content
		})
		
		# Send pending ack BEFORE showing the panel (so client doesn't time out if panel call fails)
		_send_success(client_id, {
			"status": "pending_review",
			"message": "Script edit pending user approval in Godot editor diff panel.",
			"script_path": script_path
		}, command_id)
		
		diff_panel.display_proposal(command_id, display_text)
		return
	
	# Execute immediately (review_mode is off)
	_execute_edit_script(client_id, script_path, content, command_id)

func _on_edit_proposal_accepted(proposal_id: String) -> void:
	if has_meta("pending_edit_" + proposal_id):
		var args = get_meta("pending_edit_" + proposal_id)
		remove_meta("pending_edit_" + proposal_id)
		_execute_edit_script(args["client_id"], args["script_path"], args["content"], proposal_id)

func _on_edit_proposal_rejected(proposal_id: String) -> void:
	if has_meta("pending_edit_" + proposal_id):
		var args = get_meta("pending_edit_" + proposal_id)
		remove_meta("pending_edit_" + proposal_id)
		_send_error(args["client_id"], "User rejected the proposed code changes.", proposal_id)

func _execute_edit_script(client_id: int, script_path: String, content: String, command_id: String) -> void:
	# Edit the script file
	var file = FileAccess.open(script_path, FileAccess.WRITE)
	if file == null:
		return _send_error(client_id, "Failed to open script file: %s" % script_path, command_id)
	
	file.store_string(content)
	file = null  # Close the file
	
	_send_success(client_id, {
		"script_path": script_path,
		"status": "Changes applied successfully"
	}, command_id)

func _get_script(client_id: int, params: Dictionary, command_id: String) -> void:
	var script_path = params.get("script_path", "")
	var node_path = params.get("node_path", "")
	
	# Validation - either script_path or node_path must be provided
	if script_path.is_empty() and node_path.is_empty():
		return _send_error(client_id, "Either script_path or node_path must be provided", command_id)
	
	# If node_path is provided, get the script from the node
	if not node_path.is_empty():
		var node = _get_editor_node(node_path)
		if not node:
			return _send_error(client_id, "Node not found: %s" % node_path, command_id)
		
		var script = node.get_script()
		if not script:
			return _send_error(client_id, "Node does not have a script: %s" % node_path, command_id)
		
		script_path = script.resource_path
	
	# Make sure we have an absolute path
	if not script_path.begins_with("res://"):
		script_path = "res://" + script_path
	
	# Check if the file exists
	if not FileAccess.file_exists(script_path):
		return _send_error(client_id, "Script file not found: %s" % script_path, command_id)
	
	# Read the script file
	var file = FileAccess.open(script_path, FileAccess.READ)
	if file == null:
		return _send_error(client_id, "Failed to open script file: %s" % script_path, command_id)
	
	var content = file.get_as_text()
	file = null  # Close the file
	
	_send_success(client_id, {
		"script_path": script_path,
		"content": content
	}, command_id)

func _get_script_metadata(client_id: int, params: Dictionary, command_id: String) -> void:
	var path = params.get("path", "")
	
	# Validation
	if path.is_empty():
		return _send_error(client_id, "Script path cannot be empty", command_id)
	
	if not path.begins_with("res://"):
		path = "res://" + path
	
	if not FileAccess.file_exists(path):
		return _send_error(client_id, "Script file not found: " + path, command_id)
	
	# Load the script
	var script = load(path)
	if not script:
		return _send_error(client_id, "Failed to load script: " + path, command_id)
	
	# Extract script metadata
	var metadata = {
		"path": path,
		"language": "gdscript" if path.ends_with(".gd") else "csharp" if path.ends_with(".cs") else "unknown"
	}
	
	# Attempt to get script class info
	var class_name_str = ""
	var extends_class = ""
	
	# Read the file to extract class_name and extends info
	var file = FileAccess.open(path, FileAccess.READ)
	if file:
		var content = file.get_as_text()
		
		# Extract class_name
		var class_regex = RegEx.new()
		class_regex.compile("class_name\\s+([a-zA-Z_][a-zA-Z0-9_]*)")
		var result = class_regex.search(content)
		if result:
			class_name_str = result.get_string(1)
		
		# Extract extends
		var extends_regex = RegEx.new()
		extends_regex.compile("extends\\s+([a-zA-Z_][a-zA-Z0-9_]*)")
		result = extends_regex.search(content)
		if result:
			extends_class = result.get_string(1)
		
		# Add to metadata
		metadata["class_name"] = class_name_str
		metadata["extends"] = extends_class
		
		# Try to extract methods and signals
		var methods = []
		var signals = []
		
		var method_regex = RegEx.new()
		method_regex.compile("func\\s+([a-zA-Z_][a-zA-Z0-9_]*)\\s*\\(")
		var method_matches = method_regex.search_all(content)
		
		for match_result in method_matches:
			methods.append(match_result.get_string(1))
		
		var signal_regex = RegEx.new()
		signal_regex.compile("signal\\s+([a-zA-Z_][a-zA-Z0-9_]*)")
		var signal_matches = signal_regex.search_all(content)
		
		for match_result in signal_matches:
			signals.append(match_result.get_string(1))
		
		metadata["methods"] = methods
		metadata["signals"] = signals
	
	_send_success(client_id, metadata, command_id)

func _get_current_script(client_id: int, params: Dictionary, command_id: String) -> void:
	# Get editor plugin and interfaces
	var plugin = Engine.get_meta("GodotMCPPlugin")
	if not plugin:
		return _send_error(client_id, "GodotMCPPlugin not found in Engine metadata", command_id)
	
	var editor_interface = plugin.get_editor_interface()
	var script_editor = editor_interface.get_script_editor()
	var current_script = script_editor.get_current_script()
	
	if not current_script:
		return _send_success(client_id, {
			"script_found": false,
			"message": "No script is currently being edited"
		}, command_id)
	
	var script_path = current_script.resource_path
	
	# Read the script content
	var file = FileAccess.open(script_path, FileAccess.READ)
	if not file:
		return _send_error(client_id, "Failed to open script file: %s" % script_path, command_id)
	
	var content = file.get_as_text()
	file = null  # Close the file
	
	_send_success(client_id, {
		"script_found": true,
		"script_path": script_path,
		"content": content
	}, command_id)

func _create_script_template(client_id: int, params: Dictionary, command_id: String) -> void:
	var extends_type = params.get("extends_type", "Node")
	var class_name_str = params.get("class_name", "")
	var include_ready = params.get("include_ready", true)
	var include_process = params.get("include_process", false)
	var include_physics = params.get("include_physics", false)
	var include_input = params.get("include_input", false)
	
	# Generate script content
	var content = "extends " + extends_type + "\n\n"
	
	if not class_name_str.is_empty():
		content += "class_name " + class_name_str + "\n\n"
	
	# Add variables section placeholder
	content += "# Member variables here\n\n"
	
	# Add ready function
	if include_ready:
		content += "func _ready():\n\tpass\n\n"
	
	# Add process function
	if include_process:
		content += "func _process(delta):\n\tpass\n\n"
	
	# Add physics process function
	if include_physics:
		content += "func _physics_process(delta):\n\tpass\n\n"
	
	# Add input function
	if include_input:
		content += "func _input(event):\n\tpass\n\n"
	
	_send_success(client_id, {
		"content": content
	}, command_id)

func _validate_script(client_id: int, params: Dictionary, command_id: String) -> void:
	var script_path = params.get("script_path", "")
	
	# Validation
	if script_path.is_empty():
		return _send_error(client_id, "Script path cannot be empty", command_id)
	
	if not script_path.begins_with("res://"):
		script_path = "res://" + script_path
	
	if not FileAccess.file_exists(script_path):
		return _send_success(client_id, {
			"valid": false,
			"script_path": script_path,
			"errors": [{"message": "Script file does not exist", "line": 0, "type": "file"}]
		}, command_id)
	
	# Load the script
	var script = load(script_path) as GDScript
	if not script:
		return _send_success(client_id, {
			"valid": false,
			"script_path": script_path,
			"errors": [{"message": "Failed to load script", "line": 0, "type": "load"}]
		}, command_id)
	
	# Use reload() to check for errors
	var reload_error = script.reload()
	
	if reload_error != OK:
		_send_success(client_id, {
			"valid": false,
			"script_path": script_path,
			"errors": [{
				"message": "Script reload failed with error code: " + str(reload_error),
				"line": 0,
				"type": "syntax"
			}]
		}, command_id)
	else:
		_send_success(client_id, {
			"valid": true,
			"script_path": script_path,
			"errors": []
		}, command_id)

# =============================================================================
# list_scripts — Recursively finds all .gd files in the project
# =============================================================================
func _list_scripts(client_id: int, params: Dictionary, command_id: String) -> void:
	var include_addons: bool = bool(params.get("include_addons", false))
	var root_path: String = params.get("root_path", "res://")

	if not root_path.begins_with("res://"):
		root_path = "res://" + root_path

	var scripts: Array = []
	_scan_scripts(root_path, scripts, include_addons)

	_send_success(client_id, {
		"scripts": scripts,
		"count": scripts.size()
	}, command_id)

func _scan_scripts(dir_path: String, results: Array, include_addons: bool) -> void:
	var dir = DirAccess.open(dir_path)
	if not dir:
		return

	dir.list_dir_begin()
	var file_name = dir.get_next()
	while not file_name.is_empty():
		var full_path = dir_path.path_join(file_name)
		if dir.current_is_dir():
			# Skip hidden dirs and .godot
			if not file_name.begins_with(".") and file_name != ".godot":
				if include_addons or file_name != "addons":
					_scan_scripts(full_path, results, include_addons)
		else:
			if file_name.ends_with(".gd"):
				results.append(full_path)
		file_name = dir.get_next()
	dir.list_dir_end()

# =============================================================================
# rename_file — Renames or moves a file, optionally updating res:// references
# =============================================================================
func _rename_file(client_id: int, params: Dictionary, command_id: String) -> void:
	var target_path: String = params.get("target_path", "")
	var new_path: String = params.get("new_path", "")
	var update_references: bool = bool(params.get("update_references", false))

	if target_path.is_empty():
		return _send_error(client_id, "target_path is required", command_id)
	if new_path.is_empty():
		return _send_error(client_id, "new_path is required", command_id)

	if not target_path.begins_with("res://"):
		target_path = "res://" + target_path
	if not new_path.begins_with("res://"):
		new_path = "res://" + new_path

	if not FileAccess.file_exists(target_path):
		return _send_error(client_id, "File not found: %s" % target_path, command_id)

	# Create destination directory if needed
	var dest_dir = new_path.get_base_dir()
	if not DirAccess.dir_exists_absolute(dest_dir):
		var err = DirAccess.make_dir_recursive_absolute(dest_dir)
		if err != OK:
			return _send_error(client_id, "Failed to create destination directory: %s" % dest_dir, command_id)

	# Rename/move the file
	var dir = DirAccess.open("res://")
	if not dir:
		return _send_error(client_id, "Failed to access project directory", command_id)

	var err = dir.rename(target_path, new_path)
	if err != OK:
		return _send_error(client_id, "Failed to rename file: error %d" % err, command_id)

	# Also move the .uid file if it exists
	var uid_old = target_path + ".uid"
	var uid_new = new_path + ".uid"
	if FileAccess.file_exists(uid_old):
		dir.rename(uid_old, uid_new)

	var references_updated: int = 0

	# Optionally update references in other files
	if update_references:
		var files_to_check: Array = []
		_scan_all_text_files("res://", files_to_check)

		for file_path in files_to_check:
			if file_path == new_path:
				continue
			var f = FileAccess.open(file_path, FileAccess.READ)
			if not f:
				continue
			var content = f.get_as_text()
			f = null

			if content.contains(target_path):
				var updated = content.replace(target_path, new_path)
				var fw = FileAccess.open(file_path, FileAccess.WRITE)
				if fw:
					fw.store_string(updated)
					fw = null
					references_updated += 1

	# Refresh editor filesystem
	var plugin = Engine.get_meta("GodotMCPPlugin")
	if plugin:
		plugin.get_editor_interface().get_resource_filesystem().scan()

	_send_success(client_id, {
		"old_path": target_path,
		"new_path": new_path,
		"references_updated": references_updated
	}, command_id)

func _scan_all_text_files(dir_path: String, results: Array) -> void:
	var dir = DirAccess.open(dir_path)
	if not dir:
		return
	dir.list_dir_begin()
	var file_name = dir.get_next()
	while not file_name.is_empty():
		var full_path = dir_path.path_join(file_name)
		if dir.current_is_dir():
			if not file_name.begins_with(".") and file_name != ".godot":
				_scan_all_text_files(full_path, results)
		else:
			if file_name.ends_with(".gd") or file_name.ends_with(".tscn") or file_name.ends_with(".tres") or file_name.ends_with(".cfg"):
				results.append(full_path)
		file_name = dir.get_next()
	dir.list_dir_end()

# =============================================================================
# delete_file — Deletes a file with safety checks
# =============================================================================
func _delete_file(client_id: int, params: Dictionary, command_id: String) -> void:
	var target_path: String = params.get("target_path", "")

	if target_path.is_empty():
		return _send_error(client_id, "target_path is required", command_id)

	if not target_path.begins_with("res://"):
		target_path = "res://" + target_path

	# Safety: prevent deleting outside project
	if target_path == "res://" or target_path == "res://project.godot":
		return _send_error(client_id, "Cannot delete critical project files", command_id)

	if not FileAccess.file_exists(target_path):
		return _send_error(client_id, "File not found: %s" % target_path, command_id)

	# Delete the file
	var dir = DirAccess.open(target_path.get_base_dir())
	if not dir:
		return _send_error(client_id, "Failed to access directory", command_id)

	var err = dir.remove(target_path.get_file())
	if err != OK:
		return _send_error(client_id, "Failed to delete file: error %d" % err, command_id)

	# Also delete .uid file if exists
	var uid_path = target_path + ".uid"
	if FileAccess.file_exists(uid_path):
		dir.remove(uid_path.get_file())

	# Refresh editor filesystem
	var plugin = Engine.get_meta("GodotMCPPlugin")
	if plugin:
		plugin.get_editor_interface().get_resource_filesystem().scan()

	_send_success(client_id, {
		"deleted": target_path
	}, command_id)

# =============================================================================
# create_folder — Creates a directory at a res:// path
# =============================================================================
func _create_folder(client_id: int, params: Dictionary, command_id: String) -> void:
	var folder_path: String = params.get("folder_path", "")

	if folder_path.is_empty():
		return _send_error(client_id, "folder_path is required", command_id)

	if not folder_path.begins_with("res://"):
		folder_path = "res://" + folder_path

	if DirAccess.dir_exists_absolute(folder_path):
		return _send_success(client_id, {
			"folder_path": folder_path,
			"already_existed": true
		}, command_id)

	var err = DirAccess.make_dir_recursive_absolute(folder_path)
	if err != OK:
		return _send_error(client_id, "Failed to create folder: error %d" % err, command_id)

	# Refresh editor filesystem
	var plugin = Engine.get_meta("GodotMCPPlugin")
	if plugin:
		plugin.get_editor_interface().get_resource_filesystem().scan()

	_send_success(client_id, {
		"folder_path": folder_path,
		"already_existed": false
	}, command_id)
