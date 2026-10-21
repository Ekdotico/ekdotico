// What the removal of metadata keeps (NFR-SE-18: "The location data and every
// other piece of embedded metadata of an image are removed before it is
// stored"; the owner's answer to Q13: our own removal, for the four formats,
// that does not compress the image again).
//
// REGISTER ROW S19-2, RECOMMENDED AND NOT YET ANSWERED. The removal is a
// whitelist, and the whitelist has two optional parts, which are this file and
// nothing else. The text asks for every piece of metadata to go, and two kinds
// of part change how the pixels look without saying anything of where the file
// came from:
//
// - `keepColour`: the colour chunks and profiles (PNG gAMA, cHRM, sRGB, iCCP,
//   cICP; the JPEG ICC profile; the WebP ICCP chunk). Without them an image
//   that has a profile is shown in other colours.
// - `keepOrientation`: the one Exif tag, Orientation. The Exif block is removed
//   whole and an Exif block of this one tag is written in its place, with no
//   other field: no location, no time, no device, no thumbnail. Without it a
//   photograph taken with a phone held on its side is shown on its side.
//
// The owner's answer to S19-2 sets both, and no other line of the removal
// changes. A decision to remove both is `{ keepColour: false, keepOrientation: false }`.
export interface RemovalPolicy {
  keepColour: boolean;
  keepOrientation: boolean;
}

export const REMOVAL_POLICY: Readonly<RemovalPolicy> = { keepColour: true, keepOrientation: true };
