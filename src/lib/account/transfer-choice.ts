// FR-AU-92 (b): the person the user picked, as the list of people now holds them. Nobody where the person has left
// the list since (a refusal re-reads the screen) or none was picked: never the first of the list in their place, since
// a choice that changed under the user is not one they made. The action waits until they pick again.
// No import: a page in the browser reads this too.

export function chosenPerson<T extends { collaboratorId: string }>(
  people: readonly T[],
  chosen: string,
): T | undefined {
  return people.find(({ collaboratorId }) => collaboratorId === chosen);
}
