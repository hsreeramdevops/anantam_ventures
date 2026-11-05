// Subscription-wide monthly budget with email alerts. The Visual Studio subscription's own
// spending limit is the hard stop at the $150 credit; this warns far earlier.
targetScope = 'subscription'

param amount int = 20
param contactEmails array
@description('First day of the current month, e.g. 2026-11-01')
param startDate string

resource budget 'Microsoft.Consumption/budgets@2023-11-01' = {
  name: 'anantam-monthly-budget'
  properties: {
    category: 'Cost'
    amount: amount
    timeGrain: 'Monthly'
    timePeriod: { startDate: startDate }
    notifications: {
      actual50: { enabled: true, operator: 'GreaterThanOrEqualTo', threshold: 50, thresholdType: 'Actual', contactEmails: contactEmails }
      actual80: { enabled: true, operator: 'GreaterThanOrEqualTo', threshold: 80, thresholdType: 'Actual', contactEmails: contactEmails }
      actual100: { enabled: true, operator: 'GreaterThanOrEqualTo', threshold: 100, thresholdType: 'Actual', contactEmails: contactEmails }
      forecast100: { enabled: true, operator: 'GreaterThanOrEqualTo', threshold: 100, thresholdType: 'Forecasted', contactEmails: contactEmails }
    }
  }
}
