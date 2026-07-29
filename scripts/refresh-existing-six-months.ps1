param(
  [string]$BaseUrl = "https://www.theboardroom.dev",
  [datetime]$StartDate = [datetime]"2026-01-28",
  [datetime]$EndDate = [datetime]"2026-07-28",
  [ValidateRange(1, 25)]
  [int]$Limit = 25,
  [ValidateRange(1, 8)]
  [int]$PagesPerRequest = 8,
  [ValidateRange(1, 7)]
  [int]$WindowDays = 7,
  [ValidateRange(0, 10000)]
  [int]$StartOffset = 0,
  [ValidateRange(0, 30)]
  [int]$MaxAi = 30,
  [ValidateRange(1, 10)]
  [int]$MaxAttempts = 8,
  [ValidateRange(1, 300)]
  [int]$RetryDelaySeconds = 60,
  [ValidateRange(0, 300)]
  [int]$BatchDelaySeconds = 10
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

function Get-OptionalValue {
  param(
    [object]$Object,
    [string]$PropertyName,
    [object]$DefaultValue = $null
  )

  if ($null -eq $Object) {
    return $DefaultValue
  }

  $property =
    $Object.PSObject.Properties[$PropertyName]

  if ($null -eq $property) {
    return $DefaultValue
  }

  return $property.Value
}

function Convert-ToInteger {
  param(
    [object]$Value,
    [int]$DefaultValue = 0
  )

  if ($null -eq $Value) {
    return $DefaultValue
  }

  $parsedValue = 0

  if (
    [int]::TryParse(
      [string]$Value,
      [ref]$parsedValue
    )
  ) {
    return $parsedValue
  }

  return $DefaultValue
}

function Get-HttpStatusCode {
  param(
    [object]$ErrorRecord
  )

  try {
    return [int](
      $ErrorRecord.Exception.Response.StatusCode
    )
  }
  catch {
    return 0
  }
}

function Get-RateLimitRetrySeconds {
  param(
    [object]$ErrorRecord,
    [int]$Attempt
  )

  $statusCode =
    Get-HttpStatusCode $ErrorRecord

  $message =
    [string]$ErrorRecord.Exception.Message

  $isRateLimited =
    $statusCode -eq 429 -or
    $message -match "429|RATE_LIMITED|HERMAI_RATE_LIMITED"

  if (-not $isRateLimited) {
    return 0
  }

  $retryAfterSeconds = 0

  try {
    $retryAfterHeader =
      $ErrorRecord.Exception.Response.Headers[
        "Retry-After"
      ]

    [void][int]::TryParse(
      [string]$retryAfterHeader,
      [ref]$retryAfterSeconds
    )
  }
  catch {
    $retryAfterSeconds = 0
  }

  $exponentialDelay =
    [math]::Min(
      900,
      $RetryDelaySeconds *
        [math]::Pow(
          2,
          [math]::Min(
            $Attempt - 1,
            4
          )
        )
    )

  return [int][math]::Max(
    $retryAfterSeconds,
    $exponentialDelay
  )
}

if ($StartDate.Date -gt $EndDate.Date) {
  throw "StartDate must be earlier than or equal to EndDate."
}

$clipboardValue = Get-Clipboard

if (
  [string]::IsNullOrWhiteSpace(
    [string]$clipboardValue
  )
) {
  throw (
    "Copy the production CRON_SECRET from Vercel " +
    "before running this script."
  )
}

$secret =
  ([string]$clipboardValue).Trim() `
    -replace "[`r`n]", ""

$importUrl = "$BaseUrl/api/import-form4"
$resultsPath =
  Join-Path `
    (Get-Location) `
    "refresh-existing-results.csv"

$totalBatches = 0
$totalFilings = 0
$totalGroupedTrades = 0
$totalRefreshed = 0
$totalConsolidated = 0
$totalLegacyCardsRemoved = 0
$totalPreservedVotes = 0
$totalSkippedUnmatched = 0

$currentWindowEnd = $EndDate.Date
$currentWindowStart = $EndDate.Date
$currentOffset = $StartOffset
$firstWindow = $true

Write-Host ""
Write-Host (
  "The Boardroom - Existing Card Repair"
) -ForegroundColor Cyan

Write-Host (
  "Range: {0} through {1} (newest first)" -f
    $StartDate.ToString("yyyy-MM-dd"),
    $EndDate.ToString("yyyy-MM-dd")
)

Write-Host (
  "Safety rule: every batch must report Inserted = 0."
) -ForegroundColor Yellow

Write-Host (
  "The normal historical backfill remains paused."
) -ForegroundColor Yellow

Write-Host ""

try {
  while (
    $currentWindowEnd -ge $StartDate.Date
  ) {
    $currentWindowStart =
      $currentWindowEnd.AddDays(
        -($WindowDays - 1)
      )

    if (
      $currentWindowStart -lt $StartDate.Date
    ) {
      $currentWindowStart = $StartDate.Date
    }

    if (-not $firstWindow) {
      $currentOffset = 0
    }

    Write-Host (
      "Window: {0} through {1}" -f
        $currentWindowStart.ToString("yyyy-MM-dd"),
        $currentWindowEnd.ToString("yyyy-MM-dd")
    ) -ForegroundColor Cyan

    $hasMore = $true

    while ($hasMore) {
      $requestOffset = $currentOffset

      $body = @{
        refresh_existing = $true
        confirm_refresh = "REFRESH_EXISTING_TRADES"
        role = "all"
        start_date =
          $currentWindowStart.ToString("yyyy-MM-dd")
        end_date =
          $currentWindowEnd.ToString("yyyy-MM-dd")
        offset = $requestOffset
        limit = $Limit
        max_pages = $PagesPerRequest
        max_ai = $MaxAi
        min_value = 0
        skip_zero_rows = $true
      } | ConvertTo-Json

      $result = $null
      $lastError = $null

      for (
        $attempt = 1;
        $attempt -le $MaxAttempts;
        $attempt += 1
      ) {
        try {
          Write-Host (
            "  Offset {0}, attempt {1}/{2}" -f
              $requestOffset,
              $attempt,
              $MaxAttempts
          )

          $result =
            Invoke-RestMethod `
              -Uri $importUrl `
              -Method Post `
              -Headers @{
                Authorization = "Bearer $secret"
              } `
              -ContentType "application/json" `
              -Body $body

          $lastError = $null
          break
        }
        catch {
          $lastError = $_

          if ($attempt -lt $MaxAttempts) {
            $rateLimitDelay =
              Get-RateLimitRetrySeconds `
                $_ `
                $attempt

            $waitSeconds =
              if ($rateLimitDelay -gt 0) {
                $rateLimitDelay
              }
              else {
                [math]::Min(
                  300,
                  $RetryDelaySeconds *
                    [math]::Pow(
                      2,
                      $attempt - 1
                    )
                )
              }

            $reason =
              if ($rateLimitDelay -gt 0) {
                "HermAI rate limit"
              }
              else {
                "request failure"
              }

            Write-Host (
              (
                "  {0}; keeping offset {1} and " +
                "retrying in {2} seconds."
              ) -f
                $reason,
                $requestOffset,
                [int]$waitSeconds
            ) -ForegroundColor Yellow

            Start-Sleep `
              -Seconds ([int]$waitSeconds)
          }
        }
      }

      if ($null -ne $lastError) {
        throw $lastError
      }

      $database =
        Get-OptionalValue $result "database"
      $fetched =
        Get-OptionalValue $result "fetched"
      $hermai =
        Get-OptionalValue $result "hermai"
      $pagination =
        Get-OptionalValue $hermai "pagination"

      $inserted =
        Convert-ToInteger (
          Get-OptionalValue $database "inserted" 0
        )
      $failed =
        Convert-ToInteger (
          Get-OptionalValue $database "failed" 0
        )

      if ($inserted -ne 0) {
        throw (
          "Safety stop: repair mode inserted " +
          "$inserted unexpected cards."
        )
      }

      if ($failed -ne 0) {
        throw (
          "Safety stop: repair mode reported " +
          "$failed failed cards."
        )
      }

      $filings =
        Convert-ToInteger (
          Get-OptionalValue $fetched "filings" 0
        )
      $groupedTrades =
        Convert-ToInteger (
          Get-OptionalValue $fetched "groupedTrades" 0
        )
      $refreshed =
        Convert-ToInteger (
          Get-OptionalValue $database "refreshed" 0
        )
      $consolidated =
        Convert-ToInteger (
          Get-OptionalValue $database "consolidated" 0
        )
      $legacyCardsRemoved =
        Convert-ToInteger (
          Get-OptionalValue `
            $database `
            "consolidatedLegacyCards" `
            0
        )
      $preservedVotes =
        Convert-ToInteger (
          Get-OptionalValue $database "preservedVotes" 0
        )
      $skippedUnmatched =
        Convert-ToInteger (
          Get-OptionalValue `
            $database `
            "refreshSkippedUnmatched" `
            0
        )

      $hasMore =
        [bool](
          Get-OptionalValue $pagination "has_more" $false
        )

      $nextOffset =
        Convert-ToInteger (
          Get-OptionalValue `
            $pagination `
            "next_offset" `
            (
              $requestOffset +
              ($Limit * $PagesPerRequest)
            )
        )

      if (
        $hasMore -and
        $nextOffset -le $requestOffset
      ) {
        throw (
          "Pagination did not advance beyond " +
          "offset $requestOffset."
        )
      }

      $totalBatches += 1
      $totalFilings += $filings
      $totalGroupedTrades += $groupedTrades
      $totalRefreshed += $refreshed
      $totalConsolidated += $consolidated
      $totalLegacyCardsRemoved += $legacyCardsRemoved
      $totalPreservedVotes += $preservedVotes
      $totalSkippedUnmatched += $skippedUnmatched

      [pscustomobject]@{
        WindowStart =
          $currentWindowStart.ToString("yyyy-MM-dd")
        WindowEnd =
          $currentWindowEnd.ToString("yyyy-MM-dd")
        Offset = $requestOffset
        NextOffset = $nextOffset
        HasMore = $hasMore
        Filings = $filings
        GroupedTrades = $groupedTrades
        Inserted = $inserted
        Refreshed = $refreshed
        Consolidated = $consolidated
        LegacyCardsRemoved = $legacyCardsRemoved
        PreservedVotes = $preservedVotes
        SkippedUnmatched = $skippedUnmatched
        Failed = $failed
        CompletedAt = (Get-Date).ToString("o")
      } |
        Export-Csv `
          -LiteralPath $resultsPath `
          -NoTypeInformation `
          -Append

      Write-Host (
        (
          "  Refreshed {0}; consolidated {1}; " +
          "removed {2}; preserved votes {3}; " +
          "skipped unmatched {4}."
        ) -f
          $refreshed,
          $consolidated,
          $legacyCardsRemoved,
          $preservedVotes,
          $skippedUnmatched
      ) -ForegroundColor Green

      $currentOffset = $nextOffset

      if (
        $hasMore -and
        $BatchDelaySeconds -gt 0
      ) {
        Write-Host (
          "  Pacing next batch for {0} seconds." -f
            $BatchDelaySeconds
        ) -ForegroundColor DarkGray

        Start-Sleep `
          -Seconds $BatchDelaySeconds
      }
    }

    Write-Host (
      "Completed window: {0} through {1}" -f
        $currentWindowStart.ToString("yyyy-MM-dd"),
        $currentWindowEnd.ToString("yyyy-MM-dd")
    ) -ForegroundColor Green

    Write-Host ""

    $currentWindowEnd =
      $currentWindowStart.AddDays(-1)
    $firstWindow = $false
    $currentOffset = 0
  }

  Write-Host (
    "EXISTING CARD REPAIR COMPLETED SUCCESSFULLY"
  ) -ForegroundColor Green

  Write-Host "Batches: $totalBatches"
  Write-Host "Filings scanned: $totalFilings"
  Write-Host "Grouped trades: $totalGroupedTrades"
  Write-Host "Cards refreshed: $totalRefreshed"
  Write-Host "Filings consolidated: $totalConsolidated"
  Write-Host "Legacy cards removed: $totalLegacyCardsRemoved"
  Write-Host "Preserved votes: $totalPreservedVotes"
  Write-Host "Unmatched filings skipped: $totalSkippedUnmatched"
  Write-Host "Results: $resultsPath"
}
catch {
  Write-Host ""
  Write-Host (
    "EXISTING CARD REPAIR STOPPED"
  ) -ForegroundColor Red

  Write-Host (
    "Window: {0} through {1}" -f
      $currentWindowStart.ToString("yyyy-MM-dd"),
      $currentWindowEnd.ToString("yyyy-MM-dd")
  )

  Write-Host "Resume offset: $currentOffset"
  Write-Host (
    "Reason: {0}" -f $_.Exception.Message
  ) -ForegroundColor Red

  Write-Host ""
  Write-Host "Resume with:"
  Write-Host (
    (
      ".\scripts\refresh-existing-six-months.ps1 " +
      '-StartDate "{0}" -EndDate "{1}" -StartOffset {2}'
    ) -f
      $StartDate.ToString("yyyy-MM-dd"),
      $currentWindowEnd.ToString("yyyy-MM-dd"),
      $currentOffset
  )

  throw
}
