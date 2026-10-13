# Contributing

Thanks for helping improve Pi Subagents. This guide covers local development checks and the maintainer release process.

## Development checks

Use Node.js 22.19.0 or newer, matching the package's `engines` declaration. Install the pinned development SDK, compiler, and test loader locally. This also works when Pi is installed as a standalone binary:

```sh
npm ci --ignore-scripts
npm audit --audit-level=high
npm run check
npm test
```

To run one test file, pass its path after npm's `--`, for example, `npm test -- tests/paging.test.mjs`. To run only tests whose names match a pattern, pass a Node test-runner option through npm; for example, `npm test -- --test-name-pattern='agentTags dispatch'`. The test script uses Node's default discovery so forwarded options are parsed before file paths. Set `PI_PACKAGE_DIR` to an npm Pi package directory to test against another SDK version. Standalone binary directories fall back to the local development SDK. The tests use fake child processes and make no model calls. They cover agent discovery and configuration, dispatch, output limits, rendering, process budgets, deadlines, cancellation and shutdown, including POSIX descendants and SIGKILL escalation. Windows-only integration tests also verify Job Object containment on cancellation, deadlines, and normal leader exit, with descendants that do not inherit the output pipes, and that bare Pi executable names resolve through PATH instead of being shadowed by the task working directory; they are skipped on non-Windows hosts. Because containment depends on Win32 suspended-process creation and Job Objects, source compilation alone does not validate this behavior—rely on Windows CI. GitHub Actions tests the declared Node.js 22.19.0 minimum on Ubuntu, and runs the type check and tests on Linux, macOS, and Windows with Node.js 22, 24, and 26 against Pi 1.0.4 and 1.1.0. This exercises POSIX process-group cleanup on both Linux and macOS; `/proc`-based descendant-reaping checks remain Linux-only. The required Node.js 22.19.0 Ubuntu check also runs the high-severity npm audit.

### GitHub Actions workflow changes

When changing `.github/workflows`, install the actionlint version used by CI and run the same check locally:

```sh
actionlint -ignore 'label "ubuntu-26\.04" is unknown\.' .github/workflows/*.yml
```

CI currently pins actionlint v1.7.12. The ignore is limited to its stale runner-label catalog; keep the explicit `ubuntu-26.04` matrix row until GitHub's runner migration is confirmed.

The project-agent hard-link rejection test runs on every platform. On Windows, the project-agent file-symlink boundary test runs when the process can create symbolic links. If Windows denies that privilege (`EPERM` or `EACCES`), that test is skipped with an explanation; enable Developer Mode or grant symbolic-link creation privilege to run it. Other tests, including the junction-based project-directory boundary test, still run. The junction-based extension checkout setup is a separate installation option documented in [README.md](README.md#installation).

## Releasing

GitHub Actions tests pushes and pull requests. Publishing a stable GitHub release tagged `v<package.json version>`, such as `v0.1.2`, first verifies release and npm registry prerequisites, then runs the same test matrix before publishing `@leocavalcante/pi-subagents` to npm with provenance. Prereleases still run the test matrix but are not published. Bump `package.json` and `package-lock.json` together before each new release. npm versions cannot be overwritten.

Before running the stable-release test matrix, the publishing workflow verifies that the release commit is reachable from `main`, the tag matches `package.json`, the package has been bootstrapped on npm, and the release version is still unpublished. The publishing workflow uses npm Trusted Publishing with GitHub OIDC. It does not use an npm token or an Actions publishing secret.

The package was bootstrapped manually on npm as version `0.1.0`; version `0.1.1` was published through GitHub Actions using npm Trusted Publishing. Its npm provenance attestation identifies repository `leocavalcante/pi-subagents`, workflow `.github/workflows/publish.yml`, and release tag `v0.1.1`, confirming the OIDC publish path. Do not repeat the bootstrap or attempt to republish either immutable version. Before the next stable release, an authorized npm publisher should verify that npm's publishing-access settings require two-factor authentication and disallow tokens; these account-level settings are not visible in public registry metadata.

After verifying the publishing-access settings, bump `package.json` and `package-lock.json` together to a version not yet published on npm (for example, `0.1.2` only if registry checks confirm it is available), then publish the matching GitHub release. Do not rerun the workflow for either already-published version. Later releases publish through OIDC with provenance. See [npm's trusted publishing guide](https://docs.npmjs.com/trusted-publishers/) and the [package-existence prerequisite](https://docs.npmjs.com/cli/v11/commands/npm-trust/#prerequisites).
