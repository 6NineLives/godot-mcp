# test_bridge.gd — E2E Game Testing Bridge Autoload
#
# Drop this into a Godot project as an autoload. It runs a WebSocket server
# inside the game process on port 9081 and processes JSON-RPC commands from
# the MCP server in the _process() loop.
#
# Install via: manage_game_bridge action "install"
# Or manually add as autoload named "TestBridge" in Project Settings.

extends Node

const PORT := 9081
const MAX_RESULTS := 1000

var _server: TCPServer = null
var _peers: Array = []
var _pending_waits: Array = []

func _ready() -> void:
	_server = TCPServer.new()
	var err = _server.listen(PORT)
	if err != OK:
		push_error("[TestBridge] Failed to listen on port %d: %s" % [PORT, error_string(err)])
		return
	print("[TestBridge] Listening on ws://localhost:%d" % PORT)

func _process(_delta: float) -> void:
	# Accept new TCP connections
	if _server and _server.is_connection_available():
		var tcp = _server.take_connection()
		if tcp:
			var peer = WebSocketPeer.new()
			peer.accept_stream(tcp)
			_peers.append(peer)
			print("[TestBridge] Client connected")

	# Poll existing peers
	var to_remove := []
	for i in range(_peers.size()):
		var peer: WebSocketPeer = _peers[i]
		peer.poll()

		match peer.get_ready_state():
			WebSocketPeer.STATE_OPEN:
				while peer.get_available_packet_count() > 0:
					var data = peer.get_packet().get_string_from_utf8()
					_handle_message(peer, data)
			WebSocketPeer.STATE_CLOSING:
				pass
			WebSocketPeer.STATE_CLOSED:
				to_remove.append(i)
				print("[TestBridge] Client disconnected")

	# Remove closed peers (backwards to preserve indices)
	for i in range(to_remove.size() - 1, -1, -1):
		_peers.remove_at(to_remove[i])

	# Process pending waits
	_process_waits()

func _exit_tree() -> void:
	for peer in _peers:
		peer.close()
	_peers.clear()
	if _server:
		_server.stop()
	print("[TestBridge] Stopped")

# ---------------------------------------------------------------------------
# Message handling
# ---------------------------------------------------------------------------

func _handle_message(peer: WebSocketPeer, data: String) -> void:
	var json = JSON.new()
	var err = json.parse(data)
	if err != OK:
		_send_error(peer, "parse_error", -32700, "Invalid JSON")
		return

	var request = json.data
	if typeof(request) != TYPE_DICTIONARY:
		_send_error(peer, "0", -32600, "Invalid request")
		return

	var id = str(request.get("id", "0"))
	var method = request.get("method", "")
	var params = request.get("params", {})

	if method.is_empty():
		_send_error(peer, id, -32600, "Missing method")
		return

	# Dispatch
	match method:
		# Scene tree
		"get_tree":
			_cmd_get_tree(peer, id, params)
		"find_nodes":
			_cmd_find_nodes(peer, id, params)
		"get_node_properties":
			_cmd_get_node_properties(peer, id, params)
		"set_node_property":
			_cmd_set_node_property(peer, id, params)
		"call_method":
			_cmd_call_method(peer, id, params)
		"reset_scene":
			_cmd_reset_scene(peer, id, params)
		"load_scene":
			_cmd_load_scene(peer, id, params)

		# Input
		"send_key":
			_cmd_send_key(peer, id, params)
		"send_mouse_click":
			_cmd_send_mouse_click(peer, id, params)
		"send_mouse_drag":
			_cmd_send_mouse_drag(peer, id, params)
		"send_text":
			_cmd_send_text(peer, id, params)

		# Game state
		"get_singleton":
			_cmd_get_singleton(peer, id, params)
		"evaluate_expression":
			_cmd_evaluate_expression(peer, id, params)
		"get_performance_metrics":
			_cmd_get_performance_metrics(peer, id, params)
		"get_viewport_info":
			_cmd_get_viewport_info(peer, id, params)

		# Wait
		"wait_for_node":
			_cmd_wait_for_node(peer, id, params)
		"wait_for_property":
			_cmd_wait_for_property(peer, id, params)
		"wait_for_signal":
			_cmd_wait_for_signal(peer, id, params)
		"wait_for_condition":
			_cmd_wait_for_condition(peer, id, params)

		# Visual
		"take_screenshot":
			_cmd_take_screenshot(peer, id, params)

		# Status
		"ping":
			_send_result(peer, id, {"pong": true, "scene": get_tree().current_scene.scene_file_path if get_tree().current_scene else ""})

		_:
			_send_error(peer, id, -32601, "Unknown method: %s" % method)

