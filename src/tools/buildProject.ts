import { z } from 'zod';
import { execFile, spawn } from 'child_process';
import util from 'util';
import path from 'path';
import { access, writeFile, readFile, unlink, appendFile } from 'fs/promises';
import { openSync as openSyncFs, closeSync as closeSyncFs } from 'fs';
import os from 'os';
import crypto from 'crypto';
import { getConfigManager } from '../utils/configManager.js';
import { forceReleaseLock } from '../utils/operationLocks.js';

const execFileAsync = util.promisify(execFile);

// ---------------------------------------------------------------------------
// Build-tool file logger
// ---------------------------------------------------------------------------

async function buildLog(level: 'INFO' | 'WARN' | 'ERROR', message: string): Promise<void> {
  console.error(`[build_d365fo_project] ${message}`);
  try {
    const configManager = getConfigManager();
    const logFile = configManager.getContext()?.bridgeLogFile;
    if (!logFile) return;
    const line = `[${new Date().toISOString()}] [BuildTool] [${level}] ${message}\n`;
    await appendFile(logFile, line, 'utf-8');
  } catch {
    // Best-effort — never throw from logging
  }
}

// ---------------------------------------------------------------------------
// Security
// ---------------------------------------------------------------------------

function assertSafePath(value: string, label: string): void {
  if (/[&|<>^`!;$%"'\n\r]/.test(value)) {
    throw new Error(
      `${label} contains potentially dangerous characters and cannot be used in a build command: ${value}`
    );
  }
}

// xppc.exe writes this prefix on error lines in the -log file (standalone/non-VS mode)
const XPPC_COMPILE_ERROR_RE = /^Compile Error:/m;

// ---------------------------------------------------------------------------
// Async build state management
// State and log files live in os.tmpdir(), keyed by a hash of modelName+metadataPath.
// ---------------------------------------------------------------------------

interface BuildJobState {
  pid: number;
  modelName: string;
  tool: string;
  startTime: string;
  logFile: string;
  status: 'running' | 'succeeded' | 'failed';
  exitCode?: number;
  endTime?: string;
}

function buildJobKey(modelName: string, customPackagesPath: string): string {
  return `${modelName.toLowerCase()}|${customPackagesPath.toLowerCase()}`;
}

function buildJobPaths(modelName: string, customPackagesPath: string): { stateFile: string; logFile: string } {
  const hash = crypto.createHash('md5').update(buildJobKey(modelName, customPackagesPath)).digest('hex').slice(0, 10);
  return {
    stateFile: path.join(os.tmpdir(), `d365build_state_${hash}.json`),
    logFile:   path.join(os.tmpdir(), `d365build_log_${hash}.log`),
  };
}

async function readBuildState(modelName: string, customPackagesPath: string): Promise<BuildJobState | null> {
  const { stateFile } = buildJobPaths(modelName, customPackagesPath);
  try {
    const raw = await readFile(stateFile, 'utf-8');
    return JSON.parse(raw) as BuildJobState;
  } catch {
    return null;
  }
}

async function writeBuildState(state: BuildJobState, customPackagesPath: string): Promise<void> {
  const { stateFile } = buildJobPaths(state.modelName, customPackagesPath);
  await writeFile(stateFile, JSON.stringify(state, null, 2), 'utf-8');
}

async function clearBuildState(modelName: string, customPackagesPath: string): Promise<void> {
  const { stateFile } = buildJobPaths(modelName, customPackagesPath);
  await unlink(stateFile).catch(() => {});
}

function isProcessAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

async function readLogTail(logFile: string, lines = 60): Promise<string> {
  try {
    const content = await readFile(logFile, 'utf-8');
    const all = content.split(/\r?\n/);
    return all.slice(-lines).join('\n').trim();
  } catch {
    return '(log not yet available)';
  }
}


// ---------------------------------------------------------------------------
// Parse model name from .rnrproj XML
// ---------------------------------------------------------------------------

async function getModelFromRnrproj(projectPath: string): Promise<string | null> {
  try {
    const content = await readFile(projectPath, 'utf-8');
    const match = content.match(/<Model>\s*([^<]+)\s*<\/Model>/i);
    return match ? match[1].trim() : null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Locate xppc.exe from microsoftPackagesPath
// ---------------------------------------------------------------------------

async function findXppcExe(microsoftPackagesPath: string | null): Promise<string | null> {
  const candidates: string[] = [];

  if (microsoftPackagesPath) {
    candidates.push(path.join(microsoftPackagesPath, 'bin', 'xppc.exe'));
  }

  // Search AppData for any installed UDE version
  const appDataLocal = process.env.LOCALAPPDATA ||
    path.join(process.env.USERPROFILE || 'C:\\Users\\Default', 'AppData', 'Local');
  const d365Base = path.join(appDataLocal, 'Microsoft', 'Dynamics365');
  try {
    const { readdir } = await import('fs/promises');
    const versions = await readdir(d365Base);
    for (const ver of versions.sort().reverse()) {
      candidates.push(path.join(d365Base, ver, 'PackagesLocalDirectory', 'bin', 'xppc.exe'));
    }
  } catch { /* ignore */ }

  // CHE well-known locations
  candidates.push(
    'C:\\AOSService\\PackagesLocalDirectory\\bin\\xppc.exe',
    'K:\\AOSService\\PackagesLocalDirectory\\bin\\xppc.exe',
    'J:\\AOSService\\PackagesLocalDirectory\\bin\\xppc.exe',
    'I:\\AOSService\\PackagesLocalDirectory\\bin\\xppc.exe',
  );

  for (const c of candidates) {
    try { await access(c); return c; } catch { /* next */ }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Background xppc.exe launch
// ---------------------------------------------------------------------------

async function launchXppcBackground(
  xppcExe: string,
  modelName: string,
  customPackagesPath: string,
  microsoftPackagesPath: string,
  extraReferenceFolders: string[] = [],
): Promise<BuildJobState> {
  assertSafePath(xppcExe, 'xppc.exe path');
  assertSafePath(modelName, 'Model name');
  assertSafePath(customPackagesPath, 'Custom packages path');
  assertSafePath(microsoftPackagesPath, 'Microsoft packages path');

  const { logFile } = buildJobPaths(modelName, customPackagesPath);
  const outputPath = path.join(customPackagesPath, modelName, 'bin');

  // xppc.exe -log=<path> writes all compiler diagnostics to a plain-text file:
  //   Compile Error: Class Method dynamics://...: [(line,col),(line,col)]: message
  // This is the only reliable way to capture errors in standalone (non-VS) mode.
  const xppcErrorLog = logFile.replace('.log', '.xppc.err');

  // Build the full deduplicated set of reference folders.
  // Start with the two required paths, then append any extras from ReferencePackagesPaths.
  const seenRefFolders = new Set<string>();
  const referenceFolderArgs: string[] = [];
  for (const folder of [microsoftPackagesPath, customPackagesPath, ...extraReferenceFolders]) {
    const norm = folder.toLowerCase();
    if (!seenRefFolders.has(norm)) {
      seenRefFolders.add(norm);
      referenceFolderArgs.push(`-referenceFolder=${folder}`);
    }
  }

  const xppcArgs = [
    `-metadata=${customPackagesPath}`,
    `-compilermetadata=${microsoftPackagesPath}`,
    `-modelmodule=${modelName}`,
    ...referenceFolderArgs,
    `-output=${outputPath}`,
    '-incremental',
    `-log=${xppcErrorLog}`,
  ];

  await buildLog('INFO', `xppc.exe args: ${xppcArgs.join(' ')}`);

  // Clear stale diagnostics files before each build so a previous failed run's
  // errors don't bleed into a subsequent successful build's output.
  // Clear the xppc error log so we never read stale entries from a previous run.
  await unlink(xppcErrorLog).catch(() => {});

  // xppc.exe is a normal console app — file descriptor redirect works fine
  const logFd = openSyncFs(logFile, 'w');

  const child = spawn(xppcExe, xppcArgs, {
    detached: false,
    windowsHide: true,
    stdio: ['ignore', logFd, logFd],
  });
  // Prevent the MCP server from waiting for xppc to exit on shutdown.
  child.unref();

  const state: BuildJobState = {
    pid: child.pid!,
    modelName,
    tool: 'xppc.exe',
    startTime: new Date().toISOString(),
    logFile,
    status: 'running',
  };

  await writeBuildState(state, customPackagesPath);
  await buildLog('INFO', `xppc.exe launched — PID: ${child.pid} | model: ${modelName} | log: ${logFile}`);

  child.on('close', async (code) => {
    closeSyncFs(logFd);
    const exitCode = code ?? -1;

    // Read the xppc -log output first — this is the authoritative source of
    // compiler errors. xppc does NOT write errors to stdout or the XML result
    // files when run standalone (outside VS/MSBuild). The -log file contains
    // lines like:
    //   Compile Error: Class Method dynamics://...: [(28,27),(28,28)]: ';' expected.
    //   Compile Warning: ...
    let xppcErrorContent = '';
    try {
      xppcErrorContent = await readFile(xppcErrorLog, 'utf-8');
    } catch { /* no -log file = no diagnostics */ }

    const hasCompileErrors = XPPC_COMPILE_ERROR_RE.test(xppcErrorContent);
    // A build succeeds only when xppc exits 0 AND no compile errors were logged.
    // xppc may exit 0 even when it emits errors (observed in UDE standalone mode).
    const succeeded = exitCode === 0 && !hasCompileErrors;

    if (xppcErrorContent.trim()) {
      await appendFile(logFile, '\n--- xppc compiler diagnostics ---\n' + xppcErrorContent + '\n', 'utf-8');
    }

    const updated: BuildJobState = {
      ...state,
      status: succeeded ? 'succeeded' : 'failed',
      exitCode,
      endTime: new Date().toISOString(),
    };
    await writeBuildState(updated, customPackagesPath).catch(() => {});
    await buildLog(succeeded ? 'INFO' : 'ERROR', `xppc.exe finished — PID: ${child.pid} | exit: ${exitCode} | compile errors: ${hasCompileErrors}`);
  });

  child.on('error', async (err) => {
    closeSyncFs(logFd);
    const updated: BuildJobState = { ...state, status: 'failed', exitCode: -1, endTime: new Date().toISOString() };
    await writeBuildState(updated, customPackagesPath).catch(() => {});
    await buildLog('ERROR', `xppc.exe error — PID: ${child.pid}: ${err.message}`);
  });

  return state;
}

// ---------------------------------------------------------------------------
// Kill orphaned build processes
// ---------------------------------------------------------------------------

async function killOrphanedBuildProcesses(): Promise<void> {
  await execFileAsync('taskkill', ['/F', '/IM', 'xppc.exe'], { timeout: 10_000, windowsHide: true })
    .then(({ stdout }) => console.error(`[build_d365fo_project] killed xppc.exe: ${stdout.trim() || '(no output)'}`))
    .catch(() => {});
}

// ---------------------------------------------------------------------------
// Tool definition
// ---------------------------------------------------------------------------

export const buildProjectToolDefinition = {
  name: 'build_d365fo_project',
  description: [
    'Builds a D365FO model using the X++ compiler (xppc.exe) and returns compiler errors.',
    'Compiles the entire model — equivalent to building the full model in Visual Studio.',
    'Because compilation can take several minutes, the build runs in the background.',
    'First call: starts the build and returns immediately.',
    'Subsequent calls for the same model: return current status + latest log output.',
    'Use force:true to kill a stuck build and restart.',
  ].join(' '),
  parameters: z.object({
    modelName: z.string().optional().describe('D365FO model name to build (e.g. MyCompanyModel). Auto-detected from workspace if omitted.'),
    projectPath: z.string().optional().describe('(Legacy) Absolute path to a .rnrproj file — used only to extract the model name when modelName is not provided.'),
    force: z.boolean().optional().describe('Kill any running build processes and restart.'),
  }),
};

// ---------------------------------------------------------------------------
// Tool handler
// ---------------------------------------------------------------------------

export const buildProjectTool = async (params: any, _context: any) => {
  try {
  const force = params.force === true;

  const configManager = getConfigManager();
  await configManager.ensureLoaded();

  // ------------------------------------------------------------------
  // Resolve paths — supports both UDE and CHE environments
  //
  // UDE (Unified Developer Experience):
  //   - XPP config JSON present in %LOCALAPPDATA%\Microsoft\Dynamics365\XPPConfig\
  //   - customPackagesPath    = ModelStoreFolder  (git repo metadata, e.g. src\Metadata)
  //   - microsoftPackagesPath = FrameworkDirectory (AppData UDE packages)
  //   - referencePackagesPaths = all folders xppc should reference (incl. dist/ ISV packages)
  //
  // CHE (Cloud-Hosted Environment):
  //   - No XPP config; all packages in a single PackagesLocalDirectory
  //   - Both paths = PackagesLocalDirectory
  //   - Typical locations: C:\AOSService\PackagesLocalDirectory or K:\, J:\, I:\
  // ------------------------------------------------------------------
  let customPackagesPath: string | null = null;
  let microsoftPackagesPath: string | null = null;
  let extraReferenceFolders: string[] = [];

  // Priority 1: XPP config (UDE) — authoritative source for all paths
  const xppConfig = await configManager.getActiveXppConfig();
  if (xppConfig) {
    customPackagesPath    = xppConfig.customPackagesPath;
    microsoftPackagesPath = xppConfig.microsoftPackagesPath;
    extraReferenceFolders = xppConfig.referencePackagesPaths ?? [];
  }

  // Priority 2: configManager explicit methods (covers .mcp.json overrides)
  if (!customPackagesPath) {
    customPackagesPath = await configManager.getCustomPackagesPath();
  }
  if (!microsoftPackagesPath) {
    microsoftPackagesPath = await configManager.getMicrosoftPackagesPath() ?? configManager.getPackagePath();
  }

  // Priority 3: CHE fallback — probe well-known PackagesLocalDirectory locations
  if (!microsoftPackagesPath) {
    for (const candidate of [
      'C:\\AOSService\\PackagesLocalDirectory',
      'K:\\AOSService\\PackagesLocalDirectory',
      'J:\\AOSService\\PackagesLocalDirectory',
      'I:\\AOSService\\PackagesLocalDirectory',
    ]) {
      try { await access(candidate); microsoftPackagesPath = candidate; break; } catch { /* next */ }
    }
  }

  // In CHE, custom and Microsoft packages share the same PackagesLocalDirectory
  if (!customPackagesPath && microsoftPackagesPath) {
    customPackagesPath = microsoftPackagesPath;
  }

  if (!customPackagesPath || !microsoftPackagesPath) {
    return {
      content: [{
        type: 'text',
        text: [
          `❌ Cannot resolve D365FO package paths.`,
          ``,
          `Custom packages path:    ${customPackagesPath ?? '(not found)'}`,
          `Microsoft packages path: ${microsoftPackagesPath ?? '(not found)'}`,
          ``,
          `For UDE: ensure an XPP config is present at %LOCALAPPDATA%\\Microsoft\\Dynamics365\\XPPConfig\\`,
          `For CHE: ensure PackagesLocalDirectory exists at C:\\AOSService\\PackagesLocalDirectory (or K:\\, J:\\, I:\\)`,
        ].join('\n'),
      }],
      isError: true,
    };
  }

  // ------------------------------------------------------------------
  // Resolve model name
  // Priority: 1) explicit param  2) auto-detected from workspace  3) .rnrproj fallback
  // ------------------------------------------------------------------
  let modelName: string | null = params.modelName || configManager.getModelName();

  if (!modelName && params.projectPath) {
    modelName = await getModelFromRnrproj(params.projectPath);
  }

  if (!modelName) {
    return {
      content: [{
        type: 'text',
        text: [
          `❌ Cannot determine model name.`,
          ``,
          `Provide modelName parameter, or configure it in .mcp.json / D365FO_MODEL_NAME env var.`,
        ].join('\n'),
      }],
      isError: true,
    };
  }

  // ------------------------------------------------------------------
  // Check for an existing background build for this model
  // ------------------------------------------------------------------
  const existingState = await readBuildState(modelName, customPackagesPath);

  if (existingState && !force) {
    const alive = isProcessAlive(existingState.pid);
    const logTail = await readLogTail(existingState.logFile);

    if (existingState.status === 'running' && alive) {
      const elapsed = Math.round((Date.now() - new Date(existingState.startTime).getTime()) / 1000);
      return {
        content: [{
          type: 'text',
          text: `⏳ Build in progress (${existingState.tool} PID: ${existingState.pid}, running ${elapsed}s)\n\nModel: ${modelName}\n\nCall again to refresh status.\n\n--- Latest log ---\n${logTail}`,
        }],
      };
    }

    if (existingState.status === 'running' && !alive) {
      // The process has exited but the close handler (which writes the final state) is async.
      // Wait up to 2 s for it to finish before giving up and declaring an unexpected exit.
      let finalState = existingState;
      for (let i = 0; i < 4; i++) {
        await new Promise(resolve => setTimeout(resolve, 500));
        const refreshed = await readBuildState(modelName, customPackagesPath);
        if (refreshed && refreshed.status !== 'running') { finalState = refreshed; break; }
      }
      if (finalState.status !== 'running') {
        // Close handler finished — fall through to normal result handling below
        existingState.status = finalState.status;
        existingState.exitCode = finalState.exitCode;
        existingState.endTime = finalState.endTime;
      } else {
        await clearBuildState(modelName, customPackagesPath);
        return {
          content: [{
            type: 'text',
            text: `❌ Build process (PID: ${existingState.pid}) exited unexpectedly without reporting a result.\n\nModel: ${modelName}\n\n--- Log ---\n${logTail}`,
          }],
          isError: true,
        };
      }
    }

    // Build finished — return result and clear state
    await clearBuildState(modelName, customPackagesPath);
    const succeeded = existingState.status === 'succeeded';
    const hasErrors = !succeeded;
    const hasWarnings = !hasErrors && /^(Generation Warning|Compile Warning):/m.test(logTail);
    const statusIcon = hasErrors ? '❌ Build FAILED' : hasWarnings ? '⚠️ Build succeeded with warnings' : '✅ Build succeeded';
    const duration = existingState.endTime
      ? Math.round((new Date(existingState.endTime).getTime() - new Date(existingState.startTime).getTime()) / 1000)
      : '?';
    return {
      content: [{
        type: 'text',
        text: `${statusIcon} (${existingState.tool}, ${duration}s)\n\nModel: ${modelName}\n\n${logTail || '(no output)'}`,
      }],
      ...(hasErrors ? { isError: true } : {}),
    };
  }

  // ------------------------------------------------------------------
  // force=true: kill existing processes and clear state
  // ------------------------------------------------------------------
  if (force) {
    await buildLog('WARN', `force=true — killing orphaned build processes for model: ${modelName}`);
    if (existingState?.pid) {
      try { process.kill(existingState.pid, 'SIGTERM'); } catch { /* already gone */ }
    }
    await killOrphanedBuildProcesses();
    await clearBuildState(modelName, customPackagesPath);
    await forceReleaseLock(`build:${modelName}`);
  }

  // ------------------------------------------------------------------
  // Find xppc.exe
  // ------------------------------------------------------------------
  const xppcExe = await findXppcExe(microsoftPackagesPath);
  if (!xppcExe) {
    return {
      content: [{
        type: 'text',
        text: `❌ Cannot find xppc.exe.\n\nLooked in: ${microsoftPackagesPath}\\bin\\xppc.exe\n\nEnsure the D365FO UDE tools are installed.`,
      }],
      isError: true,
    };
  }

  await buildLog('INFO', `Starting xppc.exe build — model: ${modelName}`);
  await buildLog('INFO', `  xppc.exe:              ${xppcExe}`);
  await buildLog('INFO', `  customPackagesPath:    ${customPackagesPath}`);
  await buildLog('INFO', `  microsoftPackagesPath: ${microsoftPackagesPath}`);
  if (extraReferenceFolders.length > 0) {
    await buildLog('INFO', `  extraReferenceFolders: ${extraReferenceFolders.join(', ')}`);
  }

  // ------------------------------------------------------------------
  // Launch xppc.exe in background
  // ------------------------------------------------------------------
  const jobState = await launchXppcBackground(
    xppcExe,
    modelName,
    customPackagesPath,
    microsoftPackagesPath,
    extraReferenceFolders,
  );

  return {
    content: [{
      type: 'text',
      text: [
        `🔨 Build started (xppc.exe PID: ${jobState.pid})`,
        ``,
        `Model: ${modelName}`,
        `Log:   ${jobState.logFile}`,
        ``,
        `Call **build_d365fo_project** again to check status and see output.`,
      ].join('\n'),
    }],
  };
  } catch (error: any) {
    await buildLog('ERROR', `Unhandled error in build_d365fo_project: ${error?.message}`);
    return {
      content: [{ type: 'text', text: `❌ Internal error: ${error?.message ?? String(error)}` }],
      isError: true,
    };
  }
};
