// Anantam Ventures — all resources on free / near-free tiers. See README "Cost" section.
targetScope = 'resourceGroup'

@description('Region for data, storage and AI.')
param location string = 'centralindia'
@description('Static Web Apps is only offered in a few regions; East Asia is closest to India.')
param swaLocation string = 'eastasia'
param prefix string = 'anantam'
@description('Email of the first admin; only this address can log in until users are added.')
param bootstrapAdminEmail string
@secure()
@minLength(32)
param jwtSecret string
@secure()
@minLength(16)
param jobKey string

var suffix = uniqueString(resourceGroup().id)
var tags = { app: 'anantam-ventures', costCap: 'free-tier' }

// ---------- Cosmos DB: free tier (1000 RU/s + 25 GB free), hard-capped so it can never bill RU overage ----------
resource cosmos 'Microsoft.DocumentDB/databaseAccounts@2024-11-15' = {
  name: '${prefix}-cosmos-${suffix}'
  location: location
  tags: tags
  kind: 'GlobalDocumentDB'
  properties: {
    databaseAccountOfferType: 'Standard'
    enableFreeTier: true
    capacity: { totalThroughputLimit: 1000 }
    consistencyPolicy: { defaultConsistencyLevel: 'Session' }
    locations: [ { locationName: location, failoverPriority: 0, isZoneRedundant: false } ]
    backupPolicy: { type: 'Periodic', periodicModeProperties: { backupIntervalInMinutes: 1440, backupRetentionIntervalInHours: 48, backupStorageRedundancy: 'Local' } }
    minimalTlsVersion: 'Tls12'
    publicNetworkAccess: 'Enabled'
  }
}

resource db 'Microsoft.DocumentDB/databaseAccounts/sqlDatabases@2024-11-15' = {
  parent: cosmos
  name: 'anantam'
  properties: {
    resource: { id: 'anantam' }
    options: { throughput: 400 } // shared by all containers; within the free 1000 RU/s
  }
}

resource container 'Microsoft.DocumentDB/databaseAccounts/sqlDatabases/containers@2024-11-15' = {
  parent: db
  name: 'entities'
  properties: {
    resource: {
      id: 'entities'
      partitionKey: { paths: [ '/type' ], kind: 'Hash' }
      defaultTtl: -1 // TTL on, but only docs with a `ttl` field (OTPs, audit) expire
    }
  }
}

// ---------- Blob storage for bills / photos / documents (private) ----------
resource storage 'Microsoft.Storage/storageAccounts@2023-05-01' = {
  name: take('${prefix}st${suffix}', 24)
  location: location
  tags: tags
  kind: 'StorageV2'
  sku: { name: 'Standard_LRS' }
  properties: {
    accessTier: 'Hot'
    allowBlobPublicAccess: false
    allowSharedKeyAccess: true
    minimumTlsVersion: 'TLS1_2'
    supportsHttpsTrafficOnly: true
  }
}

resource blobSvc 'Microsoft.Storage/storageAccounts/blobServices@2023-05-01' = {
  parent: storage
  name: 'default'
  properties: { deleteRetentionPolicy: { enabled: true, days: 7 } }
}

resource files 'Microsoft.Storage/storageAccounts/blobServices/containers@2023-05-01' = {
  parent: blobSvc
  name: 'files'
  properties: { publicAccess: 'None' }
}

// ---------- Document Intelligence F0 (free: 500 pages / month) ----------
resource docintel 'Microsoft.CognitiveServices/accounts@2024-10-01' = {
  name: '${prefix}-docintel-${suffix}'
  location: location
  tags: tags
  kind: 'FormRecognizer'
  sku: { name: 'F0' }
  properties: { customSubDomainName: '${prefix}-docintel-${suffix}', publicNetworkAccess: 'Enabled' }
}

// ---------- Azure OpenAI (pay-per-token, fallback bill categoriser; cents / month) ----------
module openai 'openai.bicep' = {
  name: 'openai'
  params: { name: '${prefix}-openai-${suffix}', tags: tags }
}

resource openaiAccount 'Microsoft.CognitiveServices/accounts@2024-10-01' existing = {
  name: '${prefix}-openai-${suffix}'
  dependsOn: [ openai ]
}

// ---------- Email OTP via Azure Communication Services (Azure-managed domain, ~$0.00025 / mail) ----------
resource emailSvc 'Microsoft.Communication/emailServices@2023-04-01' = {
  name: '${prefix}-email-${suffix}'
  location: 'global'
  tags: tags
  properties: { dataLocation: 'India' }
}

resource emailDomain 'Microsoft.Communication/emailServices/domains@2023-04-01' = {
  parent: emailSvc
  name: 'AzureManagedDomain'
  location: 'global'
  properties: { domainManagement: 'AzureManaged', userEngagementTracking: 'Disabled' }
}

resource acs 'Microsoft.Communication/communicationServices@2023-04-01' = {
  name: '${prefix}-acs-${suffix}'
  location: 'global'
  tags: tags
  properties: { dataLocation: 'India', linkedDomains: [ emailDomain.id ] }
}

// ---------- Static Web App (Free) hosts the React site + the Functions API ----------
resource swa 'Microsoft.Web/staticSites@2023-12-01' = {
  name: '${prefix}-web-${suffix}'
  location: swaLocation
  tags: tags
  sku: { name: 'Free', tier: 'Free' }
  properties: {}
}

resource swaSettings 'Microsoft.Web/staticSites/config@2023-12-01' = {
  parent: swa
  name: 'appsettings'
  properties: {
    COSMOS_ENDPOINT: cosmos.properties.documentEndpoint
    COSMOS_KEY: cosmos.listKeys().primaryMasterKey
    COSMOS_DATABASE: db.name
    COSMOS_CONTAINER: container.name
    STORAGE_CONNECTION_STRING: 'DefaultEndpointsProtocol=https;AccountName=${storage.name};AccountKey=${storage.listKeys().keys[0].value};EndpointSuffix=${environment().suffixes.storage}'
    STORAGE_CONTAINER: files.name
    DOCINTEL_ENDPOINT: docintel.properties.endpoint
    DOCINTEL_KEY: docintel.listKeys().key1
    AZURE_OPENAI_ENDPOINT: openai.outputs.endpoint
    AZURE_OPENAI_KEY: openaiAccount.listKeys().key1
    AZURE_OPENAI_DEPLOYMENT: openai.outputs.deploymentName
    ACS_CONNECTION_STRING: acs.listKeys().primaryConnectionString
    EMAIL_SENDER: 'DoNotReply@${emailDomain.properties.mailFromSenderDomain}'
    BOOTSTRAP_ADMIN_EMAIL: bootstrapAdminEmail
    JWT_SECRET: jwtSecret
    JOB_KEY: jobKey
  }
}

output siteUrl string = 'https://${swa.properties.defaultHostname}'
output staticWebAppName string = swa.name
