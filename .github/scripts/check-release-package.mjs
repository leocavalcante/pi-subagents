import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const PACKAGE_JSON = new URL("../../package.json", import.meta.url);
const NPM_REGISTRY = "https://registry.npmjs.org";

export function inspectNpm(specifier, run = spawnSync) {
	try {
		const result = run("npm", [
			"view", specifier, "version", "--json",
			`--registry=${NPM_REGISTRY}`,
			"--fetch-retries=0",
			"--fetch-timeout=15000",
		], { encoding: "utf8" });
		if (result.error || result.status === null) return "unavailable";
		if (result.status === 0) return "available";
		return /\bE404\b|\b404 Not Found\b/i.test(result.stderr ?? "") ? "missing" : "unavailable";
	} catch {
		return "unavailable";
	}
}

/** Validate release metadata and registry state before spending time on the release test matrix. */
export function verifyStableRelease(packageJson, releaseTag, inspect = inspectNpm) {
	const { name, version } = packageJson;
	if (typeof name !== "string" || !/^@[a-z0-9][a-z0-9._-]*\/[a-z0-9][a-z0-9._-]*$/i.test(name) ||
		typeof version !== "string" || !/^\d+\.\d+\.\d+$/.test(version) || releaseTag !== `v${version}`) {
		throw new Error("Use a stable release tag matching the package name and version in package.json.");
	}

	const packageStatus = inspect(name);
	if (packageStatus === "missing") {
		throw new Error("The npm package is not bootstrapped. Publish the initial version as described in CONTRIBUTING.md before creating a stable release.");
	}
	if (packageStatus !== "available") {
		throw new Error("Unable to verify the npm package on the registry. Check registry access and retry.");
	}

	const releaseVersion = inspect(`${name}@${version}`);
	if (releaseVersion === "available") {
		throw new Error("This package version already exists on npm. Bump package.json and package-lock.json before creating a new stable release.");
	}
	if (releaseVersion !== "missing") {
		throw new Error("Unable to verify whether this package version is available on npm. Check registry access and retry.");
	}
}

function run() {
	const packageJson = JSON.parse(readFileSync(PACKAGE_JSON, "utf8"));
	verifyStableRelease(packageJson, process.env.RELEASE_TAG ?? "");
	console.log("Stable release metadata and npm package availability verified.");
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	try {
		run();
	} catch (error) {
		console.error(`::error::${error instanceof Error ? error.message : "Unable to validate stable release."}`);
		process.exitCode = 1;
	}
}
