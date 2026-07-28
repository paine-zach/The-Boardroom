# ============================================================
# THE BOARDROOM — SIX-MONTH FORM 4 BACKFILL
# ============================================================

# Before running this script:
# 1. Copy CRON_SECRET from Vercel.
# 2. Run this script while the secret is still on your clipboard.

$secret = (Get-Clipboard -Raw).Trim() -replace "[`r`n]", ""

if ([string]::IsNullOrWhiteSpace($secret)) {
    throw "The clipboard does not contain CRON_SECRET."
}

# Remove the secret from the clipboard immediately.
Clear-Clipboard

$headers = @{
    Authorization = "Bearer $secret"
}

$baseUrl = "https://www.theboardroom.dev/api/import-form4"

# Import from six months ago through today.
$overallEnd = (Get-Date).Date
$overallStart = $overallEnd.AddMonths(-6)

# The API accepts at most 31 days.
$windowDays = 7

# Existing importer limits.
$limit = 25
$maxPages = 1
$maxAi = 30
$minimumValue = 1000

$windowStart = $overallStart
$results = @()

Write-Host ""
Write-Host "Starting six-month Form 4 backfill." -ForegroundColor Cyan
Write-Host "From $($overallStart.ToString('yyyy-MM-dd')) through $($overallEnd.ToString('yyyy-MM-dd'))."
Write-Host ""

while ($windowStart -le $overallEnd) {
    $windowEnd = $windowStart.AddDays($windowDays - 1)

    if ($windowEnd -gt $overallEnd) {
        $windowEnd = $overallEnd
    }

    $startText = $windowStart.ToString("yyyy-MM-dd")
    $endText = $windowEnd.ToString("yyyy-MM-dd")

    $offset = 0
    $hasMore = $true

    while ($hasMore) {
        $uri =
            "$baseUrl" +
            "?start_date=$startText" +
            "&end_date=$endText" +
            "&limit=$limit" +
            "&offset=$offset" +
            "&max_pages=$maxPages" +
            "&max_ai=$maxAi" +
            "&min_value=$minimumValue"

        Write-Host "Importing $startText to $endText — offset $offset..." -ForegroundColor Yellow

        try {
            $result = Invoke-RestMethod `
                -Uri $uri `
                -Method Get `
                -Headers $headers

            $row = [PSCustomObject]@{
                StartDate = $startText
                EndDate = $endText
                Offset = $offset
                Success = [bool]$result.success
                Filings = [int]$result.fetched.filings
                GroupedTrades = [int]$result.fetched.groupedTrades
                Inserted = [int]$result.database.inserted
                Existing = [int]$result.database.alreadyExisting
                Failed = [int]$result.database.failed
                AiSummaries = [int]$result.summaries.ai
                FallbackSummaries = [int]$result.summaries.fallback
            }

            $results += $row

            Write-Host (
                "  Inserted: {0} | Existing: {1} | Failed: {2} | AI: {3} | Fallback: {4}" -f
                $row.Inserted,
                $row.Existing,
                $row.Failed,
                $row.AiSummaries,
                $row.FallbackSummaries
            ) -ForegroundColor Green

            $pagination = $result.hermai.pagination

            $hasMore =
                $null -ne $pagination -and
                [bool]$pagination.has_more

            if ($hasMore) {
                $nextOffset = [int]$pagination.next_offset

                if ($nextOffset -le $offset) {
                    Write-Warning "Pagination did not advance. Stopping this date window."
                    $hasMore = $false
                }
                elseif ($nextOffset -ge 10000) {
                    Write-Warning "HermAI reached its upstream offset cap for this window."
                    $hasMore = $false
                }
                else {
                    $offset = $nextOffset
                }
            }
        }
        catch {
            Write-Host "  Request failed: $($_.Exception.Message)" -ForegroundColor Red

            $results += [PSCustomObject]@{
                StartDate = $startText
                EndDate = $endText
                Offset = $offset
                Success = $false
                Filings = 0
                GroupedTrades = 0
                Inserted = 0
                Existing = 0
                Failed = 1
                AiSummaries = 0
                FallbackSummaries = 0
            }

            throw @"
Backfill stopped after a failed request.

Date range: $startText through $endText
Offset: $offset

The database is safe to rerun because existing trades are skipped.
Check the newest /api/import-form4 entry in Vercel Logs before restarting.
"@
        }

        # Avoid sending requests back-to-back.
        Start-Sleep -Seconds 2
    }

    $windowStart = $windowEnd.AddDays(1)
}

$results |
    Export-Csv `
        -Path ".\backfill-six-months-results.csv" `
        -NoTypeInformation

Write-Host ""
Write-Host "Backfill finished." -ForegroundColor Cyan
Write-Host "Results saved to backfill-six-months-results.csv."
Write-Host ""

$results | Format-Table -AutoSize

# Remove sensitive and temporary variables.
Remove-Variable secret -ErrorAction SilentlyContinue
Remove-Variable headers -ErrorAction SilentlyContinue
Remove-Variable uri -ErrorAction SilentlyContinue
Remove-Variable result -ErrorAction SilentlyContinue