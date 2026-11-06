const env = (k: string) => (process.env[k] ?? '').trim();

/** Production = Cosmos configured. Without it the API runs in local file-backed dev mode. */
export const isProd = () => !!env('COSMOS_ENDPOINT');

export const config = {
  get cosmosEndpoint() { return env('COSMOS_ENDPOINT'); },
  get cosmosKey() { return env('COSMOS_KEY'); },
  get cosmosDatabase() { return env('COSMOS_DATABASE') || 'anantam'; },
  get cosmosContainer() { return env('COSMOS_CONTAINER') || 'entities'; },
  get storageConnection() { return env('STORAGE_CONNECTION_STRING'); },
  get storageContainer() { return env('STORAGE_CONTAINER') || 'files'; },
  get docIntelEndpoint() { return env('DOCINTEL_ENDPOINT').replace(/\/+$/, ''); },
  get docIntelKey() { return env('DOCINTEL_KEY'); },
  get openAiEndpoint() { return env('AZURE_OPENAI_ENDPOINT').replace(/\/+$/, ''); },
  get openAiKey() { return env('AZURE_OPENAI_KEY'); },
  get openAiDeployment() { return env('AZURE_OPENAI_DEPLOYMENT'); },
  get acsConnection() { return env('ACS_CONNECTION_STRING'); },
  get emailSender() { return env('EMAIL_SENDER'); },
  get bootstrapAdminEmail() { return env('BOOTSTRAP_ADMIN_EMAIL').toLowerCase(); },
  get jobKey() { return env('JOB_KEY'); },
  get telegramBotToken() { return env('TELEGRAM_BOT_TOKEN'); },
  get telegramWebhookSecret() { return env('TELEGRAM_WEBHOOK_SECRET'); },
  /** Public site URL used in notification links and the Telegram webhook address. */
  get publicUrl() { return (env('PUBLIC_URL') || 'https://www.anantamventures.com').replace(/\/+$/, ''); },
  get appName() { return env('APP_NAME') || 'Anantam Ventures'; },
  get cookieSecure() { return env('COOKIE_SECURE') !== 'false'; },
  get dataDir() { return env('LOCAL_DATA_DIR') || '.data'; },
  get jwtSecret(): string {
    const s = env('JWT_SECRET');
    if (s.length >= 32) return s;
    if (isProd()) throw new Error('JWT_SECRET must be set (>= 32 chars) in production');
    return 'local-dev-only-insecure-secret-0123456789abcdef';
  },
};

export const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;
export const ALLOWED_UPLOAD_TYPES = ['application/pdf', 'image/jpeg', 'image/png', 'image/webp'];
