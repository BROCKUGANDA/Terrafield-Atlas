import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "bun:test";
import { ESLint } from "eslint";

const packageJson = JSON.parse(
  readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), "../package.json"), "utf8"),
) as { scripts: Record<string, string> };

test("production migrations use Prisma migrate deploy without data-loss flags", () => {
  const productionMigration = packageJson.scripts["db:migrate:deploy"] ?? "";

  expect(productionMigration).toBe("prisma migrate deploy");
  expect(productionMigration).not.toContain("db push");
  expect(productionMigration).not.toContain("--accept-data-loss");
});

test("quality gates expose explicit lint, typecheck, unit, and integration commands", () => {
  expect(packageJson.scripts.lint).toBe("eslint .");
  expect(packageJson.scripts.typecheck).toBe("tsc --noEmit");
  expect(packageJson.scripts.test).toBe("bun test tests/");
  expect(packageJson.scripts["test:integration"]).toBe("bun test ./tests/*.integration.ts");
  expect(packageJson.scripts["test:integration"]).not.toContain("file:");
  expect(packageJson.scripts["test:postgres:schema"]).toBe("bun test ./tests/postgres-schema.integration.ts");
  expect(packageJson.scripts.build).toContain("next build");
});

test("application TypeScript keeps strict lint rules enabled", async () => {
  const eslint = new ESLint();
  const config = await eslint.calculateConfigForFile("src/lib/quality-gates-fixture.ts");

  expect(config?.rules?.["@typescript-eslint/no-explicit-any"]?.[0]).toBe(2);
  expect(config?.rules?.["@typescript-eslint/no-unused-vars"]?.[0]).toBeGreaterThan(0);
  expect(config?.languageOptions?.sourceType).toBe("module");
});

test.each(["tests/verification.cjs", "scripts/verification.cjs"])(
  "%s has Node CommonJS lint support",
  async (filePath) => {
    const eslint = new ESLint();
    const config = await eslint.calculateConfigForFile(filePath);

    expect(config?.languageOptions?.sourceType).toBe("commonjs");
    expect(config?.languageOptions?.globals?.require).toBe(false);
    expect(config?.languageOptions?.globals?.module).toBe(false);
    expect(config?.rules?.["no-undef"]?.[0]).toBe(2);

    const [validCommonJs] = await eslint.lintText(
      'module.exports = { readFileSync: require("node:fs").readFileSync };\n',
      { filePath },
    );
    expect(validCommonJs?.errorCount).toBe(0);

    const [undefinedVariable] = await eslint.lintText(
      "module.exports = missingQualityGateGlobal;\n",
      { filePath },
    );
    expect(undefinedVariable?.messages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ ruleId: "no-undef", severity: 2 }),
      ]),
    );
  },
);

test.each([
  "tests/account-live-browser.cjs",
  "tests/console-browser.cjs",
  "tests/responsive-browser.cjs",
])("%s has browser lint support without disabling no-undef", async (filePath) => {
  const eslint = new ESLint();
  const config = await eslint.calculateConfigForFile(filePath);

  expect(config?.languageOptions?.globals?.document).toBe(false);
  expect(config?.languageOptions?.globals?.window).toBe(false);
  expect(config?.rules?.["no-undef"]?.[0]).toBe(2);

  const [browserCode] = await eslint.lintText(
    'module.exports = () => `${document.title}:${window.location.href}`;\n',
    { filePath },
  );
  expect(browserCode?.errorCount).toBe(0);
});
