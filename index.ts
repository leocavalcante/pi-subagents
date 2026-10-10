/**
 * Subagent Tool - Delegate tasks to specialized agents
 *
 * Spawns a separate `pi` process for each subagent invocation,
 * giving it an isolated context window.
 *
 * Supports three modes:
 *   - Single: { agent: "name", task: "..." }
 *   - Parallel: { tasks: [{ agent: "name", task: "..." }, ...] }
 *   - Chain: { chain: [{ agent: "name", task: "... {previous} ..." }, ...] }
 *
 * Uses JSON mode to capture structured output from subagents.
 */

import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { AgentToolResult, ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { Message, Usage } from "@earendil-works/pi-ai";
import { StringEnum } from "@earendil-works/pi-ai";
import {
	CONFIG_DIR_NAME,
	type ExtensionAPI,
	type ToolDefinition,
	getAgentDir,
	getMarkdownTheme,
	withFileMutationQueue,
} from "@earendil-works/pi-coding-agent";
import { Container, Markdown, Spacer, Text } from "@earendil-works/pi-tui";
import { Type, type Static } from "typebox";
import {
	AGENT_NAME_PATTERN,
	MAX_AGENT_NAME_BYTES,
	type AgentConfig,
	type AgentScope,
	discoverAgents,
	isSafeAgentName,
	THINKING_LEVELS,
} from "./agents.ts";
import {
	JobManager,
	ProcessPool,
	ProcessPoolCapacityError,
	MAX_JOB_WAIT_MS,
	DEFAULT_JOB_WAIT_MS,
	type JobSnapshot,
	type JobState,
} from "./jobs.ts";
import { JsonLineCapture, MessageCapture, TextCapture, MAX_HISTORY_BYTES, MAX_JSON_RECORD_BYTES } from "./capture.ts";
import { assistantMessageError, isCapturedMessageRole, parseChildEvent, toolResultMessageError, userMessageError } from "./protocol.ts";
import { MAX_PAGE_BYTES, createOutputPager, WeakOutputPagerCache } from "./paging.ts";
import { normalizeUsage, sumUsage } from "./usage.ts";
import { CHAIN_ID_PATTERN, validateChainReferences, substituteChainContext, substituteChainContextBounded } from "./chain.ts";

const MAX_PARALLEL_TASKS = 8;
const MAX_CHAIN_STEPS = 32;
const MAX_CONCURRENCY = 4;
const MAX_ACTIVE_JOBS = 8;
// Allow every configured active background job to fill its process worker pool.
const MAX_PROCESS_QUEUE = MAX_ACTIVE_JOBS * MAX_CONCURRENCY;
const MAX_TIMEOUT_MS = 24 * 60 * 60 * 1000;
const MAX_RETAINED_JOB_BYTES = 32 * 1024 * 1024;
const COLLAPSED_ITEM_COUNT = 10;
const MODEL_TEXT_CAP = 50 * 1024;
const MAX_TASK_BYTES = 4 * 1024 * 1024;
const MAX_DISPATCH_TASK_BYTES = 16 * 1024 * 1024;
const MAX_DISPATCH_HISTORY_BYTES = 32 * 1024 * 1024;
const UNSAFE_DISPLAY_CHARACTERS = /[\u0000-\u001f\u007f-\u009f\u2028\u2029\u061c\u200e\u200f\u202a-\u202e\u2066-\u206f\ufeff]/g;

function escapeTerminalControls(value: string): string {
	return value.replace(UNSAFE_DISPLAY_CHARACTERS,
		(character) => `\\u${character.charCodeAt(0).toString(16).padStart(4, "0")}`);
}

function displayUntrustedText(value: string): string {
	const escaped = escapeTerminalControls(value).replace(/`/g, "\\u0060");
	// A code span prevents metadata from becoming Markdown/HTML; controls and
	// embedded backticks are escaped first so it cannot break out of the span.
	const padding = escaped.startsWith(" ") || escaped.endsWith(" ") ? " " : "";
	return `\`${padding}${escaped}${padding}\``;
}

function previewAgentName(value: string): string {
	return escapeTerminalControls(truncateOutput(value, MAX_AGENT_NAME_BYTES, "..."));
}

function taskByteLength(task: string): number {
	// UTF-8 bytes are never fewer than UTF-16 code units. Avoid scanning an
	// arbitrarily large tool argument when its length already exceeds the cap.
	return task.length > MAX_TASK_BYTES ? MAX_TASK_BYTES + 1 : Buffer.byteLength(task, "utf8");
}

function taskSizeError(): string {
	return `Task exceeds the ${MAX_TASK_BYTES / (1024 * 1024)} MiB UTF-8 size limit.`;
}

function formatTokens(count: number): string {
	if (count < 1000) return count.toString();
	if (count < 10000) return `${(count / 1000).toFixed(1)}k`;
	if (count < 1000000) return `${Math.round(count / 1000)}k`;
	return `${(count / 1000000).toFixed(1)}M`;
}

function formatUsageStats(
	usage: {
		input: number;
		output: number;
		cacheRead: number;
		cacheWrite: number;
		cost: number;
		contextTokens?: number;
		turns?: number;
	},
	model?: string,
): string {
	const parts: string[] = [];
	if (usage.turns) parts.push(`${usage.turns} turn${usage.turns > 1 ? "s" : ""}`);
	if (usage.input) parts.push(`↑${formatTokens(usage.input)}`);
	if (usage.output) parts.push(`↓${formatTokens(usage.output)}`);
	if (usage.cacheRead) parts.push(`R${formatTokens(usage.cacheRead)}`);
	if (usage.cacheWrite) parts.push(`W${formatTokens(usage.cacheWrite)}`);
	if (usage.cost) parts.push(`$${usage.cost.toFixed(4)}`);
	if (usage.contextTokens && usage.contextTokens > 0) {
		parts.push(`ctx:${formatTokens(usage.contextTokens)}`);
	}
	if (model) parts.push(model);
	return parts.join(" ");
}

function stringArg(value: unknown, fallback = "..."): string {
	return typeof value === "string" ? value : fallback;
}

function formatToolCall(
	toolName: string,
	args: Record<string, unknown>,
	themeFg: (color: any, text: string) => string,
): string {
	const shortenPath = (p: string) => {
		const home = os.homedir();
		const shortened = p === home || p.startsWith(`${home}${path.sep}`) ? `~${p.slice(home.length)}` : p;
		return truncateOutput(shortened, 512, "...");
	};

	switch (toolName) {
		case "bash": {
			const command = stringArg(args.command) || "...";
			const preview = truncateOutput(command, 120, "...");
			return themeFg("muted", "$ ") + themeFg("toolOutput", preview);
		}
		case "read": {
			const rawPath = stringArg(args.file_path ?? args.path);
			const filePath = shortenPath(rawPath);
			const offset = typeof args.offset === "number" && Number.isInteger(args.offset) ? args.offset : undefined;
			const limit = typeof args.limit === "number" && Number.isInteger(args.limit) ? args.limit : undefined;
			let text = themeFg("accent", filePath);
			if (offset !== undefined || limit !== undefined) {
				const startLine = offset ?? 1;
				const endLine = limit !== undefined ? startLine + limit - 1 : "";
				text += themeFg("warning", `:${startLine}${endLine ? `-${endLine}` : ""}`);
			}
			return themeFg("muted", "read ") + text;
		}
		case "write": {
			const rawPath = stringArg(args.file_path ?? args.path);
			const filePath = shortenPath(rawPath);
			const content = stringArg(args.content, "");
			let lines = 1;
			for (let i = 0; i < content.length; i++) if (content.charCodeAt(i) === 10) lines++;
			let text = themeFg("muted", "write ") + themeFg("accent", filePath);
			if (lines > 1) text += themeFg("dim", ` (${lines} lines)`);
			return text;
		}
		case "edit": {
			const rawPath = stringArg(args.file_path ?? args.path);
			return themeFg("muted", "edit ") + themeFg("accent", shortenPath(rawPath));
		}
		case "ls": {
			const rawPath = stringArg(args.path, ".");
			return themeFg("muted", "ls ") + themeFg("accent", shortenPath(rawPath));
		}
		case "find": {
			const pattern = truncateOutput(stringArg(args.pattern, "*"), 512, "...");
			const rawPath = stringArg(args.path, ".");
			return themeFg("muted", "find ") + themeFg("accent", pattern) + themeFg("dim", ` in ${shortenPath(rawPath)}`);
		}
		case "grep": {
			const pattern = truncateOutput(stringArg(args.pattern, ""), 512, "...");
			const rawPath = stringArg(args.path, ".");
			return (
				themeFg("muted", "grep ") + themeFg("accent", `/${pattern}/`) + themeFg("dim", ` in ${shortenPath(rawPath)}`)
			);
		}
		default: {
			const argsStr = JSON.stringify(args);
			const preview = truncateOutput(argsStr, 256, "...");
			return themeFg("accent", truncateOutput(toolName, 256, "...")) + themeFg("dim", ` ${preview}`);
		}
	}
}

interface UsageStats {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cost: number;
	contextTokens: number;
	turns: number;
}

type FailureEventType = "invalid_json" | "invalid_utf8" | "invalid_event" | "message_end" | "tool_result_end" | "oversized_record" | "process_exit";
type FailureRole = "assistant" | "user" | "toolResult" | "system" | "custom" | "bashExecution" | "branchSummary" | "compactionSummary" | "other";
type FailureStopReason = "stop" | "length" | "toolUse" | "error" | "aborted" | "deferred";

interface FailureContext {
	eventType: FailureEventType;
	role?: FailureRole;
	record?: number;
	lastStopReason?: FailureStopReason;
}

interface SingleResult {
	agent: string;
	agentSource: "user" | "project" | "unknown";
	task: string;
	exitCode: number;
	processExitCode?: number | null;
	failureContext?: FailureContext;
	messages: Message[];
	stderr: string;
	usage: UsageStats;
	reportedUsage?: Usage;
	model?: string;
	stopReason?: string;
	errorMessage?: string;
	step?: number;
	stepId?: string;
	timeoutMs?: number;
	timedOut?: boolean;
	capture?: {
		messagesDropped?: number;
		retainedMessageBytes?: number;
		stderrTruncated?: boolean;
		inheritedPipesClosed?: boolean;
		finalAssistantMessageDropped?: boolean;
	};
}

interface SubagentDetails {
	mode: "single" | "parallel" | "chain";
	agentScope: AgentScope;
	projectAgentsDir: string | null;
	results: SingleResult[];
	concurrency?: number;
	background?: { id: string; state: JobState; notify: boolean };
}

type JobResult = AgentToolResult<SubagentDetails>;

function reportUsage(result: JobResult): JobResult {
	try {
		const usage = sumUsage((result.details?.results ?? []).flatMap((task) => task.reportedUsage ? [task.reportedUsage] : []));
		return { ...result, usage };
	} catch (error) {
		const reason = error instanceof RangeError && error.message === "Subagent usage token totals exceed safe integer limits."
			? "token totals exceed JavaScript's safe integer limits"
			: "totals exceed finite numeric limits";
		return {
			...result, isError: true,
			content: [{ type: "text", text: `Unable to report cumulative subagent usage: ${reason}.` }, ...result.content],
		};
	}
}
type JobToolDetails = JobSnapshot<JobResult> | { jobs: Omit<JobSnapshot<JobResult>, "latest">[] } |
	{ forgotten: string } | { cleared: number } | undefined;

function estimateJobBytes(result: JobResult): number {
	let bytes = result.content.reduce((sum, part) => sum + Buffer.byteLength(part.type === "text" ? part.text : part.data), 0);
	for (const task of result.details?.results ?? []) {
		bytes += (task.capture?.retainedMessageBytes ?? 0) + Buffer.byteLength(task.task) + Buffer.byteLength(task.stderr);
		if (task.errorMessage) bytes += Buffer.byteLength(task.errorMessage);
	}
	return bytes;
}

function getFinalOutput(messages: Message[]): string {
	for (let i = messages.length - 1; i >= 0; i--) {
		const msg = messages[i];
		if (msg.role === "assistant") {
			// Use the last assistant message, not stale text from earlier turns.
			return msg.content.filter((part) => part.type === "text").map((part) => part.text).join("\n\n");
		}
	}
	return "";
}

function getPartialOutput(messages: Message[]): string {
	const blocks: string[] = [];
	for (const message of messages) {
		if (message.role === "assistant") {
			const text = message.content.filter((part) => part.type === "text").map((part) => part.text).join("\n\n");
			if (text) blocks.push(`Assistant:\n${text}`);
		} else if (message.role === "toolResult") {
			const text = message.content.filter((part) => part.type === "text").map((part) => part.text).join("\n\n");
			if (text) blocks.push(`Tool result:\n${text}`);
		}
	}
	return blocks.join("\n\n");
}

function safeFailureRole(role: unknown): FailureRole | undefined {
	if (typeof role !== "string") return undefined;
	switch (role) {
		case "assistant": case "user": case "toolResult": case "system": case "custom":
		case "bashExecution": case "branchSummary": case "compactionSummary":
			return role;
		default:
			// Never echo an arbitrary child-provided role into diagnostics.
			return "other";
	}
}

function formatFailureContext(result: SingleResult): string {
	const context = result.failureContext;
	if (!context && result.processExitCode === undefined) return "";
	const parts: string[] = [];
	if (context) {
		parts.push(`event=${context.eventType}`);
		if (context.role) parts.push(`role=${context.role}`);
		if (context.record !== undefined) parts.push(`record=${context.record}`);
		if (context.lastStopReason) parts.push(`lastStopReason=${context.lastStopReason}`);
	}
	if (result.processExitCode !== undefined) {
		parts.push(`processExitCode=${result.processExitCode === null ? "null" : result.processExitCode}`);
	}
	return `[Failure context: ${parts.join("; ")}]`;
}

function isFailedResult(result: SingleResult): boolean {
	return (
		(result.exitCode !== 0 && result.exitCode !== -1) ||
		result.stopReason === "error" ||
		result.stopReason === "aborted"
	);
}

function isPartialResult(result: SingleResult): boolean {
	return result.exitCode === -1 || isFailedResult(result);
}

function getCaptureNotice(result: SingleResult): string {
	const notices: string[] = [];
	if (result.capture?.messagesDropped) notices.push(`${result.capture.messagesDropped} messages omitted from captured history.`);
	if (result.capture?.finalAssistantMessageDropped) notices.push("Final assistant message omitted because it exceeded the history capture budget.");
	if (result.capture?.stderrTruncated) notices.push("stderr capture truncated at 64 KiB.");
	if (result.capture?.inheritedPipesClosed) notices.push("Inherited output pipes were closed after the child exited.");
	return notices.length ? `[Capture notice: ${notices.join(" ")}]` : "";
}

function getResultOutput(result: SingleResult): string {
	const failed = isFailedResult(result);
	const partial = isPartialResult(result);
	const output = failed
		? result.errorMessage || result.stderr || getFinalOutput(result.messages) || "(no output)"
		: getFinalOutput(result.messages) || "(no output)";
	const sections = [output];
	if (partial) {
		const context = formatFailureContext(result);
		if (context) sections.push(context);
		const partial = getPartialOutput(result.messages);
		if (partial) sections.push(`[Partial, unverified output]\n\n${partial}`);
	}
	const notice = getCaptureNotice(result);
	if (notice) sections.push(notice);
	return sections.join("\n\n");
}

const outputPagerCache = new WeakOutputPagerCache<SingleResult>();

function pageResultOutput(result: SingleResult, offset: number, limit: number) {
	const pager = outputPagerCache.get(result, () => createOutputPager(getResultOutput(result)));
	return pager(offset, limit);
}

function truncateOutput(output: string, budget = MODEL_TEXT_CAP,
	notice = "\n\n[Output truncated. Captured output preserved in tool details.]"): string {
	// UTF-8 output is never shorter than its UTF-16 code-unit length. Only scan
	// a complete string when that scan itself is bounded by the output budget.
	if (output.length <= budget && Buffer.byteLength(output, "utf8") <= budget) return output;
	const noticeBytes = Buffer.byteLength(notice, "utf8");
	// An unusually long header can consume a batch's entire body allowance.
	if (budget < noticeBytes) return "";
	let end = budget - noticeBytes;
	// Encode only enough of an oversized string to fill its bounded prefix.
	const bytes = Buffer.from(output.slice(0, end + 2), "utf8");
	// Do not split a multibyte character. The notice itself is inside the cap.
	while (end > 0 && (bytes[end] & 0xc0) === 0x80) end--;
	return bytes.subarray(0, end).toString("utf8") + notice;
}

function previewText(text: string): string {
	const lines = text.split("\n", 4);
	const notice = "\n[Preview truncated. Ctrl+O to expand.]";
	const preview = lines.length > 3 ? lines.slice(0, 3).join("\n") + notice : text;
	return truncateOutput(preview, 1024, notice);
}

function getFailureReason(result: SingleResult): string {
	if (!isFailedResult(result)) return "";
	return result.errorMessage || result.stderr || `Subagent failed (${result.stopReason ?? `exit code ${result.exitCode}`}).`;
}

function boundResultText(result: JobResult): JobResult {
	let remaining = MODEL_TEXT_CAP;
	let textParts = result.content.filter((part) => part.type === "text").length;
	return { ...result, content: result.content.map((part) => {
		if (part.type !== "text") return part;
		const text = truncateOutput(part.text, Math.floor(remaining / textParts));
		remaining -= Buffer.byteLength(text, "utf8");
		textParts--;
		return { ...part, text };
	}) };
}

type DisplayItem = { type: "text"; text: string } | { type: "toolCall"; name: string; args: Record<string, any> };

function getDisplayItems(messages: Message[]): DisplayItem[] {
	const items: DisplayItem[] = [];
	for (const msg of messages) {
		if (msg.role === "assistant") {
			for (const part of msg.content) {
				if (part.type === "text") items.push({ type: "text", text: part.text });
				else if (part.type === "toolCall")
					items.push({
						type: "toolCall",
						name: part.name,
						args: part.arguments,
					});
			}
		}
	}
	return items;
}

async function mapWithConcurrencyLimit<TIn, TOut>(
	items: TIn[],
	concurrency: number,
	fn: (item: TIn, index: number) => Promise<TOut>,
): Promise<TOut[]> {
	if (items.length === 0) return [];
	const limit = Math.max(1, Math.min(concurrency, items.length));
	const results: TOut[] = new Array(items.length);
	let nextIndex = 0;
	const workers = new Array(limit).fill(null).map(async () => {
		while (true) {
			const current = nextIndex++;
			if (current >= items.length) return;
			results[current] = await fn(items[current], current);
		}
	});
	// Wait for every worker to clean up even if one fails or is canceled.
	const settled = await Promise.allSettled(workers);
	const failure = settled.find((r) => r.status === "rejected");
	if (failure?.status === "rejected") throw failure.reason;
	return results;
}

async function writePromptToTempFile(agentName: string, prompt: string): Promise<{ dir: string; filePath: string }> {
	const tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pi-subagent-"));
	const safeName = agentName.replace(/[^\w.-]+/g, "_");
	const filePath = path.join(tmpDir, `prompt-${safeName}.md`);
	try {
		await withFileMutationQueue(filePath, async () => {
			await fs.promises.writeFile(filePath, prompt, {
				encoding: "utf-8",
				mode: 0o600,
			});
		});
		return { dir: tmpDir, filePath };
	} catch (error) {
		await fs.promises.rm(tmpDir, { recursive: true, force: true });
		throw error;
	}
}

function getPiInvocation(args: string[]): { command: string; args: string[] } {
	const currentScript = process.argv[1];
	const isBunVirtualScript = currentScript?.startsWith("/$bunfs/root/");
	if (currentScript && !isBunVirtualScript && fs.existsSync(currentScript)) {
		return { command: process.execPath, args: [currentScript, ...args] };
	}

	const execName = path.basename(process.execPath).toLowerCase();
	const isGenericRuntime = /^(node|bun)(\.exe)?$/.test(execName);
	if (!isGenericRuntime) {
		return { command: process.execPath, args };
	}

	return { command: "pi", args };
}

type OnUpdateCallback = (partial: AgentToolResult<SubagentDetails>) => void;

interface DispatchDefaults {
	model?: string;
	thinkingLevel?: ThinkingLevel;
}

interface DispatchOverrides {
	model?: string;
	thinking?: ThinkingLevel;
}

async function runSingleAgent(
	defaultCwd: string,
	pool: ProcessPool,
	dispatchDefaults: DispatchDefaults,
	agents: AgentConfig[],
	agentName: string,
	task: string,
	cwd: string | undefined,
	overrides: DispatchOverrides,
	timeoutMs: number | undefined,
	step: number | undefined,
	signal: AbortSignal | undefined,
	onUpdate: OnUpdateCallback | undefined,
	makeDetails: (results: SingleResult[]) => SubagentDetails,
	expandedTaskTooLarge = false,
	historyByteLimit = MAX_HISTORY_BYTES,
	expandedTaskError?: string,
): Promise<SingleResult> {
	const agent = agents.find((a) => a.name === agentName);

	if (!agent) {
		const available = agents.map((a) => `"${a.name}"`).join(", ") || "none";
		return {
			agent: agentName,
			agentSource: "unknown",
			task,
			exitCode: 1,
			messages: [],
			stderr: `Unknown agent: "${agentName}". Available agents: ${available}.`,
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				cost: 0,
				contextTokens: 0,
				turns: 0,
			},
			step,
		};
	}

	const args: string[] = ["--mode", "json", "-p", "--no-session"];
	const inheritsDispatchConfig = !overrides.model && !agent.model;
	const model = overrides.model?.trim() ?? agent.model ?? dispatchDefaults.model;
	if (model) args.push("--model", model);
	const thinking = overrides.thinking ?? agent.thinking ?? (inheritsDispatchConfig ? dispatchDefaults.thinkingLevel : undefined);
	if (thinking) args.push("--thinking", thinking);
	if (agent.tools) {
		if (agent.tools.length > 0) args.push("--tools", agent.tools.join(","));
		else args.push("--no-tools");
	}

	let tmpPromptDir: string | null = null;
	let tmpPromptPath: string | null = null;

	const currentResult: SingleResult = {
		agent: agentName,
		agentSource: agent.source,
		task,
		exitCode: -1, // Still running; progress must not count this task as completed.
		messages: [],
		stderr: "",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			cost: 0,
			contextTokens: 0,
			turns: 0,
		},
		model,
		step,
		timeoutMs,
	};

	signal?.throwIfAborted();
	if (expandedTaskTooLarge || taskByteLength(task) > MAX_TASK_BYTES) {
		currentResult.exitCode = 1;
		currentResult.errorMessage = expandedTaskError ?? taskSizeError();
		return currentResult;
	}
	if (!task.trim()) {
		currentResult.exitCode = 1;
		currentResult.errorMessage = "Delegated task is empty after chain context substitution.";
		return currentResult;
	}

	const emitUpdate = () => {
		if (onUpdate) {
			onUpdate({
				content: [
					{
						type: "text",
						text: getFinalOutput(currentResult.messages) || "(running...)",
					},
				],
				details: makeDetails([currentResult]),
			});
		}
	};

	let release: (() => void) | undefined;
	let setupPhase = "waiting for a process slot";
	let childCreated = false;
	try {
		release = await pool.acquire(signal);
		setupPhase = "preparing system prompt";
		signal?.throwIfAborted();
		if (agent.systemPrompt.trim()) {
			const tmp = await writePromptToTempFile(agent.name, agent.systemPrompt);
			tmpPromptDir = tmp.dir;
			tmpPromptPath = tmp.filePath;
			args.push("--append-system-prompt", tmpPromptPath);
		}

		// Prompt creation awaits I/O; cancellation may have arrived since acquisition.
		signal?.throwIfAborted();
		let wasAborted = false;
		let timedOut = false;
		let protocolError: string | undefined;
		let recordPosition = 0;
		const setProtocolError = (message: string, eventType: FailureEventType, record?: number, role?: unknown) => {
			if (protocolError) return; // Preserve the first malformed record and its causal context.
			protocolError = message;
			const safeRole = safeFailureRole(role);
			currentResult.failureContext = {
				eventType,
				...(safeRole ? { role: safeRole } : {}),
				...(record !== undefined ? { record } : {}),
				...(currentResult.stopReason ? { lastStopReason: currentResult.stopReason as FailureStopReason } : {}),
			};
		};
		const history = new MessageCapture<Message>(historyByteLimit);
		const stderr = new TextCapture();
		currentResult.capture = {};

		setupPhase = "launching child process";
		const exitCode = await new Promise<number>((resolve) => {
			const invocation = getPiInvocation(args);
			const proc = spawn(invocation.command, invocation.args, {
				cwd: cwd ? path.resolve(defaultCwd, cwd) : defaultCwd,
				shell: false,
				stdio: ["pipe", "pipe", "pipe"],
				// On POSIX, cancel the entire group, including tools spawned by the child.
				detached: process.platform !== "win32",
			});
			childCreated = true;
			let leaderExited = false;
			let processSpawned = false;
			let closed = false;
			let settling = false;
			let settled = false;
			let drainTimer: NodeJS.Timeout | undefined;
			let deadlineTimer: NodeJS.Timeout | undefined;
			let escalation: Promise<void> | undefined;
			const closePipes = () => {
				proc.stdin.destroy();
				proc.stdout.destroy();
				proc.stderr.destroy();
			};
			const killGroup = (killSignal: NodeJS.Signals): boolean => {
				// A POSIX group may still have descendants after its leader exits.
				if (!proc.pid || (process.platform === "win32" && leaderExited)) return false;
				try {
					if (process.platform !== "win32") process.kill(-proc.pid, killSignal);
					else return proc.kill(killSignal);
					return true;
				} catch (error) {
					if ((error as NodeJS.ErrnoException).code === "ESRCH") return false;
					try {
						return proc.kill(killSignal);
					} catch (fallbackError) {
						if ((fallbackError as NodeJS.ErrnoException).code === "ESRCH") return false;
						return false;
					}
				}
			};
			const terminateGroup = () => {
				if (process.platform === "win32") {
					// Windows SIGTERM is a force-termination request; POSIX-style grace and
					// delayed SIGKILL escalation add no protection on this platform.
					killGroup("SIGTERM");
					return;
				}
				if (escalation || !killGroup("SIGTERM")) return;
				// Keep the slot until escalation even if the leader closes early.
				escalation = new Promise<void>((done) => {
					setTimeout(() => {
						killGroup("SIGKILL");
						// Escaped descendants can also hold pipes; never wait on those forever.
						closePipes();
						done();
					}, 1000);
				});
			};
			const killProc = () => {
				// Keep observing cancellation while post-exit descendant cleanup runs.
				if (wasAborted || settled) return;
				wasAborted = true;
				terminateGroup();
			};

			const processLine = (line: string) => {
				const record = ++recordPosition;
				if (!line.trim()) return;
				let event: any;
				try {
					event = parseChildEvent(line);
				} catch (error) {
					setProtocolError(error instanceof RangeError ? error.message : "Invalid subagent JSON event: malformed JSON.", "invalid_json", record);
					return;
				}

				if (!event || typeof event !== "object" || Array.isArray(event)) {
					setProtocolError("Invalid subagent JSON event: expected an object.", "invalid_event", record);
					return;
				}
				const isMessageEnd = event.type === "message_end" || event.type === "tool_result_end";
				if (isMessageEnd && (!event.message || typeof event.message !== "object" ||
					Array.isArray(event.message) || typeof event.message.role !== "string")) {
					setProtocolError("Invalid subagent JSON event: malformed message.",
						event.type === "tool_result_end" ? "tool_result_end" : "message_end", record,
						event.message?.role);
					return;
				}
				if (event.type === "tool_result_end" && event.message.role !== "toolResult") {
					setProtocolError("Invalid subagent JSON event: tool result event must contain a tool result message.",
						"tool_result_end", record, event.message.role);
					return;
				}
				if (isMessageEnd && isCapturedMessageRole(event.message.role)) {
					const error = event.message.role === "assistant" ? assistantMessageError(event.message)
						: event.message.role === "toolResult" ? toolResultMessageError(event.message)
							: userMessageError(event.message);
					if (error) {
						setProtocolError(`Invalid subagent JSON event: ${error}.`,
							event.type === "tool_result_end" ? "tool_result_end" : "message_end", record,
							event.message.role);
						return;
					}
				}

				if (event.type === "message_end" && isCapturedMessageRole(event.message.role)) {
					const msg = event.message as Message;
					if ((msg.role === "assistant" || msg.role === "toolResult") && msg.usage !== undefined) {
						try {
							const usage = sumUsage([currentResult.reportedUsage ?? normalizeUsage(undefined), normalizeUsage(msg.usage)]);
							currentResult.reportedUsage = usage;
							Object.assign(currentResult.usage, {
								input: usage.input, output: usage.output, cacheRead: usage.cacheRead,
								cacheWrite: usage.cacheWrite, cost: usage.cost.total,
							});
						} catch (error) {
							setProtocolError(error instanceof Error ? error.message : "Malformed subagent usage.",
								"message_end", record, msg.role);
							return;
						}
					}
					const retained = history.push(msg, Buffer.byteLength(line, "utf8"));
					if (msg.role === "assistant") currentResult.capture!.finalAssistantMessageDropped = !retained;
					currentResult.messages = history.messages;
					currentResult.capture!.messagesDropped = history.dropped;
					currentResult.capture!.retainedMessageBytes = history.retainedBytes;

					if (msg.role === "assistant") {
						currentResult.usage.turns++;
						const usage = msg.usage;
						if (usage) currentResult.usage.contextTokens = usage.totalTokens ?? normalizeUsage(usage).totalTokens;
						if (!currentResult.model && msg.model) currentResult.model = msg.model;
						if (msg.stopReason) currentResult.stopReason = msg.stopReason;
						currentResult.errorMessage = msg.errorMessage;
					}
					emitUpdate();
				}

				if (event.type === "tool_result_end" && event.message) {
					history.push(event.message as Message, Buffer.byteLength(line, "utf8"));
					currentResult.messages = history.messages;
					currentResult.capture!.messagesDropped = history.dropped;
					currentResult.capture!.retainedMessageBytes = history.retainedBytes;
					emitUpdate();
				}
			};

			const reader = new JsonLineCapture(processLine, () => {
				const record = ++recordPosition;
				setProtocolError(`Subagent JSON record exceeded ${MAX_JSON_RECORD_BYTES / (1024 * 1024)} MiB; oversized record discarded.`,
					"oversized_record", record);
			}, MAX_JSON_RECORD_BYTES, () => {
				const record = ++recordPosition;
				setProtocolError("Invalid subagent JSON event: malformed UTF-8.", "invalid_utf8", record);
			});
			const finish = (code: number | null) => {
				if (settling || settled) return;
				settling = true;
				clearTimeout(drainTimer);
				clearTimeout(deadlineTimer);
				const complete = () => {
					if (settled) return;
					settled = true;
					signal?.removeEventListener("abort", killProc);
					reader.finish();
					resolve(code ?? 1);
				};
				if (escalation) void escalation.then(complete);
				else complete();
			};

			// Keep stdout as bytes so malformed UTF-8 cannot be silently replaced.
			proc.stderr.setEncoding("utf8");
			proc.stdout.on("data", (data: Buffer) => reader.append(data));
			proc.stderr.on("data", (data: string) => {
				stderr.append(data);
				currentResult.stderr = stderr.text;
				currentResult.capture!.stderrTruncated = stderr.truncated;
			});

			proc.on("exit", (code) => {
				leaderExited = true;
				currentResult.processExitCode = code;
				clearTimeout(deadlineTimer);
				// close also waits for inherited pipe handles. Give normal output a
				// drain window, then clean up descendants and close our pipe ends.
				drainTimer = setTimeout(() => {
					if (closed) return;
					currentResult.capture!.inheritedPipesClosed = true;
					terminateGroup();
					closePipes();
					finish(code);
				}, 1000);
			});
			proc.on("close", (code) => {
				closed = true;
				// Reap group members even if they closed or ignored inherited stdio.
				if (!wasAborted && !timedOut) terminateGroup();
				finish(code);
			});

			proc.once("spawn", () => { processSpawned = true; });
			proc.on("error", (error) => {
				if (processSpawned) {
					currentResult.errorMessage = "Subagent child process reported an error.";
				} else {
					const errorCode = (error as NodeJS.ErrnoException).code;
					const code = typeof errorCode === "string" && /^[A-Z][A-Z0-9_]{0,31}$/.test(errorCode)
						? ` (${errorCode})` : "";
					currentResult.errorMessage = `Subagent setup failed while launching child process${code}.`;
				}
				// Node emits close after error; let close own cleanup and slot release.
			});

			if (timeoutMs !== undefined) {
				deadlineTimer = setTimeout(() => {
					if (wasAborted || leaderExited || closed) return;
					timedOut = true;
					terminateGroup();
				}, timeoutMs);
			}

			// Pi prepends piped stdin to the prompt. This avoids OS argv size limits.
			// Early startup failures can close stdin; close/error above own the result.
			proc.stdin.on("error", () => {});
			proc.stdin.end(`Task: ${task}`);
			if (signal?.aborted) killProc();
			else signal?.addEventListener("abort", killProc, { once: true });
		});

		if (exitCode === 0 && !wasAborted && !timedOut && !protocolError) {
			if (currentResult.usage.turns === 0) {
				setProtocolError("Subagent exited without a completed assistant message.", "process_exit");
			} else if (currentResult.stopReason === "toolUse") {
				setProtocolError("Subagent exited after a tool-use response without a final assistant response.", "process_exit");
			}
		}
		const finalAssistantMessageDropped = exitCode === 0 && !protocolError && !timedOut &&
			currentResult.capture?.finalAssistantMessageDropped;
		currentResult.exitCode = protocolError || timedOut || finalAssistantMessageDropped ? 1 : exitCode;
		if (timedOut) currentResult.timedOut = true;
		const failureCauses = [
			timedOut ? `Subagent timed out after ${timeoutMs} ms.` : undefined,
			protocolError,
			finalAssistantMessageDropped ? "Final assistant message exceeded the available history capture budget." : undefined,
		];
		if (failureCauses.some(Boolean)) currentResult.errorMessage = failureCauses.filter(Boolean).join(" ");
		if (wasAborted) throw signal?.reason ?? new Error("Subagent was aborted");
		return currentResult;
	} catch (error) {
		// Cancellation still aborts the whole operation. Only pre-spawn failures
		// become task results; do not disguise unrelated execution errors as setup.
		if (signal?.aborted || childCreated) throw error;
		if (error instanceof ProcessPoolCapacityError) {
			currentResult.exitCode = 1;
			currentResult.errorMessage = error.message;
			return currentResult;
		}
		const code = error && typeof error === "object" && "code" in error ? error.code : undefined;
		const diagnostic = typeof code === "string" && /^[A-Z][A-Z0-9_]{0,31}$/.test(code) ? ` (${code})` : "";
		currentResult.exitCode = 1;
		currentResult.errorMessage = `Subagent setup failed while ${setupPhase}${diagnostic}.`;
		return currentResult;
	} finally {
		release?.();
		if (tmpPromptPath)
			try {
				fs.unlinkSync(tmpPromptPath);
			} catch {
				/* ignore */
			}
		if (tmpPromptDir)
			try {
				fs.rmdirSync(tmpPromptDir);
			} catch {
				/* ignore */
			}
	}
}

