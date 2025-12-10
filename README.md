# Lettarrboxd

**Automated Media Sync: Letterboxd → Radarr & Serializd → Sonarr**

> **Note**: This is a significantly enhanced fork of the original [ryanpage/lettarrboxd](https://github.com/ryanpage/lettarrboxd) project. It features a complete rewrite of the core logic to support multiple lists, filtering, list scheduling, Plex integration, and a high-performance Bun runtime.

---

## 🚀 Features

*   **Dual-Service Sync**:
    *   **Movies**: Syncs Letterboxd Watchlists, Lists, Filmographies, and Collections directly to **Radarr**.
    *   **TV Shows**: Syncs Serializd Watchlists and User Lists directly to **Sonarr**.
*   **Smart Automation**:
    *   **Multiple Lists**: Monitor unlimited lists from varying sources simultaneously.
    *   **Granular Control**: Override Quality Profiles, Root Folders, and Tags on a *per-list* basis (e.g., "4K" for specific lists, "1080p" for others).
    *   **Filtering**: Filter source lists by Year, Rating, or Genre before syncing.
    *   **Scheduling**: Define `activeFrom` and `activeUntil` dates for seasonal lists (e.g., automatically sync Horror lists only in October).
*   **Ecosystem Integration**:
    *   **Plex**: Automatically tag items in your Plex library to match their source lists.
    *   **Cleanup**: Optionally remove items from your media server when they are removed from the source list (`REMOVE_MISSING_ITEMS`).
*   **Performance**:
    *   Built on **Bun** for instant startup and low memory footprint.
    *   Includes a built-in Health Check server for Docker/Kubernetes readiness probes.

---

## 🛠️ Quick Start (Simple Mode)

For simple use cases (one Movie list + one TV list), you can configure everything via text environment variables.

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

## ⚡ Advanced Configuration (Recommended)

To unlock the full power of Lettarrboxd (multiple lists, filtering, overrides), use a `config.yaml` file.

1.  Download [config.example.yaml](config.example.yaml) and save it as `config.yaml`.
2.  Edit it with your desired lists and settings.
3.  Mount it into your container:

```yaml
services:
  lettarrboxd:
    image: ghcr.io/dawescc/lettarrboxd:latest
    container_name: lettarrboxd
    volumes:
      - ./config.yaml:/app/config.yaml
      - ./data:/app/data  # Persistent storage for state tracking
    environment:
      # You can still keep sensitive keys in ENV
      - RADARR_API_KEY=your_key
      - SONARR_API_KEY=your_key
    restart: unless-stopped
```

### What you can do with `config.yaml`:

```yaml
letterboxd:
  # 1. Standard Watchlist
  - url: https://letterboxd.com/user/watchlist/
    tags: [watchlist]

  # 2. Curated "Best 4K Horror" List
  - url: https://letterboxd.com/user/list/horror-masterpieces/
    # Override global quality to 4K
    qualityProfile: "Ultra HD" 
    tags: [horror, 4k]
    # Filter: Only sync high-rated movies
    filters:
      minRating: 3.5

  # 3. Seasonal List (Halloween)
  - url: https://letterboxd.com/user/list/all-hallows-eve/
    tags: [halloween]
    # Only active during October
    activeFrom: "10-01"
    activeUntil: "10-31"

serializd:
  - url: https://www.serializd.com/user/username/watchlist
    tags: [tv-watchlist]
```

---

## 📋 Supported Sources

### Letterboxd (Movies)
Lettarrboxd can scrape almost any type of list:
*   **Watchlist**: `.../username/watchlist/`
*   **Lists**: `.../username/list/list-name/`
*   **Filmography (Actor/Director/Writer)**: `.../director/christopher-nolan/`
*   **Collections**: `.../films/in/the-avengers-collection/`
*   **Popular**: `.../films/popular/`

### Serializd (TV Shows)
*   **Watchlist**: `.../user/username/watchlist`
*   **User Lists**: `.../user/username/lists/list-name`

---

## ⚙️ Configuration Reference

See [config.example.yaml](config.example.yaml) for the comprehensive list of all available options.

### Common Environment Variables
| Variable | Default | Description |
| :--- | :--- | :--- |
| `CHECK_INTERVAL_MINUTES` | `60` | Frequency of sync checks |
| `REMOVE_MISSING_ITEMS` | `false` | **CAUTION**: If true, items removed from your list will be deleted/unmonitored in Radarr/Sonarr |
| `DRY_RUN` | `false` | Log planned actions without executing them |

### Plex Integration (Optional)
Sync your tags to Plex to create smart collections easily.
| Variable | Description |
| :--- | :--- |
| `PLEX_URL` | e.g., `http://192.168.1.50:32400` |
| `PLEX_TOKEN` | Your Plex Auth Token |
| `PLEX_TAGS` | Comma-separated labels to apply (e.g. `lettarrboxd`) |

---

## 🐳 Docker Deployment

### Official Image
`ghcr.io/dawescc/lettarrboxd:latest`

### Health Check
The container exposes a health check endpoint on port `3000`.
*   `GET /health`: Returns `200 OK` if idle/syncing, `500` if the last sync job failed.

---

## 📝 License

This project is licensed under the MIT License - see the [LICENSE](LICENSE) file for details.

---

*Disclaimer: This project is intended for use with legally sourced media only. The developers are not responsible for any legal issues that may arise from the use of this project.*
