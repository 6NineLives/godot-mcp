@tool
class_name MCPAnimationCommands
extends MCPBaseCommandProcessor

func process_command(client_id: int, command_type: String, params: Dictionary, command_id: String) -> bool:
	match command_type:
		"create_animation":
			_create_animation(client_id, params, command_id)
			return true
		"add_keyframes":
			_add_keyframes(client_id, params, command_id)
			return true
		"setup_animation_tree":
			_setup_animation_tree(client_id, params, command_id)
			return true
	return false  # Command not handled


func _create_animation(client_id: int, params: Dictionary, command_id: String) -> void:
	var anim_player_path = params.get("animation_player_path", "")
	var anim_name = params.get("animation_name", "default")
	var length = params.get("length", 1.0)
	var loop_mode_str = params.get("loop_mode", "none")
	
	# Validation
	if anim_player_path.is_empty():
		return _send_error(client_id, "animation_player_path cannot be empty", command_id)
	
	# Get the AnimationPlayer node
	var anim_player = _get_editor_node(anim_player_path)
	if not anim_player:
		return _send_error(client_id, "AnimationPlayer not found: %s" % anim_player_path, command_id)
	
	if not anim_player is AnimationPlayer:
		return _send_error(client_id, "Node at %s is not an AnimationPlayer (is %s)" % [anim_player_path, anim_player.get_class()], command_id)
	
	# Create the Animation resource
	var animation = Animation.new()
	animation.length = length
	
	# Set loop mode
	match loop_mode_str:
		"linear":
			animation.loop_mode = Animation.LOOP_LINEAR
		"pingpong":
			animation.loop_mode = Animation.LOOP_PINGPONG
		_:
			animation.loop_mode = Animation.LOOP_NONE
	
	# Godot 4 uses AnimationLibrary — get or create the default library
	var library: AnimationLibrary
	if anim_player.has_animation_library(""):
		library = anim_player.get_animation_library("")
	else:
		library = AnimationLibrary.new()
		anim_player.add_animation_library("", library)
	
	# Add the animation to the library
	var err = library.add_animation(anim_name, animation)
	if err != OK:
		return _send_error(client_id, "Failed to add animation '%s': error code %d" % [anim_name, err], command_id)
	
	# Mark the scene as modified
	_mark_scene_modified()
	
	_send_success(client_id, {
		"animation_player_path": anim_player_path,
		"animation_name": anim_name,
		"length": length,
		"loop_mode": loop_mode_str
	}, command_id)


