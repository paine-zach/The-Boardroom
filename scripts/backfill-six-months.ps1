param(
  [string]$BaseUrl =
    "https://www.theboardroom.dev",

  [datetime]$StartDate =
    [datetime]"2026-01-28",

  [datetime]$EndDate =
    [datetime]"2026-07-28",

  [ValidateRange(1, 100)]
  [int]$Limit = 25,

  [ValidateRange(0, 1000000)]
  [int]$StartOffset = 0,

  [ValidateRange(0, 100)]
  [int]$MaxAi = 30,

  [ValidateRange(1, 10)]
  [int]$MaxAttempts = 3,

  [ValidateRange(1, 300)]
  [int]$RetryDelaySeconds = 15
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$importUrl =
  "$BaseUrl/api/import-form4"

$offset =
  $StartOffset

$pageNumber = 0
$totalFilings = 0
$totalInserted = 0
$totalExisting = 0
$totalFailed = 0
$totalAiSummaries = 0
$totalFallbackSummaries = 0

$backfillSucceeded = $false

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
    $Object.PSObject.Properties[
      $PropertyName
    ]

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

try {
  if ($StartDate -gt $EndDate) {
    throw (
      "StartDate must be earlier than or equal " +
      "to EndDate."
    )
  }

  $clipboardValue =
    Get-Clipboard -Raw

  if (
    [string]::IsNullOrWhiteSpace(
      $clipboardValue
    )
  ) {
    throw (
      "The clipboard is empty. Copy the " +
      "production CRON_SECRET from Vercel " +
      "before running this script."
    )
  }

  $secret =
    $clipboardValue.Trim() `
      -replace "[`r`n]", ""

  if (
    [string]::IsNullOrWhiteSpace(
      $secret
    )
  ) {
    throw (
      "The CRON_SECRET could not be read " +
      "from the clipboard."
    )
  }

  $startDateText =
    $StartDate.ToString("yyyy-MM-dd")

  $endDateText =
    $EndDate.ToString("yyyy-MM-dd")

  Write-Host ""
  Write-Host (
    "The Boardroom — Six-Month Form 4 Backfill"
  ) -ForegroundColor Cyan

  Write-Host (
    "Date range: {0} through {1}" -f
      $startDateText,
      $endDateText
  )

  Write-Host (
    "Page size: $Limit"
  )

  Write-Host (
    "Starting offset: $offset"
  )

  Write-Host (
    "Maximum AI summaries per page: $MaxAi"
  )

  Write-Host ""

  while ($true) {
    $pageNumber++

    Write-Host (
      "----------------------------------------"
    )

    Write-Host (
      "Page $pageNumber — offset $offset"
    ) -ForegroundColor Cyan

    $body = @{
      role = "ceo"

      start_date =
        $startDateText

      end_date =
        $endDateText

      limit =
        $Limit

      offset =
        $offset

      # The PowerShell script controls pagination.
      max_pages =
        1

      # Generate summaries only for new cards.
      max_ai =
        $MaxAi

      # Store valid small transactions in Neon.
      min_value =
        0

      skip_zero_rows =
        $true
    } | ConvertTo-Json

    $result = $null
    $requestSucceeded = $false

    for (
      $attempt = 1;
      $attempt -le $MaxAttempts;
      $attempt++
    ) {
      try {
        Write-Host (
          "Request attempt $attempt of " +
          "$MaxAttempts..."
        )

        $result =
          Invoke-RestMethod `
            -Uri $importUrl `
            -Method Post `
            -Headers @{
              Authorization =
                "Bearer $secret"
            } `
            -ContentType `
              "application/json" `
            -Body $body `
            -TimeoutSec 300

        $requestSucceeded = $true
        break
      }
      catch {
        Write-Host (
          "Attempt $attempt failed."
        ) -ForegroundColor Yellow

        if (
          $_.ErrorDetails -and
          $_.ErrorDetails.Message
        ) {
          Write-Host (
            $_.ErrorDetails.Message
          ) -ForegroundColor DarkYellow
        }
        else {
          Write-Host (
            $_.Exception.Message
          ) -ForegroundColor DarkYellow
        }

        if ($attempt -lt $MaxAttempts) {
          $delay =
            $RetryDelaySeconds *
            $attempt

          Write-Host (
            "Waiting $delay seconds before retry..."
          )

          Start-Sleep `
            -Seconds $delay
        }
      }
    }

    if (-not $requestSucceeded) {
      throw (
        "The import failed after $MaxAttempts " +
        "attempts at offset $offset."
      )
    }

    $success =
      Get-OptionalValue `
        -Object $result `
        -PropertyName "success" `
        -DefaultValue $false

    if ($success -ne $true) {
      $serverError =
        Get-OptionalValue `
          -Object $result `
          -PropertyName "error" `
          -DefaultValue `
            "The server returned success=false."

      throw (
        "Import failed at offset ${offset}: " +
        "$serverError"
      )
    }

    $fetched =
      Get-OptionalValue `
        -Object $result `
        -PropertyName "fetched"

    $database =
      Get-OptionalValue `
        -Object $result `
        -PropertyName "database"

    $summaries =
      Get-OptionalValue `
        -Object $result `
        -PropertyName "summaries"

    $hermai =
      Get-OptionalValue `
        -Object $result `
        -PropertyName "hermai"

    $pagination =
      Get-OptionalValue `
        -Object $hermai `
        -PropertyName "pagination"

    if ($null -eq $pagination) {
      throw (
        "Pagination metadata was missing at " +
        "offset $offset."
      )
    }

    $pageFilings =
      Convert-ToInteger (
        Get-OptionalValue `
          -Object $fetched `
          -PropertyName "filings" `
          -DefaultValue 0
      )

    $pageInserted =
      Convert-ToInteger (
        Get-OptionalValue `
          -Object $database `
          -PropertyName "inserted" `
          -DefaultValue 0
      )

    $pageExisting =
      Convert-ToInteger (
        Get-OptionalValue `
          -Object $database `
          -PropertyName "alreadyExisting" `
          -DefaultValue 0
      )

    $pageFailed =
      Convert-ToInteger (
        Get-OptionalValue `
          -Object $database `
          -PropertyName "failed" `
          -DefaultValue 0
      )

    $pageAi =
      Convert-ToInteger (
        Get-OptionalValue `
          -Object $summaries `
          -PropertyName "ai" `
          -DefaultValue 0
      )

    $pageFallback =
      Convert-ToInteger (
        Get-OptionalValue `
          -Object $summaries `
          -PropertyName "fallback" `
          -DefaultValue 0
      )

    $totalFilings +=
      $pageFilings

    $totalInserted +=
      $pageInserted

    $totalExisting +=
      $pageExisting

    $totalFailed +=
      $pageFailed

    $totalAiSummaries +=
      $pageAi

    $totalFallbackSummaries +=
      $pageFallback

    Write-Host (
      "Filings returned: $pageFilings"
    )

    Write-Host (
      "Cards inserted: $pageInserted"
    ) -ForegroundColor Green

    Write-Host (
      "Cards already existing: $pageExisting"
    )

    Write-Host (
      "Database failures: $pageFailed"
    )

    Write-Host (
      "AI summaries: $pageAi"
    )

    Write-Host (
      "Fallback summaries: $pageFallback"
    )

    if ($pageFailed -gt 0) {
      throw (
        "The importer reported $pageFailed " +
        "database failure(s) at offset $offset."
      )
    }

    $hasMoreRaw =
      Get-OptionalValue `
        -Object $pagination `
        -PropertyName "has_more" `
        -DefaultValue $false

    $hasMore =
      [System.Convert]::ToBoolean(
        $hasMoreRaw
      )

    $nextOffsetRaw =
      Get-OptionalValue `
        -Object $pagination `
        -PropertyName "next_offset"

    if (-not $hasMore) {
      Write-Host ""
      Write-Host (
        "HermAI returned has_more=false."
      ) -ForegroundColor Green

      Write-Host (
        "All available pages were processed."
      ) -ForegroundColor Green

      $backfillSucceeded = $true
      break
    }

    if ($null -eq $nextOffsetRaw) {
      throw (
        "HermAI returned has_more=true but " +
        "did not return next_offset."
      )
    }

    $nextOffset =
      Convert-ToInteger `
        -Value $nextOffsetRaw `
        -DefaultValue -1

    if ($nextOffset -le $offset) {
      throw (
        "Pagination did not advance. " +
        "Current offset: $offset. " +
        "Next offset: $nextOffset."
      )
    }

    Write-Host (
      "Next offset: $nextOffset"
    )

    $offset =
      $nextOffset
  }
}
catch {
  Write-Host ""
  Write-Host (
    "BACKFILL STOPPED"
  ) -ForegroundColor Red

  Write-Host (
    $_.Exception.Message
  ) -ForegroundColor Red

  Write-Host ""
  Write-Host (
    "Resume from offset $offset after " +
    "correcting the problem:"
  ) -ForegroundColor Yellow

  Write-Host (
    ".\scripts\backfill-six-months.ps1 " +
    "-StartOffset $offset"
  ) -ForegroundColor Yellow

  exit 1
}
finally {
  Remove-Variable secret `
    -ErrorAction SilentlyContinue

  Remove-Variable clipboardValue `
    -ErrorAction SilentlyContinue

  Set-Clipboard -Value " "
}

if ($backfillSucceeded) {
  Write-Host ""
  Write-Host (
    "========================================"
  )

  Write-Host (
    "BACKFILL COMPLETED SUCCESSFULLY"
  ) -ForegroundColor Green

  Write-Host (
    "========================================"
  )

  Write-Host (
    "Pages processed: $pageNumber"
  )

  Write-Host (
    "Filings returned: $totalFilings"
  )

  Write-Host (
    "Cards inserted: $totalInserted"
  )

  Write-Host (
    "Cards already existing: $totalExisting"
  )

  Write-Host (
    "Database failures: $totalFailed"
  )

  Write-Host (
    "AI summaries: $totalAiSummaries"
  )

  Write-Host (
    "Fallback summaries: " +
    "$totalFallbackSummaries"
  )

  Write-Host (
    "Final offset: $offset"
  )

  Write-Host ""
}