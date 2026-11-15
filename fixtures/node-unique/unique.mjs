/**
 * Remove duplicates from a list, keeping the first occurrence of each key.
 */
export function unique(items, key = (item) => item) {
	return [...new Set(items.map(key))];
}
