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
  DRY_RUN: z.string().default('false').transform(val => val.toLowerCase() === 'true'),
  REMOVE_MISSING_ITEMS: z.string().default('false').transform(val => val.toLowerCase() === 'true'),
  DATA_DIR: z.string().default('./data'),
  PLEX_URL: z.string().url().optional(),
  PLEX_TOKEN: z.string().optional(),
  PLEX_TAGS: z.string().optional(),
  OVERRIDE_TAGS: z.string().default('false').transform(val => val.toLowerCase() === 'true'),
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

  // We typically require one source, BUT if the user is using config.yaml, 
  // these might be empty. `src/util/config.ts` will handle the final validation 
  // ensuring at least one list exists from *either* source.
  // So we remove the strict dependency here.

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
  message: "Invalid configuration. Ensure Radarr/Sonarr settings are correct if provided.",
  path: ["RADARR_API_URL"] // Generic path as we relaxed the specific check
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