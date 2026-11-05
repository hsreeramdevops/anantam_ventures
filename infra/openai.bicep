// Azure OpenAI used only as a fallback bill categoriser when keyword rules don't match.
// Pay-per-token (S0 has no fixed fee). Capacity is kept tiny (10K tokens/min) so spend stays at cents/month.
@description('A region where the model has GlobalStandard quota in this subscription.')
param location string = 'southindia'
param name string
param tags object = {}
@description('Cheapest non-reasoning chat model with quota in this subscription (gpt-4.1-nano / gpt-4o-mini have 0 quota).')
param modelName string = 'gpt-4.1-mini'
param modelVersion string = '2025-04-14'
@description('Thousands of tokens per minute.')
param capacity int = 10

resource openai 'Microsoft.CognitiveServices/accounts@2024-10-01' = {
  name: name
  location: location
  tags: tags
  kind: 'OpenAI'
  sku: { name: 'S0' }
  properties: { customSubDomainName: name, publicNetworkAccess: 'Enabled' }
}

resource deployment 'Microsoft.CognitiveServices/accounts/deployments@2024-10-01' = {
  parent: openai
  name: 'categorizer'
  sku: { name: 'GlobalStandard', capacity: capacity }
  properties: {
    model: { format: 'OpenAI', name: modelName, version: modelVersion }
    versionUpgradeOption: 'OnceNewDefaultVersionAvailable'
  }
}

output accountName string = openai.name
output endpoint string = openai.properties.endpoint
output deploymentName string = deployment.name
