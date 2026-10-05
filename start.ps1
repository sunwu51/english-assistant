# Run from your project directory to keep Claude Code's working directory there.
# Local debug mode uses Claude's documented feature-flag defaults.
# Restore the caller's environment when the child process exits.
$eaPreviousGrowthBook = [Environment]::GetEnvironmentVariable('DISABLE_GROWTHBOOK', 'Process')
$eaExitCode = 1
try {
    $env:DISABLE_GROWTHBOOK = '1'
    Write-Host 'English Assistant: local debug mode; remote feature-flag fetching disabled for this process.'
    Write-Host 'Check /ea-status after startup. Other features requiring remote flags may be unavailable.'
    & claude --plugin-dir $PSScriptRoot @args
    $eaExitCode = $LASTEXITCODE
}
finally {
    [Environment]::SetEnvironmentVariable('DISABLE_GROWTHBOOK', $eaPreviousGrowthBook, 'Process')
}
exit $eaExitCode
