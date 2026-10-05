# Explicit one-time user-scope installation. Does not change feature flags.
& claude plugin marketplace add $PSScriptRoot --scope user
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
& claude plugin install 'english-assistant@english-assistant-marketplace' --scope user
exit $LASTEXITCODE
