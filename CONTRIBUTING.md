# Contributing

Thanks for helping improve Pi Subagents. This guide covers local development checks and the maintainer release process.

## Development

Use [Bun](https://bun.sh/docs/installation) 1.4.4 for dependencies and scripts, and Node.js 22.19.0 or newer, matching the package's `engines` declaration; Pi runs extensions on Node.js. Install the pinned development SDK, compiler, and test loader locally. This also works when Pi is installed as a standalone binary:

```sh
bun install --frozen-lockfile
bun audit --audit-level=high
bun run lint
bun run check
bun run test
```

`bun run lint` runs Prettier and ESLint (typescript-eslint `strictTypeChecked`), and `bun run format` applies their fixes. Disable a rule only on the line that needs it, with a reason. The JavaScript tests may relax the empty-function, empty-block, constant-condition, and dynamic-delete rules, because their subprocess fixtures need no-op callbacks, cleanup catches, worker loops, and computed environment keys. `bun run verify` runs every gate CI runs, in order, and stops at the first failure.

Logic tests that start no processes run on Bun: run one file with `bun test tests/paging.test.ts`. To run one Node.js test file, use Node directly, for example, `node --import jiti/register --test --test-concurrency=1 tests/extension.node-test.mjs`. To select test names, add `--test-name-pattern='agentTags dispatch'` before the file path. Set `PI_PACKAGE_DIR` to an npm Pi package directory to test against another SDK version. Standalone binary directories fall back to the local development SDK. The tests use fake child processes and make no model calls. They cover agent discovery and configuration, dispatch, output limits, rendering, process budgets, deadlines, cancellation and shutdown, including POSIX descendants and SIGKILL escalation. Windows-only integration tests also verify Job Object containment on cancellation, deadlines, and normal leader exit, with descendants that do not inherit the output pipes, and that bare Pi executable names resolve through PATH instead of being shadowed by the task working directory; they are skipped on non-Windows hosts. Because containment depends on Win32 suspended-process creation and Job Objects, source compilation alone does not validate this behavior—rely on Windows CI. GitHub Actions runs both test lanes on Linux, macOS, and Windows with Node.js 24. A separate Ubuntu Node.js lane runs the Node.js tests on 22.19.0, 22, 24, and 26. The `pi-min` job reads the minimum from `engines.pi` (currently Pi 1.0.4), and another Ubuntu job tests Pi 1.1.0; both pair Pi 1.0.4 and 1.1.0 with Pi Codemode 1.1.0 because those Pi versions import an export removed in Codemode 1.2.0 ([upstream report](https://github.com/earendil-works/pi/issues/10865)). A weekly canary checks the latest Pi. This exercises POSIX process-group cleanup on both Linux and macOS; `/proc`-based descendant-reaping checks remain Linux-only. CI runs the high-severity Bun audit.

### GitHub Actions workflow changes

When changing `.github/workflows`, run the local workflow integrity check:

```sh
bash .github/scripts/check-workflows.sh
```

The script downloads checksum-pinned actionlint v1.7.12 and gitleaks v8.30.1, then checks workflow syntax and the repository history for secrets.

The project-agent hard-link rejection test runs on every platform. On Windows, the project-agent file-symlink boundary test runs when the process can create symbolic links. If Windows denies that privilege (`EPERM` or `EACCES`), that test is skipped with an explanation; enable Developer Mode or grant symbolic-link creation privilege to run it. Other tests, including the junction-based project-directory boundary test, still run. The junction-based extension checkout setup is a separate installation option documented in [README.md](README.md#installation).

## Deviations from the standard

- The process and file-system suites still run as JavaScript (`tests/*.node-test.mjs`), so the Node.js lane also matches `.mjs`. Converting them to TypeScript is follow-up work.
- The root `index.ts` re-exports `src/extension.ts` for one release, for anyone who loads the old entry directly. Pi loads `src/extension.ts`.

## Commits and pull requests

Use Conventional Commits and sign off commits with `git commit -s`. Never add a `Co-Authored-By` trailer. PR titles become squash commit subjects and release notes. Keep them user-facing, at most 72 characters, without a final period.

## Automatic releases

Do not edit the development version, create release tags, or publish from your machine. `.github/workflows/cd.yaml` runs CI on pushes to `main`, then semantic-release publishes releasable changes through npm Trusted Publishing with provenance.

- `feat` releases a minor version; `fix`, `perf`, and `revert` release a patch.
- `docs(readme)` releases a patch so npm and the Pi gallery receive README changes.
- Breaking changes release a minor while the package is below 1.0. Remove that override when releasing 1.0.
- CI, toolchain, and maintainer-documentation changes do not release.

The version in `package.json` stays `0.0.0-development`. semantic-release updates only its temporary workspace; it never commits back to `main`. git-cliff generates both the GitHub release notes and the `CHANGELOG.md` shipped in the package. Run `bun run changelog` to preview the history locally.

The release job uses Node.js 24 and the OIDC-capable npm CLI installed with `@semantic-release/npm`. Lifecycle scripts are disabled during publishing.

### One-time publisher setup

The package already exists on npm. Do not repeat the bootstrap or attempt to republish any version already in the registry; npm versions are immutable.

1. Ensure the workflow is named `cd.yaml`, with a release job in the GitHub environment `npm`.
2. Log into npm interactively and move the trusted publisher from the retired `publish.yml` workflow to `cd.yaml` (npm 12 shown because older global CLIs may not support `trust`):

   ```sh
   npm login
   npx --yes npm@12 trust list @leocavalcante/pi-subagents
   npx --yes npm@12 trust revoke @leocavalcante/pi-subagents --id <publish.yml entry id>
   npx --yes npm@12 trust github @leocavalcante/pi-subagents \
     --file cd.yaml --repo leocavalcante/pi-subagents --env npm --allow-publish
   ```

3. npm's publishing-access settings require two-factor authentication and disallow tokens. Do not create an `NPM_TOKEN` secret.
4. The GitHub `npm` environment permits deployment from `main` only.
5. After the first automated release, verify the package version, provenance, and update notes:

   ```sh
   npm view @leocavalcante/pi-subagents version dist.attestations
   ```

### Recovering a partial release

Check npm before retrying a failed release. semantic-release pushes the tag before publishing, so a normal re-run may consider that version released already.

- **The version is absent from npm:** investigate the failure. An administrator may delete only the failed release tag and re-run CD on `main` once publishing is fixed.
- **The version exists on npm:** do not delete its tag or try to republish it. Verify provenance, restore any missing GitHub release from that tag, and release a new version for package fixes.
- **Publication succeeded but provenance is missing:** treat this as a release failure. Investigate OIDC and publish a new attested version; existing npm versions cannot be repaired by republishing.

### History

The package was bootstrapped manually on npm as version `0.1.0`, without provenance. Versions `0.1.1` through `0.2.0` were published through GitHub Actions using npm Trusted Publishing; their provenance attestations identify repository `leocavalcante/pi-subagents` and the release-triggered `publish.yml` workflow, which `cd.yaml` replaces.
