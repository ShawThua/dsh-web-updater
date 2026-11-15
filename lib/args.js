// dsh-web-updater — PowerShell argument assembly.
//
// The host hands a detached PowerShell command line to `powershell.exe
// -Command`. `Start-Process -ArgumentList @(...)` joins its elements without
// quoting, so an install directory such as "D:\Program Files (x86)\..."
// arrives as two arguments and the script dies before it writes a log
// (2026-11-14 21:15 regression). The one reliable shape is a single
// pre-quoted string; this module is the only place that builds it.
//
// Kept dependency-free and exported so `test/args.test.mjs` can pin the
// behavior the PowerShell side relies on (bin/dsh_update.ps1 `Join-Args`).

/** Quote one argument for the PowerShell command line. */
export function quoteArg(arg) {
  const text = String(arg)
  if (!/[\s"]/.test(text)) return text
  // Inside a double-quoted PowerShell string, "" is one literal quote.
  return '"' + text.replace(/"/g, '""') + '"'
}

/** Join already-quoted arguments into one command-line string. */
export function buildArgString(args) {
  return args.map(quoteArg).join(' ')
}

/**
 * Build the hidden `Start-Process` wrapper that detaches a child from the host.
 * `file` and every argument survive the outer single-quoted PowerShell string
 * because single quotes are doubled.
 */
export function buildStartProcessCommand(file, args, { windowStyle = 'Hidden' } = {}) {
  const escape = (text) => String(text).replace(/'/g, "''")
  return (
    `Start-Process -FilePath '${escape(file)}'` +
    ` -ArgumentList '${escape(buildArgString(args))}'` +
    ` -WindowStyle ${windowStyle}`
  )
}
