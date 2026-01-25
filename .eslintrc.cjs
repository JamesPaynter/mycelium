/** @type {import("eslint").Linter.Config} */
module.exports = {
  root: true,
  env: {
    node: true,
    es2022: true,
  },
  parser: "@typescript-eslint/parser",
  parserOptions: {
    ecmaVersion: "latest",
    sourceType: "module",
  },
  plugins: ["@typescript-eslint", "import"],
  extends: [
    "eslint:recommended",
    "plugin:@typescript-eslint/recommended",
    "plugin:import/recommended",
    "plugin:import/typescript",
    "prettier",
  ],
  settings: {
    "import/resolver": {
      typescript: true,
    },
  },
  ignorePatterns: ["dist/", "node_modules/", "test/fixtures/"],
  overrides: [
    {
      files: ["src/ui/static/**/*.js"],
      env: { browser: true },
      globals: {
        ResizeObserver: "readonly",
      },
    },
    {
      files: [
        "src/core/executor.ts",
        "src/cli/logs.ts",
        "src/cli/control-plane.ts",
        "src/ui/router.ts",
      ],
      rules: {
        "max-lines": "off",
        complexity: "off",
        "max-depth": "off",
        "max-params": "off",
        "max-statements": "off",
      },
    },
  ],
  rules: {
    "@typescript-eslint/no-explicit-any": "off",
    "@typescript-eslint/no-unused-vars": [
      "warn",
      { argsIgnorePattern: "^_", varsIgnorePattern: "^_", caughtErrorsIgnorePattern: "^_" },
    ],
    "import/no-named-as-default-member": "off",
    "no-constant-condition": ["error", { checkLoops: false }],
    "import/order": [
      "warn",
      {
        alphabetize: { order: "asc", caseInsensitive: true },
        "newlines-between": "always",
      },
    ],
    // Ratchet plan: keep warnings until refactors land, then upgrade to errors and delete overrides.
    "max-lines": [
      "warn",
      {
        max: 300,
        skipBlankLines: true,
        skipComments: true,
      },
    ],
    complexity: ["warn", 15],
    "max-depth": ["warn", 4],
    "max-params": ["warn", 5],
    "max-statements": ["warn", 50],
  },
};
