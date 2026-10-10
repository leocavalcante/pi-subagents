/**
 * Agent discovery and configuration
 */

import * as fs from "node:fs";
import { isUtf8 } from "node:buffer";
import * as path from "node:path";
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import { isWellFormedUnicode } from "./unicode.ts";
import { CONFIG_DIR_NAME, getAgentDir, parseFrontmatter } from "@earendil-works/pi-coding-agent";

export type AgentScope = "user" | "project" | "both";

export interface AgentConfig {
	name: string;
	description: string;
	tools?: string[];
	model?: string;
	thinking?: ThinkingLevel;
	timeoutMs?: number;
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
	timeoutMs?: unknown;
};

export const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const satisfies readonly ThinkingLevel[];
export const MAX_AGENT_NAME_BYTES = 256;
export const MAX_AGENT_DESCRIPTION_BYTES = 1024;
export const MAX_AGENT_TOOL_LIST_BYTES = 4 * 1024;
export const MAX_AGENT_TOOL_COUNT = 256;
export const MAX_MODEL_SELECTOR_BYTES = 512;
export const MAX_TIMEOUT_MS = 24 * 60 * 60 * 1000;
export const AGENT_NAME_PATTERN = "^[^\\u0000-\\u001f\\u007f-\\u009f\\u2028\\u2029\\u061c\\u200e\\u200f\\u202a-\\u202e\\u2066-\\u206f\\ufeff]+(?![\\s\\S])";
const INVALID_AGENT_NAME = /[\u0000-\u001f\u007f-\u009f\u2028\u2029\u061c\u200e\u200f\u202a-\u202e\u2066-\u206f\ufeff]/;
const INVALID_AGENT_TOOL_CONTROL = /[\u0000-\u001f\u007f-\u009f]/;
const INVALID_MODEL_SELECTOR_CONTROL = /[\u0000-\u001f\u007f-\u009f]/;

export function isSafeAgentName(name: string): boolean {
	// UTF-8 is never shorter than UTF-16 code units; reject large names before scanning them.
	return name.length > 0 && name.length <= MAX_AGENT_NAME_BYTES && isWellFormedUnicode(name) &&
		Buffer.byteLength(name, "utf8") <= MAX_AGENT_NAME_BYTES && name.trim().length > 0 && !INVALID_AGENT_NAME.test(name);
}

/** Keep the value passed as a child argv element well below platform command-line limits. */
export function isSafeModelSelector(value: unknown, allowBlank = false): value is string {
	return typeof value === "string" && value.length <= MAX_MODEL_SELECTOR_BYTES && isWellFormedUnicode(value) &&
		Buffer.byteLength(value, "utf8") <= MAX_MODEL_SELECTOR_BYTES &&
		(allowBlank || value.trim().length > 0) && !INVALID_MODEL_SELECTOR_CONTROL.test(value);
}

const MAX_AGENT_DIRECTORY_ENTRIES = 4096;
const MAX_AGENT_FILES = 256;
const MAX_AGENT_FILE_BYTES = 512 * 1024;
const MAX_AGENT_DIRECTORY_BYTES = 4 * 1024 * 1024;
const MAX_AGENT_DIAGNOSTICS = 64;

/** Stable across host locales and ICU versions. */
function compareLexically(left: string, right: string): number {
	return left < right ? -1 : left > right ? 1 : 0;
}

function addDiagnostic(
	diagnostics: AgentDiagnostic[],
	filePath: string,
	source: "user" | "project",
	message: string,
): void {
	if (diagnostics.length >= MAX_AGENT_DIAGNOSTICS) return;
	if (diagnostics.length === MAX_AGENT_DIAGNOSTICS - 1) {
		diagnostics.push({ filePath, source, message: "Further agent diagnostics omitted." });
		return;
	}
	diagnostics.push({ filePath, source, message });
}

/**
 * Normalize a frontmatter `tools` value to a list of tool names.
 *
 * Both spellings are valid YAML and both are in use:
 *
 *     tools: read, bash        # string
 *     tools: [read, bash]      # array
 *
 * so accept either. An explicit empty list disables tools; an omitted field
 * inherits defaults. Bound both forms before passing the normalized list through
 * one child-process argument. Reject malformed allowlists rather than broadening access.
 */
