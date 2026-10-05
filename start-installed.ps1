# For this machine's local debugging: use installed plugin without --plugin-dir.
$eaPreviousGrowthBook = [Environment]::GetEnvironmentVariable('DISABLE_GROWTHBOOK', 'Process')
$eaExitCode = 1
try {
    $env:DISABLE_GROWTHBOOK = '1'
    Write-Host 'Local debug mode: remote feature-flag fetching disabled for this process.'
    & claude @args
    $eaExitCode = $LASTEXITCODE
}
finally {
    [Environment]::SetEnvironmentVariable('DISABLE_GROWTHBOOK', $eaPreviousGrowthBook, 'Process')
}
exit $eaExitCode