const TimeoutSchema = Type.Integer({
	minimum: 1,
	maximum: MAX_TIMEOUT_MS,
	description: "Per-task runtime deadline in milliseconds, starting at child spawn. Queue time excluded. No deadline by default.",
});

const DispatchOptions = {
	model: Type.Optional(Type.String({ minLength: 1, description: "Override the agent's model. Accepts a Pi model selector, including provider/id and :thinking suffixes." })),
	thinking: Type.Optional(StringEnum(THINKING_LEVELS, { description: "Override the agent's thinking level, including any model suffix." })),
};

const AgentNameSchema = Type.String({
	pattern: AGENT_NAME_PATTERN,
	minLength: 1,
	maxLength: MAX_AGENT_NAME_BYTES,
	description: `Agent name; maximum ${MAX_AGENT_NAME_BYTES} UTF-8 bytes and no terminal or bidirectional controls.`,
});

function taskTextSchema(description: string) {
	return Type.String({ maxLength: MAX_TASK_BYTES,
		description: `${description}. Maximum ${MAX_TASK_BYTES / (1024 * 1024)} MiB UTF-8 per task and ${MAX_DISPATCH_TASK_BYTES / (1024 * 1024)} MiB total per dispatch.` });
}

const WorkingDirectory = Type.String({
	pattern: "^[^\\u0000]*$",
	description: "Working directory for the agent process; must not contain a NUL character.",
});

