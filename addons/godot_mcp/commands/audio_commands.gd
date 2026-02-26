@tool
class_name MCPAudioCommands
extends MCPBaseCommandProcessor

func process_command(client_id: int, command_type: String, params: Dictionary, command_id: String) -> bool:
	match command_type:
		"get_audio_buses":
			_get_audio_buses(client_id, params, command_id)
			return true
		"get_audio_bus":
			_get_audio_bus(client_id, params, command_id)
			return true
		"set_audio_bus_volume":
			_set_audio_bus_volume(client_id, params, command_id)
			return true
		"set_audio_bus_mute":
			_set_audio_bus_mute(client_id, params, command_id)
			return true
		"play_audio_stream":
			_play_audio_stream(client_id, params, command_id)
			return true
		"stop_audio_stream":
			_stop_audio_stream(client_id, params, command_id)
			return true
	return false  # Command not handled

func _get_audio_buses(client_id: int, _params: Dictionary, command_id: String) -> void:
	var buses = []
	for i in range(AudioServer.bus_count):
		buses.append({
			"index": i,
			"name": AudioServer.get_bus_name(i),
			"volume_db": AudioServer.get_bus_volume_db(i),
			"mute": AudioServer.is_bus_mute(i)
		})
	_send_success(client_id, {"buses": buses}, command_id)

func _resolve_bus_index(bus) -> int:
	if typeof(bus) == TYPE_INT or typeof(bus) == TYPE_FLOAT:
		var idx = int(bus)
		if idx >= 0 and idx < AudioServer.bus_count:
			return idx
	elif typeof(bus) == TYPE_STRING:
		return AudioServer.get_bus_index(bus)
	return -1

func _get_audio_bus(client_id: int, params: Dictionary, command_id: String) -> void:
	var bus = params.get("bus")
	if bus == null:
		return _send_error(client_id, "Bus name or index is required", command_id)
		
	var idx = _resolve_bus_index(bus)
	if idx < 0:
		return _send_error(client_id, "Invalid audio bus: %s" % str(bus), command_id)
		
	var bus_info = {
		"index": idx,
		"name": AudioServer.get_bus_name(idx),
		"volume_db": AudioServer.get_bus_volume_db(idx),
		"mute": AudioServer.is_bus_mute(idx)
	}
	_send_success(client_id, {"bus": bus_info}, command_id)

func _set_audio_bus_volume(client_id: int, params: Dictionary, command_id: String) -> void:
	var bus = params.get("bus")
	var volume = params.get("volume", 1.0)
	var is_db = params.get("db", false)
	
	if bus == null:
		return _send_error(client_id, "Bus name or index is required", command_id)
		
	var idx = _resolve_bus_index(bus)
	if idx < 0:
		return _send_error(client_id, "Invalid audio bus: %s" % str(bus), command_id)
		
	var volume_db = float(volume)
	if not is_db:
		volume_db = linear_to_db(volume_db)
		
	AudioServer.set_bus_volume_db(idx, volume_db)
	
	_get_audio_bus(client_id, {"bus": idx}, command_id)

func _set_audio_bus_mute(client_id: int, params: Dictionary, command_id: String) -> void:
	var bus = params.get("bus")
	var mute = params.get("mute", false)
	
	if bus == null:
		return _send_error(client_id, "Bus name or index is required", command_id)
		
	var idx = _resolve_bus_index(bus)
	if idx < 0:
		return _send_error(client_id, "Invalid audio bus: %s" % str(bus), command_id)
		
	AudioServer.set_bus_mute(idx, bool(mute))
	
	_get_audio_bus(client_id, {"bus": idx}, command_id)

func _play_audio_stream(client_id: int, params: Dictionary, command_id: String) -> void:
	var stream_path = params.get("stream_path", "")
	var node_path = params.get("node_path", "")
	
	if stream_path.is_empty():
		return _send_error(client_id, "stream_path cannot be empty", command_id)
		
	if not ResourceLoader.exists(stream_path):
		return _send_error(client_id, "Audio stream resource not found: %s" % stream_path, command_id)
		
	var stream = load(stream_path)
	if not stream is AudioStream:
		return _send_error(client_id, "Resource is not an AudioStream: %s" % stream_path, command_id)
	
	if node_path.is_empty():
		# Play globally using an autoload or editor node if possible?
		# For now, let's just create a temporary node in the root
		var player = AudioStreamPlayer.new()
		player.stream = stream
		player.name = "MCPAudioPlayer_" + str(Time.get_ticks_msec())
		player.finished.connect(player.queue_free)
		
		# Adding to editor root or scene root depending on context
		var root = Engine.get_main_loop().root
		root.add_child(player)
		player.play()
		_send_success(client_id, {"playing": true, "stream_path": stream_path}, command_id)
	else:
		# Search for node
		var node = _get_editor_node(node_path)
		if not node:
			return _send_error(client_id, "Node not found: %s" % node_path, command_id)
			
		if node.has_method("play") and "stream" in node:
			node.stream = stream
			node.play()
			_send_success(client_id, {"playing": true, "stream_path": stream_path, "node_path": node_path}, command_id)
		else:
			return _send_error(client_id, "Node is not an AudioStreamPlayer or compatible: %s" % node_path, command_id)

func _stop_audio_stream(client_id: int, params: Dictionary, command_id: String) -> void:
	var node_path = params.get("node_path", "")
	
	if node_path.is_empty():
		# Try to find our global ones
		var root = Engine.get_main_loop().root
		for child in root.get_children():
			if child.name.begins_with("MCPAudioPlayer_") and child is AudioStreamPlayer:
				child.stop()
				child.queue_free()
		_send_success(client_id, {"stopped": true}, command_id)
	else:
		# Search for node
		var node = _get_editor_node(node_path)
		if not node:
			return _send_error(client_id, "Node not found: %s" % node_path, command_id)
			
		if node.has_method("stop"):
			node.stop()
			_send_success(client_id, {"stopped": true, "node_path": node_path}, command_id)
		else:
			return _send_error(client_id, "Node does not have a stop method: %s" % node_path, command_id)
