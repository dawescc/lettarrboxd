import { z } from 'zod';

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  LOG_LEVEL: z.enum(['error', 'warn', 'info', 'debug']).default('info'),
  LETTERBOXD_URL: z.string().url().optional(),
  SERIALIZD_URL: z.string().url().optional(),
  RADARR_API_URL: z.string().optional(),
  RADARR_API_KEY: z.string().optional(),
  RADARR_QUALITY_PROFILE: z.string().optional(),
  RADARR_MINIMUM_AVAILABILITY: z.string().default('released'),
  RADARR_ROOT_FOLDER_ID: z.string().optional(),
  RADARR_TAGS: z.string().optional(),
  RADARR_ADD_UNMONITORED: z.string().default('false').transform(val => val.toLowerCase() === 'true'),
  SONARR_API_URL: z.string().optional(),
  SONARR_API_KEY: z.string().optional(),
  SONARR_QUALITY_PROFILE: z.string().optional(),
  SONARR_ROOT_FOLDER_PATH: z.string().optional(),
  SONARR_ROOT_FOLDER_ID: z.string().optional(),
  SONARR_TAGS: z.string().optional(),
  SONARR_ADD_UNMONITORED: z.string().default('false').transform(val => val.toLowerCase() === 'true'),
  SONARR_SEASON_MONITORING: z.enum(['all', 'first', 'latest', 'future', 'none']).default('all'),
  CHECK_INTERVAL_MINUTES: z.string().default('10').transform(Number).pipe(z.number().min(10)),
  LETTERBOXD_TAKE_AMOUNT: z.string().optional().transform(val => val ? Number(val) : undefined).pipe(z.number().positive().optional()),
  LETTERBOXD_TAKE_STRATEGY: z.enum(['oldest', 'newest']).optional(),
  DRY_RUN: z.string().default('false').transform(val => val.toLowerCase() === 'true')
}).refine(data => {
  // Validate Letterboxd/Radarr pairing
  if (data.LETTERBOXD_URL) {
    if (!data.RADARR_API_URL || !data.RADARR_API_KEY || !data.RADARR_QUALITY_PROFILE) {
      return false;
    }
  }

  // Validate Serializd/Sonarr pairing
  if (data.SERIALIZD_URL) {
    if (!data.SONARR_API_URL || !data.SONARR_API_KEY || !data.SONARR_QUALITY_PROFILE) {
      return false;
    }
  }

  // Must have at least one source
  if (!data.LETTERBOXD_URL && !data.SERIALIZD_URL) {
    return false;
  }

  const hasTakeAmount = data.LETTERBOXD_TAKE_AMOUNT !== undefined;
  const hasTakeStrategy = data.LETTERBOXD_TAKE_STRATEGY !== undefined;
  
  // If one is specified, both must be specified
  if (hasTakeAmount && !hasTakeStrategy) {
    return false;
  }
  
  if (hasTakeStrategy && !hasTakeAmount) {
    return false;
  }
  
  return true;
}, {
  message: "Invalid configuration. Ensure Letterboxd/Radarr or Serializd/Sonarr are correctly configured pairs.",
  path: ["LETTERBOXD_URL", "SERIALIZD_URL"]
});

export type Env = z.infer<typeof envSchema>;

function validateEnv(): Env {
  const result = envSchema.safeParse(process.env);
  
  if (!result.success) {
    console.error('Environment validation failed:');
    result.error.issues.forEach(error => {
      console.error(`- ${error.path.join('.')}: ${error.message}`);
    });
    process.exit(1);
  }
  
  return result.data;
}

const env = validateEnv();
export default env;