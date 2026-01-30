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
  ignorePatterns: ["dist/", "node_modules/", "src/ui/grove/**", "test/fixtures/"],
  overrides: [
    {
      files: ["src/ui/static/**/*.js"],
      env: { browser: true },
      globals: {
        ResizeObserver: "readonly",
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
    "import/no-restricted-paths": [
      "error",
      {
        zones: [
          {
            target: "./src/core/**",
            from: "./src/cli/**",
            message: "Core must not import CLI. Keep core UI/CLI-agnostic.",
          },
          {
            target: "./src/core/**",
            from: "./src/ui/**",
            message: "Core must not import UI. Keep core UI/CLI-agnostic.",
          },
          {
            target: "./src/ui/**",
            from: "./src/cli/**",
            message: "UI must not import CLI. Route UI through core APIs instead.",
          },
        ],
      },
    ],
    "import/order": [
      "warn",
      {
        alphabetize: { order: "asc", caseInsensitive: true },
        "newlines-between": "always",
      },
    ],
    // Budgets are enforced as errors; thresholds reflect current file sizes until refactors land.
    "max-lines": [
      "error",
      {
        max: 2500,
        skipBlankLines: true,
        skipComments: true,
      },
    ],
    complexity: ["error", 40],
    "max-depth": ["error", 4],
    "max-params": ["warn", 5],
    "max-statements": ["warn", 50],
  },
};