# ---------------------------------------------------------------------------
# Scene tree commands
# ---------------------------------------------------------------------------

func _cmd_get_tree(peer: WebSocketPeer, id: String, params: Dictionary) -> void:
	var root = get_tree().current_scene
	if not root:
		return _send_error(peer, id, -1, "No current scene")

	var max_depth = params.get("max_depth", 10)
	var tree_data = _serialize_node(root, 0, max_depth)
	_send_result(peer, id, {"tree": tree_data, "scene": root.scene_file_path})

func _cmd_find_nodes(peer: WebSocketPeer, id: String, params: Dictionary) -> void:
	var root = get_tree().current_scene
	if not root:
		return _send_error(peer, id, -1, "No current scene")

	var pattern = params.get("pattern", "")
	var type_filter = params.get("type", "")
	var group = params.get("group", "")
	var results := []

	if not group.is_empty():
		# Find by group membership
		var nodes = get_tree().get_nodes_in_group(group)
		for node in nodes:
			if results.size() >= MAX_RESULTS:
				break
			if not type_filter.is_empty() and not node.is_class(type_filter):
				continue
			results.append(_node_summary(node))
	else:
		# Recursive search
		_find_nodes_recursive(root, pattern, type_filter, results)

	_send_result(peer, id, {"count": results.size(), "nodes": results, "capped": results.size() >= MAX_RESULTS})

func _cmd_get_node_properties(peer: WebSocketPeer, id: String, params: Dictionary) -> void:
	var node_path = params.get("node_path", "")
	if node_path.is_empty():
		return _send_error(peer, id, -1, "node_path required")

	var node = _resolve_node(node_path)
	if not node:
		return _send_error(peer, id, -1, "Node not found: %s" % node_path)

	var filter = params.get("filter", [])
	var props := {}

	if filter.size() > 0:
		for prop_name in filter:
			if node.get(prop_name) != null or prop_name in node:
				props[prop_name] = _serialize_value(node.get(prop_name))
	else:
		for prop in node.get_property_list():
			if prop.usage & PROPERTY_USAGE_EDITOR:
				props[prop.name] = _serialize_value(node.get(prop.name))

	_send_result(peer, id, {
		"node_path": str(node.get_path()),
		"class": node.get_class(),
		"properties": props
	})

func _cmd_set_node_property(peer: WebSocketPeer, id: String, params: Dictionary) -> void:
	var node_path = params.get("node_path", "")
	var property = params.get("property", "")
	var value = params.get("value")

	if node_path.is_empty() or property.is_empty():
		return _send_error(peer, id, -1, "node_path and property required")

	var node = _resolve_node(node_path)
	if not node:
		return _send_error(peer, id, -1, "Node not found: %s" % node_path)

	var parsed_value = _parse_value(value)
	node.set(property, parsed_value)

	_send_result(peer, id, {
		"node_path": str(node.get_path()),
		"property": property,
		"new_value": _serialize_value(node.get(property))
	})