const TaskItem = Type.Object({
	...DispatchOptions,
	agent: AgentNameSchema,
	task: taskTextSchema("Task to delegate to the agent"),
	timeoutMs: Type.Optional(TimeoutSchema),
	cwd: Type.Optional(WorkingDirectory),
});

const ChainItem = Type.Object({
	...DispatchOptions,
	id: Type.Optional(Type.String({ pattern: CHAIN_ID_PATTERN, minLength: 1, maxLength: 64,
		description: "Optional unique step ID. Later tasks reference this output with {steps.ID}." })),
	agent: AgentNameSchema,
	task: taskTextSchema("Task with {previous} for the preceding output or {steps.ID} for an earlier named step"),
	timeoutMs: Type.Optional(TimeoutSchema),
	cwd: Type.Optional(WorkingDirectory),
});

const AgentScopeSchema = StringEnum(["user", "project", "both"] as const, {
	description: 'Which agent directories to use. Default: "user". Use "both" to include project-local agents.',
	default: "user",
});

const SubagentParams = Type.Object({
	...DispatchOptions,
	background: Type.Optional(
		Type.Boolean({
			description: "Return a job ID immediately and deliver results later. TUI/RPC only. Default: false.",
			default: false,
		}),
	),
	notify: Type.Optional(Type.Boolean({ default: true,
		description: "Background only: send an automatic completion follow-up. Set false for silent jobs inspected with subagent_jobs. Default: true." })),
	agent: Type.Optional(AgentNameSchema),
	task: Type.Optional(taskTextSchema("Task to delegate (for single mode)")),
	tasks: Type.Optional(
		Type.Array(TaskItem, {
			description: "Array of {agent, task} for parallel execution",
			minItems: 1,
			maxItems: MAX_PARALLEL_TASKS,
		}),
	),
	chain: Type.Optional(
		Type.Array(ChainItem, {
			description: "Array of {agent, task} for sequential execution, up to 32 steps",
			minItems: 1,
			maxItems: MAX_CHAIN_STEPS,
		}),
	),
	agentScope: Type.Optional(AgentScopeSchema),
	concurrency: Type.Optional(Type.Integer({
		minimum: 1, maximum: MAX_CONCURRENCY, default: MAX_CONCURRENCY,
		description: "Parallel mode only: maximum simultaneous tasks in this batch, from 1 to 4. Shared process budget still applies.",
	})),
	timeoutMs: Type.Optional(TimeoutSchema),
	confirmProjectAgents: Type.Optional(
		Type.Boolean({
			description: "Prompt before running project-local agents. Default: true.",
			default: true,
		}),
	),
	cwd: Type.Optional(WorkingDirectory),
});

