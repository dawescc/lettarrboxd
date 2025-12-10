# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Lettarrboxd is a TypeScript Bun application that automatically syncs Letterboxd lists/watchlists to Radarr and Serializd public lists/watchlists to Sonarr. It continuously monitors user lists for new additions and automatically adds them to the respective media managers.

## Commands

### Development
- `bun install` - Install dependencies
- `bun start` - Run the application
- `bun run start:dev` - Run with auto-reload
- `bun run typecheck` - Type check (tsc)
- `bun run test` - Run tests (Jest)

### Docker
- `docker build -t lettarrboxd .` - Build Docker image
- `docker run -d --env-file .env -v ./data:/app/data dawescc/lettarrboxd:latest` - Run container

## Environment Configuration

The application uses Zod for strict environment variable validation in `src/env.ts`. All environment variables are validated at startup and the application will exit with detailed error messages if validation fails.

Required variables:
- `LETTERBOXD_URL` - Letterboxd list URL
- `RADARR_API_URL` - Base URL of Radarr instance  
- `RADARR_API_KEY` - Radarr API key
- `RADARR_QUALITY_PROFILE` - Quality profile name (case-sensitive)
- `SERIALIZD_URL` - Serializd watchlist URL
- `SONARR_API_URL` - Base URL of Sonarr instance
- `SONARR_API_KEY` - Sonarr API key
- `SONARR_QUALITY_PROFILE` - Quality profile name
- `SONARR_ROOT_FOLDER_PATH` - Root folder path for series

Key validation rules:
- `CHECK_INTERVAL_MINUTES` enforces minimum 10 minutes
- Environment variables are transformed and validated using Zod schemas
- The app exits early with clear error messages for invalid configuration

## Architecture Overview

### Core Application Flow
The application follows a scheduled monitoring pattern:
1. **Scheduler** (`startScheduledMonitoring`) runs `processWatchlist()` at configured intervals
2. **Stateless Sync** - Fetches all items from source and destination to determine what needs adding/removing
3. **Rate Limiting** - Built-in delays between API calls to respect external services

### Module Separation
- **`src/index.ts`** - Main orchestration, scheduling, and file I/O operations
- **`src/scraper/index.ts`** - Scraper factory and routing logic
- **`src/scraper/serializd.ts`** - Serializd API client
- **`src/api/radarr.ts`** - Radarr API integration
- **`src/api/sonarr.ts`** - Sonarr API integration
- **`src/util/env.ts`** - Environment validation and configuration management

### Key Architectural Patterns

**Error Handling**: Each module handles errors gracefully without crashing the scheduler. Network failures and API errors are logged but don't stop the monitoring process.

**Radarr Integration**: Movies are added with:
- Specified quality profile from environment
- "letterboxd-watchlist" tag for organization
- Automatic monitoring and search enabled
- Configurable minimum availability settings
- Optional cleanup of items removed from watchlist (via `REMOVE_MISSING_ITEMS`)

**Sonarr Integration**: Series are added with:
- Specified quality profile and root folder
- "serializd-watchlist" tag
- Season monitoring strategy (all, first, latest, future, none)
- Automatic search for missing episodes

### Web Scraping Strategy
Letterboxd scraping is implemented with:
- **Multi-page support** - Automatically handles paginated watchlists
- **TMDB ID extraction** - Visits individual movie pages to extract TMDB identifiers
- **Rate limiting** - 1 second delays between page requests, 500ms between TMDB extractions
- **Graceful pagination** - Detects end of pages using CSS selectors

### Function Organization
The codebase is organized into small, focused functions:
- `processWatchlist()` - High-level orchestration (19 lines)
- `addMovieToRadarr(movie)` - Individual movie processing
- `processNewMovies(movies)` - Batch processing with delays
- `getAllWatchlistUrls()` - Pagination handling
- `getTmdbIdFromMoviePage(url)` - TMDB ID extraction

## Development Notes

### TypeScript Configuration
- Strict mode enabled with comprehensive type checking
- Uses Bun for direct TypeScript execution
- All environment variables are strictly typed through Zod inference

### Docker Multi-Stage Build
The Dockerfile uses a production-optimized approach:
- Alpine Linux base for minimal size
- Non-root user for security
- Health checks included
- Multi-architecture support (AMD64/ARM64)

### Rate Limiting Implementation
Built-in delays prevent overwhelming external services:
- 1000ms between Letterboxd page requests
- 1000ms between Radarr API calls  
- 500ms between TMDB ID extractions

### Error Recovery
The application is designed to handle transient failures:
- Individual movie processing failures don't stop the batch
- Network timeouts are caught and logged
- Scheduler continues running even if individual checks fail