func _cmd_call_method(peer: WebSocketPeer, id: String, params: Dictionary) -> void:
	var node_path = params.get("node_path", "")
	var method_name = params.get("method", "")
	var args = params.get("args", [])

	if node_path.is_empty() or method_name.is_empty():
		return _send_error(peer, id, -1, "node_path and method required")

	# Block dangerous methods
	var blocked = ["queue_free", "free", "set_script", "remove_child", "queue_redraw"]
	if method_name in blocked:
		return _send_error(peer, id, -1, "Method '%s' is blocked for safety" % method_name)

	var node = _resolve_node(node_path)
	if not node:
		return _send_error(peer, id, -1, "Node not found: %s" % node_path)

	if not node.has_method(method_name):
		return _send_error(peer, id, -1, "Node '%s' has no method '%s'" % [node_path, method_name])

	var result = node.callv(method_name, args)
	_send_result(peer, id, {"return_value": _serialize_value(result)})

func _cmd_reset_scene(peer: WebSocketPeer, id: String, _params: Dictionary) -> void:
	var current = get_tree().current_scene
	if not current:
		return _send_error(peer, id, -1, "No current scene")

	var scene_path = current.scene_file_path
	get_tree().reload_current_scene()
	_send_result(peer, id, {"reloaded": scene_path})

func _cmd_load_scene(peer: WebSocketPeer, id: String, params: Dictionary) -> void:
	var scene_path = params.get("scene_path", "")
	if scene_path.is_empty():
		return _send_error(peer, id, -1, "scene_path required")

	if not scene_path.begins_with("res://"):
		scene_path = "res://" + scene_path

	var err = get_tree().change_scene_to_file(scene_path)
	if err != OK:
		return _send_error(peer, id, -1, "Failed to load scene: %s (%s)" % [scene_path, error_string(err)])

	_send_result(peer, id, {"loaded": scene_path})

# ---------------------------------------------------------------------------
# Input commands
# ---------------------------------------------------------------------------

func _cmd_send_key(peer: WebSocketPeer, id: String, params: Dictionary) -> void:
	var key_name = params.get("key", "")
	var pressed = params.get("pressed", true)
	var duration_ms = params.get("duration_ms", 100)

	if key_name.is_empty():
		return _send_error(peer, id, -1, "key required")

	# Try as action first
	if InputMap.has_action(key_name):
		if pressed:
			Input.action_press(key_name)
			if duration_ms > 0:
				await get_tree().create_timer(duration_ms / 1000.0).timeout
				Input.action_release(key_name)
		else:
			Input.action_release(key_name)
		_send_result(peer, id, {"action": key_name, "pressed": pressed})
		return

	# Try as physical key
	var keycode = OS.find_keycode_from_string(key_name)
	if keycode == KEY_NONE:
		return _send_error(peer, id, -1, "Unknown key or action: %s" % key_name)

	var event = InputEventKey.new()
	event.keycode = keycode
	event.pressed = pressed
	event.physical_keycode = keycode
	Input.parse_input_event(event)

	if pressed and duration_ms > 0:
		await get_tree().create_timer(duration_ms / 1000.0).timeout
		event = InputEventKey.new()
		event.keycode = keycode
		event.pressed = false
		event.physical_keycode = keycode
		Input.parse_input_event(event)

	_send_result(peer, id, {"key": key_name, "keycode": keycode, "pressed": pressed})

func _cmd_send_mouse_click(peer: WebSocketPeer, id: String, params: Dictionary) -> void:
	var x = params.get("x", 0)
	var y = params.get("y", 0)
	var button = params.get("button", MOUSE_BUTTON_LEFT)
	var double = params.get("double_click", false)

	var event = InputEventMouseButton.new()
	event.position = Vector2(x, y)
	event.global_position = Vector2(x, y)
	event.button_index = button
	event.pressed = true
	event.double_click = double
	Input.parse_input_event(event)

	await get_tree().create_timer(0.05).timeout

	event = InputEventMouseButton.new()
	event.position = Vector2(x, y)
	event.global_position = Vector2(x, y)
	event.button_index = button
	event.pressed = false
	Input.parse_input_event(event)

	_send_result(peer, id, {"clicked": true, "position": {"x": x, "y": y}, "button": button})

