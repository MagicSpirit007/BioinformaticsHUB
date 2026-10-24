param([string]$Target, [switch]$Browser)

function New-BrowserStartInfo {
  param([Parameter(Mandatory=$true)][string]$RegisteredCommand, [Parameter(Mandatory=$true)][string]$Target)
  if (-not ('BrowserCommand' -as [type])) { Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class BrowserCommand {
  [DllImport("shell32.dll", SetLastError=true)] static extern IntPtr CommandLineToArgvW([MarshalAs(UnmanagedType.LPWStr)] string command, out int count);
  [DllImport("kernel32.dll")] static extern IntPtr LocalFree(IntPtr memory);
  public static string[] Split(string command) {
    int count; IntPtr memory = CommandLineToArgvW(command, out count);
    if (memory == IntPtr.Zero) throw new Exception("Invalid default browser command");
    try { var args = new string[count]; for (int i=0;i<count;i++) args[i]=Marshal.PtrToStringUni(Marshal.ReadIntPtr(memory,i*IntPtr.Size)); return args; }
    finally { LocalFree(memory); }
  }
  public static string Quote(string value) {
    var result = new System.Text.StringBuilder("\"");
    int slashes = 0;
    foreach (char c in value) {
      if (c == '\\') { slashes++; continue; }
      if (c == '"') { result.Append('\\', slashes * 2 + 1); result.Append(c); }
      else { result.Append('\\', slashes); result.Append(c); }
      slashes = 0;
    }
    result.Append('\\', slashes * 2); result.Append('"');
    return result.ToString();
  }
}
'@
  }
  $parts = [BrowserCommand]::Split($RegisteredCommand)
  if ($parts.Length -lt 1 -or -not (Test-Path -LiteralPath $parts[0] -PathType Leaf)) { throw 'Default browser executable is unavailable; set a default browser in Windows Settings.' }
  $arguments = New-Object 'System.Collections.Generic.List[string]'
  $replaced = $false
  foreach ($part in $parts | Select-Object -Skip 1) {
    # Edge/Chromium's shell marker consumes the raw remaining command line,
    # including quotes. We build a regular argv command, so omit the marker.
    if ($part -eq '--single-argument') { continue }
    $next = $part
    foreach ($placeholder in @('%1','%L','%l','%u','%U')) {
      if ($next.Contains($placeholder)) { $next = $next.Replace($placeholder, $Target); $replaced = $true }
    }
    $arguments.Add($next)
  }
  if (-not $replaced) { $arguments.Add($Target) }
  $info = New-Object System.Diagnostics.ProcessStartInfo
  $info.FileName = $parts[0]
  $info.Arguments = (($arguments | ForEach-Object { [BrowserCommand]::Quote($_) }) -join ' ')
  $info.UseShellExecute = $false
  return $info
}

# Dot-sourcing exposes the command builder for Windows argument regression tests.
if ($MyInvocation.InvocationName -eq '.') { return }
$ErrorActionPreference = 'Stop'
try {
  if ([string]::IsNullOrWhiteSpace($Target)) { throw 'An open target is required.' }
  if ($Browser) {
    # Use the HTTP browser association even if .html is associated with an editor.
    $choice = Get-ItemProperty -LiteralPath 'HKCU:\Software\Microsoft\Windows\Shell\Associations\UrlAssociations\http\UserChoice'
    $key = Get-Item -LiteralPath ('Registry::HKEY_CLASSES_ROOT\' + $choice.ProgId + '\shell\open\command')
    $registered = [Environment]::ExpandEnvironmentVariables([string]$key.GetValue(''))
    $info = New-BrowserStartInfo -RegisteredCommand $registered -Target $Target
  } else {
    $info = New-Object System.Diagnostics.ProcessStartInfo
    $info.FileName = $Target
    $info.UseShellExecute = $true
  }
  [void][System.Diagnostics.Process]::Start($info)
  exit 0
} catch {
  [Console]::Error.WriteLine($_.Exception.Message)
  exit 1
}
