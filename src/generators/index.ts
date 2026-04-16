import { reactGenerator } from './react-generator.js';
import { vueGenerator } from './vue-generator.js';
import { svelteGenerator } from './svelte-generator.js';
import { vanillaGenerator } from './vanilla-generator.js';
import type { CodeGenerator } from './types.js';

const generators: CodeGenerator[] = [
  reactGenerator,
  vanillaGenerator,
  vueGenerator,
  svelteGenerator,
];

function normalizeFramework(framework: string): string {
  const value = framework.trim().toLowerCase();
  if (value.includes('html') && value.includes('css') && value.includes('js')) {
    return 'html+css+js';
  }
  if (['vanilla', 'native', 'javascript', 'js', 'html'].includes(value)) {
    return 'html+css+js';
  }
  return value;
}

export function listCodeGenerators(): CodeGenerator[] {
  return generators;
}

export function getCodeGenerator(framework: string): CodeGenerator {
  const normalized = normalizeFramework(framework);
  return (
    generators.find((generator) => generator.frameworkAliases.includes(normalized)) ??
    reactGenerator
  );
}