function parseToolList(value: unknown): string[] | undefined {
	if (value === undefined) return undefined;
	if (typeof value === "string" && (value.length > MAX_AGENT_TOOL_LIST_BYTES || !isWellFormedUnicode(value) ||
		Buffer.byteLength(value, "utf8") > MAX_AGENT_TOOL_LIST_BYTES)) {
		throw new Error(`tools must be valid Unicode, at most ${MAX_AGENT_TOOL_LIST_BYTES} UTF-8 bytes, and contain at most ${MAX_AGENT_TOOL_COUNT} entries.`);
	}
	if (Array.isArray(value) && value.length > MAX_AGENT_TOOL_COUNT) {
		throw new Error(`tools must be at most ${MAX_AGENT_TOOL_LIST_BYTES} UTF-8 bytes and contain at most ${MAX_AGENT_TOOL_COUNT} entries.`);
	}
	const raw = Array.isArray(value) ? value : typeof value === "string" ? value.split(",") : null;
	if (!raw || raw.length > MAX_AGENT_TOOL_COUNT || !raw.every((tool): tool is string => typeof tool === "string")) {
		throw new Error(`tools must be a comma-separated string or an array of at most ${MAX_AGENT_TOOL_COUNT} strings.`);
	}
	const tools: string[] = [];
	const seen = new Set<string>();
	let totalBytes = 0;
	for (const item of raw) {
		if (item.length > MAX_AGENT_TOOL_LIST_BYTES) {
			throw new Error(`tools must be at most ${MAX_AGENT_TOOL_LIST_BYTES} UTF-8 bytes and contain at most ${MAX_AGENT_TOOL_COUNT} entries.`);
		}
		if (!isWellFormedUnicode(item)) throw new Error("tools entries must contain well-formed Unicode.");
		const tool = item.trim();
		if (!tool) continue;
		if (tool.includes(",") || tool.startsWith("+") || tool.startsWith("-") || INVALID_AGENT_TOOL_CONTROL.test(tool)) {
			throw new Error("tools entries must not contain commas, control characters, or start with '+' or '-'.");
		}
		if (seen.has(tool)) continue;
		const bytes = Buffer.byteLength(tool, "utf8") + (tools.length > 0 ? 1 : 0);
		if (bytes > MAX_AGENT_TOOL_LIST_BYTES - totalBytes || tools.length >= MAX_AGENT_TOOL_COUNT) {
			throw new Error(`tools must be at most ${MAX_AGENT_TOOL_LIST_BYTES} UTF-8 bytes and contain at most ${MAX_AGENT_TOOL_COUNT} entries.`);
		}
		tools.push(tool);
		seen.add(tool);
		totalBytes += bytes;
	}
	return tools;
}

