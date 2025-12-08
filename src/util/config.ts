import { z } from 'zod';
import yaml from 'js-yaml';
import fs from 'fs';
import path from 'path';
import logger from './logger';
import env from './env';

// --- Zod Schemas ---

const FilterSchema = z.object({
  minRating: z.number().min(0).max(10).optional(),
  minYear: z.number().int().min(1800).optional(),
  maxYear: z.number().int().min(1800).optional(),
  genre: z.array(z.string()).optional(), // Future proofing
});

const LetterboxdListSchema = z.object({
  id: z.string().optional(), // For logging, e.g. "horror-list"
  url: z.string().url(),
  tags: z.array(z.string()).default([]),
  filters: FilterSchema.optional(),
  activeFrom: z.string().regex(/^\d{2}-\d{2}$/, "Format must be MM-DD").optional(),
  activeUntil: z.string().regex(/^\d{2}-\d{2}$/, "Format must be MM-DD").optional(),
  takeAmount: z.number().positive().optional(),
  takeStrategy: z.enum(['oldest', 'newest']).optional(),
});

const SerializdListSchema = z.object({
  id: z.string().optional(),
  url: z.string().url(),
  tags: z.array(z.string()).default([]),
  filters: FilterSchema.optional(),
  activeFrom: z.string().regex(/^\d{2}-\d{2}$/, "Format must be MM-DD").optional(),
  activeUntil: z.string().regex(/^\d{2}-\d{2}$/, "Format must be MM-DD").optional(),
});

const ConfigSchema = z.object({
  letterboxd: z.array(LetterboxdListSchema).default([]),
  serializd: z.array(SerializdListSchema).default([]),
  
  // Radarr override (optional, falls back to ENV)
  radarr: z.object({
    url: z.string().optional(),
    apiKey: z.string().optional(),
    qualityProfile: z.string().optional(),
    rootFolder: z.string().optional(),
    tags: z.array(z.string()).default([]) // Additional global tags
  }).optional(),

  // Sonarr override (optional, falls back to ENV)
  sonarr: z.object({
    url: z.string().optional(),
    apiKey: z.string().optional(),
    qualityProfile: z.string().optional(),
    rootFolder: z.string().optional(),
    tags: z.array(z.string()).default([]),
    seasonMonitoring: z.enum(['all', 'first', 'latest', 'future', 'none']).optional()
  }).optional(),
  
  dryRun: z.boolean().default(false),
});

export type Config = z.infer<typeof ConfigSchema>;
export type LetterboxdList = z.infer<typeof LetterboxdListSchema>;
export type SerializdList = z.infer<typeof SerializdListSchema>;

// --- Loader Logic ---

function loadConfig(): Config {
  const configPath = path.resolve(process.cwd(), 'config', 'config.yaml');
  const fallbackPath = path.resolve(process.cwd(), 'config.yaml'); // Support root config.yaml too
  
  let loadedConfig: any = {};
  
  // Try loading YAML
  if (fs.existsSync(configPath)) {
    logger.info(`Loading configuration from ${configPath}`);
    try {
      const fileContents = fs.readFileSync(configPath, 'utf8');
      loadedConfig = yaml.load(fileContents);
    } catch (e: any) {
      logger.error(`Failed to parse config.yaml: ${e.message}`);
      process.exit(1);
    }
  } else if (fs.existsSync(fallbackPath)) {
    logger.info(`Loading configuration from ${fallbackPath}`);
    try {
      const fileContents = fs.readFileSync(fallbackPath, 'utf8');
      loadedConfig = yaml.load(fileContents);
    } catch (e: any) {
      logger.error(`Failed to parse config.yaml: ${e.message}`);
      process.exit(1);
    }
  } else {
    logger.info('No config.yaml found. Using Environment Variables only.');
  }

  // Parse with Zod (partial validation)
  const result = ConfigSchema.safeParse(loadedConfig);
  if (!result.success) {
    logger.error('Configuration validation failed:');
    result.error.issues.forEach(err => {
      logger.error(`- ${err.path.join('.')}: ${err.message}`);
    });
    process.exit(1);
  }

  const config = result.data;

  // --- Hybrid Merge: Inject ENV vars if config lists are empty ---

  // Legal fallback: If NO Letterboxd lists in config, use ENV
  if (config.letterboxd.length === 0 && env.LETTERBOXD_URL) {
    config.letterboxd.push({
      id: 'env-letterboxd',
      url: env.LETTERBOXD_URL,
      // If legacy user set take amount via env
      takeAmount: env.LETTERBOXD_TAKE_AMOUNT,
      takeStrategy: env.LETTERBOXD_TAKE_STRATEGY,
      tags: [] 
    });
  }

  // Legal fallback: If NO Serializd lists in config, use ENV
  if (config.serializd.length === 0 && env.SERIALIZD_URL) {
    config.serializd.push({
      id: 'env-serializd',
      url: env.SERIALIZD_URL,
      tags: []
    });
  }

  // Set dryRun from ENV if not in config
  if (env.DRY_RUN) {
    config.dryRun = true;
  }

  return config;
}

const config = loadConfig();
export default config;
