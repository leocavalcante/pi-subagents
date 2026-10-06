/**
 * Agent discovery and configuration
 */

import * as fs from "node:fs";
import * as path from "node:path";
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import { CONFIG_DIR_NAME, getAgentDir, parseFrontmatter } from "@earendil-works/pi-coding-agent";

export type AgentScope = "user" | "project" | "both";

export interface AgentConfig {
	name: string;
	description: string;
	tools?: string[];
	model?: string;
	thinking?: ThinkingLevel;
	systemPrompt: string;
	source: "user" | "project";
	filePath: string;
}

export interface AgentDiagnostic {
	filePath: string;
	source: "user" | "project";
	message: string;
}

export interface AgentDiscoveryResult {
	agents: AgentConfig[];
	projectAgentsDir: string | null;
	diagnostics: AgentDiagnostic[];
}

/**
 * Raw agent frontmatter. Values are `unknown` because `parseFrontmatter` runs a
 * real YAML parser, so any scalar or collection can appear here.
 *
 * A type alias rather than an interface: `parseFrontmatter` constrains its
 * parameter to `Record<string, unknown>`, and only an alias picks up the
 * implicit index signature that satisfies it.
 */
type AgentFrontmatter = {
	name?: unknown;
	description?: unknown;
	tools?: unknown;
	model?: unknown;
	thinking?: unknown;
};

export const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const satisfies readonly ThinkingLevel[];

/**
 * Normalize a frontmatter `tools` value to a list of tool names.
 *
 * Both spellings are valid YAML and both are in use:
 *
 *     tools: read, bash        # string
 *     tools: [read, bash]      # array
 *
 * so accept either. An explicit empty list disables tools; an omitted field
 * inherits defaults. Reject malformed allowlists rather than broadening access.
 */
function parseToolList(value: unknown): string[] | undefined {
	if (value === undefined) return undefined;
	const raw = Array.isArray(value) ? value : typeof value === "string" ? value.split(",") : null;
	if (!raw || !raw.every((t): t is string => typeof t === "string")) {
		throw new Error("tools must be a comma-separated string or an array of strings.");
	}
	return [...new Set(raw.map((t: string) => t.trim()).filter(Boolean))];
}

function loadAgentsFromDir(dir: string, source: "user" | "project", diagnostics: AgentDiagnostic[]): AgentConfig[] {
	const agents: AgentConfig[] = [];

	if (!fs.existsSync(dir)) {
		return agents;
	}

	let entries: fs.Dirent[];
	try {
		entries = fs.readdirSync(dir, { withFileTypes: true });
	} catch {
		diagnostics.push({ filePath: dir, source, message: "Unable to read agent directory." });
		return agents;
	}

	for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
		if (!entry.name.endsWith(".md")) continue;
		if (!entry.isFile() && !entry.isSymbolicLink()) continue;

		const filePath = path.join(dir, entry.name);
		try {
			const content = fs.readFileSync(filePath, "utf-8");
			let parsed: ReturnType<typeof parseFrontmatter<AgentFrontmatter>>;
			try {
				parsed = parseFrontmatter<AgentFrontmatter>(content);
			} catch {
				// YAML errors can include source excerpts; do not echo private prompts.
				throw new Error("Invalid YAML frontmatter.");
			}
			const { frontmatter, body } = parsed;
			if (!frontmatter || typeof frontmatter !== "object" || Array.isArray(frontmatter)) {
				throw new Error("Frontmatter must be a mapping.");
			}
			if (
				typeof frontmatter.name !== "string" || !frontmatter.name.trim() ||
				typeof frontmatter.description !== "string" || !frontmatter.description.trim()
			) {
				throw new Error("name and description must be non-empty strings.");
			}
			if (frontmatter.model !== undefined && typeof frontmatter.model !== "string") {
				throw new Error("model must be a string.");
			}
			const thinking = frontmatter.thinking;
			if (thinking !== undefined && !THINKING_LEVELS.includes(thinking as ThinkingLevel)) {
				throw new Error(`thinking must be one of: ${THINKING_LEVELS.join(", ")}.`);
			}
			agents.push({
				name: frontmatter.name.trim(),
				description: frontmatter.description.trim(),
				tools: parseToolList(frontmatter.tools),
				model: frontmatter.model?.trim() || undefined,
				thinking: thinking as ThinkingLevel | undefined,
				systemPrompt: body,
				source,
				filePath,
			});
		} catch (error) {
			diagnostics.push({ filePath, source, message: error instanceof Error ? error.message : "Unable to load agent." });
		}
	}

	return agents;
}

function isDirectory(p: string): boolean {
	try {
		return fs.statSync(p).isDirectory();
	} catch {
		return false;
	}
}

function findNearestProjectAgentsDir(cwd: string): string | null {
	let currentDir = path.resolve(cwd);
	while (true) {
		const candidate = path.join(currentDir, CONFIG_DIR_NAME, "agents");
		if (isDirectory(candidate)) return candidate;

		const parentDir = path.dirname(currentDir);
		if (parentDir === currentDir) return null;
		currentDir = parentDir;
	}
}

export function discoverAgents(cwd: string, scope: AgentScope): AgentDiscoveryResult {
	const userDir = path.join(getAgentDir(), "agents");
	const projectAgentsDir = findNearestProjectAgentsDir(cwd);

	const diagnostics: AgentDiagnostic[] = [];
	const userAgents = scope === "project" ? [] : loadAgentsFromDir(userDir, "user", diagnostics);
	const projectAgents = scope === "user" || !projectAgentsDir
		? [] : loadAgentsFromDir(projectAgentsDir, "project", diagnostics);

	const agentMap = new Map<string, AgentConfig>();

	if (scope === "both") {
		for (const agent of userAgents) agentMap.set(agent.name, agent);
		for (const agent of projectAgents) agentMap.set(agent.name, agent);
	} else if (scope === "user") {
		for (const agent of userAgents) agentMap.set(agent.name, agent);
	} else {
		for (const agent of projectAgents) agentMap.set(agent.name, agent);
	}

	return {
		agents: Array.from(agentMap.values()).sort((a, b) => a.name.localeCompare(b.name)),
		projectAgentsDir,
		diagnostics,
	};
}

export function formatAgentList(agents: AgentConfig[], maxItems: number): { text: string; remaining: number } {
	if (agents.length === 0) return { text: "none", remaining: 0 };
	const listed = agents.slice(0, maxItems);
	const remaining = agents.length - listed.length;
	return {
		text: listed.map((a) => `${a.name} (${a.source}): ${a.description}`).join("; "),
		remaining,
	};
}
