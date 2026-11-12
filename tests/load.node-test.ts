import assert from "node:assert/strict";
import { test } from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import extension from "../index.ts";

test("the extension loads on Node.js and registers its tools, commands, and hooks", () => {
  const tools: string[] = [];
  const commands: string[] = [];
  const events: string[] = [];
  const messageRenderers: string[] = [];
  const pi = {
    registerTool(definition: { name: string }) {
      tools.push(definition.name);
    },
    registerCommand(name: string) {
      commands.push(name);
    },
    registerMessageRenderer(name: string) {
      messageRenderers.push(name);
    },
    on(event: string) {
      events.push(event);
    },
  };

  // Registration-only methods ensure loading does not run a child Pi process.
  extension(pi as unknown as ExtensionAPI);

  assert.deepEqual(tools, ["subagent_agents", "subagent_jobs", "subagent"]);
  assert.deepEqual(commands, []);
  assert.deepEqual(messageRenderers, ["subagent-background"]);
  assert.deepEqual(events, ["session_shutdown"]);
});