type SubagentExecute = ToolDefinition<typeof SubagentParams, SubagentDetails>["execute"];

function boundedSubagentExecute(execute: SubagentExecute): SubagentExecute {
	return async (id, params, signal, onUpdate, ctx) => boundResultText(await execute(
		id, params, signal, onUpdate ? (partial) => onUpdate(boundResultText(partial)) : undefined, ctx,
	));
}

const JOB_ACTIONS = ["list", "status", "cancel", "forget", "clear", "output", "wait"] as const;
type JobAction = typeof JOB_ACTIONS[number];
const JobActionSchema = StringEnum(JOB_ACTIONS);
const TokenCountSchema = Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER });
const UsageSummarySchema = Type.Object({
	input: TokenCountSchema, output: TokenCountSchema,
	cacheRead: TokenCountSchema, cacheWrite: TokenCountSchema,
	totalTokens: TokenCountSchema,
	cost: Type.Object({
		input: Type.Number({ minimum: 0 }), output: Type.Number({ minimum: 0 }),
		cacheRead: Type.Number({ minimum: 0 }), cacheWrite: Type.Number({ minimum: 0 }),
		total: Type.Number({ minimum: 0 }),
	}),
	cacheWrite1h: Type.Optional(TokenCountSchema),
	reasoning: Type.Optional(TokenCountSchema),
});
const FailureContextSchema = Type.Object({
	eventType: StringEnum(["invalid_json", "invalid_utf8", "invalid_event", "message_end", "tool_result_end", "oversized_record", "process_exit"] as const),
	role: Type.Optional(StringEnum(["assistant", "user", "toolResult", "system", "custom", "bashExecution", "branchSummary", "compactionSummary", "other"] as const)),
	record: Type.Optional(Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER })),
	lastStopReason: Type.Optional(StringEnum(["stop", "length", "toolUse", "error", "aborted", "deferred"] as const)),
});
const JobMetadataSchema = Type.Object({
	id: Type.String(), label: Type.String(), notify: Type.Boolean(),
	state: StringEnum(["running", "canceling", "completed", "failed", "canceled"] as const),
	startedAt: Type.String(), finishedAt: Type.Optional(Type.String()),
	error: Type.Optional(Type.String()), outputEvicted: Type.Optional(Type.Boolean()),
	resultCount: Type.Optional(Type.Integer()), usage: Type.Optional(UsageSummarySchema),
});
const JobResponseSchema = Type.Object({
	action: JobActionSchema,
	jobs: Type.Optional(Type.Array(JobMetadataSchema)),
	job: Type.Optional(JobMetadataSchema),
	output: Type.Optional(Type.Object({
		taskIndex: Type.Integer(), agent: Type.String(), exitCode: Type.Integer(),
		processExitCode: Type.Optional(Type.Union([Type.Integer(), Type.Null()])),
		partial: Type.Boolean(), failureContext: Type.Optional(FailureContextSchema), stepId: Type.Optional(Type.String()),
		text: Type.String(), offset: Type.Integer(), totalBytes: Type.Integer(),
		nextOffset: Type.Union([Type.Integer(), Type.Null()]),
	})),
	forgotten: Type.Optional(Type.String()), cleared: Type.Optional(Type.Integer()),
	timedOut: Type.Optional(Type.Boolean()),
	error: Type.Optional(Type.String()),
});

function summarizeJobUsage(result: JobResult | undefined): Usage | undefined {
	const reports = result?.details?.results.flatMap((task) =>
		task.reportedUsage ? [task.reportedUsage] : [],
	) ?? [];
	if (reports.length === 0) return undefined;
	try {
		return sumUsage(reports);
	} catch {
		// Oversized aggregates are already represented as tool errors; do not
		// let optional observation metadata make status/list calls fail.
		return undefined;
	}
}

function jobMetadata(job: JobSnapshot<JobResult>, observation?: Usage): Static<typeof JobMetadataSchema> {
	const usage = observation ?? summarizeJobUsage(job.latest);
	return {
		id: job.id, label: truncateOutput(job.label, 1024, "..."),
		state: job.state, notify: job.notify, startedAt: job.startedAt,
		...(job.finishedAt ? { finishedAt: job.finishedAt } : {}),
		...(job.error ? { error: truncateOutput(job.error, 2048, "...") } : {}),
		...(job.outputEvicted ? { outputEvicted: true } : {}),
		...(job.latest?.details ? { resultCount: job.latest.details.results.length } : {}),
		...(usage !== undefined ? { usage } : {}),
	};
}

