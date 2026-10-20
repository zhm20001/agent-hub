/** Adapter protocol facts only; message contents never stand in for event envelopes. */
export interface AgentActivity { latestEvent: string | null; latestToolEvent: string | null }
export function observeCodexActivity(tail: string): AgentActivity {
  const view: AgentActivity = { latestEvent: null, latestToolEvent: null };
  for (const line of tail.split('\n')) {
    let event: any; try { event = JSON.parse(line); } catch { continue; }
    if (!event || typeof event !== 'object') continue;
    if (['thread.started', 'turn.started', 'turn.completed', 'turn.failed', 'item.started', 'item.completed', 'error'].includes(event.type)) view.latestEvent = event.type;
    if (['item.started', 'item.completed'].includes(event.type) && ['command_execution', 'mcp_tool_call', 'web_search'].includes(event.item?.type)) view.latestToolEvent = `${event.item.type}:${event.type.split('.')[1]}`;
  }
  return view;
}
export function observeZcodeActivity(tail: string): AgentActivity {
  const view: AgentActivity = { latestEvent: null, latestToolEvent: null };
  for (const line of tail.split('\n')) {
    let event: any; try { event = JSON.parse(line); } catch { continue; }
    const kind = event?.type;
    if (['model.request.started', 'model.request.completed', 'tool.call.started', 'tool.call.completed', 'turn_complete', 'model_complete'].includes(kind)) view.latestEvent = kind;
    if (['tool.call.started', 'tool.call.completed'].includes(kind)) view.latestToolEvent = kind;
  }
  return view;
}
