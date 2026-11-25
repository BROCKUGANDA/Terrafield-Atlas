#!/usr/bin/env node
/**
 * Compile contracts/TerraFieldSupport.sol with solc and emit contracts/abi/TerraFieldSupport.json.
 *
 * OpenZeppelin sources are resolved from node_modules through solc's import
 * callback. Any compilation error (including an unresolved import) fails the
 * script with a non-zero exit; warnings that indicate missing sources are
 * promoted to errors.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import solc from 'solc';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const CONTRACT_PATH = resolve(ROOT, 'contracts', 'TerraFieldSupport.sol');
const ABI_PATH = resolve(ROOT, 'contracts', 'abi', 'TerraFieldSupport.json');
const SOURCE_UNIT = 'contracts/TerraFieldSupport.sol';
const MISSING_IMPORT_PATTERN = /not found|source .* not found|file not found|cannot find/i;

function resolveImport(importPath) {
  const candidates = [
    resolve(ROOT, 'node_modules', importPath),
    resolve(ROOT, 'contracts', importPath),
    resolve(ROOT, importPath),
  ];
  for (const candidate of candidates) {
    if (!isAbsolute(candidate) || !existsSync(candidate)) continue;
    return { contents: readFileSync(candidate, 'utf8') };
  }
  return { error: `Source "${importPath}" not found (missing dependency)` };
}

/** @returns {{ abi: unknown[]; bytecode: string; compiler: string }} */
export function compileSupportContract({ write = true } = {}) {
  if (!existsSync(CONTRACT_PATH)) throw new Error(`contract source missing: ${CONTRACT_PATH}`);
  const input = {
    language: 'Solidity',
    sources: { [SOURCE_UNIT]: { content: readFileSync(CONTRACT_PATH, 'utf8') } },
    settings: {
      optimizer: { enabled: true, runs: 200 },
      outputSelection: { '*': { '*': ['abi', 'evm.bytecode.object', 'evm.deployedBytecode.object'] } },
    },
  };
  const output = JSON.parse(solc.compile(JSON.stringify(input), { import: resolveImport }));
  const diagnostics = output.errors ?? [];
  const errors = diagnostics.filter((entry) => entry.severity === 'error');
  if (errors.length > 0) {
    const message = errors.map((entry) => entry.formattedMessage ?? entry.message).join('\n');
    if (errors.some((entry) => MISSING_IMPORT_PATTERN.test(entry.formattedMessage ?? entry.message))) {
      throw new Error(`contract compilation failed with unresolved imports:\n${message}`);
    }
    throw new Error(`contract compilation failed:\n${message}`);
  }
  const contract = output.contracts?.[SOURCE_UNIT]?.TerraFieldSupport;
  if (!contract) throw new Error('compiled output is missing TerraFieldSupport');
  const bytecode = contract.evm?.bytecode?.object ?? '';
  if (!bytecode) throw new Error('compiled output has no deployment bytecode');
  const artifact = {
    contractName: 'TerraFieldSupport',
    compiler: solc.version(),
    abi: contract.abi,
    bytecode: `0x${bytecode}`,
    deployedBytecode: `0x${contract.evm?.deployedBytecode?.object ?? ''}`,
  };
  if (write) {
    mkdirSync(dirname(ABI_PATH), { recursive: true });
    writeFileSync(ABI_PATH, `${JSON.stringify(artifact, null, 2)}\n`, 'utf8');
  }
  return artifact;
}

const invokedDirectly = process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (invokedDirectly) {
  try {
    const artifact = compileSupportContract();
    console.log(`compiled ${artifact.contractName} with ${artifact.compiler}`);
    console.log(`wrote ${ABI_PATH}`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  }
}