func _cmd_send_mouse_drag(peer: WebSocketPeer, id: String, params: Dictionary) -> void:
	var from_x = params.get("from_x", 0)
	var from_y = params.get("from_y", 0)
	var to_x = params.get("to_x", 0)
	var to_y = params.get("to_y", 0)
	var steps = params.get("steps", 10)
	var duration_ms = params.get("duration_ms", 200)
	var button = params.get("button", MOUSE_BUTTON_LEFT)

	# Press
	var press_event = InputEventMouseButton.new()
	press_event.position = Vector2(from_x, from_y)
	press_event.global_position = Vector2(from_x, from_y)
	press_event.button_index = button
	press_event.pressed = true
	Input.parse_input_event(press_event)

	# Move
	var step_delay = (duration_ms / 1000.0) / steps
	for i in range(steps + 1):
		var t = float(i) / steps
		var pos = Vector2(
			lerp(float(from_x), float(to_x), t),
			lerp(float(from_y), float(to_y), t)
		)
		var move_event = InputEventMouseMotion.new()
		move_event.position = pos
		move_event.global_position = pos
		Input.parse_input_event(move_event)
		await get_tree().create_timer(step_delay).timeout

	# Release
	var release_event = InputEventMouseButton.new()
	release_event.position = Vector2(to_x, to_y)
	release_event.global_position = Vector2(to_x, to_y)
	release_event.button_index = button
	release_event.pressed = false
	Input.parse_input_event(release_event)

	_send_result(peer, id, {"dragged": true, "from": {"x": from_x, "y": from_y}, "to": {"x": to_x, "y": to_y}})

func _cmd_send_text(peer: WebSocketPeer, id: String, params: Dictionary) -> void:
	var text = params.get("text", "")
	var delay_ms = params.get("delay_ms", 50)

	if text.is_empty():
		return _send_error(peer, id, -1, "text required")

	for ch in text:
		var keycode = ch.unicode_at(0)
		var event = InputEventKey.new()
		event.unicode = keycode
		event.pressed = true
		Input.parse_input_event(event)

		event = InputEventKey.new()
		event.unicode = keycode
		event.pressed = false
		Input.parse_input_event(event)

		if delay_ms > 0:
			await get_tree().create_timer(delay_ms / 1000.0).timeout

	_send_result(peer, id, {"typed": text, "length": text.length()})

# ---------------------------------------------------------------------------
# Game state commands
# ---------------------------------------------------------------------------

func _cmd_get_singleton(peer: WebSocketPeer, id: String, params: Dictionary) -> void:
	var singleton_name = params.get("name", "")
	if singleton_name.is_empty():
		return _send_error(peer, id, -1, "name required")

	# Validate no path traversal
	if ".." in singleton_name or "/" in singleton_name:
		return _send_error(peer, id, -1, "Invalid singleton name (path traversal)")

	if not Engine.has_singleton(singleton_name):
		# Also try as autoload
		var autoload = get_node_or_null("/root/" + singleton_name)
		if not autoload:
			return _send_error(peer, id, -1, "Singleton not found: %s" % singleton_name)

		var filter = params.get("filter", [])
		var props = _get_node_props(autoload, filter)
		_send_result(peer, id, {"name": singleton_name, "type": "autoload", "properties": props})
		return

	var singleton = Engine.get_singleton(singleton_name)
	_send_result(peer, id, {"name": singleton_name, "type": "engine_singleton", "class": singleton.get_class() if singleton else "null"})

func _cmd_evaluate_expression(peer: WebSocketPeer, id: String, params: Dictionary) -> void:
	var expr_text = params.get("expression", "")
	if expr_text.is_empty():
		return _send_error(peer, id, -1, "expression required")

	var expression = Expression.new()
	var err = expression.parse(expr_text)
	if err != OK:
		return _send_error(peer, id, -1, "Expression parse error: %s" % expression.get_error_text())

	var base = get_tree().current_scene
	var result = expression.execute([], base, true)

	if expression.has_execute_failed():
		return _send_error(peer, id, -1, "Expression execution error: %s" % expression.get_error_text())

	_send_result(peer, id, {"expression": expr_text, "result": _serialize_value(result)})

