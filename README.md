# Lettarrboxd / Serializd Sync

**Automated Media Sync for Radarr & Sonarr**

![License](https://img.shields.io/github/license/dawescc/lettarrboxd)
![Docker Image Version (latest by date)](https://img.shields.io/github/v/release/dawescc/lettarrboxd)

Lettarrboxd is a high-performance sync tool built on **Bun** that automatically populates your Radarr and Sonarr instances from external lists.

> **Note**: This project is a complete rewrite of the original [ryanpage/lettarrboxd](https://github.com/ryanpage/lettarrboxd), designed for advanced scheduling, multiple list support, and direct Plex integration.

---

## Features

### for Movies (Letterboxd → Radarr)
*   **Universal Support**: Scrape **Watchlists**, **User Lists**, **Filmographies** (Actor/Director/Writer), **Collections**, and **Popular** lists.
*   **Granular Control**: Override **Quality Profiles** and **Tags** on a per-list basis.
*   **Smart Filtering**: Filter source lists by **Year** or **Rating** (e.g., "Only sync movies rated 7.0+ released after 1990").
*   **Scheduling**: Activate specific lists only during certain dates (e.g., automatically sync a "Horror" list only in October).

### for TV Shows (Serializd → Sonarr)
*   **Watchlists & User Lists**: Automatic sync from [Serializd](https://www.serializd.com).
*   **Season Awareness**: Intelligently maps seasons from Serializd to Sonarr monitoring.

### Core Ecosystem
*   **Plex Integration**: Automatically tag items in your Plex library for easy smart collections.
*   **Library Cleanup**: Optional `REMOVE_MISSING_ITEMS` mode to keep your library in sync with your lists (deletes/unmonitors items removed from the source).
*   **Performance**: Built on the Bun runtime for instant startup and minimal resource usage.
*   **Health Checks**: Built-in HTTP server for Docker health probes.

---

## Quick Start

### Docker Compose (Recommended)

To unlock the full power of Lettarrboxd (multiple lists, filtering, overrides), use a `config.yaml` file.

1.  Download [compose/config.example.yaml](compose/config.example.yaml) and save it as `config.yaml`.
2.  Edit it with your desired lists and settings.
3.  Deploy using the [compose/docker-compose.yml](compose/docker-compose.yml) file:

```yaml
services:
  lettarrboxd:
    image: ghcr.io/dawescc/lettarrboxd:latest
    container_name: lettarrboxd
    volumes:
      - ./config.yaml:/app/config.yaml
      - ./data:/app/data  # Persistent cache
    environment:
      - RADARR_API_KEY=your_radarr_key
      - SONARR_API_KEY=your_sonarr_key
      - PLEX_TOKEN=your_plex_token # Optional
    restart: unless-stopped
```

### Simple Mode (Env Vars Only)

For a single-list setup, you can skip the config file:

```bash
docker run -d \
  --name lettarrboxd \
  -e LETTERBOXD_URL=https://letterboxd.com/yourname/watchlist/ \
  -e RADARR_API_URL=http://radarr:7878 \
  -e RADARR_API_KEY=your_key \
  -e RADARR_QUALITY_PROFILE="HD-1080p" \
  -e SERIALIZD_URL=https://www.serializd.com/user/yourname/watchlist \
  -e SONARR_API_URL=http://sonarr:8989 \
  -e SONARR_API_KEY=your_key \
  -e SONARR_QUALITY_PROFILE="HD-1080p" \
  -e SONARR_ROOT_FOLDER_PATH="/tv" \
  ghcr.io/dawescc/lettarrboxd:latest
```

---

## Configuration

### `config.yaml` Reference

See [compose/config.example.yaml](compose/config.example.yaml) for a comprehensive, commented example of all available options, including:
* Multiple Lists
* Metric Filtering (Year, Rating)
* Date-based Scheduling
* Per-list Overrides (Quality Profile, Tags)

### Environment Variables

| Variable | Default | Description |
| :--- | :--- | :--- |
| `CHECK_INTERVAL_MINUTES` | `60` | Frequency of sync checks |
| `REMOVE_MISSING_ITEMS` | `false` | **CAUTION**: If true, items removed from your source list will be deleted/unmonitored in Radarr/Sonarr |
| `DRY_RUN` | `false` | Log planned actions without executing them |
| `LOG_LEVEL` | `info` | `debug`, `info`, `warn`, `error` |

---

## Release Channels

We publish multi-arch images (`linux/amd64`, `linux/arm64`) to GHCR:

*   `latest`: Stable releases from the `main` branch.
*   `beta`: Testing candidates from the `beta` branch.
*   `nightly`: Bleeding edge builds from the `dev` branch.
*   `vX.Y.Z`: Specific version tags.

---

## Contributing

Contributions are welcome! Please ensure all unexpected changes are covered by tests and run `bun run typecheck` before submitting a PR.
