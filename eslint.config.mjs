import nextCoreWebVitals from "eslint-config-next/core-web-vitals";
import nextTypescript from "eslint-config-next/typescript";
import globals from "globals";

const eslintConfig = [
  ...nextCoreWebVitals,
  ...nextTypescript,
  {
    ignores: [
      "node_modules/**",
      ".next/**",
      "out/**",
      "build/**",
      "next-env.d.ts",
      "examples/**",
      "skills",
      "public/**",
      "mini-services/**",
      ".superpowers/**",
    ],
  },
  {
    files: ["tests/*.cjs", "scripts/*.cjs"],
    languageOptions: {
      sourceType: "commonjs",
      globals: globals.node,
    },
    rules: {
      "no-undef": "error",
      "@typescript-eslint/no-require-imports": "off",
      "@next/next/no-assign-module-variable": "off",
    },
  },
  {
    files: ["tests/*browser.cjs", "scripts/*browser.cjs"],
    languageOptions: {
      globals: { ...globals.node, ...globals.browser },
    },
  },
];

export default eslintConfig;
