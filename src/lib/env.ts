import {
  resolveTextApiKeys,
  resolveTextFallbackApiKeys,
  resolveTextTertiaryApiKeys,
} from './text-api-pool'

function required(name: string): string {
  const value = process.env[name]
  if (!value || !value.trim()) {
    throw new Error(`${name} is required`)
  }
  return value.trim()
}

function optional(name: string, fallback = ''): string {
  return (process.env[name] || fallback).trim()
}

function boundedInteger(name: string, fallback: number, maximum = 8): number {
  const parsed = Number(optional(name, String(fallback)))
  if (!Number.isFinite(parsed)) return fallback
  return Math.max(1, Math.min(maximum, Math.round(parsed)))
}

function configuredTextApiKeys() {
  const keys = resolveTextApiKeys()
  if (keys.length > 0) return keys
  return [required('VIDEO_API_KEY')]
}

function configuredTextFallbackApiKeys() {
  return resolveTextFallbackApiKeys()
}

export const env = {
  authSecret: () => required('AUTH_SECRET'),
  redisHost: () => optional('REDIS_HOST', 'localhost'),
  redisPort: () => Number(optional('REDIS_PORT', '6379')),
  redisPassword: () => optional('REDIS_PASSWORD'),
  s3Endpoint: () => required('S3_ENDPOINT'),
  s3Region: () => optional('S3_REGION', 'us-east-1'),
  s3Bucket: () => required('S3_BUCKET'),
  s3AccessKeyId: () => required('S3_ACCESS_KEY_ID'),
  s3SecretAccessKey: () => required('S3_SECRET_ACCESS_KEY'),
  s3ForcePathStyle: () => optional('S3_FORCE_PATH_STYLE', 'true') !== 'false',
  openAICompatBaseUrl: () => required('OPENAI_COMPAT_BASE_URL').replace(/\/+$/, ''),
  openAICompatApiKey: () => required('OPENAI_COMPAT_API_KEY'),
  imageModel: () => optional('IMAGE_MODEL', 'gpt-image-2'),
  imageApiMode: () => optional('OPENAI_COMPAT_IMAGE_MODE', 'images'),
  imageQuality: () => optional('IMAGE_QUALITY', 'low'),
  imageSize: () => optional('IMAGE_SIZE', '1024x1024'),
  imageOutputFormat: () => optional('IMAGE_OUTPUT_FORMAT', 'jpeg'),
  imageOutputCompression: () => Number(optional('IMAGE_OUTPUT_COMPRESSION', '75')),
  imagePartialImages: () => Number(optional('IMAGE_PARTIAL_IMAGES', '3')),
  imageStream: () => optional('IMAGE_STREAM', 'true') !== 'false',
  imageAsync: () => optional('IMAGE_ASYNC', 'true') !== 'false',
  imageProviderTimeoutRetries: () => boundedInteger('IMAGE_PROVIDER_TIMEOUT_RETRIES', 2, 5),
  textApiBaseUrl: () => optional('TEXT_API_BASE_URL', required('VIDEO_API_BASE_URL')).replace(/\/+$/, ''),
  textApiKeys: configuredTextApiKeys,
  textApiKey: () => configuredTextApiKeys()[0],
  textApiMode: () => optional('TEXT_API_MODE', 'auto'),
  textModel: () => optional('TEXT_MODEL', 'gpt-5.6-sol'),
  textReasoningEffort: () => optional('TEXT_REASONING_EFFORT'),
  textPrimaryOnly: () => optional('TEXT_PRIMARY_ONLY', 'false') === 'true',
  textFallbackApiBaseUrl: () => optional('TEXT_FALLBACK_API_BASE_URL').replace(/\/+$/, ''),
  textFallbackApiKeys: configuredTextFallbackApiKeys,
  textFallbackApiKey: () => configuredTextFallbackApiKeys()[0] || '',
  textFallbackApiMode: () => optional('TEXT_FALLBACK_API_MODE', 'responses'),
  textFallbackModel: () => optional('TEXT_FALLBACK_MODEL', 'gpt-5.6-sol'),
  textFallbackReasoningEffort: () => optional('TEXT_FALLBACK_REASONING_EFFORT'),
  textTertiaryApiBaseUrl: () => optional('TEXT_TERTIARY_API_BASE_URL').replace(/\/+$/, ''),
  textTertiaryApiKeys: () => resolveTextTertiaryApiKeys(),
  textTertiaryApiKey: () => resolveTextTertiaryApiKeys()[0] || '',
  textTertiaryApiMode: () => optional('TEXT_TERTIARY_API_MODE', 'responses'),
  textTertiaryModel: () => optional('TEXT_TERTIARY_MODEL', 'gpt-5.6-sol'),
  textTertiaryReasoningEffort: () => optional('TEXT_TERTIARY_REASONING_EFFORT'),
  textPrimaryConcurrencyPerKey: () => boundedInteger('TEXT_PRIMARY_CONCURRENCY_PER_KEY', 1, 10),
  textAnalysisConcurrency: () => boundedInteger('TEXT_ANALYSIS_CONCURRENCY', 3, 6),
  textEpisodeConcurrency: () => boundedInteger('TEXT_EPISODE_CONCURRENCY', 3, 6),
  textAssetConcurrency: () => boundedInteger('TEXT_ASSET_CONCURRENCY', 4, 8),
  textStoryboardConcurrency: () => boundedInteger('TEXT_STORYBOARD_CONCURRENCY', 2, 10),
  textStoryboardSegmentConcurrency: () => boundedInteger('TEXT_STORYBOARD_SEGMENT_CONCURRENCY', 3, 4),
  videoApiBaseUrl: () => required('VIDEO_API_BASE_URL').replace(/\/+$/, ''),
  videoDirectApiBaseUrl: () => optional('VIDEO_DIRECT_API_BASE_URL', required('VIDEO_API_BASE_URL')).replace(/\/+$/, ''),
  videoApiKey: () => required('VIDEO_API_KEY'),
  videoApiMode: () => optional('VIDEO_API_MODE', 'auto'),
  videoModel: () => optional('VIDEO_MODEL'),
  videoSeconds: () => Number(optional('VIDEO_SECONDS', '8')),
  videoSize: () => optional('VIDEO_SIZE', '1280x720'),
  grokVideoApiBaseUrl: () => required('GROK_VIDEO_API_BASE_URL').replace(/\/+$/, ''),
  grokVideoApiKey: () => required('GROK_VIDEO_API_KEY'),
  grokVideoApiMode: () => optional('GROK_VIDEO_API_MODE', 'auto'),
  grokVideoModel: () => optional('GROK_VIDEO_MODEL', 'grok-imagine-video'),
}
