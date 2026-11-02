param(
  [Parameter(Mandatory = $true, Position = 0)]
  [string] $Command,
  [Parameter(ValueFromRemainingArguments = $true)]
  [string[]] $CommandArgs
)

$ErrorActionPreference = 'Stop'

# The command and every argument arrive as separate process arguments.
# Do not build or evaluate a command-line string here.
& $Command @CommandArgs
if ($null -eq $LASTEXITCODE) {
  exit 0
}
exit $LASTEXITCODE