func _cmd_get_performance_metrics(peer: WebSocketPeer, id: String, _params: Dictionary) -> void:
	var metrics = {
		"fps": Performance.get_monitor(Performance.TIME_FPS),
		"process_time": Performance.get_monitor(Performance.TIME_PROCESS),
		"physics_time": Performance.get_monitor(Performance.TIME_PHYSICS_PROCESS),
		"memory_static": Performance.get_monitor(Performance.MEMORY_STATIC),
		"memory_static_max": Performance.get_monitor(Performance.MEMORY_STATIC_MAX),
		"object_count": Performance.get_monitor(Performance.OBJECT_COUNT),
		"object_node_count": Performance.get_monitor(Performance.OBJECT_NODE_COUNT),
		"object_orphan_count": Performance.get_monitor(Performance.OBJECT_ORPHAN_NODE_COUNT),
		"render_objects_in_frame": Performance.get_monitor(Performance.RENDER_TOTAL_OBJECTS_IN_FRAME),
		"render_draw_calls": Performance.get_monitor(Performance.RENDER_TOTAL_DRAW_CALLS_IN_FRAME),
	}
	_send_result(peer, id, metrics)

func _cmd_get_viewport_info(peer: WebSocketPeer, id: String, _params: Dictionary) -> void:
	var viewport = get_viewport()
	var info = {
		"size": {"width": viewport.get_visible_rect().size.x, "height": viewport.get_visible_rect().size.y},
		"world_2d": viewport.world_2d != null,
		"world_3d": viewport.world_3d != null,
	}

	# Camera info
	var cam2d = viewport.get_camera_2d()
	if cam2d:
		info["camera_2d"] = {
			"position": {"x": cam2d.global_position.x, "y": cam2d.global_position.y},
			"zoom": {"x": cam2d.zoom.x, "y": cam2d.zoom.y}
		}

	var cam3d = viewport.get_camera_3d()
	if cam3d:
		info["camera_3d"] = {
			"position": {"x": cam3d.global_position.x, "y": cam3d.global_position.y, "z": cam3d.global_position.z},
			"fov": cam3d.fov
		}

	_send_result(peer, id, info)

# ---------------------------------------------------------------------------
# Wait commands
# ---------------------------------------------------------------------------

func _cmd_wait_for_node(peer: WebSocketPeer, id: String, params: Dictionary) -> void:
	var node_path = params.get("node_path", "")
	var timeout_ms = params.get("timeout_ms", 5000)

	if node_path.is_empty():
		return _send_error(peer, id, -1, "node_path required")

	_pending_waits.append({
		"type": "node",
		"peer": peer,
		"id": id,
		"node_path": node_path,
		"timeout": Time.get_ticks_msec() + timeout_ms,
	})

func _cmd_wait_for_property(peer: WebSocketPeer, id: String, params: Dictionary) -> void:
	var node_path = params.get("node_path", "")
	var property = params.get("property", "")
	var expected = params.get("expected")
	var timeout_ms = params.get("timeout_ms", 5000)

	if node_path.is_empty() or property.is_empty():
		return _send_error(peer, id, -1, "node_path and property required")

	_pending_waits.append({
		"type": "property",
		"peer": peer,
		"id": id,
		"node_path": node_path,
		"property": property,
		"expected": expected,
		"timeout": Time.get_ticks_msec() + timeout_ms,
	})

