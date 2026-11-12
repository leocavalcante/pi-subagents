// @ts-check
import eslint from "@eslint/js";
import { defineConfig } from "eslint/config";
import prettier from "eslint-config-prettier/flat";
import globals from "globals";
import tseslint from "typescript-eslint";

// Node's test runner owns and reports promises returned by these declarations.
const nodeTestSafeCalls = {
  "@typescript-eslint/no-floating-promises": [
    "error",
    {
      allowForKnownSafeCalls: [
        {
          from: "package",
          name: ["test", "it", "describe", "suite"],
          package: "node:test",
        },
      ],
    },
  ],
};

// Subagent tests inspect dynamically shaped JSON, subprocess, and SDK payloads.
const testPayloadRules = Object.fromEntries(
  Object.keys(tseslint.plugin.rules)
    .filter(
      (name) =>
        name.startsWith("no-unsafe-") ||
        name === "no-explicit-any" ||
        name === "no-non-null-assertion",
    )
    .map((name) => [`@typescript-eslint/${name}`, "off"]),
);

export default defineConfig(
  { ignores: ["dist/", "coverage/"] },
  eslint.configs.recommended,
  tseslint.configs.strictTypeChecked,
  tseslint.configs.stylisticTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
  },
  {
    rules: nodeTestSafeCalls,
  },
  {
    // This repository keeps Node runtime modules at its root, not under src/.
    // Node globals are explicit here; pi-otel's runtime block relies on TS types.
    files: ["*.ts"],
    languageOptions: { globals: globals.node },
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: ["bun", "bun:*"],
              message:
                "Pi runs extensions on Node.js. Use node:* APIs in runtime modules.",
            },
          ],
        },
      ],
    },
  },
  {
    files: ["**/*.{js,mjs,cjs}"],
    extends: [tseslint.configs.disableTypeChecked],
    // Unlike pi-otel, this also covers Node.js tests, which are .mjs here.
    languageOptions: { globals: globals.node },
  },
  {
    files: ["tests/**/*.ts"],
    rules: testPayloadRules,
  },
  {
    // Node subprocess fixtures deliberately use no-op callbacks, empty cleanup catches,
    // computed environment keys, and constant worker loops.
    files: ["tests/**/*.mjs"],
    rules: {
      "@typescript-eslint/no-empty-function": "off",
      "@typescript-eslint/no-dynamic-delete": "off",
      "no-constant-condition": "off",
      "no-empty": "off",
    },
  },
  prettier,
);