function isPathInside(parent: string, child: string): boolean {
	const relative = path.relative(parent, child);
	return relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

function loadAgentsFromDir(
	dir: string,
	source: "user" | "project",
	diagnostics: AgentDiagnostic[],
	projectRoot?: string,
): AgentConfig[] {
	const agents: AgentConfig[] = [];
	const sourceFiles = new Map<string, string>();
	let realProjectRoot: string | undefined;

	if (source === "project" && projectRoot) {
		try {
			realProjectRoot = fs.realpathSync(projectRoot);
			const realDir = fs.realpathSync(dir);
			if (!isPathInside(realProjectRoot, realDir)) {
				addDiagnostic(diagnostics, dir, source, "Agent directory resolves outside the project root.");
				return agents;
			}
		} catch {
			addDiagnostic(diagnostics, dir, source, "Unable to resolve project agent directory safely.");
			return agents;
		}
	}

	if (!fs.existsSync(dir)) {
		return agents;
	}

	const entries: fs.Dirent[] = [];
	let scannedEntries = 0;
	let tooManyEntries = false;
	let tooManyFiles = false;
	try {
		const directory = fs.opendirSync(dir);
		try {
			let entry: fs.Dirent | null;
			while ((entry = directory.readSync()) !== null) {
				scannedEntries++;
				if (scannedEntries > MAX_AGENT_DIRECTORY_ENTRIES) {
					tooManyEntries = true;
					break;
				}
				if (!entry.name.endsWith(".md") || (!entry.isFile() && !entry.isSymbolicLink())) continue;
				if (entries.length === MAX_AGENT_FILES) {
					tooManyFiles = true;
					break;
				}
				entries.push(entry);
			}
		} finally {
			try { directory.closeSync(); } catch { /* ignore */ }
		}
	} catch {
		addDiagnostic(diagnostics, dir, source, "Unable to read agent directory.");
		return agents;
	}
	if (tooManyEntries) {
		addDiagnostic(diagnostics, dir, source,
			`Agent directory exceeds the ${MAX_AGENT_DIRECTORY_ENTRIES}-entry scan limit; no definitions from this directory were loaded.`);
		return agents;
	}
	if (tooManyFiles) {
		addDiagnostic(diagnostics, dir, source,
			`Agent directory exceeds the ${MAX_AGENT_FILES}-definition limit; no definitions from this directory were loaded.`);
		return agents;
	}

	let totalBytes = 0;
	for (const entry of entries.sort((a, b) => compareLexically(a.name, b.name))) {
		const filePath = path.join(dir, entry.name);
		let contentPath = filePath;
		if (realProjectRoot) {
			try {
				contentPath = fs.realpathSync(filePath);
			} catch {
				addDiagnostic(diagnostics, filePath, source, "Unable to resolve agent file safely.");
				continue;
			}
			if (!isPathInside(realProjectRoot, contentPath)) {
				addDiagnostic(diagnostics, filePath, source, "Agent file resolves outside the project root.");
				continue;
			}
		}

		let expectedFileIdentity: { dev: bigint; ino: bigint } | undefined;
		if (realProjectRoot) {
			try {
				const expected = fs.statSync(contentPath, { bigint: true });
				expectedFileIdentity = { dev: expected.dev, ino: expected.ino };
				// Re-resolve after stat so a concurrent parent-directory swap cannot
				// redirect openSync outside the project between the earlier check and read.
				contentPath = fs.realpathSync(contentPath);
			} catch {
				addDiagnostic(diagnostics, filePath, source, "Unable to re-verify project agent file safely.");
				continue;
			}
			if (!isPathInside(realProjectRoot, contentPath)) {
				addDiagnostic(diagnostics, filePath, source, "Agent file resolves outside the project root.");
				continue;
			}
		}

		let content: string;
		try {
			let flags = fs.constants.O_RDONLY;
			if (process.platform !== "win32" && typeof fs.constants.O_NONBLOCK === "number") flags |= fs.constants.O_NONBLOCK;
			if (process.platform !== "win32" && source === "project" && typeof fs.constants.O_NOFOLLOW === "number") {
				flags |= fs.constants.O_NOFOLLOW;
			}
			const fd = fs.openSync(contentPath, flags);
			try {
				// The name can still race after realpath; verify the opened file identity.
				const stat = fs.fstatSync(fd, { bigint: true });
				if (expectedFileIdentity &&
					(stat.dev !== expectedFileIdentity.dev || stat.ino !== expectedFileIdentity.ino)) {
					throw new Error("Agent definition changed while opening; rejecting unsafe path.");
				}
				if (!stat.isFile()) throw new Error("Agent definition is not a regular file.");
				if (stat.size > BigInt(MAX_AGENT_FILE_BYTES)) {
					throw new Error(`Agent definition exceeds the ${MAX_AGENT_FILE_BYTES / 1024} KiB size limit.`);
				}
				const remaining = MAX_AGENT_DIRECTORY_BYTES - totalBytes;
				if (stat.size > BigInt(remaining)) {
					addDiagnostic(diagnostics, filePath, source,
						`Agent directory exceeds the ${MAX_AGENT_DIRECTORY_BYTES / (1024 * 1024)} MiB content limit; remaining definitions were skipped.`);
					break;
				}
				const bytes = Buffer.allocUnsafe(remaining < MAX_AGENT_FILE_BYTES ? remaining + 1 : MAX_AGENT_FILE_BYTES + 1);
				let length = 0;
				while (length < bytes.length) {
					const count = fs.readSync(fd, bytes, length, bytes.length - length, null);
					if (count === 0) break;
					length += count;
				}
				if (length > MAX_AGENT_FILE_BYTES) {
					throw new Error(`Agent definition exceeds the ${MAX_AGENT_FILE_BYTES / 1024} KiB size limit.`);
				}
				if (length > remaining) {
					addDiagnostic(diagnostics, filePath, source,
						`Agent directory exceeds the ${MAX_AGENT_DIRECTORY_BYTES / (1024 * 1024)} MiB content limit; remaining definitions were skipped.`);
					break;
				}
				totalBytes += length;
				const fileContents = bytes.subarray(0, length);
				if (!isUtf8(fileContents)) throw new Error("Agent definition is not valid UTF-8.");
				content = fileContents.toString("utf-8");
			} finally {
				fs.closeSync(fd);
			}
		} catch (error) {
			addDiagnostic(diagnostics, filePath, source,
				error instanceof Error ? error.message : "Unable to load agent.");
			continue;
		}

		try {
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
			const description = frontmatter.description.trim();
			if (description.length > MAX_AGENT_DESCRIPTION_BYTES || !isWellFormedUnicode(description) ||
				Buffer.byteLength(description, "utf8") > MAX_AGENT_DESCRIPTION_BYTES) {
				throw new Error(`description must be well-formed Unicode and at most ${MAX_AGENT_DESCRIPTION_BYTES} UTF-8 bytes.`);
			}
			if (!isSafeAgentName(frontmatter.name.trim())) {
				throw new Error(`name must be well-formed Unicode, at most ${MAX_AGENT_NAME_BYTES} UTF-8 bytes, and contain no control or bidirectional formatting characters.`);
			}
			if (frontmatter.model !== undefined && !isSafeModelSelector(frontmatter.model, true)) {
				throw new Error(`model must be well-formed Unicode, at most ${MAX_MODEL_SELECTOR_BYTES} UTF-8 bytes, and contain no control characters.`);
			}
			const thinking = frontmatter.thinking;
			if (thinking !== undefined && !THINKING_LEVELS.includes(thinking as ThinkingLevel)) {
				throw new Error(`thinking must be one of: ${THINKING_LEVELS.join(", ")}.`);
			}
			const timeoutMs = frontmatter.timeoutMs;
			if (timeoutMs !== undefined && (typeof timeoutMs !== "number" || !Number.isInteger(timeoutMs) ||
				timeoutMs < 1 || timeoutMs > MAX_TIMEOUT_MS)) {
				throw new Error(`timeoutMs must be an integer between 1 and ${MAX_TIMEOUT_MS}.`);
			}
			const agent: AgentConfig = {
				name: frontmatter.name.trim(),
				description,
				tools: parseToolList(frontmatter.tools),
				model: frontmatter.model?.trim() || undefined,
				thinking: thinking as ThinkingLevel | undefined,
				timeoutMs: timeoutMs as number | undefined,
				systemPrompt: body,
				source,
				filePath,
			};
			const previous = sourceFiles.get(agent.name);
			if (previous) addDiagnostic(diagnostics, filePath, source,
				`Duplicate agent name. This definition overrides ${previous}.`);
			sourceFiles.set(agent.name, filePath);
			agents.push(agent);
		} catch (error) {
			addDiagnostic(diagnostics, filePath, source,
				error instanceof Error ? error.message : "Unable to load agent.");
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

function findNearestProjectAgentsDir(cwd: string): { dir: string; root: string } | null {
	let currentDir = path.resolve(cwd);
	while (true) {
		const candidate = path.join(currentDir, CONFIG_DIR_NAME, "agents");
		if (isDirectory(candidate)) return { dir: candidate, root: currentDir };

		const parentDir = path.dirname(currentDir);
		if (parentDir === currentDir) return null;
		currentDir = parentDir;
	}
}

export function discoverAgents(cwd: string, scope: AgentScope): AgentDiscoveryResult {
	const userDir = path.join(getAgentDir(), "agents");
	const projectLocation = findNearestProjectAgentsDir(cwd);
	const projectAgentsDir = projectLocation?.dir ?? null;

	const diagnostics: AgentDiagnostic[] = [];
	const userAgents = scope === "project" ? [] : loadAgentsFromDir(userDir, "user", diagnostics);
	const projectAgents = scope === "user" || !projectLocation
		? [] : loadAgentsFromDir(projectLocation.dir, "project", diagnostics, projectLocation.root);

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
		agents: Array.from(agentMap.values()).sort((a, b) => compareLexically(a.name, b.name)),
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
