// The identifier of the place in the header of a document where the editor puts
// the row of the people present (./people-row.tsx). The page renders the place,
// which is a server component and holds no connection, and the editor, which
// holds it, fills the place; neither imports the other, so both name it here.
export const PEOPLE_SLOT = 'people-present';
