# YAML Frontmatter Fixer Script
# This script helps identify and fix YAML frontmatter issues in the failed notes

$vaultPath = "X:\Obsidian Vaults\Managed Knowledge"

# List of files with YAML errors
$problematicFiles = @(
    "03-Areas/Security & Compliance/Forensic Value of Prefetch.md",
    "02-Projects/AWS-Defender-integration/03-Scripts/03-Scripts.md",
    "03-Areas/Training & Certification/CTF/picoCTF/Wireshark twoo twooo two twoo.md",
    "04-Resources/Documentation/tldr/common/[.md",
    "04-Resources/Documentation/tldr/common/[[.md"
)

Write-Host "=== YAML Frontmatter Issue Inspector ===" -ForegroundColor Cyan
Write-Host ""

foreach ($file in $problematicFiles) {
    $fullPath = Join-Path $vaultPath $file
    
    if (Test-Path $fullPath) {
        Write-Host "File: $file" -ForegroundColor Yellow
        Write-Host "Path: $fullPath" -ForegroundColor Gray
        
        # Read first 20 lines to see the frontmatter
        $lines = Get-Content $fullPath -TotalCount 20
        
        Write-Host "First 20 lines:" -ForegroundColor Green
        for ($i = 0; $i -lt [Math]::Min(20, $lines.Count); $i++) {
            Write-Host "$($i+1): $($lines[$i])"
        }
        
        Write-Host ""
        Write-Host "---" -ForegroundColor DarkGray
        Write-Host ""
    } else {
        Write-Host "File not found: $file" -ForegroundColor Red
        Write-Host ""
    }
}

Write-Host ""
Write-Host "=== Recommendations ===" -ForegroundColor Cyan
Write-Host "1. Check for proper YAML frontmatter delimiters (---)"
Write-Host "2. Validate YAML syntax (use https://www.yamllint.com/)"
Write-Host "3. Ensure proper indentation (use spaces, not tabs)"
Write-Host "4. Quote special characters in values"
Write-Host "5. For multiline values, use | or > indicators"
Write-Host ""
Write-Host "To fix automatically, you can:"
Write-Host "  - Remove invalid frontmatter entirely"
Write-Host "  - Or wrap problematic values in quotes"
Write-Host "  - Or escape special characters"