func _add_keyframes(client_id: int, params: Dictionary, command_id: String) -> void:
	var anim_player_path = params.get("animation_player_path", "")
	var anim_name = params.get("animation_name", "")
	var track_path_str = params.get("track_path", "")
	var track_type_str = params.get("track_type", "value")
	var keyframes = params.get("keyframes", [])
	
	# Validation
	if anim_player_path.is_empty():
		return _send_error(client_id, "animation_player_path cannot be empty", command_id)
	if anim_name.is_empty():
		return _send_error(client_id, "animation_name cannot be empty", command_id)
	if track_path_str.is_empty():
		return _send_error(client_id, "track_path cannot be empty", command_id)
	if keyframes.is_empty():
		return _send_error(client_id, "keyframes array cannot be empty", command_id)
	
	# Get the AnimationPlayer node
	var anim_player = _get_editor_node(anim_player_path)
	if not anim_player:
		return _send_error(client_id, "AnimationPlayer not found: %s" % anim_player_path, command_id)
	
	if not anim_player is AnimationPlayer:
		return _send_error(client_id, "Node at %s is not an AnimationPlayer" % anim_player_path, command_id)
	
	# Get the animation
	var animation: Animation = null
	
	# Search through all libraries for the animation
	for lib_name in anim_player.get_animation_library_list():
		var lib = anim_player.get_animation_library(lib_name)
		if lib.has_animation(anim_name):
			animation = lib.get_animation(anim_name)
			break
	
	if not animation:
		return _send_error(client_id, "Animation '%s' not found in AnimationPlayer" % anim_name, command_id)
	
	# Determine track type
	var track_type: Animation.TrackType
	match track_type_str:
		"method":
			track_type = Animation.TYPE_METHOD
		"bezier":
			track_type = Animation.TYPE_BEZIER
		"audio":
			track_type = Animation.TYPE_AUDIO
		"animation":
			track_type = Animation.TYPE_ANIMATION
		_:
			track_type = Animation.TYPE_VALUE
	
	# Find or create the track
	var track_idx = -1
	var node_path = NodePath(track_path_str)
	
	for i in range(animation.get_track_count()):
		if animation.track_get_path(i) == node_path and animation.track_get_type(i) == track_type:
			track_idx = i
			break
	
	if track_idx == -1:
		track_idx = animation.add_track(track_type)
		animation.track_set_path(track_idx, node_path)
	
	# Insert keyframes
	var inserted_count = 0
	for kf in keyframes:
		var time = kf.get("time", 0.0)
		var value = kf.get("value")
		
		if value == null:
			continue
		
		# Parse value for Godot types
		var parsed_value = _parse_keyframe_value(value)
		
		match track_type:
			Animation.TYPE_VALUE:
				animation.track_insert_key(track_idx, time, parsed_value)
				# Apply transition if specified
				var transition = kf.get("transition", null)
				if transition != null:
					var key_idx = animation.track_find_key(track_idx, time, Animation.FIND_MODE_EXACT)
					if key_idx >= 0:
						animation.track_set_key_transition(track_idx, key_idx, transition)
			Animation.TYPE_BEZIER:
				animation.bezier_track_insert_key(track_idx, time, parsed_value)
			_:
				animation.track_insert_key(track_idx, time, parsed_value)
		
		inserted_count += 1
	
	# Mark the scene as modified
	_mark_scene_modified()
	
	_send_success(client_id, {
		"animation_player_path": anim_player_path,
		"animation_name": anim_name,
		"track_path": track_path_str,
		"track_type": track_type_str,
		"keyframes_inserted": inserted_count
	}, command_id)


func _setup_animation_tree(client_id: int, params: Dictionary, command_id: String) -> void:
	var tree_path = params.get("tree_path", "")
	var root_type = params.get("root_type", "AnimationNodeStateMachine")
	
	# Validation
	if tree_path.is_empty():
		return _send_error(client_id, "tree_path cannot be empty", command_id)
	
	# Get the AnimationTree node
	var tree_node = _get_editor_node(tree_path)
	if not tree_node:
		return _send_error(client_id, "AnimationTree not found: %s" % tree_path, command_id)
	
	if not tree_node is AnimationTree:
		return _send_error(client_id, "Node at %s is not an AnimationTree" % tree_path, command_id)
	
	# Create the appropriate root node type
	var root_node: AnimationRootNode = null
	
	match root_type:
		"AnimationNodeStateMachine":
			root_node = AnimationNodeStateMachine.new()
		"AnimationNodeBlendTree":
			root_node = AnimationNodeBlendTree.new()
		"AnimationNodeBlendSpace1D":
			root_node = AnimationNodeBlendSpace1D.new()
		"AnimationNodeBlendSpace2D":
			root_node = AnimationNodeBlendSpace2D.new()
		_:
			return _send_error(client_id, "Unknown AnimationTree root type: %s" % root_type, command_id)
	
	# Set the tree root
	tree_node.tree_root = root_node
	
	# Mark the scene as modified
	_mark_scene_modified()
	
	_send_success(client_id, {
		"tree_path": tree_path,
		"root_type": root_type
	}, command_id)


## Parse a keyframe value that may be a Godot type encoded as a dictionary
func _parse_keyframe_value(value):
	if value is Dictionary:
		# Check for Vector2
		if value.has("x") and value.has("y") and not value.has("z"):
			return Vector2(value.x, value.y)
		# Check for Vector3
		if value.has("x") and value.has("y") and value.has("z"):
			return Vector3(value.x, value.y, value.z)
		# Check for Color
		if value.has("r") and value.has("g") and value.has("b"):
			var a = value.get("a", 1.0)
			return Color(value.r, value.g, value.b, a)
	return value
