/**
 * Programmatic API. Every CLI command is also available as a function that returns a
 * ToolResult (findings + summary + sections), so you can build your own reports or checks.
 */
export type { Finding, Section, Severity, ToolDef, ToolResult } from "./core/types.js"
export { render, renderSarif, shouldFail, type Format } from "./core/report.js"
export { main } from "./cli.js"
export { TOOLS } from "./tools/index.js"
export { scanRepo } from "./tools/repodoctor.js"
export { checkMigrations } from "./tools/migraguard/index.js"
export { analyzeSql } from "./tools/migraguard/rules.js"
export { analyzeKnex } from "./tools/migraguard/knex.js"
export { runSuite, toJUnit } from "./tools/pulseapi/engine.js"
export { analyze as analyzeDependencies, graphOf as dependencyGraph } from "./tools/depscope/index.js"
export { checkEnv, parseDotenv } from "./tools/envdoctor.js"
export { lintMessage, suggest as suggestCommit, changelog, scanDiff } from "./tools/commitsmith.js"
export { checkArchitecture, type ArchConfig } from "./tools/archwatch.js"
export { analyzeLogs } from "./tools/loglens.js"
export { buildGraph, findCycles } from "./core/imports.js"