export default function (pi: ExtensionAPI) {
	const pool = new ProcessPool(MAX_CONCURRENCY, MAX_PROCESS_QUEUE);
	const jobs = new JobManager<JobResult, Usage>(
		(job) => {
			const output =
				job.state === "canceled"
					? "Canceled by request."
					: (job.error ??
						job.latest?.content
							.filter((c) => c.type === "text")
							.map((c) => c.text)
							.join("\n\n") ??
						"(no output)");
			pi.sendMessage(
				{
					customType: "subagent-background",
					content: truncateOutput(
						`Background subagent job ${job.id} ${job.state} (${displayUntrustedText(job.label)}).\n\n${output}`,
					),
					display: true,
					details: job,
				},
				{ deliverAs: "followUp", triggerTurn: true },
			);
		},
		(result) => Boolean(result.isError) || Boolean(result.details?.results.some(isFailedResult)),
		MAX_ACTIVE_JOBS, 32, { maxBytes: MAX_RETAINED_JOB_BYTES, measure: estimateJobBytes }, summarizeJobUsage,
	);
	pi.on("session_shutdown", async () => {
		await jobs.shutdown();
	});

	pi.registerTool({
		name: "subagent_agents",
		label: "Subagent agents",
		description: [
			"List available subagents, descriptions, configuration, and source paths without running them.",
			"Reports invalid and duplicate definitions. Defaults to personal agents; use agentScope to include project agents.",
		].join(" "),
		parameters: Type.Object({ agentScope: Type.Optional(AgentScopeSchema) }),
		outputSchema: Type.Object({
			agentScope: AgentScopeSchema,
			agents: Type.Array(Type.Object({
				name: Type.String(),
				description: Type.String(),
				source: StringEnum(["user", "project"] as const),
				filePath: Type.String(),
				model: Type.Optional(Type.String()),
				thinking: Type.Optional(Type.String()),
				tools: Type.Optional(Type.Array(Type.String())),
			})),
			projectAgentsDir: Type.Union([Type.String(), Type.Null()]),
			diagnostics: Type.Array(Type.Object({
				filePath: Type.String(),
				source: StringEnum(["user", "project"] as const),
				message: Type.String(),
			})),
		}),
		annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
		async execute(_id, params, _signal, _onUpdate, ctx) {
			const requestedAgentScope: unknown = params.agentScope;
			if (requestedAgentScope !== undefined && requestedAgentScope !== "user" &&
				requestedAgentScope !== "project" && requestedAgentScope !== "both") {
				const details = { agentScope: "user" as const, agents: [], projectAgentsDir: null, diagnostics: [] };
				return {
					content: [{ type: "text" as const, text: 'agentScope must be "user", "project", or "both".' }],
					details, structuredContent: details, isError: true,
				};
			}
			const agentScope: AgentScope = requestedAgentScope ?? "user";
			const discovery = discoverAgents(ctx.cwd, agentScope);
			const agents = discovery.agents.map((agent) => ({
				name: agent.name,
				description: agent.description,
				source: agent.source,
				filePath: agent.filePath,
				...(agent.model !== undefined ? { model: agent.model } : {}),
				...(agent.thinking !== undefined ? { thinking: agent.thinking } : {}),
				...(agent.tools !== undefined ? { tools: agent.tools } : {}),
			}));
			const listing = agents.map((a) => {
				const config = [
					a.model && `model=${displayUntrustedText(a.model)}`,
					a.thinking && `thinking=${a.thinking}`,
					a.tools && `tools=${displayUntrustedText(a.tools.length ? a.tools.join(",") : "none")}`,
				].filter(Boolean).join("; ");
				return `${displayUntrustedText(a.name)} (${a.source}): ${displayUntrustedText(a.description)}${config ? ` [${config}]` : ""}\n  ${displayUntrustedText(a.filePath)}`;
			}).join("\n");
			const warnings = discovery.diagnostics.map((d) => `${displayUntrustedText(d.filePath)}: ${displayUntrustedText(d.message)}`).join("\n");
			const details = {
				agentScope, agents, projectAgentsDir: discovery.projectAgentsDir,
				diagnostics: discovery.diagnostics.map((diagnostic) => ({ ...diagnostic })),
			};
			return {
				content: [{
					type: "text" as const,
					text: truncateOutput(
						(listing || "No subagents found.") + (warnings ? `\n\nDefinition diagnostics:\n${warnings}` : ""),
					),
				}],
				details,
				structuredContent: details,
			};
		},
	});

	pi.registerTool({
		name: "subagent_jobs",
		label: "Subagent jobs",
		description: "List, inspect, wait for, cancel, or forget session-owned background jobs. Wait blocks until cleanup finishes or its timeout expires without canceling the job. Use output to page through a finished task's captured text, failure diagnosis, and any partial, unverified assistant/tool output. Clear removes only finished records; it never cancels active jobs. Do not poll repeatedly; non-silent completions arrive automatically as follow-ups.",
		parameters: Type.Object({
			action: JobActionSchema,
			jobId: Type.Optional(Type.String({ description: "Job ID required except for list and clear." })),
			taskIndex: Type.Optional(Type.Integer({ minimum: 0, description: "Output only: zero-based task index. Default: 0." })),
			offset: Type.Optional(Type.Integer({ minimum: 0, description: "Output only: UTF-8 byte offset. Default: 0. Use nextOffset from the previous page." })),
			limit: Type.Optional(Type.Integer({ minimum: 4, maximum: MAX_PAGE_BYTES, description: "Output only: maximum page bytes, from 4 to 32768. Default: 16384." })),
			timeoutMs: Type.Optional(Type.Integer({ minimum: 1, maximum: MAX_JOB_WAIT_MS, default: DEFAULT_JOB_WAIT_MS,
				description: "Wait only: maximum milliseconds to wait, from 1 to 60000. Default: 30000. Does not cancel the job." })),
		}),
		outputSchema: JobResponseSchema,
		async execute(_id, params, signal): Promise<AgentToolResult<JobToolDetails>> {
			const requestedAction: unknown = params.action;
			const action: JobAction | undefined = typeof requestedAction === "string" &&
				(JOB_ACTIONS as readonly string[]).includes(requestedAction)
				? requestedAction as JobAction : undefined;
			const reply = (text: string, details: JobToolDetails, data: Omit<Static<typeof JobResponseSchema>, "action">, isError = false): AgentToolResult<JobToolDetails> => ({
				content: [{ type: "text", text: truncateOutput(text) }], details,
				structuredContent: { action: action ?? "status", ...data }, ...(isError ? { isError: true } : {}),
			});
			const fail = (error: string, job?: JobSnapshot<JobResult>) =>
				reply(error, undefined, { error, ...(job ? { job: jobMetadata(job, jobs.getObservation(job.id)) } : {}) }, true);
			if (!action) return fail(`action must be one of: ${JOB_ACTIONS.join(", ")}.`);
			if (params.timeoutMs !== undefined && (action !== "wait" || !Number.isInteger(params.timeoutMs) ||
				params.timeoutMs < 1 || params.timeoutMs > MAX_JOB_WAIT_MS)) {
				return fail(`timeoutMs applies only to action: wait and must be an integer between 1 and ${MAX_JOB_WAIT_MS}.`);
			}
			if (action !== "output" && [params.taskIndex, params.offset, params.limit].some((v) => v !== undefined)) {
				return fail("taskIndex, offset, and limit apply only to action: output.");
			}
			if (action === "output" && (
				(params.taskIndex !== undefined && (!Number.isSafeInteger(params.taskIndex) || params.taskIndex < 0)) ||
				(params.offset !== undefined && (!Number.isSafeInteger(params.offset) || params.offset < 0)) ||
				(params.limit !== undefined && (!Number.isInteger(params.limit) || params.limit < 4 || params.limit > MAX_PAGE_BYTES)))) {
				return fail("Invalid output query. Use non-negative integer taskIndex/offset and a limit between 4 and 32768.");
			}
			if (action === "clear") {
				const cleared = jobs.clearFinished();
				return reply(`Cleared ${cleared} finished job record(s). Active jobs are unchanged.`, { cleared }, { cleared });
			}
			if (action === "list") {
				const listed = jobs.list();
				const snapshots = listed.map(({ latest: _latest, ...job }) => job);
				const metadata = listed.map((job) => jobMetadata(job, jobs.getObservation(job.id)));
				return reply(metadata.length
					? metadata.map((j) => `${j.id} ${j.state}: ${j.label}${!j.notify ? " (silent)" : ""}${j.outputEvicted ? " (output evicted)" : ""}`).join("\n")
					: "No background subagent jobs.", { jobs: snapshots }, { jobs: metadata });
			}
			const waited = action === "wait" && params.jobId
				? await jobs.wait(params.jobId, params.timeoutMs ?? DEFAULT_JOB_WAIT_MS, signal) : undefined;
			const job = action === "wait" ? waited?.job : params.jobId
				? action === "cancel" ? jobs.cancel(params.jobId) : jobs.get(params.jobId)
				: undefined;
			if (!job) return fail("Unknown or missing job ID. Use action: list to see jobs.");
			if (action === "forget") {
				if (!job.finishedAt) return fail("Cannot forget an active job. Cancel it and wait for cleanup first.", job);
				jobs.forget(job.id);
				return reply(`Forgot finished job ${job.id}.`, { forgotten: job.id }, { forgotten: job.id });
			}
			const metadata = jobMetadata(job, jobs.getObservation(job.id));
			const completionHint = job.notify ? "See the completion message." : "Silent jobs do not deliver completion messages.";
			if (action === "output") {
				if (!job.finishedAt) return fail("Output pages require a finished job. Use action: wait to await cleanup.", job);
				if (job.outputEvicted) return fail(`Captured output was evicted from the job registry. ${completionHint}`, job);
				const taskIndex = params.taskIndex ?? 0;
				const task = job.latest?.details?.results[taskIndex];
				if (!task) return fail("No retained task at this taskIndex. Inspect status for resultCount.", job);
				try {
					const output = { ...pageResultOutput(task, params.offset ?? 0, params.limit ?? 16384),
						taskIndex, agent: truncateOutput(task.agent, 256, "..."), exitCode: task.exitCode,
						...(task.processExitCode !== undefined ? { processExitCode: task.processExitCode } : {}),
						partial: isPartialResult(task),
						...(task.failureContext ? { failureContext: task.failureContext } : {}),
						...(task.stepId !== undefined ? { stepId: task.stepId } : {}) };
					const cursor = output.nextOffset === null ? "end" : `nextOffset=${output.nextOffset}`;
					return reply(`${job.id} task ${taskIndex} [${output.agent}] bytes ${output.offset}/${output.totalBytes} (${cursor})\n\n${output.text}`,
						metadata, { job: metadata, output });
				} catch (error) {
					if (!(error instanceof RangeError)) throw error;
					return fail(error.message, job);
				}
			}
			const output = job.error ?? (job.state === "canceled"
				? "Canceled by request."
				: job.outputEvicted
					? `Captured output was evicted from the job registry to honor its retention budget. ${completionHint}`
					: job.latest?.content.filter((c) => c.type === "text").map((c) => c.text).join("\n\n") ?? "(awaiting output)");
			const waitNotice = waited?.timedOut ? `Wait timed out. The job is still active; ${job.notify
				? "completion will arrive automatically." : "no automatic completion message will be sent."}\n` : "";
			return reply(`${waitNotice}${job.id} ${job.state}: ${displayUntrustedText(job.label)}\n\n${output}`, job,
				{ job: metadata, ...(waited ? { timedOut: waited.timedOut } : {}) });
		},
	});

	pi.registerTool({
		name: "subagent",
		label: "Subagent",
		description: [
			"Delegate tasks to specialized subagents with isolated context.",
			"Modes: single (agent + task), parallel (tasks array), chain (sequential with {previous} or {steps.ID} output references).",
			"Use subagent_agents to discover available agents and diagnose invalid definitions.",
			"Set timeoutMs for a per-child runtime deadline. Parallel/chain entries can override it. Queue time is excluded.",
			"In parallel mode, set concurrency from 1 to 4 to lower this batch's process limit.",
			"Set model or thinking to override agent configuration. Parallel/chain entries override batch defaults.",
			"Set background: true to return immediately with a job ID while you continue working. Results arrive automatically unless notify: false requests a silent job. Use subagent_jobs to inspect, wait, or cancel.",
			`Default agent scope is "user" (from ${path.join(getAgentDir(), "agents")}).`,
			`To enable project-local agents in ${CONFIG_DIR_NAME}/agents, set agentScope: "both" (or "project").`,
		].join(" "),
		parameters: SubagentParams,

		execute: boundedSubagentExecute(async (_toolCallId, params, signal, onUpdate, ctx) => {
			const requestedAgentScope: unknown = params.agentScope;
			if (requestedAgentScope !== undefined && requestedAgentScope !== "user" &&
				requestedAgentScope !== "project" && requestedAgentScope !== "both") {
				return {
					content: [{ type: "text", text: 'agentScope must be "user", "project", or "both".' }],
					details: { mode: "single", agentScope: "user", projectAgentsDir: null, results: [] },
					isError: true,
				};
			}
			const agentScope: AgentScope = requestedAgentScope ?? "user";
			const dispatchDefaults: DispatchDefaults = {
				model: ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined,
				thinkingLevel: ctx.thinkingLevel,
			};
			const defaultCwd = ctx.cwd;
			const discovery = discoverAgents(defaultCwd, agentScope);
			const agents = discovery.agents;

			const hasChain = params.chain !== undefined;
			const hasTasks = params.tasks !== undefined;
			const hasSingle = params.agent !== undefined || params.task !== undefined;
			const modeCount = Number(hasChain) + Number(hasTasks) + Number(hasSingle);
			const concurrency = Number.isInteger(params.concurrency) && params.concurrency! >= 1 && params.concurrency! <= MAX_CONCURRENCY
				? params.concurrency! : MAX_CONCURRENCY;

			const makeDetails =
				(mode: "single" | "parallel" | "chain") =>
				(results: SingleResult[]): SubagentDetails => ({
					mode,
					agentScope,
					projectAgentsDir: discovery.projectAgentsDir,
					results,
					...(mode === "parallel" ? { concurrency } : {}),
				});

			if (modeCount !== 1) {
				const available = agents.map((a) => `${displayUntrustedText(a.name)} (${a.source})`).join(", ") || "none";
				return {
					content: [
						{
							type: "text",
							text: `Invalid parameters. Provide exactly one mode.\nAvailable agents: ${available}`,
						},
					],
					details: makeDetails("single")([]),
					isError: true,
				};
			}

			const mode = hasChain ? "chain" : hasTasks ? "parallel" : "single";
			if (params.confirmProjectAgents !== undefined && typeof params.confirmProjectAgents !== "boolean") {
				return {
					content: [{ type: "text", text: "confirmProjectAgents must be a boolean." }],
					details: makeDetails(mode)([]), isError: true,
				};
			}
			const confirmProjectAgents = params.confirmProjectAgents ?? true;
			if (params.background !== undefined && typeof params.background !== "boolean") {
				return {
					content: [{ type: "text", text: "background must be a boolean." }],
					details: makeDetails(mode)([]), isError: true,
				};
			}
			if (params.notify !== undefined && (typeof params.notify !== "boolean" || !params.background)) {
				return {
					content: [{ type: "text", text: "notify applies only to background jobs and must be a boolean." }],
					details: makeDetails(mode)([]), isError: true,
				};
			}
			const batch = hasChain ? params.chain : params.tasks;
			if (mode !== "single" && !Array.isArray(batch)) {
				return {
					content: [{ type: "text", text: "tasks and chain must be arrays of tasks." }],
					details: makeDetails(mode)([]), isError: true,
				};
			}
			const taskLimit = hasChain ? MAX_CHAIN_STEPS : MAX_PARALLEL_TASKS;
			if (batch && batch.length > taskLimit) {
				return {
					content: [{ type: "text", text: `Too many ${hasChain ? "chain steps" : "parallel tasks"} (${batch.length}). Max is ${taskLimit}.` }],
					details: makeDetails(mode)([]), isError: true,
				};
			}
			if (params.concurrency !== undefined && (mode !== "parallel" || !Number.isInteger(params.concurrency) ||
				params.concurrency < 1 || params.concurrency > MAX_CONCURRENCY)) {
				return {
					content: [{ type: "text", text: `concurrency applies only to parallel mode and must be an integer from 1 to ${MAX_CONCURRENCY}.` }],
					details: makeDetails(mode)([]), isError: true,
				};
			}
			const requested = hasChain ? params.chain! : hasTasks ? params.tasks! : [{ agent: params.agent!, task: params.task! }];
			if (!requested.length || requested.some((item) =>
				typeof item?.agent !== "string" || typeof item?.task !== "string")) {
				return {
					content: [{ type: "text", text: "Provide a non-empty agent and task for each requested task." }],
					details: makeDetails(mode)([]), isError: true,
				};
			}
			let submittedTaskBytes = 0;
			for (const item of requested) {
				if (!isSafeAgentName(item.agent)) return {
					content: [{ type: "text", text: `Agent name must be at most ${MAX_AGENT_NAME_BYTES} UTF-8 bytes and contain no terminal or bidirectional controls.` }],
					details: makeDetails(mode)([]), isError: true,
				};
				const bytes = taskByteLength(item.task);
				if (bytes > MAX_TASK_BYTES) return {
					content: [{ type: "text", text: taskSizeError() }],
					details: makeDetails(mode)([]), isError: true,
				};
				if (!item.task.trim()) return {
					content: [{ type: "text", text: "Provide a non-empty agent and task for each requested task." }],
					details: makeDetails(mode)([]), isError: true,
				};
				if (bytes > MAX_DISPATCH_TASK_BYTES - submittedTaskBytes) return {
					content: [{ type: "text", text: `Combined task text exceeds the ${MAX_DISPATCH_TASK_BYTES / (1024 * 1024)} MiB UTF-8 size limit.` }],
					details: makeDetails(mode)([]), isError: true,
				};
				submittedTaskBytes += bytes;
			}
			const referenceError = params.chain ? validateChainReferences(params.chain) : undefined;
			if (referenceError) return {
				content: [{ type: "text", text: referenceError }],
				details: makeDetails(mode)([]), isError: true,
			};
			if (params.chain && !substituteChainContext(params.chain[0].task, "", new Map()).trim()) {
				return {
					content: [{ type: "text", text: "The first chain task is empty after replacing {previous}. There is no previous output at step 1." }],
					details: makeDetails(mode)([]), isError: true,
				};
			}
			const configurations: DispatchOverrides[] = [params, ...(params.tasks ?? []), ...(params.chain ?? [])];
			if (configurations.some((item) =>
				(item.model !== undefined && (typeof item.model !== "string" || !item.model.trim())) ||
				(item.thinking !== undefined && !THINKING_LEVELS.includes(item.thinking)))) {
				return {
					content: [{ type: "text", text: `model must be a non-empty string; thinking must be one of: ${THINKING_LEVELS.join(", ")}.` }],
					details: makeDetails(mode)([]), isError: true,
				};
			}
			const deadlines = [params.timeoutMs, ...(params.tasks ?? []).map((t) => t.timeoutMs),
				...(params.chain ?? []).map((t) => t.timeoutMs)];
			if (deadlines.some((value) => value !== undefined &&
				(!Number.isInteger(value) || value < 1 || value > MAX_TIMEOUT_MS))) {
				return {
					content: [{ type: "text", text: `timeoutMs must be an integer between 1 and ${MAX_TIMEOUT_MS}.` }],
					details: makeDetails(mode)([]),
					isError: true,
				};
			}
			const workingDirectories: unknown[] = [params.cwd,
				...(params.tasks ?? []).map((task) => task.cwd),
				...(params.chain ?? []).map((step) => step.cwd)];
			if (workingDirectories.some((cwd) => cwd !== undefined &&
				(typeof cwd !== "string" || cwd.includes("\0")))) {
				return {
					content: [{ type: "text", text: "cwd must be a string without NUL characters." }],
					details: makeDetails(mode)([]),
					isError: true,
				};
			}
			if (params.background && ctx.mode !== "tui" && ctx.mode !== "rpc") {
				return {
					content: [
						{
							type: "text",
							text: "Background subagents require a long-lived TUI or RPC session. Use foreground execution in print/JSON mode.",
						},
					],
					details: makeDetails(mode)([]),
					isError: true,
				};
			}
			{
				const unknown = requested.find((r) => !agents.some((a) => a.name === r.agent));
				if (unknown)
					return {
						content: [
							{
								type: "text",
								text: `Unknown agent: ${displayUntrustedText(unknown.agent)}. Available agents: ${agents.map((a) => displayUntrustedText(a.name)).join(", ") || "none"}.`,
							},
						],
						details: makeDetails(mode)([]),
						isError: true,
					};
			}

			if (
				(agentScope === "project" || agentScope === "both") &&
				confirmProjectAgents &&
				ctx.hasUI &&
				!ctx.isProjectTrusted()
			) {
				const requestedAgentNames = new Set<string>();
				if (params.chain) for (const step of params.chain) requestedAgentNames.add(step.agent);
				if (params.tasks) for (const t of params.tasks) requestedAgentNames.add(t.agent);
				if (params.agent) requestedAgentNames.add(params.agent);

				const projectAgentsRequested = Array.from(requestedAgentNames)
					.map((name) => agents.find((a) => a.name === name))
					.filter((a): a is AgentConfig => a?.source === "project");

				if (projectAgentsRequested.length > 0) {
					const names = projectAgentsRequested.map((a) => displayUntrustedText(a.name)).join(", ");
					const dir = displayUntrustedText(discovery.projectAgentsDir ?? "(unknown)");
					const ok = await ctx.ui.confirm(
						"Run project-local agents?",
						`Agents: ${names}\nSource: ${dir}\n\nProject agents are repo-controlled. Only continue for trusted repositories.`,
					);
					if (!ok)
						return {
							content: [
								{
									type: "text",
									text: "Canceled: project-local agents not approved.",
								},
							],
							details: makeDetails(hasChain ? "chain" : hasTasks ? "parallel" : "single")([]),
						};
				}
			}

			// Capture dispatch configuration and permissions before detaching from this turn.
			const run = async (
				signal: AbortSignal | undefined,
				onUpdate: OnUpdateCallback | undefined,
			): Promise<AgentToolResult<SubagentDetails>> => {
				if (params.chain && params.chain.length > 0) {
					const results: SingleResult[] = [];
					let retainedHistoryBytes = 0;
					let expandedTaskBytes = 0;
					let previousOutput = "";
					const namedOutputs = new Map<string, string>();

					for (let i = 0; i < params.chain.length; i++) {
						const step = params.chain[i];
						const remainingTaskBytes = MAX_DISPATCH_TASK_BYTES - expandedTaskBytes;
						const taskByteLimit = Math.min(MAX_TASK_BYTES, remainingTaskBytes);
						const boundedTask = substituteChainContextBounded(step.task, previousOutput, namedOutputs, taskByteLimit);
						const expandedTaskTooLarge = boundedTask === undefined;
						const expandedTaskError = expandedTaskTooLarge && remainingTaskBytes < MAX_TASK_BYTES
							? `Expanded chain task exceeds the remaining ${remainingTaskBytes} UTF-8 bytes of the ${MAX_DISPATCH_TASK_BYTES / (1024 * 1024)} MiB per-dispatch task limit.`
							: undefined;
						// Keep only the bounded template in the failed result if expansion would exceed the cap.
						const taskWithContext = boundedTask ?? step.task;

						// Create update callback that includes all previous results
						const chainUpdate: OnUpdateCallback | undefined = onUpdate
							? (partial) => {
									// Combine completed results with current streaming result
									const currentResult = partial.details?.results[0];
									if (currentResult) {
										if (step.id !== undefined) currentResult.stepId = step.id;
										const allResults = [...results, currentResult];
										onUpdate({
											content: partial.content,
											details: makeDetails("chain")(allResults),
										});
									}
								}
							: undefined;

						const remainingSteps = params.chain.length - i;
						const availableHistoryBytes = MAX_DISPATCH_HISTORY_BYTES - retainedHistoryBytes;
						const historyByteLimit = Math.max(1, Math.min(
							MAX_HISTORY_BYTES, Math.floor(availableHistoryBytes / remainingSteps),
						));
						const result = await runSingleAgent(
							defaultCwd,
							pool,
							dispatchDefaults,
							agents,
							step.agent,
							taskWithContext,
							step.cwd,
							{ model: step.model ?? params.model, thinking: step.thinking ?? params.thinking },
							step.timeoutMs ?? params.timeoutMs,
							i + 1,
							signal,
							chainUpdate,
							makeDetails("chain"),
							expandedTaskTooLarge,
							historyByteLimit,
							expandedTaskError,
						);
						if (step.id !== undefined) result.stepId = step.id;
						if (boundedTask !== undefined) expandedTaskBytes += Buffer.byteLength(taskWithContext, "utf8");
						retainedHistoryBytes += result.capture?.retainedMessageBytes ?? 0;
						results.push(result);

						const isError = isFailedResult(result);
						if (isError) {
							const errorMsg = getResultOutput(result);
							return {
								content: [
									{
										type: "text",
										text: `Chain stopped at step ${i + 1} (${displayUntrustedText(step.agent)}): ${errorMsg}`,
									},
								],
								details: makeDetails("chain")(results),
								isError: true,
							};
						}
						previousOutput = getFinalOutput(result.messages);
						if (step.id !== undefined) namedOutputs.set(step.id, previousOutput);
					}
					return {
						content: [
							{
								type: "text",
								text: getResultOutput(results[results.length - 1]),
							},
						],
						details: makeDetails("chain")(results),
					};
				}

				if (params.tasks && params.tasks.length > 0) {
					// Track all results for streaming updates
					const allResults: SingleResult[] = new Array(params.tasks.length);

					// Initialize placeholder results
					for (let i = 0; i < params.tasks.length; i++) {
						allResults[i] = {
							agent: params.tasks[i].agent,
							agentSource: "unknown",
							task: params.tasks[i].task,
							exitCode: -1, // -1 = running or waiting for a process slot
							messages: [],
							stderr: "",
							usage: {
								input: 0,
								output: 0,
								cacheRead: 0,
								cacheWrite: 0,
								cost: 0,
								contextTokens: 0,
								turns: 0,
							},
						};
					}

					const emitParallelUpdate = () => {
						if (onUpdate) {
							const running = allResults.filter((r) => r.exitCode === -1).length;
							const done = allResults.filter((r) => r.exitCode !== -1).length;
							onUpdate({
								content: [
									{
										type: "text",
										text: `Parallel: ${done}/${allResults.length} done, ${running} pending...`,
									},
								],
								details: makeDetails("parallel")([...allResults]),
							});
						}
					};

					const historyByteLimit = Math.max(1, Math.min(
						MAX_HISTORY_BYTES, Math.floor(MAX_DISPATCH_HISTORY_BYTES / params.tasks.length),
					));
					const results = await mapWithConcurrencyLimit(params.tasks, concurrency, async (t, index) => {
						const result = await runSingleAgent(
							defaultCwd,
							pool,
							dispatchDefaults,
							agents,
							t.agent,
							t.task,
							t.cwd,
							{ model: t.model ?? params.model, thinking: t.thinking ?? params.thinking },
							t.timeoutMs ?? params.timeoutMs,
							undefined,
							signal,
							// Per-task update callback
							(partial) => {
								if (partial.details?.results[0]) {
									allResults[index] = partial.details.results[0];
									emitParallelUpdate();
								}
							},
							makeDetails("parallel"),
							false,
							historyByteLimit,
						);
						allResults[index] = result;
						emitParallelUpdate();
						return result;
					});

					const successCount = results.filter((r) => !isFailedResult(r)).length;
					const header = `Parallel: ${successCount}/${results.length} succeeded\n\n`;
					const separator = "\n\n---\n\n";
					const headings = results.map((r) => {
						const status = isFailedResult(r)
							? `failed${r.stopReason ? ` (${r.stopReason})` : ""}` : "completed";
						return `### [${displayUntrustedText(truncateOutput(r.agent, 256, "..."))}] ${status}\n\n`;
					});
					const overhead = Buffer.byteLength(header + headings.join(separator));
					const bodyBudget = Math.max(0, Math.floor((MODEL_TEXT_CAP - overhead) / results.length));
					const summaries = results.map((r, i) => headings[i] + truncateOutput(getResultOutput(r), bodyBudget));
					return {
						content: [
							{
								type: "text",
								text: header + summaries.join(separator),
							},
						],
						details: makeDetails("parallel")(results),
						isError: successCount !== results.length,
					};
				}

				if (params.agent && params.task) {
					const result = await runSingleAgent(
						defaultCwd,
						pool,
						dispatchDefaults,
						agents,
						params.agent,
						params.task,
						params.cwd,
						params,
						params.timeoutMs,
						undefined,
						signal,
						onUpdate,
						makeDetails("single"),
					);
					const isError = isFailedResult(result);
					if (isError) {
						const errorMsg = getResultOutput(result);
						return {
							content: [
								{
									type: "text",
									text: `Agent failed: ${errorMsg}`,
								},
							],
							details: makeDetails("single")([result]),
							isError: true,
						};
					}
					return {
						content: [
							{
								type: "text",
								text: getResultOutput(result),
							},
						],
						details: makeDetails("single")([result]),
					};
				}

				const available = agents.map((a) => `${displayUntrustedText(a.name)} (${a.source})`).join(", ") || "none";
				return {
					content: [
						{
							type: "text",
							text: `Invalid parameters. Available agents: ${available}`,
						},
					],
					details: makeDetails("single")([]),
				};
			};

			if (!params.background) return reportUsage(await run(signal, onUpdate));
			signal?.throwIfAborted();
			const label =
				mode === "single"
					? params.agent!
					: `${mode}: ${(hasChain ? params.chain! : params.tasks!).map((t) => t.agent).join(", ")}`;
			const job = jobs.start(label, async (jobSignal, update) => boundResultText(
				reportUsage(await run(jobSignal, (partial) => update(boundResultText(partial)))),
			), { notify: params.notify });
			return {
				content: [
					{
						type: "text",
						text: `Background job ${job.id} started (${displayUntrustedText(label)}). ${job.notify
							? "Continue your work; results will arrive automatically."
							: "No automatic completion message will be sent."} Use subagent_jobs to inspect, wait, or cancel.`,
					},
				],
				details: {
					...makeDetails(mode)([]),
					background: { id: job.id, state: job.state, notify: job.notify },
				},
			};
		}),

		renderCall(args, theme, _context) {
			const scope = `${stringArg(args.agentScope, "user")}${args.background ? ", background" : ""}${args.background && args.notify === false ? ", silent" : ""}`;
			if (Array.isArray(args.chain) && args.chain.length > 0) {
				let text =
					theme.fg("toolTitle", theme.bold("subagent ")) +
					theme.fg("accent", `chain (${args.chain.length} steps)`) +
					theme.fg("muted", ` [${scope}]`);
				for (let i = 0; i < Math.min(args.chain.length, 3); i++) {
					const step = args.chain[i];
					// Clean up {previous} placeholder for display
					const cleanTask = stringArg(step?.task, "").replace(/\{previous\}|\{steps\.[^{}]*\}/g, "").trim();
					const preview = cleanTask.length > 40 ? `${cleanTask.slice(0, 40)}...` : cleanTask;
					text +=
						"\n  " +
						theme.fg("muted", `${i + 1}.`) +
						" " +
						theme.fg("accent", previewAgentName(stringArg(step?.agent))) +
						theme.fg("dim", ` ${preview}`);
				}
				if (args.chain.length > 3) text += `\n  ${theme.fg("muted", `... +${args.chain.length - 3} more`)}`;
				return new Text(text, 0, 0);
			}
			if (Array.isArray(args.tasks) && args.tasks.length > 0) {
				let text =
					theme.fg("toolTitle", theme.bold("subagent ")) +
					theme.fg("accent", `parallel (${args.tasks.length} tasks, limit ${Number.isInteger(args.concurrency) ? args.concurrency : MAX_CONCURRENCY})`) +
					theme.fg("muted", ` [${scope}]`);
				for (const t of args.tasks.slice(0, 3)) {
					const task = stringArg(t?.task, "");
					const preview = task.length > 40 ? `${task.slice(0, 40)}...` : task;
					text += `\n  ${theme.fg("accent", previewAgentName(stringArg(t?.agent)))}${theme.fg("dim", ` ${preview}`)}`;
				}
				if (args.tasks.length > 3) text += `\n  ${theme.fg("muted", `... +${args.tasks.length - 3} more`)}`;
				return new Text(text, 0, 0);
			}
			const agentName = previewAgentName(stringArg(args.agent));
			const task = stringArg(args.task);
			const preview = task.length > 60 ? `${task.slice(0, 60)}...` : task;
			let text =
				theme.fg("toolTitle", theme.bold("subagent ")) +
				theme.fg("accent", agentName) +
				theme.fg("muted", ` [${scope}]`);
			text += `\n  ${theme.fg("dim", preview)}`;
			return new Text(text, 0, 0);
		},

		renderResult(result, { expanded }, theme, _context) {
			const details = result.details as SubagentDetails | undefined;
			if (!details || details.results.length === 0) {
				const text = result.content[0];
				return new Text(text?.type === "text" ? text.text : "(no output)", 0, 0);
			}

			const mdTheme = getMarkdownTheme();

			const renderDisplayItems = (items: DisplayItem[], limit?: number) => {
				const toShow = limit ? items.slice(-limit) : items;
				const skipped = limit && items.length > limit ? items.length - limit : 0;
				let text = "";
				if (skipped > 0) text += theme.fg("muted", `... ${skipped} earlier items\n`);
				for (const item of toShow) {
					if (item.type === "text") {
						const preview = expanded ? item.text : previewText(item.text);
						text += `${theme.fg("toolOutput", preview)}\n`;
					} else {
						text += `${theme.fg("muted", "→ ") + formatToolCall(item.name, item.args, theme.fg.bind(theme))}\n`;
					}
				}
				return text.trimEnd();
			};

			if (details.mode === "single" && details.results.length === 1) {
				const r = details.results[0];
				const isError = isFailedResult(r);
				const icon =
					r.exitCode === -1 ? theme.fg("warning", "⏳") : isError ? theme.fg("error", "✗") : theme.fg("success", "✓");
				const displayItems = getDisplayItems(r.messages);
				const finalOutput = getFinalOutput(r.messages);

				if (expanded) {
					const container = new Container();
					let header = `${icon} ${theme.fg("toolTitle", theme.bold(r.agent))}${theme.fg("muted", ` (${r.agentSource})`)}`;
					if (isError && r.stopReason) header += ` ${theme.fg("error", `[${r.stopReason}]`)}`;
					container.addChild(new Text(header, 0, 0));
					const failure = getFailureReason(r);
					if (failure) container.addChild(new Text(theme.fg("error", `Error: ${truncateOutput(failure)}`), 0, 0));
					container.addChild(new Spacer(1));
					container.addChild(new Text(theme.fg("muted", "─── Task ───"), 0, 0));
					container.addChild(new Text(theme.fg("dim", r.task), 0, 0));
					container.addChild(new Spacer(1));
					container.addChild(new Text(theme.fg("muted", "─── Output ───"), 0, 0));
					if (displayItems.length === 0 && !finalOutput) {
						container.addChild(new Text(theme.fg("muted", "(no output)"), 0, 0));
					} else {
						for (const item of displayItems) {
							if (item.type === "toolCall")
								container.addChild(
									new Text(theme.fg("muted", "→ ") + formatToolCall(item.name, item.args, theme.fg.bind(theme)), 0, 0),
								);
						}
						if (finalOutput) {
							container.addChild(new Spacer(1));
							container.addChild(new Markdown(finalOutput.trim(), 0, 0, mdTheme));
						}
					}
					const captureNotice = getCaptureNotice(r);
					if (captureNotice) container.addChild(new Text(theme.fg("warning", captureNotice), 0, 0));
					const usageStr = formatUsageStats(r.usage, r.model);
					if (usageStr) {
						container.addChild(new Spacer(1));
						container.addChild(new Text(theme.fg("dim", usageStr), 0, 0));
					}
					return container;
				}

				let text = `${icon} ${theme.fg("toolTitle", theme.bold(r.agent))}${theme.fg("muted", ` (${r.agentSource})`)}`;
				if (isError && r.stopReason) text += ` ${theme.fg("error", `[${r.stopReason}]`)}`;
				if (isError) text += `\n${theme.fg("error", `Error: ${previewText(getFailureReason(r))}`)}`;
				else if (displayItems.length === 0) text += `\n${theme.fg("muted", "(no output)")}`;
				else {
					text += `\n${renderDisplayItems(displayItems, COLLAPSED_ITEM_COUNT)}`;
					if (displayItems.length > COLLAPSED_ITEM_COUNT) text += `\n${theme.fg("muted", "(Ctrl+O to expand)")}`;
				}
				const captureNotice = getCaptureNotice(r);
				if (captureNotice) text += `\n${theme.fg("warning", captureNotice)}`;
				const usageStr = formatUsageStats(r.usage, r.model);
				if (usageStr) text += `\n${theme.fg("dim", usageStr)}`;
				return new Text(text, 0, 0);
			}

			const aggregateUsage = (results: SingleResult[]) => {
				const total = {
					input: 0,
					output: 0,
					cacheRead: 0,
					cacheWrite: 0,
					cost: 0,
					turns: 0,
				};
				for (const r of results) {
					for (const field of ["input", "output", "cacheRead", "cacheWrite", "turns"] as const) {
						const value = r.usage[field];
						const sum = total[field] + value;
						if (!Number.isSafeInteger(value) || value < 0 || !Number.isSafeInteger(sum)) return undefined;
						total[field] = sum;
					}
					const cost = total.cost + r.usage.cost;
					if (!Number.isFinite(r.usage.cost) || r.usage.cost < 0 || !Number.isFinite(cost)) return undefined;
					total.cost = cost;
				}
				return total;
			};
			const aggregateUsageText = (results: SingleResult[]) => {
				const usage = aggregateUsage(results);
				return usage ? formatUsageStats(usage) : "";
			};

			if (details.mode === "chain") {
				const successCount = details.results.filter((r) => r.exitCode !== -1 && !isFailedResult(r)).length;
				const icon = details.results.some((r) => r.exitCode === -1)
					? theme.fg("warning", "⏳")
					: successCount === details.results.length
						? theme.fg("success", "✓")
						: theme.fg("error", "✗");

				if (expanded) {
					const container = new Container();
					container.addChild(
						new Text(
							icon +
								" " +
								theme.fg("toolTitle", theme.bold("chain ")) +
								theme.fg("accent", `${successCount}/${details.results.length} steps`),
							0,
							0,
						),
					);

					for (const r of details.results) {
						const rIcon = r.exitCode === -1 ? theme.fg("warning", "⏳")
							: isFailedResult(r) ? theme.fg("error", "✗") : theme.fg("success", "✓");
						const displayItems = getDisplayItems(r.messages);
						const finalOutput = getFinalOutput(r.messages);

						container.addChild(new Spacer(1));
						container.addChild(
							new Text(`${theme.fg("muted", `─── Step ${r.step}: `) + theme.fg("accent", r.agent)} ${rIcon}`, 0, 0),
						);
						container.addChild(new Text(theme.fg("muted", "Task: ") + theme.fg("dim", r.task), 0, 0));
						const failure = getFailureReason(r);
						if (failure) container.addChild(new Text(theme.fg("error", `Error: ${truncateOutput(failure)}`), 0, 0));

						// Show tool calls
						for (const item of displayItems) {
							if (item.type === "toolCall") {
								container.addChild(
									new Text(theme.fg("muted", "→ ") + formatToolCall(item.name, item.args, theme.fg.bind(theme)), 0, 0),
								);
							}
						}

						// Show final output as markdown
						if (finalOutput) {
							container.addChild(new Spacer(1));
							container.addChild(new Markdown(finalOutput.trim(), 0, 0, mdTheme));
						}

						const captureNotice = getCaptureNotice(r);
						if (captureNotice) container.addChild(new Text(theme.fg("warning", captureNotice), 0, 0));
						const stepUsage = formatUsageStats(r.usage, r.model);
						if (stepUsage) container.addChild(new Text(theme.fg("dim", stepUsage), 0, 0));
					}

					const usageStr = aggregateUsageText(details.results);
					if (usageStr) {
						container.addChild(new Spacer(1));
						container.addChild(new Text(theme.fg("dim", `Total: ${usageStr}`), 0, 0));
					}
					return container;
				}

				// Collapsed view
				let text =
					icon +
					" " +
					theme.fg("toolTitle", theme.bold("chain ")) +
					theme.fg("accent", `${successCount}/${details.results.length} steps`);
				for (const r of details.results) {
					const rIcon = r.exitCode === -1 ? theme.fg("warning", "⏳")
						: isFailedResult(r) ? theme.fg("error", "✗") : theme.fg("success", "✓");
					const displayItems = getDisplayItems(r.messages);
					text += `\n\n${theme.fg("muted", `─── Step ${r.step}: `)}${theme.fg("accent", r.agent)} ${rIcon}`;
					const failure = getFailureReason(r);
					if (failure) text += `\n${theme.fg("error", `Error: ${previewText(failure)}`)}`;
					if (displayItems.length === 0) text += `\n${theme.fg("muted", "(no output)")}`;
					else text += `\n${renderDisplayItems(displayItems, 5)}`;
					const captureNotice = getCaptureNotice(r);
					if (captureNotice) text += `\n${theme.fg("warning", captureNotice)}`;
				}
				const usageStr = aggregateUsageText(details.results);
				if (usageStr) text += `\n\n${theme.fg("dim", `Total: ${usageStr}`)}`;
				text += `\n${theme.fg("muted", "(Ctrl+O to expand)")}`;
				return new Text(text, 0, 0);
			}

			if (details.mode === "parallel") {
				const running = details.results.filter((r) => r.exitCode === -1).length;
				const successCount = details.results.filter((r) => r.exitCode !== -1 && !isFailedResult(r)).length;
				const failCount = details.results.filter((r) => r.exitCode !== -1 && isFailedResult(r)).length;
				const isRunning = running > 0;
				const icon = isRunning
					? theme.fg("warning", "⏳")
					: failCount > 0
						? theme.fg("warning", "◐")
						: theme.fg("success", "✓");
				const status = isRunning
					? `${successCount + failCount}/${details.results.length} done, ${running} pending`
					: `${successCount}/${details.results.length} tasks`;

				if (expanded && !isRunning) {
					const container = new Container();
					container.addChild(
						new Text(`${icon} ${theme.fg("toolTitle", theme.bold("parallel "))}${theme.fg("accent", status)}`, 0, 0),
					);

					for (const r of details.results) {
						const rIcon = isFailedResult(r) ? theme.fg("error", "✗") : theme.fg("success", "✓");
						const displayItems = getDisplayItems(r.messages);
						const finalOutput = getFinalOutput(r.messages);

						container.addChild(new Spacer(1));
						container.addChild(new Text(`${theme.fg("muted", "─── ") + theme.fg("accent", r.agent)} ${rIcon}`, 0, 0));
						container.addChild(new Text(theme.fg("muted", "Task: ") + theme.fg("dim", r.task), 0, 0));
						const failure = getFailureReason(r);
						if (failure) container.addChild(new Text(theme.fg("error", `Error: ${truncateOutput(failure)}`), 0, 0));

						// Show tool calls
						for (const item of displayItems) {
							if (item.type === "toolCall") {
								container.addChild(
									new Text(theme.fg("muted", "→ ") + formatToolCall(item.name, item.args, theme.fg.bind(theme)), 0, 0),
								);
							}
						}

						// Show final output as markdown
						if (finalOutput) {
							container.addChild(new Spacer(1));
							container.addChild(new Markdown(finalOutput.trim(), 0, 0, mdTheme));
						}

						const captureNotice = getCaptureNotice(r);
						if (captureNotice) container.addChild(new Text(theme.fg("warning", captureNotice), 0, 0));
						const taskUsage = formatUsageStats(r.usage, r.model);
						if (taskUsage) container.addChild(new Text(theme.fg("dim", taskUsage), 0, 0));
					}

					const usageStr = aggregateUsageText(details.results);
					if (usageStr) {
						container.addChild(new Spacer(1));
						container.addChild(new Text(theme.fg("dim", `Total: ${usageStr}`), 0, 0));
					}
					return container;
				}

				// Collapsed view (or still running)
				let text = `${icon} ${theme.fg("toolTitle", theme.bold("parallel "))}${theme.fg("accent", status)}`;
				for (const r of details.results) {
					const rIcon =
						r.exitCode === -1
							? theme.fg("warning", "⏳")
							: isFailedResult(r)
								? theme.fg("error", "✗")
								: theme.fg("success", "✓");
					const displayItems = getDisplayItems(r.messages);
					text += `\n\n${theme.fg("muted", "─── ")}${theme.fg("accent", r.agent)} ${rIcon}`;
					const failure = getFailureReason(r);
					if (failure) text += `\n${theme.fg("error", `Error: ${previewText(failure)}`)}`;
					if (displayItems.length === 0)
						text += `\n${theme.fg("muted", r.exitCode === -1 ? "(running...)" : "(no output)")}`;
					else text += `\n${renderDisplayItems(displayItems, 5)}`;
					const captureNotice = getCaptureNotice(r);
					if (captureNotice) text += `\n${theme.fg("warning", captureNotice)}`;
				}
				if (!isRunning) {
					const usageStr = aggregateUsageText(details.results);
					if (usageStr) text += `\n\n${theme.fg("dim", `Total: ${usageStr}`)}`;
				}
				if (!expanded) text += `\n${theme.fg("muted", "(Ctrl+O to expand)")}`;
				return new Text(text, 0, 0);
			}

			const text = result.content[0];
			return new Text(text?.type === "text" ? text.text : "(no output)", 0, 0);
		},
	});
}
