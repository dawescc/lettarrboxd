import logger from './logger';

export interface TagClient {
    getAllTags: () => Promise<{ id: number; label: string }[]>;
    createTag: (label: string) => Promise<number | null>;
}

export interface TagResolutionResult {
    tagMap: Map<string, number>;
    managedTagIds: Set<number>;
    systemTagIds: number[];
    defaultTagId?: number;
}

export async function resolveTagsForItems(
    items: { tags?: string[] }[],
    managedTags: Set<string>,
    systemTagNames: string[],
    defaultTagName: string,
    client: TagClient
): Promise<TagResolutionResult> {
    

    const itemTagNames = new Set<string>();
    items.forEach(item => {
        if (item.tags) {
            item.tags.forEach(t => itemTagNames.add(t));
        }
    });


    const allRequiredTags = [...new Set([...systemTagNames, ...itemTagNames, ...managedTags])];
    
    if (allRequiredTags.length === 0) {
        return {
            tagMap: new Map(),
            managedTagIds: new Set(),
            systemTagIds: [],
            defaultTagId: undefined
        };
    }

    logger.info(`Resolving ${allRequiredTags.length} tags...`);


    const tagMap = await ensureTagsAreAvailable(allRequiredTags, client);


    const managedTagIds = new Set<number>();
    [...managedTags, ...systemTagNames].forEach(t => {
        const id = tagMap.get(t);
        if (id) managedTagIds.add(id);
    });

    const systemTagIds = systemTagNames
        .map(name => tagMap.get(name))
        .filter((id): id is number => id !== undefined);

    return {
        tagMap,
        managedTagIds,
        systemTagIds,
        defaultTagId: tagMap.get(defaultTagName)
    };
}

async function ensureTagsAreAvailable(
    requiredTags: string[], 
    client: TagClient
): Promise<Map<string, number>> {
    const tagMap = new Map<string, number>();
    

    const existingTags = await client.getAllTags();
    existingTags.forEach(t => tagMap.set(t.label, t.id));


    const missingTags = requiredTags.filter(t => !tagMap.has(t));

    if (missingTags.length > 0) {
        logger.info(`Creating ${missingTags.length} new tags...`);
        for (const tagLabel of missingTags) {
            const newId = await client.createTag(tagLabel);
            if (newId) {
                tagMap.set(tagLabel, newId);
            }
        }
    }

    return tagMap;
}