func _cmd_wait_for_signal(peer: WebSocketPeer, id: String, params: Dictionary) -> void:
	var node_path = params.get("node_path", "")
	var signal_name = params.get("signal_name", "")
	var timeout_ms = params.get("timeout_ms", 5000)

	if node_path.is_empty() or signal_name.is_empty():
		return _send_error(peer, id, -1, "node_path and signal_name required")

	var node = _resolve_node(node_path)
	if not node:
		return _send_error(peer, id, -1, "Node not found: %s" % node_path)

	if not node.has_signal(signal_name):
		return _send_error(peer, id, -1, "Signal '%s' not found on node '%s'" % [signal_name, node_path])

	# Wait asynchronously
	var timed_out := false
	var timer = get_tree().create_timer(timeout_ms / 1000.0)

	# Race: signal vs timeout
	var received := false
	var cb = func():
		if not received:
			received = true
			_send_result(peer, id, {"signal": signal_name, "received": true})

	node.connect(signal_name, cb, CONNECT_ONE_SHOT)

	await timer.timeout

	if not received:
		received = true  # Prevent double-send
		if node.is_connected(signal_name, cb):
			node.disconnect(signal_name, cb)
		_send_result(peer, id, {"signal": signal_name, "received": false, "timed_out": true})

func _cmd_wait_for_condition(peer: WebSocketPeer, id: String, params: Dictionary) -> void:
	var expression_text = params.get("expression", "")
	var timeout_ms = params.get("timeout_ms", 5000)

	if expression_text.is_empty():
		return _send_error(peer, id, -1, "expression required")

	_pending_waits.append({
		"type": "condition",
		"peer": peer,
		"id": id,
		"expression": expression_text,
		"timeout": Time.get_ticks_msec() + timeout_ms,
	})

# Process pending waits each frame
func _process_waits() -> void:
	var now = Time.get_ticks_msec()
	var to_remove := []

	for i in range(_pending_waits.size()):
		var w = _pending_waits[i]
		var resolved := false

		match w.type:
			"node":
				var node = _resolve_node(w.node_path)
				if node:
					_send_result(w.peer, w.id, {"node_path": w.node_path, "found": true})
					resolved = true
			"property":
				var node = _resolve_node(w.node_path)
				if node:
					var current = node.get(w.property)
					if str(current) == str(w.expected) or current == w.expected:
						_send_result(w.peer, w.id, {"node_path": w.node_path, "property": w.property, "value": _serialize_value(current), "matched": true})
						resolved = true
			"condition":
				var expression = Expression.new()
				var err = expression.parse(w.expression)
				if err == OK:
					var result = expression.execute([], get_tree().current_scene, true)
					if not expression.has_execute_failed() and result:
						_send_result(w.peer, w.id, {"expression": w.expression, "result": true})
						resolved = true

		if not resolved and now >= w.timeout:
			_send_result(w.peer, w.id, {"timed_out": true, "type": w.type})
			resolved = true

		if resolved:
			to_remove.append(i)

	for i in range(to_remove.size() - 1, -1, -1):
		_pending_waits.remove_at(to_remove[i])

# ---------------------------------------------------------------------------
# Visual commands
# ---------------------------------------------------------------------------

func _cmd_take_screenshot(peer: WebSocketPeer, id: String, params: Dictionary) -> void:
	var output_path = params.get("output_path", "")

	# Wait one frame for rendering to complete
	await RenderingServer.frame_post_draw

	var viewport = get_viewport()
	var texture = viewport.get_texture()
	if not texture:
		return _send_error(peer, id, -1, "Failed to get viewport texture")

	var image = texture.get_image()
	if not image:
		return _send_error(peer, id, -1, "Failed to get image from viewport")

	if not output_path.is_empty():
		# Save to file
		var err = image.save_png(output_path)
		if err != OK:
			return _send_error(peer, id, -1, "Failed to save screenshot: %s" % error_string(err))
		_send_result(peer, id, {"saved": true, "path": output_path, "size": {"width": image.get_width(), "height": image.get_height()}})
	else:
		# Return base64
		var png_data = image.save_png_to_buffer()
		var base64_str = Marshalls.raw_to_base64(png_data)
		_send_result(peer, id, {"base64_png": base64_str, "size": {"width": image.get_width(), "height": image.get_height()}})

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

func _resolve_node(path: String) -> Node:
	if path.is_empty():
		return get_tree().current_scene

	# Try as absolute path first
	if path.begins_with("/"):
		return get_node_or_null(path)

	# Try relative to current scene
	var scene = get_tree().current_scene
	if scene:
		return scene.get_node_or_null(path)
	return null

