# Contributing

Thanks for helping improve Pi Subagents. This guide covers local development checks and the maintainer release process.

## Development checks

Use [Bun](https://bun.sh/docs/installation) 1.4.4 for dependencies and scripts, and Node.js 22.19.0 or newer, matching the package's `engines` declaration; Pi runs extensions on Node.js. Install the pinned development SDK, compiler, and test loader locally. This also works when Pi is installed as a standalone binary:

```sh
bun install --frozen-lockfile
bun audit --audit-level=high
bun run check
bun run test
```

To run one Node.js test file, use Node directly, for example, `node --import jiti/register --test --test-concurrency=1 tests/paging.node-test.mjs`. To select test names, add `--test-name-pattern='agentTags dispatch'` before the file path. Set `PI_PACKAGE_DIR` to an npm Pi package directory to test against another SDK version. Standalone binary directories fall back to the local development SDK. The tests use fake child processes and make no model calls. They cover agent discovery and configuration, dispatch, output limits, rendering, process budgets, deadlines, cancellation and shutdown, including POSIX descendants and SIGKILL escalation. Windows-only integration tests also verify Job Object containment on cancellation, deadlines, and normal leader exit, with descendants that do not inherit the output pipes, and that bare Pi executable names resolve through PATH instead of being shadowed by the task working directory; they are skipped on non-Windows hosts. Because containment depends on Win32 suspended-process creation and Job Objects, source compilation alone does not validate this behavior—rely on Windows CI. GitHub Actions runs both test lanes on Linux, macOS, and Windows with Node.js 24. A separate Ubuntu Node.js lane runs the Node.js tests on 22.19.0, 22, 24, and 26. The `pi-min` job reads the minimum from `engines.pi` (currently Pi 1.0.4), and another Ubuntu job tests Pi 1.1.0; both pair Pi 1.0.4 and 1.1.0 with Pi Codemode 1.1.0 because those Pi versions import an export removed in Codemode 1.2.0 ([upstream report](https://github.com/earendil-works/pi/issues/10865)). A weekly canary checks the latest Pi. This exercises POSIX process-group cleanup on both Linux and macOS; `/proc`-based descendant-reaping checks remain Linux-only. CI runs the high-severity Bun audit.

### GitHub Actions workflow changes

When changing `.github/workflows`, run the local workflow integrity check:

```sh
bash .github/scripts/check-workflows.sh
```

The script downloads checksum-pinned actionlint v1.7.12 and gitleaks v8.30.1, then checks workflow syntax and the repository history for secrets.

The project-agent hard-link rejection test runs on every platform. On Windows, the project-agent file-symlink boundary test runs when the process can create symbolic links. If Windows denies that privilege (`EPERM` or `EACCES`), that test is skipped with an explanation; enable Developer Mode or grant symbolic-link creation privilege to run it. Other tests, including the junction-based project-directory boundary test, still run. The junction-based extension checkout setup is a separate installation option documented in [README.md](README.md#installation).

## Releasing

GitHub Actions tests every pull request. The release-triggered `publish.yml` workflow is retired because it called the deleted `test.yml`. Releases are moving to automated publishing from `main`; nothing publishes until that is in place. Do not create a GitHub release expecting it to publish this package. npm versions cannot be overwritten.

The package was bootstrapped manually on npm as version `0.1.0`; version `0.1.1` was published through GitHub Actions using npm Trusted Publishing. Its npm provenance attestation identifies repository `leocavalcante/pi-subagents`, workflow `.github/workflows/publish.yml`, and release tag `v0.1.1`, confirming the historical OIDC publish path. Do not repeat the bootstrap or attempt to republish any version already in the registry; npm versions are immutable. For additional account security, an authorized npm publisher should verify that npm's publishing-access settings require two-factor authentication and disallow tokens. These account-level settings are not visible in public registry metadata. When automated publishing from `main` is in place, it will use npm Trusted Publishing without an npm token.

Do not bump the package version or try to publish manually while automated publishing is being prepared.
