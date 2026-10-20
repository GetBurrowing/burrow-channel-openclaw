import assert from "node:assert/strict";
import { buildUsageEventPayload } from "../index.ts";
import { resetPluginStateForTests, setSpaceTaskId } from "../src/plugin-state.ts";
import { buildTaskSessionKey } from "../src/session-key.ts";

function testExecutionSpaceMapping() {
  resetPluginStateForTests();

  const executionSpaceId = "exec-space-1";
  const taskId = "019d1cba-40a7-7851-b045-733cd81b7745";
  setSpaceTaskId(executionSpaceId, taskId);

  const payload = buildUsageEventPayload({
    spaceId: executionSpaceId,
    sessionKey: buildTaskSessionKey(taskId, "execution"),
    model: "claude-sonnet-4-6",
    provider: "anthropic",
    usage: { input: 120, output: 40, cacheRead: 12 },
    sessionId: "session-1",
    runId: "run-1",
  });

  assert.equal(payload.task_id, taskId, "execution-space usage should inherit mapped task_id");
  assert.equal(payload.space_id, executionSpaceId);
  assert.equal(payload.input_tokens, 120);
  assert.equal(payload.output_tokens, 40);
  assert.equal(payload.cache_read_tokens, 12);
}

function testRegularChatRemainsNull() {
  resetPluginStateForTests();

  const payload = buildUsageEventPayload({
    spaceId: "general-space",
    sessionKey: "startup-suite:group:general-space",
    model: "claude-sonnet-4-6",
    provider: "anthropic",
    usage: { input: 10, output: 5 },
    sessionId: "session-2",
    runId: "run-2",
  });

  assert.equal(payload.task_id, null, "regular chat usage should remain unscoped");
}

function testHeartbeatRefreshKeepsMappingCurrent() {
  resetPluginStateForTests();

  const executionSpaceId = "exec-space-2";
  const firstTaskId = "task-initial";
  const refreshedTaskId = "task-refreshed";

  setSpaceTaskId(executionSpaceId, firstTaskId);
  setSpaceTaskId(executionSpaceId, refreshedTaskId);

  const payload = buildUsageEventPayload({
    spaceId: executionSpaceId,
    sessionKey: buildTaskSessionKey(refreshedTaskId, "execution"),
    model: "claude-sonnet-4-6",
    provider: "anthropic",
    usage: { input: 1, output: 1 },
    sessionId: "session-3",
    runId: "run-3",
  });

  assert.equal(payload.task_id, refreshedTaskId, "latest task signal should win for the execution space");
}

function testTaskSessionFallbackWithoutMapping() {
  resetPluginStateForTests();

  const taskId = "task-from-session";
  const payload = buildUsageEventPayload({
    spaceId: null,
    sessionKey: buildTaskSessionKey(taskId, "execution"),
    model: "claude-sonnet-4-6",
    provider: "anthropic",
    usage: { input: 2, output: 3 },
    sessionId: "session-4",
    runId: "run-4",
  });

  assert.equal(payload.task_id, taskId, "task session key should still identify the task when space mapping is absent");
}

function main() {
  testExecutionSpaceMapping();
  testRegularChatRemainsNull();
  testHeartbeatRefreshKeepsMappingCurrent();
  testTaskSessionFallbackWithoutMapping();
  console.log("usage attribution regression checks passed");
}

main();
