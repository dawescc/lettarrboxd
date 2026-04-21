import logger from './logger';

/**
 * Resolves the quality profile ID to use for a given *arr service.
 * If a profile name is configured, it must exist — throws otherwise.
 * If nothing is configured, attempts to discover the instance default.
 */
export function resolveDefaultProfileId(
    serviceName: 'Radarr' | 'Sonarr',
    profiles: any[],
    configuredProfileName: string | undefined,
    profileMap: Map<string, number>
): number {
    if (configuredProfileName) {
        const explicit = profileMap.get(configuredProfileName);
        if (!explicit) {
            throw new Error(`${serviceName} quality profile not found: ${configuredProfileName}`);
        }
        return explicit;
    }

    const discovered = profiles.find((p: any) =>
        p?.isDefault === true ||
        p?.default === true ||
        p?.isSelected === true ||
        p?.selected === true
    );

    if (discovered?.id) {
        logger.info(`Using ${serviceName} instance default quality profile: ${discovered.name ?? discovered.id}`);
        return discovered.id;
    }

    throw new Error(
        `${serviceName} quality profile is not configured and no instance default could be discovered. ` +
        `Set ${serviceName.toUpperCase()}_QUALITY_PROFILE or config.${serviceName.toLowerCase()}.qualityProfile.`
    );
}