func _serialize_node(node: Node, depth: int, max_depth: int) -> Dictionary:
	var data := {
		"name": node.name,
		"class": node.get_class(),
		"path": str(node.get_path()),
	}

	if node is Node2D:
		data["position"] = {"x": node.position.x, "y": node.position.y}
	elif node is Node3D:
		data["position"] = {"x": node.position.x, "y": node.position.y, "z": node.position.z}
	elif node is Control:
		data["position"] = {"x": node.position.x, "y": node.position.y}
		data["size"] = {"width": node.size.x, "height": node.size.y}

	if node.get_child_count() > 0 and depth < max_depth:
		var children := []
		for child in node.get_children():
			children.append(_serialize_node(child, depth + 1, max_depth))
		data["children"] = children
	elif node.get_child_count() > 0:
		data["child_count"] = node.get_child_count()

	return data

func _node_summary(node: Node) -> Dictionary:
	return {
		"name": node.name,
		"class": node.get_class(),
		"path": str(node.get_path()),
	}

func _find_nodes_recursive(node: Node, pattern: String, type_filter: String, results: Array) -> void:
	if results.size() >= MAX_RESULTS:
		return

	var matches := true
	if not pattern.is_empty() and not pattern in node.name:
		matches = false
	if not type_filter.is_empty() and not node.is_class(type_filter):
		matches = false

	if matches and (not pattern.is_empty() or not type_filter.is_empty()):
		results.append(_node_summary(node))

	for child in node.get_children():
		_find_nodes_recursive(child, pattern, type_filter, results)

func _serialize_value(value) -> Variant:
	match typeof(value):
		TYPE_VECTOR2:
			return {"x": value.x, "y": value.y}
		TYPE_VECTOR3:
			return {"x": value.x, "y": value.y, "z": value.z}
		TYPE_COLOR:
			return {"r": value.r, "g": value.g, "b": value.b, "a": value.a}
		TYPE_RECT2:
			return {"x": value.position.x, "y": value.position.y, "width": value.size.x, "height": value.size.y}
		TYPE_TRANSFORM2D:
			return str(value)
		TYPE_TRANSFORM3D:
			return str(value)
		TYPE_OBJECT:
			if value == null:
				return null
			if value is Resource:
				return value.resource_path if value.resource_path != "" else str(value)
			return str(value)
		TYPE_ARRAY:
			var arr = []
			for item in value:
				arr.append(_serialize_value(item))
			return arr
		TYPE_DICTIONARY:
			var dict = {}
			for key in value:
				dict[key] = _serialize_value(value[key])
			return dict
		_:
			return value

func _parse_value(value) -> Variant:
	if typeof(value) != TYPE_STRING:
		return value
	# Try parsing Godot type expressions
	if value.begins_with("Vector2") or value.begins_with("Vector3") or value.begins_with("Color"):
		var expression = Expression.new()
		if expression.parse(value) == OK:
			var result = expression.execute([], null, true)
			if not expression.has_execute_failed():
				return result
	return value

func _get_node_props(node: Node, filter: Array) -> Dictionary:
	var props := {}
	if filter.size() > 0:
		for prop_name in filter:
			props[prop_name] = _serialize_value(node.get(prop_name))
	else:
		for prop in node.get_property_list():
			if prop.usage & PROPERTY_USAGE_EDITOR:
				props[prop.name] = _serialize_value(node.get(prop.name))
	return props

func _send_result(peer: WebSocketPeer, id: String, result) -> void:
	var response = {
		"jsonrpc": "2.0",
		"id": id,
		"result": result
	}
	peer.send_text(JSON.stringify(response))

func _send_error(peer: WebSocketPeer, id: String, code: int, message: String) -> void:
	var response = {
		"jsonrpc": "2.0",
		"id": id,
		"error": {"code": code, "message": message}
	}
	peer.send_text(JSON.stringify(response))
