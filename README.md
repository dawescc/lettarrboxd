# Lettarrboxd

**Passively sync items from Letterboxd/Serializd to Radarr/Sonarr.**

![License](https://img.shields.io/badge/license-MIT-green)
![Docker Image Version](https://forgejo.dawes.cc/ryan/lettarrboxd/badges/release.svg)
![Issues](https://forgejo.dawes.cc/ryan/lettarrboxd/badges/issues.svg)

---

## Quick Start

### Docker Compose

```yaml
services:
    lettarrboxd:
        image: forgejo.dawes.cc/ryan/lettarrboxd:latest
        container_name: lettarrboxd
        env_file: .env
        user: "1000:1000"
        volumes:
            - ./data:/data
```

Place `config.yaml` and the SQLite cache in `./data/` (both paths are the default):

```sh
mkdir -p data
cp compose/.env.example .env
cp compose/config.example.yaml data/config.yaml
# Edit .env with your Radarr/Sonarr credentials
docker compose up -d
```

The SQLite cache is created automatically at `./data/lettarrboxd.db` on first run.

---

## Configuration

### config.yaml

Key each entry by the full source URL. Domain determines whether it's a movie (Letterboxd) or series (Serializd).

```yaml
https://letterboxd.com/username/watchlist/:

https://letterboxd.com/username/list/my-list/:
    profile: HD-1080p
    root_folder: /movies
    tags: list-tag, another-tag

https://serializd.com/user/username/watchlist:

https://serializd.com/user/username/lists/my-list-slug:
    profile: FHD-4K
    root_folder: /tv
    tags: list-tag

https://serializd.com/list/My-Public-List-123:
    profile: Any
```

> **Note:** `profile`, `root_folder`, and `tags` are applied only when adding a new item to Radarr/Sonarr. Items that already exist in your library are not updated to reflect later config changes.

### Environment Variables

| Variable             | Default                | Description                                                                                                                                                                                                                                           |
| :------------------- | :--------------------- | :---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `SYNC_INTERVAL`      | `60`                   | Sync interval in minutes                                                                                                                                                                                                                              |
| `FETCH_TIMEOUT`      | `30`                   | Per-request timeout in seconds (minimum enforced: 5)                                                                                                                                                                                                  |
| `DELETE_ORPHANS`     | `false`                | **CAUTION**: If true, items removed from your list will be deleted.                                                                                                                                                                                   |
| `DRY_RUN`            | `false`                | Log planned actions without executing them                                                                                                                                                                                                            |
| `LOG_LEVEL`          | `warn`                 | `debug`, `info`, `warn`, `error`                                                                                                                                                                                                                      |
| `RADARR_URL`         | -                      | Radarr instance base URL                                                                                                                                                                                                                              |
| `RADARR_TOKEN`       | -                      | Radarr API key                                                                                                                                                                                                                                        |
| `SONARR_URL`         | -                      | Sonarr instance base URL                                                                                                                                                                                                                              |
| `SONARR_TOKEN`       | -                      | Sonarr API key                                                                                                                                                                                                                                        |
| `QUAL_PROF_MOVIES`   | -                      | Default quality profile for movies                                                                                                                                                                                                                    |
| `QUAL_PROF_SERIES`   | -                      | Default quality profile for series                                                                                                                                                                                                                    |
| `RADARR_ROOT_FOLDER` | -                      | Default root folder for movies                                                                                                                                                                                                                        |
| `SONARR_ROOT_FOLDER` | -                      | Default root folder for series                                                                                                                                                                                                                        |
| `MASTER_TAG`         | -                      | Tag applied to items when added. Used to identify managed items for orphan detection. Items already in your library before the tag was configured will not be tagged automatically. Orphan cleanup only applies to items that already carry this tag. |
| `CONFIG_PATH`        | `/data/config.yaml`    | Path to config file                                                                                                                                                                                                                                   |
| `DB_PATH`            | `/data/lettarrboxd.db` | Path to SQLite cache                                                                                                                                                                                                                                  |

---

## Release Channels

I publish multi-arch images to Forgejo:

- `latest`: Stable releases from the `main` branch.
- `beta`: Testing candidates from the `beta` branch.
- `nightly`: Bleeding edge builds from the `dev` branch.
- `vX.Y.Z`: Specific version tags.
