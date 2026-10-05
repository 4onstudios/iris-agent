import { createRequire } from "node:module";
import path from "node:path";
import ts from "typescript";

const require = createRequire(import.meta.url);
const args = ts.parseCommandLine(process.argv.slice(2));
const formatHost = {
  getCanonicalFileName: (file) => file,
  getCurrentDirectory: ts.sys.getCurrentDirectory,
  getNewLine: () => ts.sys.newLine,
};
const report = (diagnostics) => {
  if (diagnostics.length) {
    console.error(ts.formatDiagnosticsWithColorAndContext(diagnostics, formatHost));
  }
};
const configPath = path.resolve(args.options.project || "tsconfig.json");
const config = ts.readConfigFile(configPath, ts.sys.readFile);
if (config.error) {
  report([config.error]);
  process.exit(1);
}
const parsed = ts.parseJsonConfigFileContent(
  config.config,
  ts.sys,
  path.dirname(configPath),
  args.options.noEmit ? { noEmit: true } : {},
  configPath,
);
const configErrors = [...args.errors, ...parsed.errors];
if (configErrors.length) {
  report(configErrors);
  process.exitCode = 1;
} else {
  let nativeUiAvailable = true;
  for (const dependency of ["@opentui/core", "web-tree-sitter"]) {
    try {
      require.resolve(dependency);
    } catch (error) {
      if (error.code !== "MODULE_NOT_FOUND") throw error;
      nativeUiAvailable = false;
    }
  }
  if (!nativeUiAvailable) {
    console.warn(
      "Optional OpenTUI dependencies are absent; compiling SDK, service, ACP and plain chat only. " +
      "Install optional dependencies with Node.js >=26.4.0 to build OpenTUI.",
    );
  }
  const nativeUiPath = path.resolve("api/core/library/cliOpenTui.ts");
  const files = parsed.fileNames.filter(
    (file) => nativeUiAvailable || path.resolve(file) !== nativeUiPath,
  );
  const program = ts.createProgram(files, parsed.options);
  const result = program.emit();
  const diagnostics = [...ts.getPreEmitDiagnostics(program), ...result.diagnostics];
  report(diagnostics);
  if (result.emitSkipped || diagnostics.some((item) => item.category === ts.DiagnosticCategory.Error)) {
    process.exitCode = 1;
  }
}
