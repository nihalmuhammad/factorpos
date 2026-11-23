/**
 * FactorPOS setup helpers.
 *
 * FloCafe pins India and Argentina to the top of the setup country list. FactorPOS
 * preselects Saudi Arabia, so without this its tick sat far out of view while India
 * was the first, one-click choice.
 */

/** Moves the selected country to the top of the list so its tick is always in view. */
export function selectedCountryFirst<T extends { code: string }>(
  countries: T[],
  selected: string,
): T[] {
  const index = countries.findIndex((c) => c.code === selected);
  if (index <= 0) return countries;
  return [countries[index], ...countries.slice(0, index), ...countries.slice(index + 1)];
}
