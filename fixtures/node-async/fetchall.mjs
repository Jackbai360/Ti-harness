/**
 * Fetch every id and return the results in the order given.
 */
export async function fetchAll(ids, fetchOne) {
	const results = [];
	ids.forEach(async (id) => {
		results.push(await fetchOne(id));
	});
	return results;
}
