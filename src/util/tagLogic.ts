/**
 * Calculates the final set of tags for an item.
 * 
 * @param currentTags list of current tags (managed + manual)
 * @param managedTags set of all tags the system is allowed to remove/manage
 * @param nextTags list of tags the item should have from the current sync
 * @returns the final list of tags
 */
export function calculateNextTags(
    currentTags: string[], 
    managedTags: Set<string>, 
    nextTags: string[],
    caseInsensitive: boolean = false
): string[] {
    // 1. Prepare Managed Set (Normalize if needed)
    let managedSet = managedTags;
    if (caseInsensitive) {
        managedSet = new Set([...managedTags].map(t => t.toLowerCase()));
    }

    // 2. Identify Preserved Tags
    const preservedTags = currentTags.filter(t => {
        const key = caseInsensitive ? t.toLowerCase() : t;
        return !managedSet.has(key);
    });
    
    // 3. Combine with new tags (Deduplicate)
    const finalTags = [...new Set([...preservedTags, ...nextTags])];
    
    return finalTags;
}


export function calculateNextTagIds(
    currentTagIds: number[], 
    managedTagIds: Set<number>, 
    nextTagIds: number[]
): number[] {
    const preserved = currentTagIds.filter(id => !managedTagIds.has(id));
    return [...new Set([...preserved, ...nextTagIds])];
}
