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

Set `PI_PACKAGE_DIR` to an npm Pi package directory to test against another SDK version. Standalone binary directories fall back to the local development SDK. The tests use fake child processes and make no model calls. They cover agent discovery and configuration, dispatch, output limits, rendering, process budgets, deadlines, cancellation and shutdown, including POSIX descendants and SIGKILL escalation. GitHub Actions tests the declared Node.js 22.19.0 minimum on Ubuntu, and runs the type check and tests on Linux and Windows with Node.js 22, 24, and 26 against Pi 1.0.4 and 1.1.0. The required Node.js 22.19.0 Ubuntu check also runs the high-severity npm audit.

On Windows, the project-agent file-symlink boundary test runs when the process can create symbolic links. If Windows denies that privilege (`EPERM` or `EACCES`), that test is skipped with an explanation; enable Developer Mode or grant symbolic-link creation privilege to run it. Other tests, including the junction-based project-directory boundary test, still run. The junction-based extension checkout setup is a separate installation option documented in [README.md](README.md#installation).

## Releasing

GitHub Actions tests pushes and pull requests. Publishing a stable GitHub release tagged `v<package.json version>`, such as `v0.1.0`, runs the same test matrix before publishing `@leocavalcante/pi-subagents` to npm with provenance. Prereleases are not published. Bump `package.json` and `package-lock.json` together before each new release. npm versions cannot be overwritten.

The publishing workflow uses npm Trusted Publishing with GitHub OIDC. It does not use an npm token or an Actions publishing secret.

npm requires the package to exist before configuring a trusted publisher. Bootstrap version `0.1.0` once from this checkout using interactive npm login and 2FA, without creating a CI token:

```sh
npm login
npm ci --ignore-scripts
npm audit --audit-level=high
npm run check
npm test
npm publish --access public --provenance=false --ignore-scripts
```

The initial local publish has no provenance. Configure the package's trusted publisher on npm using GitHub owner `leocavalcante`, repository `pi-subagents`, and workflow filename `publish.yml`. Leave the environment name blank and allow `npm publish`. The workflow must already exist on GitHub.

After configuring trust, select "Require two-factor authentication and disallow tokens" in npm's publishing access settings. Bump to a new version, such as `0.1.1`, before publishing a GitHub release. Do not run the workflow for the already-published bootstrap version. Later releases publish through OIDC with provenance. See [npm's trusted publishing guide](https://docs.npmjs.com/trusted-publishers/) and the [package-existence prerequisite](https://docs.npmjs.com/cli/v11/commands/npm-trust/#prerequisites).
