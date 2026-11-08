const productions = new Map([
  ['written in the dark', 'written-in-the-dark'],
  ['wherein lies continue', 'wherein-lies-continue']
]);

export function eventProductions(event) {
  if (event.isCancelled || event.sensitivity !== 'normal') return [];
  const categories = (event.categories || []).map(value => value.trim().toLowerCase());
  return [...productions].filter(([name]) => categories.includes(name)).map(([, id]) => id);
}

export function includesMember(productionIds, member) {
  if (!member || member.revoked) return false;
  const assigned = member.productions ?? {'written-in-the-dark': {}};
  return productionIds?.some(id => Object.hasOwn(assigned, id)) || false;
}
