import type { ComponentSpec } from '../tools/design/index.js';

export interface GeneratedArtifact {
  fileName: string;
  content: string;
  role: 'component' | 'markup' | 'style' | 'script';
}

export interface CodeGeneratorOptions {
  framework: string;
  styleMethod: string;
  darkMode: boolean;
}

export interface CodeGenerator {
  id: string;
  displayName: string;
  frameworkAliases: string[];
  createScaffold(spec: ComponentSpec, options: CodeGeneratorOptions): GeneratedArtifact[];
  buildFillSystem(options: CodeGeneratorOptions): string;
  buildFillPrompt(
    spec: ComponentSpec,
    artifacts: GeneratedArtifact[],
    options: CodeGeneratorOptions,
  ): string;
  supportsStylePass(options: CodeGeneratorOptions): boolean;
  buildStyleSystem(options: CodeGeneratorOptions): string;
  buildStylePrompt(
    spec: ComponentSpec,
    artifacts: GeneratedArtifact[],
    options: CodeGeneratorOptions,
  ): string;
  buildFixPrompt(
    spec: ComponentSpec,
    artifacts: GeneratedArtifact[],
    issues: Array<{ check: string; severity: string; message: string }>,
    options: CodeGeneratorOptions,
  ): string;
  getEntryArtifact(artifacts: GeneratedArtifact[]): GeneratedArtifact;
}
