import eslint from "@eslint/js";
import tseslint from "typescript-eslint";
import globals from "globals";
import reactHooks from "eslint-plugin-react-hooks";

// Baseline only: catches real bugs (unused vars, fallthrough, unreachable
// code) without rewriting existing style. Tighten rules incrementally;
// do not mix rule changes with behavior changes in the same commit.
export default tseslint.config(
  {
    ignores: [
      "**/dist/**",
      "**/dist-renderer/**",
      "**/release/**",
      "**/node_modules/**",
      "**/__pycache__/**",
      ".playwright-cli/**",
      ".pi/**",
      ".claude/**",
      ".codex/**",
      ".workbuddy/**",
      "_repair_tmp/**",
    ],
  },
  eslint.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ["apps/desktop/src/renderer/**/*"],
    languageOptions: { globals: { ...globals.browser } },
    plugins: { "react-hooks": reactHooks },
    rules: {
      // Recommended set minus the aggressive refs/set-state-in-effect rules:
      // reading refs during render and effect-driven setState are established
      // patterns here and reworking them is a separate, behavior-bearing change.
      "react-hooks/exhaustive-deps": "warn",
      "react-hooks/rules-of-hooks": "error",
      "react-hooks/refs": "off",
      "react-hooks/set-state-in-effect": "off",
    },
  },
  {
    // CommonJS entry points legitimately use require().
    files: ["**/*.cjs"],
    rules: { "@typescript-eslint/no-require-imports": "off" },
  },
  {
    files: [
      "packages/**/*",
      "scripts/**/*",
      "apps/desktop/src/main/**/*",
      "apps/desktop/src/preload/**/*",
      "apps/desktop/scripts/**/*",
      "apps/desktop/vite.config.mts",
      "*.mjs",
      "*.cjs",
    ],
    languageOptions: { globals: { ...globals.node } },
  },
  {
    rules: {
      // The Pi SDK surface is intentionally loosely typed in agentcore-adapter;
      // re-enable per-package once structural Pi types exist.
      "@typescript-eslint/no-explicit-any": "off",
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_", caughtErrors: "none" },
      ],
      // Many empty catch blocks are deliberate degradation paths.
      "no-empty": ["error", { allowEmptyCatch: true }],
    },
  },
);
